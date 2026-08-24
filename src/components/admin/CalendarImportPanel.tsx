'use client';

import * as React from 'react';

import Link from 'next/link';

import {
  AlertTriangle,
  Check,
  Download,
  FileUp,
  Loader2,
  Undo2,
  Upload,
} from 'lucide-react';

import { importCalendarEntries } from '@/app/admin/dashboard/actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useAction } from '@/hooks/use-action';
import type { CalendarImportResult } from '@/lib/calendar-import';
import {
  buildCalendarImportTemplate,
  buildCalendarImportTemplateFull,
  CONTENT_COLUMN_LABELS,
  IMPORT_MAX_BYTES,
  IMPORT_ROW_LIMIT,
  POSTER_COLUMN_LABELS,
  parseCalendarImport,
  type ConflictMode,
  type ParsedImportRow,
} from '@/lib/calendar-parse';
import { POSTER_ICONS } from '@/lib/types/poster';

/**
 * Bulk import of operator-authored calendar days.
 *
 * The whole sheet is parsed and dry-run in the browser first: every row shows
 * the day it will land on and whether it creates, replaces, or bounces, so the
 * operator sees the outcome before anything is written. The server action
 * re-validates and re-resolves independently — this preview is a courtesy, not
 * the authority.
 */

const TEXTAREA_CLASS =
  'w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-[11px] leading-relaxed shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background';

const PREVIEW_LIMIT = 8;
const PROBLEM_LIMIT = 12;

const CONTENT_COLUMNS = Object.values(CONTENT_COLUMN_LABELS);

/** What the dry run says will happen to one row. */
type Disposition = 'create' | 'overwrite' | 'skip' | 'blocked' | 'no-slot' | 'invalid';

const DISPOSITION_LABEL: Record<Disposition, string> = {
  create: 'New day',
  overwrite: 'Replaces',
  skip: 'Skipped',
  blocked: 'Locked',
  'no-slot': 'No slot',
  invalid: 'Invalid',
};

interface PlannedRow {
  row: ParsedImportRow;
  /** Resolved day number; null when auto-assignment ran out of campaign. */
  day: number | null;
  disposition: Disposition;
}

