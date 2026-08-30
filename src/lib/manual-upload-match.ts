import { z } from 'zod';

import { normalizeHashtags } from '@/lib/calendar-parse';

/**
 * The lightweight caption sheet for manually-uploaded posters, and the rule that
 * pairs one of its rows with one uploaded image.
 *
 * **Why this is a second sheet format rather than a column on the first.** The
 * bulk importer's sheet (`calendar-parse.ts`) describes work the pipeline is
 * about to do: it names a template to lay out, a photograph to synthesise, and
 * optionally the typography to set. None of that applies here. A manual upload
 * is a poster somebody already finished in a design tool; the only thing still
 * missing is the words WhatsApp sends beside it. So the sheet carries exactly
 * three columns — `day`, `caption`, `hashtags` — and asking an operator to fill
 * a template name and an image brief for a file that will never be rendered
 * would be asking them to lie to the importer.
 *
 * `calendar-parse.ts` is deliberately not touched by any of this, which is why
 * the tokenizer below is its own rather than an export borrowed from there. The
 * duplication is the price of being able to prove the existing importer is
 * untouched with `git diff`, and it is a fair one: this reader has no poster
 * columns, no JSON envelope, and no template resolution, so it is a fraction of
 * the size.
 *
 * Isomorphic, exactly like `calendar-parse`: the panel parses in the browser so
 * every mismatch is visible *before* anything is written, and the server action
 * re-validates the same rows against the same schema. Nothing here may import
 * Prisma or any other server-only code.
 *
 * **The join key is the filename.** An image is `day-1.png`; the sheet row that
 * describes it says `1` in its `day` column. Nothing else connects the two —
 * upload order is not a contract, and neither is the order rows appear in the
 * sheet. That makes both failure directions explicit and reportable: an image
 * with no row, and a row with no image. Neither is scheduled.
 */

// ---------------------------------------------------------------------------
// Field contract
// ---------------------------------------------------------------------------

export const MANUAL_FIELD_LIMITS = {
  /** Matches `ContentCalendar.caption`, which is unbounded TEXT in Postgres. */
  caption: { min: 1, max: 2_000 },
  hashtags: { max: 400 },
} as const;

/** The longest plan runs 365 days; the slack absorbs a few stray sheet rows. */
export const MANUAL_ROW_LIMIT = 400;

/** Guards against someone dropping a spreadsheet export of the wrong thing. */
export const MANUAL_SHEET_MAX_BYTES = 500_000;

/**
 * Images per batch.
 *
 * Well above a 365-day campaign's worth of open days in practice, and low enough
 * that a mis-click on a photo library does not try to upload ten thousand files
 * one server action at a time.
 */
export const MANUAL_IMAGE_LIMIT = 400;

/** Formats a finished poster may arrive in. Mirrors the template uploader. */
export const MANUAL_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

/**
 * Per-file ceiling.
 *
 * Under the 8 MB Server Action body limit configured in `next.config.mjs`, with
 * room for the multipart envelope — each image is uploaded in its own action
 * call, so this is the whole body rather than a share of one.
 */
export const MANUAL_IMAGE_MAX_BYTES = 6 * 1024 * 1024;

export const manualSheetRowSchema = z.object({
  /**
   * The `day-N` label this row describes, taken from the sheet's `day` column.
   *
   * **Not a calendar day number and not a scheduling instruction.** It is one
   * half of a join key; the other half is the filename. Which actual campaign
   * day a matched pair lands on is decided later, by walking the client's open
   * delivery days in ascending label order — see `manual-upload-schedule.ts`.
   */
  day: z.number().int().min(1).max(3650),
  caption: z
    .string()
    .trim()
    .min(MANUAL_FIELD_LIMITS.caption.min, 'Caption is required')
    .max(MANUAL_FIELD_LIMITS.caption.max, 'Caption is too long'),
  /**
   * Optional, and normalised through the importer's own rule so a manually
   * uploaded day's tags read identically to an imported one's — bare words get
   * their `#`, duplicates collapse, separators become single spaces.
   */
  hashtags: z
    .string()
    .trim()
    .max(MANUAL_FIELD_LIMITS.hashtags.max, 'Hashtags are too long')
    .default(''),
});

export type ManualSheetRow = z.infer<typeof manualSheetRowSchema>;

// ---------------------------------------------------------------------------
// Column recognition
// ---------------------------------------------------------------------------

type ManualColumn = 'day' | 'caption' | 'hashtags';

