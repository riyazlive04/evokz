import ExcelJS from 'exceljs';

import { STUDIO_FESTIVALS } from '@/lib/poster-studio/festivals';
import {
  MAX_STUDIO_PROMPT_LENGTH,
  MIN_STUDIO_PROMPT_LENGTH,
  STUDIO_ASPECT_RATIO_KEYS,
  STUDIO_QUALITIES,
  type StudioAspectRatio,
  type StudioQuality,
} from '@/lib/poster-studio/limits';

/**
 * Reads a bulk Poster Studio sheet: one row per image, **Day** and **Prompt**
 * required, optional per-row Aspect ratio, Festival, Text free and Quality.
 *
 * Accepts .xlsx (the first worksheet) and .csv. Headers are matched by alias,
 * lower-cased with punctuation removed, so "Image prompt", "PROMPT" and
 * "prompt:" are one column. Blank rows are skipped. Every problem names its row
 * as the operator sees it in the sheet (header = row 1), and a row with a
 * problem is left out rather than guessed at.
 *
 * Pure apart from exceljs; no database. Server-only (exceljs is not bundled
 * for the browser).
 */

export const MAX_BATCH_ROWS = 200;
export const MAX_BATCH_FILE_BYTES = 2 * 1024 * 1024;

export interface BatchSheetRow {
  /** Order in the sheet among kept rows, from 1. */
  position: number;
  /** Row number in the sheet (header is 1), for messages. */
  sheetRow: number;
  dayLabel: string;
  /** "12", "Day 12" or 12 → 12; anything else → null. */
  dayNumber: number | null;
  prompt: string;
  aspectRatio: StudioAspectRatio | null;
  festival: string | null;
  textFree: boolean | null;
  quality: StudioQuality | null;
}

export interface BatchSheetProblem {
  /** Null for a problem with the file itself. */
  sheetRow: number | null;
  message: string;
}

export interface BatchSheetResult {
  rows: BatchSheetRow[];
  problems: BatchSheetProblem[];
}

type Column = 'day' | 'prompt' | 'aspectRatio' | 'festival' | 'textFree' | 'quality';

const HEADER_ALIASES: Record<Column, string[]> = {
  day: ['day', 'dayno', 'daynumber', 'date', 'daylabel', 'dayname'],
  prompt: ['prompt', 'imageprompt', 'posterprompt', 'brief', 'posterbrief', 'description', 'text'],
  aspectRatio: ['aspectratio', 'aspect', 'ratio', 'format', 'size'],
  festival: ['festival', 'occasion', 'festivalname'],
  textFree: ['textfree', 'notext', 'textfreeartwork'],
  quality: ['quality'],
};

const normalizeHeader = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
const normalizeValue = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Parses the uploaded bytes by file name: .xlsx through exceljs, .csv as text. */
export async function parseBatchSheet(bytes: Buffer, fileName: string): Promise<BatchSheetResult> {
  if (bytes.length === 0) return fileProblem('The file is empty.');
  if (bytes.length > MAX_BATCH_FILE_BYTES) {
    return fileProblem(`The file is ${(bytes.length / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_BATCH_FILE_BYTES / 1024 / 1024} MB.`);
  }
  const lower = fileName.toLowerCase();
  let table: string[][];
  if (lower.endsWith('.csv')) {
    table = parseCsv(bytes.toString('utf8'));
  } else if (lower.endsWith('.xlsx')) {
    try {
      table = await readXlsx(bytes);
    } catch {
      return fileProblem('This file could not be read as an Excel workbook. Save it as .xlsx (or .csv) and upload it again.');
    }
  } else {
    return fileProblem('Upload an Excel .xlsx file or a .csv file.');
  }
  return parseBatchTable(table);
}

