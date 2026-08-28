import { z } from 'zod';

import {
  coercePosterCopy,
  CTA_LABEL_MAX,
  posterCopySchema,
  POSTER_ICONS,
  type PosterCopy,
} from '@/lib/types/poster';
import {
  normalizeTemplateLabel,
  TEMPLATE_LABEL_MAX,
} from '@/lib/template-label';
import { verticalImageryFor } from '@/lib/ai/vertical-vocabulary';

/**
 * Bulk content-calendar import — sheet parsing and the wire contract.
 *
 * Isomorphic by design. The operator panel parses the pasted/uploaded sheet in
 * the browser so every problem is visible *before* anything is written, and the
 * server action re-validates the same rows against the same schema. Nothing in
 * this module may import Prisma or any other server-only code — `types/poster`
 * is zod-only and safe to pull into the browser bundle.
 *
 * Two column groups. The **content** columns (template name, caption, hashtags,
 * image prompt) are all an import needs. The **poster** columns are optional:
 * supply them to author the typographic layer by hand, or leave them blank and
 * `ensurePosterCopy` derives it from the content columns on first render.
 *
 * **The template name is resolved against a catalogue the caller passes in**, not
 * one this module fetches — which is the no-Prisma rule showing up as a
 * parameter. The panel hands it the vertical's approved templates so a typo is
 * caught before submit; the server action hands it a freshly read catalogue,
 * and that one is the authority. A name that resolves in the browser and not on
 * the server means the library moved in between, which is exactly the race the
 * day-number comment below describes.
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
  templateName: { min: 1, max: TEMPLATE_LABEL_MAX },
  caption: { min: 10, max: 2_000 },
  hashtags: { max: 400 },
  imagePrompt: { min: 10, max: 2_000 },
  headlineLine: { max: 24 },
  eyebrow: { max: 40 },
  posterBody: { min: 1, max: 240 },
  featureLabel: { max: 28 },
  featureBody: { max: 90 },
  contactLabel: { max: 28 },
  ctaLabel: { max: CTA_LABEL_MAX },
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
  /**
   * The reference template this day must be laid out from, by name.
   *
   * The name rather than the id, for the same reason `dayNumber` is resolved
   * server-side: the browser's catalogue is a snapshot from whenever the page
   * rendered, and a template un-approved or renamed since then must be caught by
   * the server rather than trusted from the wire.
   */
  templateName: z
    .string()
    .trim()
    .min(1, 'Template name is required')
    .max(IMPORT_FIELD_LIMITS.templateName.max, 'Template name is too long'),
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
   * Brief for a `scene` backdrop's frame. Optional, and empty means "no
   * backdrop" — a template asking for one degrades to the painted `blob` rather
   * than failing, so a sheet written before this column existed still delivers.
   */
  backgroundPrompt: z
    .string()
    .trim()
    .max(IMPORT_FIELD_LIMITS.imagePrompt.max, 'Background prompt is too long')
    .nullable()
    .default(null),
  /**
   * Hand-authored poster text layer, already repaired and validated by
   * `coercePosterCopy`. Null leaves `ContentCalendar.posterCopy` unset, which is
   * the signal `ensurePosterCopy` uses to write it at render time.
   */
  poster: posterCopySchema.nullable(),
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

type ContentColumn =
  | 'dayNumber'
  | 'templateName'
  | 'caption'
  | 'hashtags'
  | 'imagePrompt'
  | 'backgroundPrompt';

type PosterColumn =
  | 'headline'
  | 'accentLine'
  | 'eyebrow'
  | 'posterBody'
  | 'ctaLabel'
  | 'callLabel'
  | 'websiteLabel'
  | 'headlinePeriod';

type FeatureSlot = 1 | 2 | 3 | 4;
type FeatureColumn = `feature${FeatureSlot}${'Icon' | 'Label' | 'Body'}`;

type SheetColumn = ContentColumn | PosterColumn | FeatureColumn;

const FEATURE_SLOTS: FeatureSlot[] = [1, 2, 3, 4];

