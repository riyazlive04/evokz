import { z } from 'zod';

import {
  coercePosterCopy,
  posterArchetypeSchema,
  posterCopySchema,
  POSTER_ARCHETYPES,
  POSTER_ICONS,
  type PosterArchetype,
  type PosterCopy,
} from '@/lib/types/poster';

/**
 * Bulk content-calendar import — sheet parsing and the wire contract.
 *
 * Isomorphic by design. The operator panel parses the pasted/uploaded sheet in
 * the browser so every problem is visible *before* anything is written, and the
 * server action re-validates the same rows against the same schema. Nothing in
 * this module may import Prisma or any other server-only code — `types/poster`
 * is zod-only and safe to pull into the browser bundle.
 *
 * Two column groups. The **content** columns (theme, caption, hashtags, image
 * prompt) are what the calendar generator writes and are all an import needs.
 * The **poster** columns are optional: supply them to author the typographic
 * layer by hand, or leave them blank and `ensurePosterCopy` derives it from the
 * content columns on first render.
 */

// ---------------------------------------------------------------------------
// Field contract
// ---------------------------------------------------------------------------

/**
 * Per-cell limits.
 *
 * The content limits mirror `demoCreativeSchema`, so imported and hand-typed
 * copy agree. The poster limits mirror `posterCopySchema`, which stays the
 * authority — these exist only to produce a *specific* message naming the
 * offending cell, instead of letting `coercePosterCopy` silently truncate an
 * operator's deliberate wording at a word boundary.
 */
export const IMPORT_FIELD_LIMITS = {
  theme: { min: 2, max: 120 },
  caption: { min: 10, max: 2_000 },
  hashtags: { max: 400 },
  imagePrompt: { min: 10, max: 2_000 },
  headlineLine: { max: 24 },
  eyebrow: { max: 40 },
  posterBody: { min: 1, max: 240 },
  featureLabel: { max: 28 },
  featureBody: { max: 90 },
  contactLabel: { max: 28 },
} as const;

/** The longest plan runs 365 days; the slack absorbs a few stray sheet rows. */
export const IMPORT_ROW_LIMIT = 400;

/** Guards against someone dropping a spreadsheet export of the wrong thing. */
export const IMPORT_MAX_BYTES = 1_000_000;

/** Headline lines and feature counts the poster schema will accept. */
const HEADLINE_LINES = { min: 2, max: 4 } as const;
const FEATURES = { min: 2, max: 4 } as const;

export const CONFLICT_MODES = ['skip', 'overwrite'] as const;
export type ConflictMode = (typeof CONFLICT_MODES)[number];

export const calendarImportRowSchema = z.object({
  /**
   * Null means "assign the next unwritten day". Resolution is deliberately left
   * to the server, which reads the days that exist *now* rather than trusting
   * the browser's snapshot from whenever the page was rendered.
   */
  dayNumber: z.number().int().min(1).max(3650).nullable(),
  theme: z
    .string()
    .trim()
    .min(IMPORT_FIELD_LIMITS.theme.min, 'Theme is too short')
    .max(IMPORT_FIELD_LIMITS.theme.max, 'Theme is too long'),
  caption: z
    .string()
    .trim()
    .min(IMPORT_FIELD_LIMITS.caption.min, 'Caption is too short')
    .max(IMPORT_FIELD_LIMITS.caption.max, 'Caption is too long'),
  hashtags: z.string().trim().max(IMPORT_FIELD_LIMITS.hashtags.max, 'Hashtags are too long'),
  imagePrompt: z
    .string()
    .trim()
    .min(IMPORT_FIELD_LIMITS.imagePrompt.min, 'Image prompt is too short')
    .max(IMPORT_FIELD_LIMITS.imagePrompt.max, 'Image prompt is too long'),
  /**
   * Hand-authored poster text layer, already repaired and validated by
   * `coercePosterCopy`. Null leaves `ContentCalendar.posterCopy` unset, which is
   * the signal `ensurePosterCopy` uses to write it at render time.
   */
  poster: posterCopySchema.nullable(),
  /** Pinned layout. Null lets `archetypeForDay` derive it from the day number. */
  archetype: posterArchetypeSchema.nullable(),
});

export const calendarImportSchema = z.object({
  mode: z.enum(CONFLICT_MODES),
  rows: z
    .array(calendarImportRowSchema)
    .min(1, 'Nothing to import')
    .max(IMPORT_ROW_LIMIT, `An import is capped at ${IMPORT_ROW_LIMIT} rows`),
});