/** The table form of the sheet, header first. Exported for the pure check suite. */
export function parseBatchTable(table: string[][]): BatchSheetResult {
  const problems: BatchSheetProblem[] = [];
  const headerIndex = table.findIndex((row) => row.some((cell) => cell.trim() !== ''));
  if (headerIndex === -1) return fileProblem('The sheet has no rows.');

  const header = table[headerIndex]!;
  const columns = new Map<Column, number>();
  header.forEach((cell, index) => {
    const key = normalizeHeader(cell);
    if (!key) return;
    for (const [column, aliases] of Object.entries(HEADER_ALIASES) as Array<[Column, string[]]>) {
      if (aliases.includes(key) && !columns.has(column)) columns.set(column, index);
    }
  });
  const missing = (['day', 'prompt'] as const).filter((column) => !columns.has(column));
  if (missing.length > 0) {
    return fileProblem(
      `The first row must name the columns. Missing: ${missing.map((column) => (column === 'day' ? '"Day"' : '"Prompt"')).join(' and ')}. Download the template to see the layout.`,
    );
  }

  const rows: BatchSheetRow[] = [];
  const cell = (row: string[], column: Column) => {
    const index = columns.get(column);
    return index === undefined ? '' : (row[index] ?? '').trim();
  };

  for (let index = headerIndex + 1; index < table.length; index += 1) {
    const row = table[index]!;
    const sheetRow = index + 1;
    if (row.every((value) => value.trim() === '')) continue;

    const dayLabel = cell(row, 'day');
    const prompt = cell(row, 'prompt').replace(/\r\n/g, '\n');
    const rowProblems: string[] = [];
    if (!dayLabel) rowProblems.push('the Day is empty');
    if (dayLabel.length > 60) rowProblems.push('the Day is longer than 60 characters');
    if (prompt.length < MIN_STUDIO_PROMPT_LENGTH) rowProblems.push('the Prompt is empty or too short');
    if (prompt.length > MAX_STUDIO_PROMPT_LENGTH) {
      rowProblems.push(`the Prompt is longer than ${MAX_STUDIO_PROMPT_LENGTH.toLocaleString('en-IN')} characters`);
    }

    const aspectCell = cell(row, 'aspectRatio');
    const aspectRatio = aspectCell ? parseAspect(aspectCell) : null;
    if (aspectCell && !aspectRatio) {
      rowProblems.push(`the Aspect ratio "${aspectCell}" is not one of ${STUDIO_ASPECT_RATIO_KEYS.join(', ')}`);
    }
    const festivalCell = cell(row, 'festival');
    const festival = festivalCell ? matchFestival(festivalCell) : null;
    if (festivalCell && !festival) rowProblems.push(`the Festival "${festivalCell}" is not in the festival list`);
    const textFreeCell = cell(row, 'textFree');
    const textFree = textFreeCell ? parseYesNo(textFreeCell) : null;
    if (textFreeCell && textFree === null) rowProblems.push(`Text free "${textFreeCell}" should be Yes or No`);
    const qualityCell = cell(row, 'quality');
    const quality = qualityCell ? parseQuality(qualityCell) : null;
    if (qualityCell && !quality) rowProblems.push(`the Quality "${qualityCell}" should be Low, Medium or High`);

    if (rowProblems.length > 0) {
      problems.push({ sheetRow, message: `Row ${sheetRow}: ${rowProblems.join('; ')}.` });
      continue;
    }
    if (rows.length >= MAX_BATCH_ROWS) {
      problems.push({ sheetRow, message: `Row ${sheetRow} and after: a batch holds at most ${MAX_BATCH_ROWS} rows. Split the sheet.` });
      break;
    }
    rows.push({
      position: rows.length + 1,
      sheetRow,
      dayLabel,
      dayNumber: parseDayNumber(dayLabel),
      prompt,
      aspectRatio,
      festival,
      textFree,
      quality,
    });
  }

  if (rows.length === 0 && problems.length === 0) problems.push({ sheetRow: null, message: 'The sheet has a header but no rows.' });
  return { rows, problems };
}

export function parseDayNumber(label: string): number | null {
  const match = /^\s*(?:day\s*)?(\d{1,4})\s*$/i.exec(label);
  if (!match) return null;
  const value = Number.parseInt(match[1]!, 10);
  return value >= 1 ? value : null;
}