/** Without these three a row carries no deliverable content at all. */
const REQUIRED_COLUMNS: ContentColumn[] = ['templateName', 'caption', 'imagePrompt'];

/** Canonical spelling of the content columns, in template order. */
export const CONTENT_COLUMN_LABELS: Record<ContentColumn, string> = {
  dayNumber: 'day',
  templateName: 'template name',
  caption: 'caption',
  hashtags: 'hashtags',
  imagePrompt: 'image prompt',
  // Optional. Only read by a template whose spec asks for a `scene` backdrop;
  // everywhere else it is carried and ignored, which is why it is not in
  // REQUIRED_COLUMNS and why a sheet written before it existed still imports.
  backgroundPrompt: 'background prompt',
};

/** Canonical spelling of every poster column, in template order. */
export const POSTER_COLUMN_LABELS: string[] = [
  'headline',
  'accent line',
  'eyebrow',
  'poster body',
  /*
   * All four slots, not three.
   *
   * `readPosterCells` has always read four; the downloaded sheet showed three,
   * so an operator filling in a template that draws four cards had no column for
   * the fourth and no way to learn one existed. Most of the library draws four.
   */
  ...FEATURE_SLOTS.flatMap((slot) => [
    `feature ${slot} icon`,
    `feature ${slot} label`,
    `feature ${slot} body`,
  ]),
  'cta label',
  'call label',
  'website label',
  'headline period',
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

  // `theme` is deliberately absent. Leaving it unrecognised routes a legacy
  // sheet's column into `ignoredColumns`, so the panel says "theme was ignored"
  // *and* "missing required column: template name" — together the exact pair of
  // messages that explains the change to whoever pasted it.
  templatename: 'templateName',
  template: 'templateName',
  templatelabel: 'templateName',
  layoutname: 'templateName',
  posterlayout: 'templateName',
  reference: 'templateName',
  referencetemplate: 'templateName',
  design: 'templateName',

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
  backgroundprompt: 'backgroundPrompt',
  backgroundbrief: 'backgroundPrompt',
  backdropprompt: 'backgroundPrompt',
  scenebrief: 'backgroundPrompt',

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

  ctalabel: 'ctaLabel',
  cta: 'ctaLabel',
  ctatext: 'ctaLabel',
  buttonlabel: 'ctaLabel',
  buttontext: 'ctaLabel',

  calllabel: 'callLabel',
  callcta: 'callLabel',
  callaction: 'callLabel',

  websitelabel: 'websiteLabel',
  websitecta: 'websiteLabel',

  headlineperiod: 'headlinePeriod',
  period: 'headlinePeriod',
  fullstop: 'headlinePeriod',

  // Repurposed. A legacy sheet whose `layout` column holds `scrim` or `diagonal`
  // now fails strict matching by name, which is the right outcome — a named
  // value that no longer exists beats a silent misread.
  layout: 'templateName',

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
// Template name resolution
// ---------------------------------------------------------------------------

/** One approved template a sheet may name. */
export interface ImportTemplate {
  id: string;
  label: string;
}

export interface TemplateIndex {
  /** Normalised label to every template id carrying it. */
  byName: Map<string, string[]>;
  /** Original labels, for the "valid names are" sentence. */
  labels: string[];
  /** Pre-rendered once per sheet — see `finalize`. */
  validNames: string;
}

/**
 * How many names an error message lists before giving up and counting.
 *
 * A vertical may hold a hundred templates. Naming all of them on each of four
 * hundred rows produces a three-kilobyte sentence repeated four hundred times,
 * which is not help, it is noise.
 */
const NAMES_IN_ERROR = 12;

export function buildTemplateIndex(templates: readonly ImportTemplate[]): TemplateIndex {
  const byName = new Map<string, string[]>();
  for (const template of templates) {
    const key = normalizeTemplateLabel(template.label);
    const existing = byName.get(key);
    if (existing) existing.push(template.id);
    else byName.set(key, [template.id]);
  }

  const labels = templates.map((template) => template.label);
  const shown = labels.slice(0, NAMES_IN_ERROR).join(', ');
  const validNames =
    labels.length > NAMES_IN_ERROR
      ? `${shown} (+${labels.length - NAMES_IN_ERROR} more)`
      : shown;

  return { byName, labels, validNames };
}

/**
 * Matches one typed name against the catalogue.
 *
 * Four outcomes, four sentences. The distinctions matter because they call for
 * different actions: an empty catalogue is a job for the vertical's template
 * library, a misspelling is a job for the sheet, and an ambiguous name is a job
 * for the rename control — and an operator reading "invalid template" would have
 * to work out which.
 *
 * Matching is case- and spacing-insensitive (`normalizeTemplateLabel`), because
 * those are the differences nobody means. Two templates whose labels differ only
 * that way can only predate the uniqueness constraint; rather than pick one, this
 * names both and asks for a rename.
 */
export function resolveTemplateName(
  name: string,
  index: TemplateIndex,
): { id: string } | { error: string } {
  if (index.labels.length === 0) {
    return {
      error:
        'This vertical has no approved template layouts, so there is nothing for a ' +
        'sheet to name. Upload a reference poster and approve its layout first.',
    };
  }

  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return { error: `Template name is required. Valid names: ${index.validNames}` };
  }

  const matches = index.byName.get(normalizeTemplateLabel(trimmed));
  if (!matches || matches.length === 0) {
    return {
      error:
        `Template "${truncate(trimmed, 40)}" is not an approved template for this ` +
        `vertical. Valid names: ${index.validNames}`,
    };
  }

  if (matches.length > 1) {
    return {
      error:
        `Template name "${truncate(trimmed, 40)}" matches ${matches.length} templates ` +
        'in this vertical. Rename one in the template library so a sheet can tell them apart.',
    };
  }

  return { id: matches[0] as string };
}