export type CalendarImportRow = z.infer<typeof calendarImportRowSchema>;
export type CalendarImportInput = z.input<typeof calendarImportSchema>;

// ---------------------------------------------------------------------------
// Column recognition
// ---------------------------------------------------------------------------

type ContentColumn = 'dayNumber' | 'theme' | 'caption' | 'hashtags' | 'imagePrompt';

type PosterColumn =
  | 'headline'
  | 'accentLine'
  | 'eyebrow'
  | 'posterBody'
  | 'callLabel'
  | 'websiteLabel'
  | 'headlinePeriod'
  | 'archetype';

type FeatureSlot = 1 | 2 | 3 | 4;
type FeatureColumn = `feature${FeatureSlot}${'Icon' | 'Label' | 'Body'}`;

type SheetColumn = ContentColumn | PosterColumn | FeatureColumn;

const FEATURE_SLOTS: FeatureSlot[] = [1, 2, 3, 4];

/** Without these three a row carries no deliverable content at all. */
const REQUIRED_COLUMNS: ContentColumn[] = ['theme', 'caption', 'imagePrompt'];

/** Canonical spelling of the content columns, in template order. */
export const CONTENT_COLUMN_LABELS: Record<ContentColumn, string> = {
  dayNumber: 'day',
  theme: 'theme',
  caption: 'caption',
  hashtags: 'hashtags',
  imagePrompt: 'image prompt',
};

/** Canonical spelling of every poster column, in template order. */
export const POSTER_COLUMN_LABELS: string[] = [
  'headline',
  'accent line',
  'eyebrow',
  'poster body',
  ...FEATURE_SLOTS.slice(0, 3).flatMap((slot) => [
    `feature ${slot} icon`,
    `feature ${slot} label`,
    `feature ${slot} body`,
  ]),
  'call label',
  'website label',
  'headline period',
  'archetype',
];

/**
 * Header spellings we accept, keyed by the normalised form (lowercased, with
 * every non-alphanumeric character stripped) so "Image Prompt", "image_prompt",
 * and "ImagePrompt" all land on the same column.
 */
const HEADER_ALIASES: Record<string, SheetColumn> = {
  // ---- Content ----
  day: 'dayNumber',
  daynumber: 'dayNumber',
  dayno: 'dayNumber',
  daynum: 'dayNumber',
  sno: 'dayNumber',
  srno: 'dayNumber',

  theme: 'theme',
  topic: 'theme',
  angle: 'theme',
  contentangle: 'theme',

  caption: 'caption',
  copy: 'caption',
  postcopy: 'caption',
  posttext: 'caption',

  hashtags: 'hashtags',
  hashtag: 'hashtags',
  tags: 'hashtags',

  imageprompt: 'imagePrompt',
  prompt: 'imagePrompt',
  visualprompt: 'imagePrompt',
  imagedescription: 'imagePrompt',
  imagebrief: 'imagePrompt',
  photobrief: 'imagePrompt',

  // ---- Poster ----
  headline: 'headline',
  headlines: 'headline',
  headlinelines: 'headline',
  posterheadline: 'headline',

  accentline: 'accentLine',
  accent: 'accentLine',
  accentindex: 'accentLine',
  accentlineindex: 'accentLine',

  eyebrow: 'eyebrow',
  kicker: 'eyebrow',
  postereyebrow: 'eyebrow',

  posterbody: 'posterBody',
  body: 'posterBody',
  postertext: 'posterBody',
  posterparagraph: 'posterBody',

  calllabel: 'callLabel',
  callcta: 'callLabel',
  callaction: 'callLabel',

  websitelabel: 'websiteLabel',
  websitecta: 'websiteLabel',

  headlineperiod: 'headlinePeriod',
  period: 'headlinePeriod',
  fullstop: 'headlinePeriod',

  archetype: 'archetype',
  layout: 'archetype',
  posterarchetype: 'archetype',

  // ---- Features (generated below) ----
  ...buildFeatureAliases(),
};