/** Canonical spelling of each column, in template order. */
export const MANUAL_COLUMN_LABELS: Record<ManualColumn, string> = {
  day: 'day',
  caption: 'caption',
  hashtags: 'hashtags',
};

/** Without these a row cannot be paired with an image or sent. */
const MANUAL_REQUIRED_COLUMNS: ManualColumn[] = ['day', 'caption'];

/**
 * Header spellings accepted, keyed by the normalised form (lowercased, with
 * every non-alphanumeric character stripped) so "Day No", "day_number" and
 * "DayNumber" all land on the same column.
 */
const MANUAL_HEADER_ALIASES: Record<string, ManualColumn> = {
  day: 'day',
  daynumber: 'day',
  dayno: 'day',
  daynum: 'day',
  filename: 'day',
  file: 'day',
  image: 'day',
  poster: 'day',
  sno: 'day',
  srno: 'day',

  caption: 'caption',
  copy: 'caption',
  postcopy: 'caption',
  posttext: 'caption',
  message: 'caption',

  hashtags: 'hashtags',
  hashtag: 'hashtags',
  tags: 'hashtags',
};

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ---------------------------------------------------------------------------
// Filenames
// ---------------------------------------------------------------------------

/**
 * The filename shape an uploaded poster must carry.
 *
 * Tolerant about the things an operating system decides for you — case, and
 * whether the separator survived as `-`, `_`, a space or nothing — and strict
 * about everything else. `Day 3.PNG` is day 3; `day-3 (1).png` is not, because a
 * duplicated download is exactly the file somebody uploads by accident and
 * silently treating it as day 3 would overwrite the real one's pairing.
 *
 * Leading zeros are accepted and dropped, so `day-01` and `day-1` are the same
 * day — a sheet cannot spell a number two ways, and neither should a filename.
 */
const DAY_FILENAME = /^day[\s._-]*(\d{1,4})$/i;

/** The name with its extension removed, which is what the pattern matches. */
export function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '').trim();
}

/**
 * The day label an uploaded file claims, or null when its name does not say.
 *
 * Null is a reportable error rather than a fallback: there is no correct guess
 * for "which day is `final_v2_FINAL.png`", and assigning one would put an
 * unreviewed pairing into a campaign.
 */
export function readDayFromFileName(fileName: string): number | null {
  const match = DAY_FILENAME.exec(stripExtension(fileName));
  if (!match?.[1]) return null;

  const day = Number.parseInt(match[1], 10);
  return Number.isInteger(day) && day >= 1 && day <= 3650 ? day : null;
}

// ---------------------------------------------------------------------------
// Sheet parsing
// ---------------------------------------------------------------------------

/** One sheet row that could not be read, and the reason. */
export interface ManualSheetProblem {
  /** 1-based line in the pasted text, so the operator can find it. */
  line: number;
  /** The day value read, when one was legible. */
  day: number | null;
  issue: string;
}

export interface ManualSheetParse {
  /** Rows that validated. */
  rows: ManualSheetRow[];
  /** Rows that did not, each with the reason. Never scheduled. */
  problems: ManualSheetProblem[];
  /** Set when nothing could be read at all; `rows` is then empty. */
  error: string | null;
  /** Delimiter that won the header sniff, for the panel's status line. */
  delimiter: 'comma' | 'tab' | 'semicolon' | null;
  /** Recognised-but-unused header names, surfaced so typos are noticeable. */
  ignoredColumns: string[];
  /** True when the sheet carried more than `MANUAL_ROW_LIMIT` data rows. */
  truncated: boolean;
}

const EMPTY_SHEET: Omit<ManualSheetParse, 'error'> = {
  rows: [],
  problems: [],
  delimiter: null,
  ignoredColumns: [],
  truncated: false,
};

function fatal(error: string): ManualSheetParse {
  return { ...EMPTY_SHEET, error };
}

const DELIMITERS: Array<{
  char: string;
  name: NonNullable<ManualSheetParse['delimiter']>;
}> = [
  { char: ',', name: 'comma' },
  { char: '\t', name: 'tab' },
  { char: ';', name: 'semicolon' },
];

interface RawRecord {
  line: number;
  fields: string[];
}

/**
 * Reads the lightweight caption sheet.
 *
 * CSV, TSV or semicolon-separated. Unlike the bulk importer this accepts no JSON
 * envelope: that path exists there so the calendar generator's own output can be
 * pasted back after editing, and nothing generates this sheet.
 */