function parseAspect(value: string): StudioAspectRatio | null {
  const compact = value.trim().toLowerCase().replace(/\s+/g, '').replace(/[x×/]/g, ':');
  const direct = STUDIO_ASPECT_RATIO_KEYS.find((key) => key === compact);
  if (direct) return direct;
  const named: Record<string, StudioAspectRatio> = { story: '9:16', square: '1:1', banner: '16:9', landscape: '16:9', portrait: '4:5', poster: '2:3' };
  return named[compact] ?? null;
}

/** A festival by key or label, or by any part of a "Diwali / Deepavali" label. */
export function matchFestival(value: string): string | null {
  const wanted = normalizeValue(value);
  if (!wanted) return null;
  for (const festival of STUDIO_FESTIVALS) {
    const names = [festival.key, festival.label, ...festival.label.split(/[/()]/)].map(normalizeValue).filter(Boolean);
    if (names.includes(wanted)) return festival.key;
  }
  return null;
}

function parseYesNo(value: string): boolean | null {
  const normalized = normalizeValue(value);
  if (['yes', 'y', 'true', '1'].includes(normalized)) return true;
  if (['no', 'n', 'false', '0'].includes(normalized)) return false;
  return null;
}

function parseQuality(value: string): StudioQuality | null {
  const normalized = normalizeValue(value);
  return (STUDIO_QUALITIES as readonly string[]).includes(normalized) ? (normalized as StudioQuality) : null;
}

function fileProblem(message: string): BatchSheetResult {
  return { rows: [], problems: [{ sheetRow: null, message }] };
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

async function readXlsx(bytes: Buffer): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];
  const table: string[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const values: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
      values[columnNumber - 1] = cellText(cell.value);
    });
    table[rowNumber - 1] = Array.from(values, (value) => value ?? '');
  });
  return Array.from(table, (row) => row ?? []);
}

/** A cell as the operator reads it: rich text joined, formulas by result, dates as YYYY-MM-DD. */
export function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('richText' in value && Array.isArray(value.richText)) return value.richText.map((part) => part.text).join('');
    if ('text' in value && typeof value.text === 'string') return value.text;
    if ('result' in value) return cellText((value as { result?: ExcelJS.CellValue }).result ?? null);
    if ('error' in value) return '';
  }
  return String(value);
}

/**
 * RFC 4180 CSV: quoted fields may hold commas, quotes ("") and line breaks.
 * Strips the byte-order mark Excel writes.
 */
export function parseCsv(text: string): string[][] {
  const input = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field === '') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[index + 1] === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

/** The downloadable template: the columns, three example rows and a festival list sheet. */
export async function buildBatchTemplate(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Posters');
  sheet.columns = [
    { header: 'Day', key: 'day', width: 10 },
    { header: 'Prompt', key: 'prompt', width: 80 },
    { header: 'Aspect ratio', key: 'aspect', width: 14 },
    { header: 'Festival', key: 'festival', width: 22 },
    { header: 'Text free', key: 'textFree', width: 10 },
    { header: 'Quality', key: 'quality', width: 10 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.addRow({ day: 1, prompt: 'Free dental check-up camp this Sunday. Headline "Smile Brighter". Friendly clinic scene, bright daylight.' });
  sheet.addRow({ day: 2, prompt: 'Tips for healthy gums: brush twice, floss daily, visit every six months. Clean illustrated style.', aspect: '1:1' });
  sheet.addRow({ day: 3, prompt: 'Festive greeting from the clinic team with a warm family scene.', festival: 'Diwali', quality: 'Medium' });
  sheet.getColumn('prompt').alignment = { wrapText: true, vertical: 'top' };

  const help = workbook.addWorksheet('Festivals and formats');
  help.columns = [
    { header: 'Festival (use either column)', key: 'label', width: 34 },
    { header: 'Key', key: 'key', width: 22 },
  ];
  help.getRow(1).font = { bold: true };
  for (const festival of STUDIO_FESTIVALS) help.addRow({ label: festival.label, key: festival.key });
  help.addRow({});
  help.addRow({ label: `Aspect ratios: ${STUDIO_ASPECT_RATIO_KEYS.join(', ')}` });
  help.addRow({ label: 'Quality: Low, Medium or High (blank = default)' });
  help.addRow({ label: 'Text free: Yes or No (blank = the batch setting)' });

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