function buildFeatureAliases(): Record<string, FeatureColumn> {
  const aliases: Record<string, FeatureColumn> = {};

  for (const slot of FEATURE_SLOTS) {
    const parts: Array<{ suffix: 'Icon' | 'Label' | 'Body'; words: string[] }> = [
      { suffix: 'Icon', words: ['icon'] },
      { suffix: 'Label', words: ['label', 'title'] },
      { suffix: 'Body', words: ['body', 'text', 'description'] },
    ];

    for (const part of parts) {
      const column = `feature${slot}${part.suffix}` as FeatureColumn;
      for (const word of part.words) {
        // "feature 1 icon", "f1 icon", "icon 1" — the three ways a spreadsheet
        // column for an indexed sub-object actually gets named in practice.
        aliases[`feature${slot}${word}`] = column;
        aliases[`f${slot}${word}`] = column;
        aliases[`${word}${slot}`] = column;
      }
    }
  }

  return aliases;
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ---------------------------------------------------------------------------
// Parse results
// ---------------------------------------------------------------------------

export interface ParsedImportRow extends CalendarImportRow {
  /** 1-based source line (CSV) or element index (JSON), for error copy. */
  line: number;
  /** Empty when the row is importable exactly as it stands. */
  issues: string[];
}

export interface CalendarImportParse {
  /** Every data row found, importable or not. */
  rows: ParsedImportRow[];
  /** Set when nothing could be read at all; `rows` is then empty. */
  error: string | null;
  format: 'csv' | 'json' | null;
  /** Delimiter that won the header sniff, for the panel's status line. */
  delimiter: 'comma' | 'tab' | 'semicolon' | null;
  /** Recognised-but-unused header names, surfaced so typos are noticeable. */
  ignoredColumns: string[];
  /** True when the sheet carried more than `IMPORT_ROW_LIMIT` data rows. */
  truncated: boolean;
  /** True when the sheet supplied any poster column at all. */
  hasPosterColumns: boolean;
}

const EMPTY_PARSE: Omit<CalendarImportParse, 'error'> = {
  rows: [],
  format: null,
  delimiter: null,
  ignoredColumns: [],
  truncated: false,
  hasPosterColumns: false,
};

function fatal(error: string): CalendarImportParse {
  return { ...EMPTY_PARSE, error };
}

/** Reads one row's cells by canonical column name; '' when absent. */
type CellReader = (column: SheetColumn) => string;

/**
 * Reads a pasted or uploaded sheet into candidate calendar rows.
 *
 * `maxDay` is the client's plan duration: a day number beyond it can never be
 * delivered, so it is rejected here rather than silently dropped server-side.
 */
export function parseCalendarImport(
  raw: string,
  options: { maxDay: number },
): CalendarImportParse {
  // Excel and Google Sheets both prepend a BOM to CSV exports, which would
  // otherwise glue itself to the first header cell and break its alias lookup.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  // Blank input is the panel's resting state, not a mistake worth reporting.
  if (text.trim().length === 0) return { ...EMPTY_PARSE, error: null };

  const leading = text.trimStart();
  const parsed =
    leading.startsWith('[') || leading.startsWith('{')
      ? parseJsonSheet(text)
      : parseDelimitedSheet(text);

  if (parsed.error !== null) return parsed;

  return finalize(parsed, options.maxDay);
}

// ---------------------------------------------------------------------------
// Delimited (CSV / TSV) input
// ---------------------------------------------------------------------------

interface RawRecord {
  line: number;
  fields: string[];
}

const DELIMITERS: Array<{ char: string; name: NonNullable<CalendarImportParse['delimiter']> }> = [
  { char: ',', name: 'comma' },
  { char: '\t', name: 'tab' },
  { char: ';', name: 'semicolon' },
];

function parseDelimitedSheet(text: string): CalendarImportParse {
  // Sniff on the head of the file only. Counting delimiters across the whole
  // text would pick comma over tab for any TSV whose captions contain commas.
  const head = text.slice(0, 4_000);

  let best: { char: string; name: NonNullable<CalendarImportParse['delimiter']>; score: number } | null =
    null;

  for (const candidate of DELIMITERS) {
    const header = splitRecords(head, candidate.char).find(hasContent);
    if (!header) continue;

    const matched = new Set(
      header.fields
        .map((cell) => HEADER_ALIASES[normalizeHeader(cell)])
        .filter((column): column is SheetColumn => column !== undefined),
    );

    if (best === null || matched.size > best.score) {
      best = { char: candidate.char, name: candidate.name, score: matched.size };
    }
  }

  // Two recognised columns is the floor: one lucky hit ("day", "tags") is more
  // likely a coincidence than a real header row.
  if (best === null || best.score < 2) {
    return fatal(
      `No header row recognised. The first line must name the columns — ${Object.values(CONTENT_COLUMN_LABELS).join(', ')} — in any order. Download a template for the exact shape.`,
    );
  }

  const records = splitRecords(text, best.char).filter(hasContent);
  const header = records[0];
  if (!header) return fatal('The sheet has a header row but no content rows.');

  const columns = header.fields.map((cell) => HEADER_ALIASES[normalizeHeader(cell)] ?? null);
  const present = new Set(columns.filter((column): column is SheetColumn => column !== null));

  const missing = REQUIRED_COLUMNS.filter((column) => !present.has(column));
  if (missing.length > 0) {
    return fatal(
      `Missing required column${missing.length === 1 ? '' : 's'}: ${missing
        .map((column) => CONTENT_COLUMN_LABELS[column])
        .join(', ')}.`,
    );
  }

  const ignoredColumns = header.fields.filter(
    (cell, index) => columns[index] === null && cell.trim().length > 0,
  );

  const dataRecords = records.slice(1);
  if (dataRecords.length === 0) {
    return fatal('The sheet has a header row but no content rows.');
  }

  const truncated = dataRecords.length > IMPORT_ROW_LIMIT;

  // Precomputed so a 400-row sheet does not run indexOf per cell per row.
  const columnIndex = new Map<SheetColumn, number>();
  columns.forEach((column, index) => {
    if (column !== null && !columnIndex.has(column)) columnIndex.set(column, index);
  });

  const rows = dataRecords.slice(0, IMPORT_ROW_LIMIT).map((record) => {
    const read: CellReader = (column) => {
      const index = columnIndex.get(column);
      return index === undefined ? '' : (record.fields[index] ?? '').trim();
    };
    return draftRow(record.line, read, null);
  });

  return {
    rows,
    error: null,
    format: 'csv',
    delimiter: best.name,
    ignoredColumns,
    truncated,
    hasPosterColumns: [...present].some(isPosterColumn),
  };
}

function isPosterColumn(column: SheetColumn): boolean {
  return !(column in CONTENT_COLUMN_LABELS);
}

function hasContent(record: RawRecord): boolean {
  return record.fields.some((field) => field.trim().length > 0);
}

/**
 * RFC-4180-shaped tokenizer: quoted fields may contain the delimiter, newlines,
 * and doubled quotes. A quote appearing mid-field is treated as literal text,
 * which keeps unquoted copy like `6" slab` intact.
 *
 * `line` is tracked through quoted newlines so a problem in row 40 of a sheet
 * with multi-line captions still points at the right place in the paste box.
 */
function splitRecords(text: string, delimiter: string): RawRecord[] {
  const records: RawRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let started = false;

  const endRecord = (): void => {
    fields.push(field);
    records.push({ line: recordLine, fields });
    fields = [];
    field = '';
    started = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (!started) {
      recordLine = line;
      started = true;
    }

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
        continue;
      }

      if (char === '\r') {
        // Normalise CRLF inside a quoted cell to a single newline.
        if (text[index + 1] === '\n') index += 1;
        field += '\n';
        line += 1;
        continue;
      }

      if (char === '\n') {
        field += '\n';
        line += 1;
        continue;
      }

      field += char;
      continue;
    }

    if (char === '"' && field.length === 0) {
      inQuotes = true;
      continue;
    }

    if (char === delimiter) {
      fields.push(field);
      field = '';
      continue;
    }

    if (char === '\r' || char === '\n') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      endRecord();
      line += 1;
      continue;
    }

    field += char;
  }

  if (started) endRecord();

  return records;
}