// ---------------------------------------------------------------------------
// Parse results
// ---------------------------------------------------------------------------

export interface ParsedImportRow extends CalendarImportRow {
  /** 1-based source line (CSV) or element index (JSON), for error copy. */
  line: number;
  /** Empty when the row is importable exactly as it stands. */
  issues: string[];
  /**
   * The template `templateName` resolved to, or null when it did not resolve.
   *
   * Preview-only and deliberately NOT on the wire schema: the browser's
   * catalogue is a snapshot, so the server resolves the name again against a
   * fresh read rather than trusting an id it was handed.
   */
  templateId: string | null;
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
  options: { maxDay: number; templates: readonly ImportTemplate[] },
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

  return finalize(parsed, options);
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
        templateName: '',
        caption: '',
        hashtags: '',
        imagePrompt: '',
        backgroundPrompt: null,
        poster: null,
        issues: ['Entry is not an object'],
        templateId: null,
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

  const templateName = read('templateName');
  const caption = read('caption');
  const hashtags = normalizeHashtags(read('hashtags'));
  const imagePrompt = read('imagePrompt');
  // Empty means "no backdrop", not "invalid row": the column is optional and the
  // renderer degrades to `blob` without it.
  const backgroundPromptCell = read('backgroundPrompt');
  const backgroundPrompt = backgroundPromptCell.length > 0 ? backgroundPromptCell : null;

  // Length only. Whether the name is empty or unknown is settled in `finalize`,
  // where the catalogue is in hand, so exactly one place composes the sentence
  // that lists the valid names.
  if (templateName.length > IMPORT_FIELD_LIMITS.templateName.max) {
    issues.push(`Template name exceeds ${IMPORT_FIELD_LIMITS.templateName.max} characters`);
  }
  checkLength(issues, 'Caption', caption, IMPORT_FIELD_LIMITS.caption);
  checkLength(issues, 'Image prompt', imagePrompt, IMPORT_FIELD_LIMITS.imagePrompt);
  if (backgroundPrompt !== null) {
    checkLength(issues, 'Background prompt', backgroundPrompt, IMPORT_FIELD_LIMITS.imagePrompt);
  }

  if (hashtags.length > IMPORT_FIELD_LIMITS.hashtags.max) {
    issues.push(`Hashtags exceed ${IMPORT_FIELD_LIMITS.hashtags.max} characters`);
  }