export function parseManualSheet(raw: string): ManualSheetParse {
  // Excel and Google Sheets both prepend a BOM to CSV exports, which would
  // otherwise glue itself to the first header cell and break its alias lookup.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  // Blank input is the panel's resting state, not a mistake worth reporting.
  if (text.trim().length === 0) return { ...EMPTY_SHEET, error: null };

  // Sniff on the head of the file only. Counting delimiters across the whole
  // text would pick comma over tab for any TSV whose captions contain commas.
  const head = text.slice(0, 4_000);

  let best:
    | { char: string; name: NonNullable<ManualSheetParse['delimiter']>; score: number }
    | null = null;

  for (const candidate of DELIMITERS) {
    const header = splitRecords(head, candidate.char).find(hasContent);
    if (!header) continue;

    const matched = new Set(
      header.fields
        .map((cell) => MANUAL_HEADER_ALIASES[normalizeHeader(cell)])
        .filter((column): column is ManualColumn => column !== undefined),
    );

    if (best === null || matched.size > best.score) {
      best = { char: candidate.char, name: candidate.name, score: matched.size };
    }
  }

  // Two recognised columns is the floor, and here it is also the requirement:
  // `day` and `caption` are both mandatory, so one lucky hit cannot be enough.
  if (best === null || best.score < 2) {
    return fatal(
      `No header row recognised. The first line must name the columns — ${Object.values(
        MANUAL_COLUMN_LABELS,
      ).join(', ')} — in any order.`,
    );
  }

  const records = splitRecords(text, best.char).filter(hasContent);
  const header = records[0];
  if (!header) return fatal('The sheet has a header row but no content rows.');

  const columns = header.fields.map(
    (cell) => MANUAL_HEADER_ALIASES[normalizeHeader(cell)] ?? null,
  );
  const present = new Set(columns.filter((column): column is ManualColumn => column !== null));

  const missing = MANUAL_REQUIRED_COLUMNS.filter((column) => !present.has(column));
  if (missing.length > 0) {
    return fatal(
      `Missing required column${missing.length === 1 ? '' : 's'}: ${missing
        .map((column) => MANUAL_COLUMN_LABELS[column])
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

  // Precomputed so a 400-row sheet does not run indexOf per cell per row.
  const columnIndex = new Map<ManualColumn, number>();
  columns.forEach((column, index) => {
    if (column !== null && !columnIndex.has(column)) columnIndex.set(column, index);
  });

  const rows: ManualSheetRow[] = [];
  const problems: ManualSheetProblem[] = [];
  /*
   * A day may be described once.
   *
   * Two rows claiming day 4 means the operator wrote two captions for one
   * poster. The first keeps the day and the second is reported by line number,
   * which is the same rule the matcher applies to two files claiming one day —
   * refusing both instead would throw away a usable pairing over a stray
   * duplicate, and the confirm screen shows the refusal either way.
   */
  const seen = new Map<number, number>();

  for (const record of dataRecords.slice(0, MANUAL_ROW_LIMIT)) {
    const read = (column: ManualColumn): string => {
      const index = columnIndex.get(column);
      return index === undefined ? '' : (record.fields[index] ?? '').trim();
    };

    const rawDay = read('day');
    const day = readDayCell(rawDay);
    if (day === null) {
      problems.push({
        line: record.line,
        day: null,
        issue:
          rawDay.length === 0
            ? 'the day column is blank — every row must say which day-N image it describes'
            : `"${rawDay}" is not a day number. Write the number alone (4), or the filename form (day-4).`,
      });
      continue;
    }

    const firstLine = seen.get(day);
    if (firstLine !== undefined) {
      problems.push({
        line: record.line,
        day,
        issue: `day ${day} is already described on line ${firstLine}. A day may appear once.`,
      });
      continue;
    }

    const parsed = manualSheetRowSchema.safeParse({
      day,
      caption: read('caption'),
      hashtags: read('hashtags'),
    });

    if (!parsed.success) {
      problems.push({
        line: record.line,
        day,
        issue:
          parsed.error.issues.map((issue) => issue.message).join('; ') || 'the row is not usable',
      });
      continue;
    }

    seen.set(day, record.line);
    rows.push({ ...parsed.data, hashtags: normalizeHashtags(parsed.data.hashtags) });
  }

  return {
    rows,
    problems,
    error: null,
    delimiter: best.name,
    ignoredColumns,
    truncated: dataRecords.length > MANUAL_ROW_LIMIT,
  };
}

/**
 * Reads the `day` cell, which may be written either way.
 *
 * `4` is the obvious spelling and `day-4` is the one an operator reaches for
 * after naming four hundred files that way. Both mean the same day; anything
 * else — a date, a blank, a caption that slid a column left — is null and is
 * reported rather than coerced.
 */
function readDayCell(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  if (/^\d{1,4}$/.test(trimmed)) {
    const value = Number.parseInt(trimmed, 10);
    return value >= 1 && value <= 3650 ? value : null;
  }

  return readDayFromFileName(trimmed);
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
// Matching
// ---------------------------------------------------------------------------

/** One image and the sheet row that describes it. */
export interface ManualPair {
  /** The `day-N` label both halves agreed on. Decides scheduling order. */
  day: number;
  fileName: string;
  caption: string;
  hashtags: string;
}

/** An uploaded image that will not be scheduled, and why. */
export interface UnmatchedImage {
  fileName: string;
  /** The day its name claimed, or null when the name could not be read. */
  day: number | null;
  reason: string;
}

/** A sheet row that will not be scheduled, and why. */
export interface UnmatchedRow {
  day: number;
  caption: string;
  reason: string;
}

export interface ManualMatch {
  /** Fully matched pairs, in ascending day order — the scheduling order. */
  pairs: ManualPair[];
  unmatchedImages: UnmatchedImage[];
  unmatchedRows: UnmatchedRow[];
}

/**
 * Pairs uploaded filenames with sheet rows by their `day-N` label.
 *
 * Pure: names and rows in, three lists out. No database, no Drive, no clock —
 * which is what lets the browser show the operator the same answer the server
 * will compute, before anything is written.
 *
 * Every input ends up in exactly one of the three lists. That total is the
 * property the confirm screen depends on: an operator who uploaded twelve images
 * and a twelve-row sheet must be able to see, without counting, that all
 * twenty-four inputs were accounted for.
 */
export function matchManualUploads(
  fileNames: readonly string[],
  rows: readonly ManualSheetRow[],
): ManualMatch {
  const pairs: ManualPair[] = [];
  const unmatchedImages: UnmatchedImage[] = [];
  const unmatchedRows: UnmatchedRow[] = [];

  const rowByDay = new Map(rows.map((row) => [row.day, row]));
  /** Which file already claimed a day, so a second one can name the first. */
  const claimedBy = new Map<number, string>();
  const pairedDays = new Set<number>();

  for (const fileName of fileNames) {
    const day = readDayFromFileName(fileName);

    if (day === null) {
      unmatchedImages.push({
        fileName,
        day: null,
        reason:
          'the filename does not say which day this is. Rename it day-1, day-2, day-3 … so it ' +
          'can be paired with a row in the sheet.',
      });
      continue;
    }

    /*
     * Two files for one day.
     *
     * Usually `day-3.png` beside `day-3.jpg`, or a re-export that kept the name.
     * Refusing both would throw away a good pairing over a stray duplicate, so
     * the first file in the selection keeps the day and the later one is
     * reported by name — the operator can see exactly which file was left out
     * and remove it.
     */
    const claimed = claimedBy.get(day);
    if (claimed !== undefined) {
      unmatchedImages.push({
        fileName,
        day,
        reason: `day ${day} was already taken by "${claimed}". Only one image per day.`,
      });
      continue;
    }
    claimedBy.set(day, fileName);

    const row = rowByDay.get(day);
    if (!row) {
      unmatchedImages.push({
        fileName,
        day,
        reason: `the sheet has no row for day ${day}, so there is no caption to send with it.`,
      });
      continue;
    }

    pairedDays.add(day);
    pairs.push({
      day,
      fileName,
      caption: row.caption,
      hashtags: row.hashtags,
    });
  }

  for (const row of rows) {
    if (pairedDays.has(row.day)) continue;
    unmatchedRows.push({
      day: row.day,
      caption: row.caption,
      reason: `no image named day-${row.day} was uploaded, so there is nothing to send.`,
    });
  }

  // Ascending day order is the contract the scheduler is written against:
  // day-1 takes the soonest open delivery day, day-2 the next, and so on.
  pairs.sort((a, b) => a.day - b.day);
  unmatchedRows.sort((a, b) => a.day - b.day);

  return { pairs, unmatchedImages, unmatchedRows };
}