// ---------------------------------------------------------------------------
// JSON input
// ---------------------------------------------------------------------------

/**
 * Accepts a bare array or the `{ days: [...] }` envelope, so the calendar
 * generator's own structured output can be pasted straight back in after an
 * editor has revised it — including its nested `poster` block, which is read
 * directly rather than flattened through the column aliases.
 */
function parseJsonSheet(text: string): CalendarImportParse {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (cause) {
    return fatal(
      `That looked like JSON but would not parse: ${cause instanceof Error ? cause.message : 'unknown error'}`,
    );
  }

  const list = Array.isArray(decoded) ? decoded : extractEnvelope(decoded);

  if (list === null) {
    return fatal(
      'Expected a JSON array of objects, or an object with a "days" array holding them.',
    );
  }
  if (list.length === 0) return fatal('The JSON array is empty.');

  const truncated = list.length > IMPORT_ROW_LIMIT;
  const rows: ParsedImportRow[] = [];
  const ignored = new Set<string>();
  let sawPoster = false;

  list.slice(0, IMPORT_ROW_LIMIT).forEach((element, index) => {
    // Line numbers are 1-based element positions here — JSON has no useful line
    // to point at once it has been through JSON.parse.
    const line = index + 1;

    if (typeof element !== 'object' || element === null || Array.isArray(element)) {
      rows.push({
        line,
        dayNumber: null,
        theme: '',
        caption: '',
        hashtags: '',
        imagePrompt: '',
        poster: null,
        archetype: null,
        issues: ['Entry is not an object'],
      });
      return;
    }

    const source = element as Record<string, unknown>;
    const cells = new Map<SheetColumn, string>();
    let nestedPoster: unknown = null;

    for (const [key, value] of Object.entries(source)) {
      const normalized = normalizeHeader(key);

      // The generator emits `poster` as a nested object. Take it whole: pushing
      // it through the flat aliases would lose the feature array's structure.
      if (normalized === 'poster' || normalized === 'postercopy') {
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          nestedPoster = value;
          sawPoster = true;
          continue;
        }
      }

      const column = HEADER_ALIASES[normalized];
      if (column === undefined) {
        ignored.add(key);
        continue;
      }
      if (value === null || value === undefined) continue;

      if (isPosterColumn(column)) sawPoster = true;

      // `headlineLines` arrives as an array; the flat form is pipe-separated.
      cells.set(
        column,
        Array.isArray(value)
          ? value.map((entry) => String(entry).trim()).filter(Boolean).join(' | ')
          : typeof value === 'string'
            ? value.trim()
            : String(value),
      );
    }

    const read: CellReader = (column) => cells.get(column) ?? '';
    rows.push(draftRow(line, read, nestedPoster));
  });

  return {
    rows,
    error: null,
    format: 'json',
    delimiter: null,
    ignoredColumns: [...ignored],
    truncated,
    hasPosterColumns: sawPoster,
  };
}