export function CalendarImportPanel({
  clientId,
  companyName,
  totalDays,
  seededDays,
  lockedDays,
  templates,
}: {
  clientId: string;
  companyName: string;
  totalDays: number;
  /** Day numbers that already have a `ContentCalendar` row. */
  seededDays: number[];
  /** Subset of `seededDays` already GENERATED or DELIVERED — never rewritten. */
  lockedDays: number[];
  /**
   * The vertical's approved template layouts, for resolving the sheet's template
   * column. A courtesy copy — it lets a typo surface in the preview instead of
   * as a rejected import — while the server resolves again against a fresh read.
   */
  templates: Array<{ id: string; label: string }>;
}) {
  const importRows = useAction(importCalendarEntries);
  const fileInput = React.useRef<HTMLInputElement>(null);

  const [raw, setRaw] = React.useState('');
  const [sourceName, setSourceName] = React.useState<string | null>(null);
  const [readError, setReadError] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<ConflictMode>('skip');
  const [armed, setArmed] = React.useState(false);
  const [result, setResult] = React.useState<CalendarImportResult | null>(null);

  const parse = React.useMemo(
    () => parseCalendarImport(raw, { maxDay: totalDays, templates }),
    [raw, totalDays, templates],
  );

  const planned = React.useMemo(
    () => planRows(parse.rows, mode, { totalDays, seededDays, lockedDays }),
    [parse.rows, mode, totalDays, seededDays, lockedDays],
  );

  const counts = React.useMemo(() => tally(planned), [planned]);
  const writable = counts.create + counts.overwrite;
  const rejected = planned.length - writable;

  const authoredPosters = planned.filter(
    (entry) =>
      entry.row.poster !== null &&
      (entry.disposition === 'create' || entry.disposition === 'overwrite'),
  ).length;

  // Any change to the sheet or the conflict mode invalidates a pending confirm.
  function reset(): void {
    setArmed(false);
    setResult(null);
    importRows.reset();
  }

  function handlePaste(value: string): void {
    setRaw(value);
    setSourceName(null);
    setReadError(null);
    reset();
  }

  function handleMode(next: ConflictMode): void {
    setMode(next);
    reset();
  }

  async function handleFile(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    // Cleared so re-picking the same file after an edit still fires onChange.
    event.target.value = '';
    if (!file) return;

    reset();

    if (file.size > IMPORT_MAX_BYTES) {
      setReadError(
        `${file.name} is ${Math.round(file.size / 1_000)} kB — the limit is ${Math.round(IMPORT_MAX_BYTES / 1_000)} kB. Split the sheet or trim unused columns.`,
      );
      return;
    }

    try {
      const text = await file.text();
      setRaw(text);
      setSourceName(file.name);
      setReadError(null);
    } catch {
      setReadError(`${file.name} could not be read.`);
    }
  }

  function handleTemplate(withPoster: boolean): void {
    const blob = new Blob(
      [
        withPoster
          ? buildCalendarImportTemplateFull(templates)
          : buildCalendarImportTemplate(templates),
      ],
      { type: 'text/csv;charset=utf-8' },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = withPoster
      ? 'evokz-calendar-template-with-poster.csv'
      : 'evokz-calendar-template.csv';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function handleImport(): Promise<void> {
    setResult(null);

    const outcome = await importRows.run(clientId, {
      mode,
      rows: parse.rows
        .filter((row) => row.issues.length === 0)
        .map((row) => ({
          dayNumber: row.dayNumber,
          templateName: row.templateName,
          caption: row.caption,
          hashtags: row.hashtags,
          imagePrompt: row.imagePrompt,
          poster: row.poster,
        })),
    });

    setArmed(false);
    if (outcome.ok) {
      setResult(outcome.data);
      setRaw('');
      setSourceName(null);
    }
  }

  const problems = planned.filter((entry) => entry.row.issues.length > 0);

  /*
   * Nothing can be imported into a vertical with no approved layout, because
   * every row has to name one. Said once, up front, rather than left to produce
   * four hundred identical row errors — and the link is the actual fix, which a
   * per-row message cannot carry.
   */
  if (templates.length === 0) {
    return (
      <div className="rounded-xl border border-warning/30 bg-warning/5 p-4 text-xs text-warning-ink">
        <p className="font-medium">
          This vertical has no approved template layouts yet.
        </p>
        <p className="mt-1.5 text-muted-foreground">
          Every imported day names the template its poster is drawn in, so there is nothing
          for a sheet to choose from until at least one is approved. Open the vertical, use
          <span className="font-mono"> Read layout</span> on a reference poster, check it with
          <span className="font-mono"> See this template rendered</span>, then approve it.
        </p>
        <Button asChild size="sm" variant="ghost" className="mt-2 h-7 px-2 text-[11px]">
          <Link href="/admin/verticals">Open verticals</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileInput}
          type="file"
          accept=".csv,.tsv,.txt,.json,text/csv,text/plain,application/json"
          onChange={handleFile}
          className="hidden"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => fileInput.current?.click()}
        >
          <FileUp className="h-4 w-4" />
          Choose file
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => handleTemplate(false)}
          title="Day plus the four content fields"
        >
          <Download className="h-4 w-4" />
          Content template
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => handleTemplate(true)}
          title="Content fields plus every hand-authored poster column"
        >
          <Download className="h-4 w-4" />
          + poster columns
        </Button>
        {sourceName && (
          <span className="truncate text-[11px] text-muted-foreground">
            Loaded <span className="font-mono">{sourceName}</span>
          </span>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="calendar-import">Sheet contents</Label>
        <textarea
          id="calendar-import"
          value={raw}
          onChange={(event) => handlePaste(event.target.value)}
          rows={7}
          spellCheck={false}
          placeholder={`${CONTENT_COLUMNS.join(',')}\n1,Monsoon-ready sites,"Rain does not pause a deadline…",#construction #safety,"A wide shot of an active site at dawn…"`}
          className={TEXTAREA_CLASS}
        />
        <p className="text-[10px] text-muted-foreground/70">
          CSV, TSV, or a JSON array. The first line must name the columns —{' '}
          <span className="font-mono">{CONTENT_COLUMNS.join(', ')}</span> — in any order. Leave{' '}
          <span className="font-mono">day</span> blank to append onto the next unwritten days.
          Up to {IMPORT_ROW_LIMIT} rows per import.
        </p>
        <p className="text-[10px] text-muted-foreground/70">
          <span className="font-mono">template name</span> chooses the layout that day&apos;s
          poster is drawn in, and must match an approved template in this vertical exactly —
          a name that does not match stops the whole import rather than guessing.{' '}
          {templates.length > 0 ? (
            <>
              Available here:{' '}
              <span className="font-mono">
                {templates.slice(0, 8).map((template) => template.label).join(', ')}
                {templates.length > 8 ? ` (+${templates.length - 8} more)` : ''}
              </span>
              .
            </>
          ) : null}
        </p>
        <p className="text-[10px] text-muted-foreground/70">
          Image prompts describe the <strong className="font-semibold">background photograph
          only</strong>: no text, letters, or logos in frame, and push the subject to one side
          so there is a low-detail area — open sky, deep shadow, plain wall — for the poster
          type to sit on.
        </p>
        <details className="text-[10px] text-muted-foreground/70">
          <summary className="cursor-pointer select-none">
            Optional: author the poster text layer too ({POSTER_COLUMN_LABELS.length} more
            columns)
          </summary>
          <div className="mt-2 space-y-1.5 border-l-2 border-border pl-3">
            <p>
              Add <span className="font-mono">{POSTER_COLUMN_LABELS.join(', ')}</span>. Leave
              them out entirely and the poster&apos;s headline, body, and features are written
              on first render from that day&apos;s caption and image prompt, shaped to fit the
              template that day names.
            </p>
            <p>
              <span className="font-mono">headline</span> takes 2–4 short lines separated by{' '}
              <span className="font-mono">|</span> — you choose the breaks.{' '}
              <span className="font-mono">accent line</span> is which of those lines takes the
              brand colour, counting from 1.{' '}
              <span className="font-mono">headline period</span> is yes/no.
            </p>
            <p>
              Each feature needs all three of icon, label, and body. Valid icons:{' '}
              <span className="font-mono">{POSTER_ICONS.join(', ')}</span>.
            </p>
            <p>
              Poster columns are all-or-nothing per row: fill any one and that row must supply a
              complete block, so a typo surfaces instead of quietly falling back to generation.
            </p>
          </div>
        </details>
      </div>

      {readError && (
        <p role="alert" className="text-[11px] text-danger-ink">
          {readError}
        </p>
      )}

      {parse.error && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-danger/25 bg-danger/5 p-3 text-[11px] text-danger-ink"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{parse.error}</span>
        </p>
      )}

      {planned.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-border pt-4 text-[11px] text-muted-foreground">
            <span>
              <span className="font-mono text-foreground">{planned.length}</span> row
              {planned.length === 1 ? '' : 's'} parsed
              {parse.delimiter ? ` · ${parse.delimiter}-separated` : ''}
              {parse.format === 'json' ? ' · JSON' : ''}
            </span>
            {counts.create > 0 && (
              <span className="text-success-ink">{counts.create} new day(s)</span>
            )}
            {counts.overwrite > 0 && (
              <span className="text-warning-ink">{counts.overwrite} replaced</span>
            )}
            {counts.skip > 0 && <span>{counts.skip} skipped (day already written)</span>}
            {counts.blocked > 0 && (
              <span className="text-warning-ink">
                {counts.blocked} locked (already generated or delivered)
              </span>
            )}
            {counts['no-slot'] > 0 && (
              <span className="text-warning-ink">{counts['no-slot']} with no free day left</span>
            )}
            {counts.invalid > 0 && (
              <span className="text-danger-ink">{counts.invalid} invalid</span>
            )}
            {parse.hasPosterColumns && (
              <span>
                {authoredPosters} of {writable} with an authored poster
              </span>
            )}
          </div>

          {parse.truncated && (
            <p className="text-[11px] text-warning-ink">
              Only the first {IMPORT_ROW_LIMIT} rows were read — the rest of the sheet is
              ignored. Import these, then load the remainder.
            </p>
          )}

          {parse.ignoredColumns.length > 0 && (
            <p className="text-[11px] text-warning-ink">
              Unrecognised column{parse.ignoredColumns.length === 1 ? '' : 's'} ignored:{' '}
              <span className="font-mono">{parse.ignoredColumns.join(', ')}</span>. Check for a
              typo if one of those was meant to be a content field.
            </p>
          )}

          {/* Every sheet written before this change will land here, so it is
              worth saying plainly what replaced what rather than leaving the
              generic "unrecognised column" line to imply a typo. */}
          {parse.ignoredColumns.some(
            (column) => column.toLowerCase().replace(/[^a-z]/g, '') === 'theme',
          ) && (
            <p className="text-[11px] text-warning-ink">
              The <span className="font-mono">theme</span> column was retired — a day&apos;s
              angle now comes from its caption. Replace it with{' '}
              <span className="font-mono">template name</span>, naming the layout each day
              should be drawn in.
            </p>
          )}

          <div className="rounded-xl border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-14">Day</TableHead>
                  <TableHead className="w-24">Outcome</TableHead>
                  <TableHead>Template</TableHead>
                  <TableHead>Caption</TableHead>
                  <TableHead>Image prompt</TableHead>
                  {parse.hasPosterColumns && <TableHead className="w-24">Poster</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {planned.slice(0, PREVIEW_LIMIT).map((entry) => (
                  <TableRow key={entry.row.line}>
                    <TableCell className="font-mono text-xs">
                      {entry.day ?? '—'}
                      {entry.row.dayNumber === null && entry.day !== null && (
                        <span className="ml-1 text-[10px] text-muted-foreground">auto</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={dispositionTone(entry.disposition)}>
                        {DISPOSITION_LABEL[entry.disposition]}
                      </Badge>
                    </TableCell>
                    {/* Tinted when the name did not resolve, so a typo is
                        visible in the row it belongs to rather than only in the
                        issues list underneath. */}
                    <TableCell
                      className={`max-w-[10rem] truncate text-xs ${
                        entry.row.templateId === null ? 'text-danger-ink' : ''
                      }`}
                    >
                      {entry.row.templateName || '—'}
                    </TableCell>
                    <TableCell className="max-w-[16rem] truncate text-xs text-muted-foreground">
                      {entry.row.caption || '—'}
                    </TableCell>
                    <TableCell className="max-w-[16rem] truncate text-xs text-muted-foreground">
                      {entry.row.imagePrompt || '—'}
                    </TableCell>
                    {parse.hasPosterColumns && (
                      <TableCell className="text-xs">
                        {entry.row.poster ? (
                          <span
                            className="text-foreground"
                            title={entry.row.poster.headlineLines.join(' / ')}
                          >
                            {entry.row.poster.headlineLines.length} lines,{' '}
                            {entry.row.poster.features.length} features
                          </span>
                        ) : (
                          <span className="text-muted-foreground">On render</span>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {planned.length > PREVIEW_LIMIT && (
              <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
                + {planned.length - PREVIEW_LIMIT} more row
                {planned.length - PREVIEW_LIMIT === 1 ? '' : 's'} not previewed.
              </p>
            )}
          </div>

          {problems.length > 0 && (
            <div className="space-y-1 rounded-lg border border-danger/25 bg-danger/5 p-3">
              <p className="text-[11px] font-semibold text-danger-ink">
                {problems.length} row{problems.length === 1 ? '' : 's'} cannot be imported and
                will be left out:
              </p>
              <ul className="space-y-0.5 text-[11px] text-danger-ink/90">
                {problems.slice(0, PROBLEM_LIMIT).map((entry) => (
                  <li key={entry.row.line}>
                    <span className="font-mono">
                      {parse.format === 'json' ? 'Entry' : 'Line'} {entry.row.line}
                    </span>{' '}
                    — {entry.row.issues.join('; ')}
                  </li>
                ))}
              </ul>
              {problems.length > PROBLEM_LIMIT && (
                <p className="text-[11px] text-danger-ink/70">
                  + {problems.length - PROBLEM_LIMIT} more.
                </p>
              )}
            </div>
          )}
        </>
      )}

      <div className="flex flex-wrap items-end gap-4 border-t border-border pt-4">
        <div className="w-56 space-y-1.5">
          <Label htmlFor="calendar-import-mode">Existing days</Label>
          <Select value={mode} onValueChange={(next) => handleMode(next as ConflictMode)}>
            <SelectTrigger id="calendar-import-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="skip">Keep — skip written days</SelectItem>
              <SelectItem value="overwrite">Overwrite — replace the copy</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {armed ? (
            <>
              <Button
                type="button"
                variant="destructive"
                onClick={handleImport}
                disabled={importRows.pending}
              >
                {importRows.pending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4" />
                )}
                {importRows.pending
                  ? 'Importing…'
                  : `Confirm — replace ${counts.overwrite} day(s)`}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setArmed(false)}
                disabled={importRows.pending}
              >
                <Undo2 className="h-4 w-4" />
                Cancel
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant={rejected > 0 ? 'outline' : 'default'}
              onClick={() => (counts.overwrite > 0 ? setArmed(true) : handleImport())}
              disabled={writable === 0 || importRows.pending}
            >
              {importRows.pending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              {importRows.pending
                ? 'Importing…'
                : writable === 0
                  ? 'Nothing to import'
                  : `Import ${writable} day(s)${rejected > 0 ? ` · leave out ${rejected}` : ''}`}
            </Button>
          )}

          {armed && !importRows.pending && (
            <span className="text-[11px] text-warning-ink">
              Replaces the stored caption, hashtags, image prompt and template on{' '}
              {counts.overwrite} of {companyName}&apos;s days. The previous copy is not
              recoverable.
            </span>
          )}

          {result && (
            <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-success-ink">
              <Check className="h-3.5 w-3.5" />
              {describeResult(result)}
            </span>
          )}

          {importRows.error && (
            <span role="alert" className="text-[11px] text-danger-ink">
              {importRows.error}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

/**
 * Mirrors `planWrites` in src/lib/calendar-import.ts: explicit day numbers are
 * claimed first, then blank ones take the lowest free day in file order. Kept in
 * step with the server so the previewed day numbers are the ones written.
 */
function planRows(
  rows: ParsedImportRow[],
  mode: ConflictMode,
  context: { totalDays: number; seededDays: number[]; lockedDays: number[] },
): PlannedRow[] {
  const seeded = new Set(context.seededDays);
  const locked = new Set(context.lockedDays);

  const claimed = new Set<number>();
  for (const row of rows) {
    if (row.issues.length === 0 && row.dayNumber !== null) claimed.add(row.dayNumber);
  }

  let cursor = 1;
  const nextFreeDay = (): number | null => {
    while (cursor <= context.totalDays && (seeded.has(cursor) || claimed.has(cursor))) {
      cursor += 1;
    }
    return cursor <= context.totalDays ? cursor : null;
  };

  const handled = new Set<number>();

  return rows.map((row): PlannedRow => {
    if (row.issues.length > 0) return { row, day: row.dayNumber, disposition: 'invalid' };

    let day = row.dayNumber;
    if (day === null) {
      day = nextFreeDay();
      if (day === null) return { row, day: null, disposition: 'no-slot' };
      claimed.add(day);
    }

    // A repeat of a day an earlier row already took behaves like a lost slot.
    if (handled.has(day)) return { row, day, disposition: 'no-slot' };
    handled.add(day);

    if (!seeded.has(day)) return { row, day, disposition: 'create' };
    if (mode === 'skip') return { row, day, disposition: 'skip' };
    if (locked.has(day)) return { row, day, disposition: 'blocked' };
    return { row, day, disposition: 'overwrite' };
  });
}

function tally(planned: PlannedRow[]): Record<Disposition, number> {
  const counts: Record<Disposition, number> = {
    create: 0,
    overwrite: 0,
    skip: 0,
    blocked: 0,
    'no-slot': 0,
    invalid: 0,
  };
  for (const entry of planned) counts[entry.disposition] += 1;
  return counts;
}

function dispositionTone(
  disposition: Disposition,
): 'emerald' | 'amber' | 'destructive' | 'slate' {
  switch (disposition) {
    case 'create':
      return 'emerald';
    case 'overwrite':
    case 'blocked':
    case 'no-slot':
      return 'amber';
    case 'invalid':
      return 'destructive';
    default:
      return 'slate';
  }
}

function describeResult(result: CalendarImportResult): string {
  const parts: string[] = [];
  if (result.created > 0) parts.push(`${result.created} day(s) written`);
  if (result.updated > 0) parts.push(`${result.updated} replaced`);
  if (result.postersAuthored > 0) {
    parts.push(`${result.postersAuthored} with an authored poster`);
  }
  if (result.skippedExisting > 0) parts.push(`${result.skippedExisting} left alone`);
  if (result.blockedDelivered > 0) {
    parts.push(`${result.blockedDelivered} locked by delivery`);
  }
  if (result.outOfRange > 0) parts.push(`${result.outOfRange} past day ${result.totalDays}`);
  if (result.noFreeDay > 0) parts.push(`${result.noFreeDay} with no free day left`);
  if (result.duplicateDay > 0) parts.push(`${result.duplicateDay} duplicate day(s)`);

  const span =
    result.firstDay !== null && result.lastDay !== null
      ? result.firstDay === result.lastDay
        ? ` Day ${result.firstDay}.`
        : ` Days ${result.firstDay}–${result.lastDay}.`
      : '';

  const remaining =
    result.remaining > 0
      ? ` ${result.remaining} of ${result.totalDays} campaign days still unwritten.`
      : ' Calendar complete.';

  return `${parts.join(', ')}.${span}${remaining}`;
}