  const poster =
    nestedPoster !== null
      ? readNestedPoster(nestedPoster, issues)
      : readPosterCells(read, issues);

  return {
    line,
    dayNumber,
    templateName,
    caption,
    hashtags,
    imagePrompt,
    backgroundPrompt,
    poster,
    issues,
    // Filled by `finalize`, which holds the catalogue.
    templateId: null,
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
  const ctaLabel = read('ctaLabel');
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
    [
      headlineRaw,
      posterBody,
      eyebrow,
      ctaLabel,
      callLabel,
      websiteLabel,
      periodRaw,
      accentRaw,
    ].some((cell) => cell.length > 0) ||
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

  /*
   * A row may carry no features at all, but not one of them half-written.
   *
   * Seven of the Constructions templates draw none, so demanding two there asks
   * an operator to write words that land nowhere. A row that touched a feature
   * cell and got it wrong is still an error — the difference is between "this
   * design has no features" and "I started one and stopped".
   */
  const touchedAnyFeature = featureCells.some((cell) => cell.icon || cell.label || cell.body);
  if (touchedAnyFeature && features.length < FEATURES.min) {
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
  if (ctaLabel.length > IMPORT_FIELD_LIMITS.ctaLabel.max) {
    issues.push(`CTA label exceeds ${IMPORT_FIELD_LIMITS.ctaLabel.max} characters`);
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
  const copy = coercePosterCopy(
    {
      headlineLines,
      accentLineIndex,
      eyebrow,
      body: posterBody,
      features,
      /*
       * Omitting this is what made every hand-authored poster say "LEARN MORE".
       *
       * `coercePosterCopy` falls through to the schema default when the key is
       * absent, so an operator who typed a call to action into the sheet had it
       * silently replaced by the default on the way to the database — and the
       * templates that draw a CTA are exactly the ones where that line is the ask.
       * Empty is still allowed: it falls through to the default as before.
       */
      ...(ctaLabel.length > 0 ? { ctaLabel } : {}),
      callLabel,
      websiteLabel,
      headlinePeriod: headlinePeriod === true,
    },
    { allowNoFeatures: !touchedAnyFeature },
  );

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
function finalize(
  parsed: CalendarImportParse,
  options: { maxDay: number; templates: readonly ImportTemplate[] },
): CalendarImportParse {
  const seen = new Map<number, number>();
  // Built once per sheet, not once per row. A 400-row import against a
  // 100-template vertical would otherwise rebuild the same index 400 times —
  // the same waste the `columnIndex` map further up exists to avoid.
  const index = buildTemplateIndex(options.templates);

  const rows = parsed.rows.map((row) => {
    const issues = [...row.issues];

    // Runs for every row, including one with no day number: a bad template name
    // is worth reporting whether or not the day resolved.
    const resolved = resolveTemplateName(row.templateName, index);
    const templateId = 'id' in resolved ? resolved.id : null;
    if ('error' in resolved) issues.push(resolved.error);

    if (row.dayNumber !== null) {
      if (row.dayNumber > options.maxDay) {
        issues.push(`Day ${row.dayNumber} is past the plan's ${options.maxDay}-day duration`);
      }

      const firstLine = seen.get(row.dayNumber);
      if (firstLine === undefined) {
        seen.set(row.dayNumber, row.line);
      } else {
        issues.push(`Day ${row.dayNumber} is already used on line ${firstLine}`);
      }
    }

    return issues.length === row.issues.length && templateId === row.templateId
      ? row
      : { ...row, issues, templateId };
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
 *
 * The template-name cell is filled from the vertical's *own* approved templates
 * rather than a fixed sample value. Under the strict rule a hard-coded name is
 * guaranteed to be rejected, so a downloaded sheet would fail on every row — and
 * generating it from the catalogue both makes the file importable as it stands
 * and shows the operator the exact spelling to copy, which is the best defence
 * there is against the strict rule feeling arbitrary.
 */
/**
 * Skeleton for the two example days, minus everything industry-specific.
 *
 * The caption, hashtags and image prompt are composed per vertical by
 * `sampleRowsFor` below. What stays fixed is the poster block, because its rules
 * are structural rather than editorial — the headline is 2-4 hand-broken lines,
 * the accent line is 1-based, features are parallel noun phrases — and those
 * read the same in any industry.
 */
const TEMPLATE_SKELETON = [
  {
    day: '1',
    headline: 'BUILT FOR | WHAT YOU | ACTUALLY DO',
    accentLine: '2',
    eyebrow: 'NOW BOOKING',
    posterBody:
      'One short paragraph in sentence case. Three to five lines when it is typeset, so keep it under about forty words.',
    features: [
      { icon: 'shieldCheck', label: 'First benefit', body: 'One short sentence saying what the client gets.' },
      { icon: 'stopwatch', label: 'Second benefit', body: 'Labels read as parallel noun phrases, not sentences.' },
      { icon: 'award', label: 'Third benefit', body: 'Three items is the count most layouts are built for.' },
      { icon: 'people', label: 'Fourth benefit', body: 'Four is what most of the library actually draws.' },
    ],
    ctaLabel: 'BOOK AN APPOINTMENT',
    callLabel: 'CALL US TODAY',
    websiteLabel: 'VISIT OUR WEBSITE',
    headlinePeriod: 'yes',
  },
  {
    day: '2',
    headline: 'THE DETAIL | NOBODY ELSE | CHECKS',
    accentLine: '2',
    eyebrow: '',
    posterBody:
      'A second example, with the eyebrow left blank and no full stop on the headline. Both are optional.',
    features: [
      { icon: 'award', label: 'Proof point', body: 'Something specific enough to be checked.' },
      { icon: 'people', label: 'Who does it', body: 'The person or team behind the promise.' },
      { icon: 'star', label: 'What it means', body: 'The outcome the reader actually cares about.' },
      { icon: 'handshake', label: 'Why you', body: 'Left blank on a template that draws only three.' },
    ],
    ctaLabel: 'TALK TO US TODAY',
    callLabel: 'TALK TO OUR TEAM',
    websiteLabel: 'VISIT OUR WEBSITE',
    headlinePeriod: 'no',
  },
] as const;

/**
 * The two example days, written for the vertical the sheet is being downloaded
 * for.
 *
 * These used to be two fully-worked construction days, sent to every vertical.
 * That is precisely the defect `vertical-vocabulary.ts` was written to fix for
 * the photo brief — "a dental clinic was briefed as a building site" — and it
 * had simply reappeared here. A café operator downloading a sheet about
 * pre-monsoon drainage audits reasonably concludes the tool is broken, and one
 * who imports it unchanged sends their customers a WhatsApp about silt traps.
 *
 * The caption and hashtags are now self-describing placeholders rather than
 * plausible prose. That is deliberate: a sample sheet has to survive being
 * imported as-is, and a day whose caption reads "replace this" is obviously
 * wrong in the ledger, where a fluent caption for the wrong industry is not.
 *
 * The image prompt stays a genuinely worked example, because it is the one field
 * whose rules cannot be guessed — no text or logos in frame, and the subject
 * pushed aside to reserve a low-detail region for the type. It is built from the
 * vertical's own subject and lighting vocabulary so the example is copyable
 * rather than merely illustrative.
 */
function sampleRowsFor(categoryName: string | null | undefined) {
  const imagery = verticalImageryFor(categoryName);
  const subjects = imagery.subjects.split(',').map((subject) => subject.trim());
  const industry = (categoryName ?? 'your industry').trim() || 'your industry';

  const prompts = [
    `${subjects[0] ?? 'the product or service in use'}, subject grouped to the lower right, ` +
      `an unbroken low-detail area filling the upper left for the poster type to sit on, ` +
      `${imagery.lighting.split('.')[0] ?? 'natural light'}, no text, letters or logos anywhere in frame`,
    `${subjects[1] ?? 'a close detail of the tools of the trade'}, held tight to the right edge of ` +
      `the frame with the left two thirds left deliberately empty, shallow depth of field, ` +
      `${imagery.lighting.split('.')[0] ?? 'natural light'}, no text, letters or logos anywhere in frame`,
  ];

  return TEMPLATE_SKELETON.map((row, index) => ({
    ...row,
    caption:
      `Replace this with the caption sent alongside day ${row.day}'s poster. It is the ` +
      `WhatsApp message body, so write it for a reader rather than for the poster — ` +
      `10 to 2000 characters. This example row is for ${industry}.`,
    hashtags: '#replace #these #tags',
    imagePrompt: prompts[index] ?? (prompts[0] as string),
  }));
}

/** RFC-4180 quoting: wrap in quotes and double any quote inside. */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function buildTemplate(
  templates: readonly ImportTemplate[],
  categoryName: string | null | undefined,
  maxRows: number,
  includePoster: boolean,
): string {
  const header = includePoster
    ? [...Object.values(CONTENT_COLUMN_LABELS), ...POSTER_COLUMN_LABELS]
    : Object.values(CONTENT_COLUMN_LABELS);

  /*
   * One row per approved template, not two rows for the whole vertical.
   *
   * The sheet used to be a fixed pair of example days, so a vertical with five
   * approved layouts demonstrated two of them and the other three appeared
   * nowhere — an operator adding a template had no way to learn its name from
   * the file that exists to teach them the names.
   *
   * Bounded by the plan's duration as well as by the library, because a day
   * number past `durationDays` is rejected on import: a seventeen-template
   * vertical on a seven-day plan would otherwise emit a sheet that cannot be
   * imported, which is worse than one that omits a name. Where the two collide
   * the console's own list is the complete reference.
   *
   * Floors at two so a single-template vertical still shows the eyebrow-present
   * and eyebrow-absent variants that the second skeleton exists to demonstrate.
   */
  const rowCount = Math.max(2, Math.min(templates.length, Math.max(1, maxRows)));
  const samples = sampleRowsFor(categoryName);

  const nameFor = (index: number): string =>
    templates[index % Math.max(1, templates.length)]?.label ?? 'NAME AN APPROVED TEMPLATE HERE';

  const lines = Array.from({ length: rowCount }, (_, index) => {
    // The two skeletons cycle under however many templates there are.
    const row = { ...samples[index % samples.length]!, day: String(index + 1) };
    /*
     * Six values for six headers.
     *
     * `background prompt` was in `CONTENT_COLUMN_LABELS` and missing from here,
     * which is harmless in the content-only sheet — a trailing empty column —
     * and quietly ruinous in the poster one: every poster value shifted a column
     * left, so `headline` landed under `background prompt`, `accent line` under
     * `headline`, and `headline period` under `website label`. A sheet
     * downloaded from the console and re-imported unchanged misparsed.
     */
    const content = [
      row.day,
      nameFor(index),
      row.caption,
      row.hashtags,
      row.imagePrompt,
      '',
    ];
    if (!includePoster) return content.map(csvCell).join(',');

    const poster = [
      row.headline,
      row.accentLine,
      row.eyebrow,
      row.posterBody,
      ...row.features.flatMap((feature) => [feature.icon, feature.label, feature.body]),
      row.ctaLabel,
      row.callLabel,
      row.websiteLabel,
      row.headlinePeriod,
    ];
    return [...content, ...poster].map(csvCell).join(',');
  });

  // CRLF and no trailing comment rows: the parser has no comment syntax, so a
  // `#`-prefixed note would come back as a broken entry.
  return [header.map(csvCell).join(','), ...lines].join('\r\n');
}

/**
 * Content columns only — the day, the template name and the three copy fields.
 *
 * A function rather than a constant because the sheet now has to name templates
 * that exist, and which those are depends on the vertical the operator is
 * downloading for.
 */
export function buildCalendarImportTemplate(
  templates: readonly ImportTemplate[],
  categoryName: string | null | undefined,
  maxRows: number,
): string {
  return buildTemplate(templates, categoryName, maxRows, false);
}

/** Content columns plus the whole hand-authored poster text layer. */
export function buildCalendarImportTemplateFull(
  templates: readonly ImportTemplate[],
  categoryName: string | null | undefined,
  maxRows: number,
): string {
  return buildTemplate(templates, categoryName, maxRows, true);
}