function extractEnvelope(decoded: unknown): unknown[] | null {
  if (typeof decoded !== 'object' || decoded === null) return null;
  const record = decoded as Record<string, unknown>;
  for (const key of ['days', 'rows', 'entries', 'calendar']) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Row validation
// ---------------------------------------------------------------------------

/**
 * Turns one row's cells into a candidate entry plus the list of reasons it
 * cannot be imported.
 *
 * `nestedPoster` short-circuits the poster columns for JSON input that already
 * carries a structured `poster` object.
 */
function draftRow(
  line: number,
  read: CellReader,
  nestedPoster: unknown,
): ParsedImportRow {
  const issues: string[] = [];

  const dayNumber = readDayNumber(read('dayNumber'), issues);

  const theme = read('theme');
  const caption = read('caption');
  const hashtags = normalizeHashtags(read('hashtags'));
  const imagePrompt = read('imagePrompt');

  checkLength(issues, 'Theme', theme, IMPORT_FIELD_LIMITS.theme);
  checkLength(issues, 'Caption', caption, IMPORT_FIELD_LIMITS.caption);
  checkLength(issues, 'Image prompt', imagePrompt, IMPORT_FIELD_LIMITS.imagePrompt);

  if (hashtags.length > IMPORT_FIELD_LIMITS.hashtags.max) {
    issues.push(`Hashtags exceed ${IMPORT_FIELD_LIMITS.hashtags.max} characters`);
  }

  const poster =
    nestedPoster !== null
      ? readNestedPoster(nestedPoster, issues)
      : readPosterCells(read, issues);

  const archetype = readArchetype(read('archetype'), issues);

  return {
    line,
    dayNumber,
    theme,
    caption,
    hashtags,
    imagePrompt,
    poster,
    archetype,
    issues,
  };
}

function readDayNumber(raw: string, issues: string[]): number | null {
  if (raw.length === 0) return null;

  // Tolerates "Day 12" and "12." — both common when a column is retyped by hand.
  const digits = /^(?:day\s*)?(\d+)\.?$/i.exec(raw);
  if (!digits) {
    issues.push(`Day "${truncate(raw, 20)}" is not a whole number`);
    return null;
  }
  return Number.parseInt(digits[1] as string, 10);
}

function readArchetype(raw: string, issues: string[]): PosterArchetype | null {
  if (raw.length === 0) return null;

  const result = posterArchetypeSchema.safeParse(raw.toLowerCase());
  if (!result.success) {
    issues.push(
      `Archetype "${truncate(raw, 20)}" is not one of: ${POSTER_ARCHETYPES.join(', ')}`,
    );
    return null;
  }
  return result.data;
}

/** JSON rows carrying the generator's nested `poster` object. */
function readNestedPoster(source: unknown, issues: string[]): PosterCopy | null {
  const copy = coercePosterCopy(source);
  if (!copy) {
    issues.push(
      'The nested "poster" object is unusable — it needs at least 2 headline lines, ' +
        '2 features with a label and body, and a body paragraph',
    );
  }
  return copy;
}

/**
 * Builds poster copy from the flat sheet columns.
 *
 * All-or-nothing per row: a row that touches *any* poster cell must supply a
 * complete block, because a half-filled poster cannot be rendered and silently
 * falling back to generation would hide the operator's typo behind a plausible
 * result. A row that touches none returns null and gets its poster written by
 * `ensurePosterCopy` at render time.
 */
function readPosterCells(read: CellReader, issues: string[]): PosterCopy | null {
  const headlineRaw = read('headline');
  const posterBody = read('posterBody');
  const eyebrow = read('eyebrow');
  const callLabel = read('callLabel');
  const websiteLabel = read('websiteLabel');
  const periodRaw = read('headlinePeriod');
  const accentRaw = read('accentLine');

  const featureCells = FEATURE_SLOTS.map((slot) => ({
    slot,
    icon: read(`feature${slot}Icon`),
    label: read(`feature${slot}Label`),
    body: read(`feature${slot}Body`),
  }));

  const touched =
    [headlineRaw, posterBody, eyebrow, callLabel, websiteLabel, periodRaw, accentRaw].some(
      (cell) => cell.length > 0,
    ) ||
    featureCells.some((cell) => cell.icon || cell.label || cell.body);

  if (!touched) return null;

  // ---- Headline ----
  const headlineLines = headlineRaw
    .split(/[|\r\n]+/)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0);

  if (headlineLines.length < HEADLINE_LINES.min) {
    issues.push(
      headlineLines.length === 0
        ? 'Poster headline is empty — give 2 to 4 short lines separated by "|"'
        : 'Poster headline needs at least 2 lines — separate them with "|"',
    );
  } else if (headlineLines.length > HEADLINE_LINES.max) {
    issues.push(`Poster headline has ${headlineLines.length} lines; the maximum is 4`);
  }

  for (const line of headlineLines) {
    if (line.length > IMPORT_FIELD_LIMITS.headlineLine.max) {
      issues.push(
        `Headline line "${truncate(line, 18)}" exceeds ${IMPORT_FIELD_LIMITS.headlineLine.max} characters`,
      );
    }
  }

  // ---- Features ----
  const features: Array<{ icon: string; label: string; body: string }> = [];

  for (const cell of featureCells) {
    if (!cell.icon && !cell.label && !cell.body) continue;

    if (!cell.icon || !cell.label || !cell.body) {
      issues.push(`Feature ${cell.slot} needs all three of icon, label, and body`);
      continue;
    }
    if (!(POSTER_ICONS as readonly string[]).includes(cell.icon)) {
      // Named rather than silently substituted: `coercePosterCopy` would fall
      // back to shieldCheck, and an icon contradicting its own label is worse
      // than being told to fix the spelling.
      issues.push(
        `Feature ${cell.slot} icon "${truncate(cell.icon, 20)}" is not a known icon (${POSTER_ICONS.join(', ')})`,
      );
      continue;
    }
    if (cell.label.length > IMPORT_FIELD_LIMITS.featureLabel.max) {
      issues.push(
        `Feature ${cell.slot} label exceeds ${IMPORT_FIELD_LIMITS.featureLabel.max} characters`,
      );
    }
    if (cell.body.length > IMPORT_FIELD_LIMITS.featureBody.max) {
      issues.push(
        `Feature ${cell.slot} body exceeds ${IMPORT_FIELD_LIMITS.featureBody.max} characters`,
      );
    }

    features.push({ icon: cell.icon, label: cell.label, body: cell.body });
  }

  if (features.length < FEATURES.min) {
    issues.push(`Poster needs at least ${FEATURES.min} features, each with icon, label, and body`);
  }

  // ---- Body, eyebrow, contact labels ----
  if (posterBody.length === 0) {
    issues.push('Poster body is required once any poster column is filled');
  } else if (posterBody.length > IMPORT_FIELD_LIMITS.posterBody.max) {
    issues.push(`Poster body exceeds ${IMPORT_FIELD_LIMITS.posterBody.max} characters`);
  }

  if (eyebrow.length > IMPORT_FIELD_LIMITS.eyebrow.max) {
    issues.push(`Poster eyebrow exceeds ${IMPORT_FIELD_LIMITS.eyebrow.max} characters`);
  }
  if (callLabel.length > IMPORT_FIELD_LIMITS.contactLabel.max) {
    issues.push(`Call label exceeds ${IMPORT_FIELD_LIMITS.contactLabel.max} characters`);
  }
  if (websiteLabel.length > IMPORT_FIELD_LIMITS.contactLabel.max) {
    issues.push(`Website label exceeds ${IMPORT_FIELD_LIMITS.contactLabel.max} characters`);
  }

  // ---- Accent line: 1-based in the sheet, 0-based on the wire ----
  // Defaults to line 2, the accented line in 8 of the 12 reference posters.
  let accentLineIndex = Math.min(1, Math.max(0, headlineLines.length - 1));
  if (accentRaw.length > 0) {
    const digits = /^(?:line\s*)?(\d+)\.?$/i.exec(accentRaw);
    if (!digits) {
      issues.push(`Accent line "${truncate(accentRaw, 16)}" is not a line number`);
    } else {
      const oneBased = Number.parseInt(digits[1] as string, 10);
      if (oneBased < 1 || oneBased > headlineLines.length) {
        issues.push(
          `Accent line ${oneBased} is outside the ${headlineLines.length} headline line(s) on this row`,
        );
      } else {
        accentLineIndex = oneBased - 1;
      }
    }
  }

  // ---- Headline period ----
  const headlinePeriod = readFlag(periodRaw);
  if (periodRaw.length > 0 && headlinePeriod === null) {
    issues.push(`Headline period "${truncate(periodRaw, 16)}" is not yes/no`);
  }

  // `coercePosterCopy` is the authority on shape. Everything above exists to
  // produce a specific message first — by here, a clean row needs no repair.
  const copy = coercePosterCopy({
    headlineLines,
    accentLineIndex,
    eyebrow,
    body: posterBody,
    features,
    callLabel,
    websiteLabel,
    headlinePeriod: headlinePeriod === true,
  });

  if (!copy && issues.length === 0) {
    issues.push('The poster columns on this row do not form a usable poster');
  }

  return copy;
}

/** Spreadsheet truthiness: yes/no, y/n, true/false, 1/0, and a bare tick. */
function readFlag(raw: string): boolean | null {
  const value = raw.trim().toLowerCase();
  if (value.length === 0) return false;
  if (['yes', 'y', 'true', '1', 'x', '✓', '✔'].includes(value)) return true;
  if (['no', 'n', 'false', '0', '-'].includes(value)) return false;
  return null;
}

function checkLength(
  issues: string[],
  label: string,
  value: string,
  limits: { min?: number; max: number },
): void {
  if (limits.min !== undefined && value.length < limits.min) {
    issues.push(
      value.length === 0
        ? `${label} is empty`
        : `${label} needs at least ${limits.min} characters`,
    );
    return;
  }
  if (value.length > limits.max) {
    issues.push(`${label} exceeds ${limits.max} characters`);
  }
}

/**
 * Applies the checks that need the whole sheet in hand: a duplicated day number
 * and a day number the plan cannot reach.
 */
function finalize(parsed: CalendarImportParse, maxDay: number): CalendarImportParse {
  const seen = new Map<number, number>();

  const rows = parsed.rows.map((row) => {
    if (row.dayNumber === null) return row;

    const issues = [...row.issues];

    if (row.dayNumber > maxDay) {
      issues.push(`Day ${row.dayNumber} is past the plan's ${maxDay}-day duration`);
    }

    const firstLine = seen.get(row.dayNumber);
    if (firstLine === undefined) {
      seen.set(row.dayNumber, row.line);
    } else {
      issues.push(`Day ${row.dayNumber} is already used on line ${firstLine}`);
    }

    return issues.length === row.issues.length ? row : { ...row, issues };
  });

  return { ...parsed, rows };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Normalises to space-separated `#tags`, deduped, order preserved. Shared with
 * the calendar generator so LLM-written and operator-written tags land in
 * `ContentCalendar.hashtags` in exactly one format.
 *
 * The `#` is added *before* the length filter, which then only discards empties
 * and a lone `#`. Filtering first would silently swallow every single-character
 * tag in a hand-written sheet — the generator's output always arrives prefixed,
 * so that ordering was invisible until operators started typing bare words.
 */
export function normalizeHashtags(raw: string): string {
  const tags = raw
    .split(/[\s,]+/)
    .map((tag) => tag.trim())
    .map((tag) => (tag.startsWith('#') ? tag : `#${tag}`))
    .filter((tag) => tag.length > 1);

  return [...new Set(tags)].join(' ');
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

// ---------------------------------------------------------------------------
// Downloadable templates
// ---------------------------------------------------------------------------

/**
 * Two example days, used by both templates.
 *
 * Filled rather than blank because every house rule here is easier to copy than
 * to describe: `imagePrompt` must request no embedded text or logos (the type is
 * composited as real vector glyphs afterwards, and diffusion models cannot
 * spell) and must push the subject aside to reserve a low-detail region for that
 * type; the headline is 2–4 stacked lines the copywriter breaks by hand; feature
 * labels have to read as parallel noun phrases.
 */
const TEMPLATE_ROWS = [
  {
    day: '1',
    theme: 'Monsoon-ready sites',
    caption:
      'Rain does not pause a deadline — it exposes the crews who planned for it. Our pre-monsoon drainage audit is now open for the season: silt traps cleared, pump capacity verified, access roads graded before the first downpour. Book a site walkthrough this week and start the rains on schedule.',
    hashtags: '#construction #sitesafety #monsoonprep #infrastructure',
    imagePrompt:
      'An active construction site at dawn under heavy grey cloud, two engineers in high-visibility jackets reviewing a plan beside freshly cut drainage channels, subject grouped to the lower right, clear overcast sky filling the upper left as an unbroken low-detail area, cool desaturated blues with a single warm amber safety light, calm and prepared mood, documentary photography, natural light',
    headline: 'READY BEFORE | THE FIRST | DOWNPOUR',
    accentLine: '2',
    eyebrow: 'PRE-MONSOON AUDIT',
    posterBody:
      'A graded site drains itself. We clear, verify and grade before the season turns, so your schedule never waits on the weather.',
    features: [
      { icon: 'shieldCheck', label: 'Drainage audit', body: 'Silt traps cleared and pump capacity verified on site.' },
      { icon: 'stopwatch', label: 'Season timing', body: 'Works completed before the first heavy rainfall.' },
      { icon: 'hardHat', label: 'Trained crews', body: 'Wet-weather protocol briefed to every team on site.' },
    ],
    callLabel: 'BOOK A WALKTHROUGH',
    websiteLabel: 'VISIT OUR WEBSITE',
    headlinePeriod: 'yes',
    archetype: 'scrim',
  },
  {
    day: '2',
    theme: 'Steel that holds',
    caption:
      'Every beam we set carries a mill certificate and a name. Third-party tested, batch-traced, and logged against the drawing before it leaves the yard — because the cheapest steel on a quote is the most expensive line in a retrofit. Ask us for the traceability file on your next structural package.',
    hashtags: '#structuralsteel #qualityassurance #engineering #buildright',
    imagePrompt:
      'A steel I-beam suspended from a tower crane at blue hour, beam and weld seam sharp along the right edge of the frame, deep uncluttered dusk sky occupying the entire left two thirds, industrial greys against cold blue, shallow depth of field, precise and confident mood, high-contrast editorial photography',
    headline: 'EVERY BEAM | CARRIES | A NAME',
    accentLine: '2',
    eyebrow: '',
    posterBody:
      'Mill-certified, batch-traced and logged against the drawing before it leaves the yard. Ask for the traceability file.',
    features: [
      { icon: 'award', label: 'Mill certified', body: 'Third-party tested against the specified grade.' },
      { icon: 'blueprint', label: 'Drawing matched', body: 'Each batch logged against its structural drawing.' },
      { icon: 'building', label: 'Retrofit ready', body: 'Full traceability file supplied with every package.' },
    ],
    callLabel: 'TALK TO OUR TEAM',
    websiteLabel: 'VISIT OUR WEBSITE',
    headlinePeriod: 'no',
    archetype: 'diagonal',
  },
] as const;

/** RFC-4180 quoting: wrap in quotes and double any quote inside. */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function buildTemplate(includePoster: boolean): string {
  const header = includePoster
    ? [...Object.values(CONTENT_COLUMN_LABELS), ...POSTER_COLUMN_LABELS]
    : Object.values(CONTENT_COLUMN_LABELS);

  const lines = TEMPLATE_ROWS.map((row) => {
    const content = [row.day, row.theme, row.caption, row.hashtags, row.imagePrompt];
    if (!includePoster) return content.map(csvCell).join(',');

    const poster = [
      row.headline,
      row.accentLine,
      row.eyebrow,
      row.posterBody,
      ...row.features.flatMap((feature) => [feature.icon, feature.label, feature.body]),
      row.callLabel,
      row.websiteLabel,
      row.headlinePeriod,
      row.archetype,
    ];
    return [...content, ...poster].map(csvCell).join(',');
  });

  // CRLF and no trailing comment rows: the parser has no comment syntax, so a
  // `#`-prefixed note would come back as a broken entry.
  return [header.map(csvCell).join(','), ...lines].join('\r\n');
}

/** Content columns only — the four fields plus the day. */
export const CALENDAR_IMPORT_TEMPLATE = buildTemplate(false);

/** Content columns plus the whole hand-authored poster text layer. */
export const CALENDAR_IMPORT_TEMPLATE_FULL = buildTemplate(true);
