'use client';

import * as React from 'react';

import {
  AlertTriangle,
  Check,
  FolderUp,
  ImageUp,
  Loader2,
  Upload,
} from 'lucide-react';

import { uploadManualPoster, type ManualPosterOutcome } from '@/app/admin/dashboard/actions';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { useAction } from '@/hooks/use-action';
import {
  MANUAL_COLUMN_LABELS,
  MANUAL_IMAGE_LIMIT,
  MANUAL_IMAGE_MAX_BYTES,
  MANUAL_SHEET_MAX_BYTES,
  matchManualUploads,
  parseManualSheet,
} from '@/lib/manual-upload-match';
import { planManualSchedule } from '@/lib/manual-upload-schedule';

/**
 * Upload a batch of already-finished posters and schedule them.
 *
 * **A separate entrance, on purpose.** Everything else on this page describes
 * work the pipeline is about to do — a template to lay out, a photograph to
 * synthesise, copy to typeset. This describes work that is already done: the
 * operator made these posters somewhere else, and all that is left is the words
 * WhatsApp sends beside each one and the day it goes out. So the flow asks for
 * exactly two things, images and a three-column sheet, and nothing about layouts.
 *
 * **The confirm screen is the whole design.** Two files chosen from a desktop
 * cannot be trusted to line up — a renamed export, a row typed for a poster that
 * was never made — and the failure mode that matters is the quiet one, where
 * eleven of twelve posters schedule and nobody notices the twelfth. So every
 * input is accounted for before anything is written: each image is either paired
 * or listed with a reason, each row likewise, and each pair either has a date or
 * is named as not fitting. An operator who reads nothing but the counts still
 * sees whether their batch was whole.
 *
 * The preview is computed here, in the browser, from the same pure functions the
 * server uses — `parseManualSheet`, `matchManualUploads`, `planManualSchedule`.
 * That makes it instant and makes it a courtesy rather than the authority, the
 * same relationship `CalendarImportPanel` has with `applyCalendarImport`: the
 * server re-parses the caption, re-derives the open day against a fresh read, and
 * reports what it actually did. Where the two disagree, the results list below is
 * the one that happened.
 *
 * Uploads run one file per action call rather than one call carrying the batch.
 * Server Actions have a body limit, a dozen full-size posters would breach it,
 * and sequencing gives a per-file answer — "day-7.png is 9 MB" — instead of one
 * failure for the batch with nothing to act on.
 */

const MANUAL_COLUMNS = Object.values(MANUAL_COLUMN_LABELS);
const PREVIEW_LIMIT = 60;

/** Junk an operating system leaves in a folder. Never a poster, never a sheet. */
const HIDDEN_FILES = new Set(['thumbs.db', 'desktop.ini', '.ds_store']);

/**
 * What each file is, decided by extension first and MIME second.
 *
 * Extension leads because it is the half that survives: Windows hands a `.csv`
 * to the browser as `application/vnd.ms-excel` when Excel is installed, and a
 * folder picked through `webkitdirectory` can report an empty `type` for
 * anything the OS has no association for. The extension is what the operator
 * actually typed, and — for the images — it is the same string the `day-N`
 * matcher reads.
 */
function isImage(file: File): boolean {
  return /\.(png|jpe?g|webp)$/i.test(file.name) || file.type.startsWith('image/');
}

function isSheet(file: File): boolean {
  return (
    /\.(csv|tsv|txt)$/i.test(file.name) ||
    file.type === 'text/csv' ||
    file.type === 'text/tab-separated-values' ||
    file.type === 'text/plain'
  );
}

export function ManualTemplateUploadDialog({
  clientId,
  companyName,
  totalDays,
  seededDays,
  startDate,
  endDate,
  deliveryDays,
  timeZone,
  notBefore,
}: {
  clientId: string;
  companyName: string;
  /** The plan's duration — the highest campaign day that may exist. */
  totalDays: number;
  /** Day numbers that already carry a row, so the preview skips them. */
  seededDays: number[];
  /** ISO strings, because a Date cannot cross the server/client boundary intact. */
  startDate: string;
  endDate: string;
  /** ISO weekdays the client accepts (1 = Mon … 7 = Sun). Empty means every day. */
  deliveryDays: number[];
  timeZone: string;
  /**
   * The earliest date still worth scheduling onto, computed on the server from
   * the client's `cronTime` — today, or tomorrow if today's delivery minute has
   * already gone by. Passed down rather than derived here: the app timezone is a
   * server fact, and a browser in another zone would preview the wrong day.
   */
  notBefore: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [images, setImages] = React.useState<File[]>([]);
  const [sheetText, setSheetText] = React.useState('');
  const [sheetName, setSheetName] = React.useState<string | null>(null);
  const [readError, setReadError] = React.useState<string | null>(null);
  const [progress, setProgress] = React.useState<string | null>(null);
  const [results, setResults] = React.useState<ManualPosterOutcome[] | null>(null);

  const filesInput = React.useRef<HTMLInputElement>(null);
  const folderInput = React.useRef<HTMLInputElement | null>(null);

  /**
   * Turns the folder input into a directory picker as it mounts.
   *
   * `webkitdirectory` is not in React's `HTMLInputElement` typings — it predates
   * the standard and is still prefixed in every engine — so setting it as a JSX
   * prop costs an `any` cast. It is applied here instead.
   *
   * **A callback ref, not an effect, and that distinction is the whole fix.**
   * This input lives inside `DialogContent`, and Radix unmounts dialog content
   * while the dialog is closed. A `useEffect(…, [])` therefore runs once, on the
   * component's own mount, at a moment when the input does not exist — so
   * `.current` is null, `setAttribute` never happens, and the button opens an
   * ordinary file picker that cannot select a folder at all. Nothing errors; it
   * simply does the wrong thing, which is why it survived a browser test:
   * Playwright's `setInputFiles` writes straight to the input and never opens the
   * picker the attribute governs.
   *
   * A callback ref fires on every mount of the node, which is exactly the event
   * that matters here — the dialog being opened.
   */
  const attachFolderInput = React.useCallback((node: HTMLInputElement | null) => {
    folderInput.current = node;
    node?.setAttribute('webkitdirectory', '');
  }, []);

  const upload = useAction(uploadManualPoster);

  const parse = React.useMemo(() => parseManualSheet(sheetText), [sheetText]);

  const match = React.useMemo(
    () => matchManualUploads(images.map((file) => file.name), parse.rows),
    [images, parse.rows],
  );

  const plan = React.useMemo(
    () =>
      planManualSchedule(match.pairs, {
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        deliveryDays,
        totalDays,
        occupiedDays: seededDays,
        timeZone,
        notBefore: new Date(notBefore),
      }),
    [match.pairs, startDate, endDate, deliveryDays, totalDays, seededDays, timeZone, notBefore],
  );

  /** Which file carries each scheduled pair, by `day-N` label. */
  const fileByDay = React.useMemo(
    () => new Map(images.map((file) => [file.name, file])),
    [images],
  );

  const dateFormat = React.useMemo(
    () =>
      new Intl.DateTimeFormat('en-GB', {
        timeZone,
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      }),
    [timeZone],
  );

  function resetOutcome(): void {
    setResults(null);
    setProgress(null);
    upload.reset();
  }

  /**
   * Takes whatever was picked and works out what each file is.
   *
   * **One intake for both buttons, because the two questions an operator was
   * being asked are really one.** Choosing images and then choosing a sheet is
   * two dialogs and two chances to forget the second; and picking twelve posters
   * one at a time — which is what the picker does if you click rather than
   * Ctrl+A — silently produces a batch of one and eleven rows reported as having
   * no image. Nothing about that is wrong, and it is still the wrong thing to put
   * in front of somebody.
   *
   * So a batch of files, or a whole folder, is sorted here by what each file
   * plainly is: images are posters, a text sheet is the captions, anything else
   * is named and ignored. A folder from `webkitdirectory` arrives as a flat file
   * list with `webkitRelativePath` set, and `file.name` is still the bare
   * filename — which is what the `day-N` matcher reads, so a nested folder pairs
   * exactly as a hand-picked selection does.
   *
   * Merging rather than replacing: picking the posters, then the sheet from
   * somewhere else, has to add up rather than overwrite. Deduplicated by name, so
   * picking the same folder twice is idempotent.
   */
  async function intake(picked: File[]): Promise<void> {
    if (picked.length === 0) return;

    resetOutcome();
    setReadError(null);

    const problems: string[] = [];
    const nextImages: File[] = [];
    let sheet: File | null = null;
    const ignored: string[] = [];

    for (const file of picked) {
      // Whatever the OS dropped in — .DS_Store, Thumbs.db, desktop.ini.
      if (file.name.startsWith('.') || HIDDEN_FILES.has(file.name.toLowerCase())) continue;

      if (isImage(file)) {
        if (file.size > MANUAL_IMAGE_MAX_BYTES) {
          problems.push(
            `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB — over the ${
              MANUAL_IMAGE_MAX_BYTES / 1024 / 1024
            } MB limit`,
          );
          continue;
        }
        nextImages.push(file);
        continue;
      }

      if (isSheet(file)) {
        if (file.size > MANUAL_SHEET_MAX_BYTES) {
          problems.push(
            `${file.name} is ${Math.round(file.size / 1_000)} kB — over the ${Math.round(
              MANUAL_SHEET_MAX_BYTES / 1_000,
            )} kB limit`,
          );
          continue;
        }
        /*
         * Two sheets is genuinely ambiguous and picking one would be a guess.
         * Named rather than resolved — the operator knows which is current.
         */
        if (sheet) {
          problems.push(
            `both ${sheet.name} and ${file.name} look like caption sheets — keep one in the folder, or pick the sheet on its own`,
          );
          continue;
        }
        sheet = file;
        continue;
      }

      ignored.push(file.name);
    }

    if (sheet) {
      try {
        setSheetText(await sheet.text());
        setSheetName(sheet.name);
      } catch {
        problems.push(`${sheet.name} could not be read`);
      }
    }

    if (nextImages.length > 0) {
      setImages((current) => {
        const byName = new Map(current.map((file) => [file.name, file]));
        for (const file of nextImages) byName.set(file.name, file);
        return [...byName.values()].slice(0, MANUAL_IMAGE_LIMIT);
      });
    }

    /*
     * An .xlsx is the one ignored file worth explaining rather than listing.
     *
     * It is what somebody reaches for when told "a sheet", and it cannot be read
     * here — the format is a zip archive, not text. Saying so beats leaving them
     * to notice their captions never loaded.
     */
    const spreadsheet = ignored.find((name) => /\.(xlsx|xls|numbers|ods)$/i.test(name));
    if (spreadsheet) {
      problems.push(
        `${spreadsheet} is a spreadsheet file, not a text sheet. Open it and use File → Save As → CSV, then pick that`,
      );
    } else if (ignored.length > 0) {
      problems.push(`ignored ${ignored.length} file(s) that are neither images nor a sheet`);
    }

    if (nextImages.length === 0 && !sheet && problems.length === 0) {
      problems.push('nothing in that selection was an image or a caption sheet');
    }

    setReadError(problems.length > 0 ? problems.join(' · ') : null);
  }

  function handlePick(event: React.ChangeEvent<HTMLInputElement>): void {
    const chosen = Array.from(event.target.files ?? []);
    // Cleared so re-picking the same files after a rename still fires onChange.
    event.target.value = '';
    void intake(chosen);
  }

  /**
   * Uploads each scheduled pair, one action call at a time.
   *
   * Sequential rather than parallel, and that is load-bearing rather than
   * cautious: the server picks each poster's open day at the moment it writes it,
   * so running these concurrently would have several calls read the same free day
   * and all but one lose to the unique constraint. In order, each call sees the
   * day the one before it took.
   */
  async function handleSave(): Promise<void> {
    setResults(null);
    const outcomes: ManualPosterOutcome[] = [];

    for (const [index, entry] of plan.scheduled.entries()) {
      const file = fileByDay.get(entry.pair.fileName);
      if (!file) continue;

      setProgress(`Uploading ${index + 1} of ${plan.scheduled.length} — ${file.name}`);

      const body = new FormData();
      body.set('poster', file);
      body.set('day', String(entry.pair.day));
      body.set('caption', entry.pair.caption);
      body.set('hashtags', entry.pair.hashtags);

      const outcome = await upload.run(clientId, body);
      if (outcome.ok) {
        outcomes.push(outcome.data);
      } else {
        outcomes.push({
          ok: false,
          day: entry.pair.day,
          fileName: file.name,
          refused: outcome.error,
        });
      }
    }

    setProgress(null);
    setResults(outcomes);
    // The sheet and the selection have been consumed. Clearing them stops a
    // second click on "Save & Schedule" from writing the same batch twice.
    setImages([]);
    setSheetText('');
    setSheetName(null);
  }

  const saved = results?.filter((outcome) => outcome.ok).length ?? 0;
  const refused = results?.filter((outcome) => !outcome.ok).length ?? 0;
  const problemCount =
    match.unmatchedImages.length + match.unmatchedRows.length + parse.problems.length;
  const ready = plan.scheduled.length > 0 && !upload.pending;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          // A closed dialog keeps nothing: a half-chosen batch reopened days
          // later would be scheduled against a calendar that has since moved.
          setImages([]);
          setSheetText('');
          setSheetName(null);
          setReadError(null);
          resetOutcome();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <ImageUp className="h-4 w-4" />
          Upload templates
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Upload finished posters</DialogTitle>
          <DialogDescription>
            For posters made outside Evokz. Each image is scheduled onto{' '}
            {companyName}&apos;s next open delivery day and sent by the ordinary cron —
            nothing is generated, and nothing needs approving afterwards, because
            choosing the file is the review.
          </DialogDescription>
        </DialogHeader>

        {/* ---- Inputs ---- */}
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {/* The folder picker leads: one gesture, everything in it sorted out
                here. `accept` is deliberately absent — a directory picker filters
                by folder, and an accept list would only hide files from the
                dialog's own preview while still handing them over. */}
            <input
              ref={attachFolderInput}
              type="file"
              multiple
              onChange={handlePick}
              className="hidden"
            />
            <Button
              type="button"
              size="sm"
              onClick={() => folderInput.current?.click()}
              disabled={upload.pending}
            >
              <FolderUp className="h-4 w-4" />
              Choose folder
            </Button>

            <input
              ref={filesInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,.csv,.tsv,.txt,text/csv,text/plain"
              multiple
              onChange={handlePick}
              className="hidden"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => filesInput.current?.click()}
              disabled={upload.pending}
            >
              <ImageUp className="h-4 w-4" />
              Choose files
            </Button>

            <span className="text-[11px] text-muted-foreground">
              {images.length > 0
                ? `${images.length} image${images.length === 1 ? '' : 's'}`
                : 'no images'}
              {' · '}
              {sheetName ? (
                <span className="font-mono">{sheetName}</span>
              ) : (
                'no sheet'
              )}
            </span>
          </div>

          <p className="text-[10px] leading-relaxed text-muted-foreground/80">
            Put the posters and the sheet in one folder and choose the folder — the images and
            the caption sheet are sorted out for you, and the order you picked them in does not
            matter. Name each image <span className="font-mono">day-1</span>,{' '}
            <span className="font-mono">day-2</span>, <span className="font-mono">day-3</span> …
            — that name is what pairs it with a sheet row, and{' '}
            <span className="font-mono">day-1</span> takes the soonest open delivery day. The
            sheet is CSV or TSV with three columns:{' '}
            <span className="font-mono">{MANUAL_COLUMNS.join(', ')}</span>. A caption is required
            on every row; hashtags are optional. Nothing is scheduled unless both halves are
            present.
          </p>
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

        {/* ---- Confirm screen ---- */}
        {(images.length > 0 || parse.rows.length > 0) && results === null && (
          <div className="space-y-3 border-t border-border pt-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
              <span className="text-muted-foreground">
                <span className="font-mono text-foreground">{match.pairs.length}</span> matched
                {' · '}
                <span className="font-mono text-foreground">{plan.scheduled.length}</span> will be
                scheduled
              </span>
              {plan.unscheduled.length > 0 && (
                <span className="text-warning-ink">
                  {plan.unscheduled.length} will not fit
                </span>
              )}
              {problemCount > 0 && (
                <span className="text-danger-ink">{problemCount} flagged</span>
              )}
            </div>

            {/* Matched and placed. */}
            {plan.scheduled.length > 0 && (
              <Section
                tone="ok"
                title={`${plan.scheduled.length} poster(s) will be scheduled`}
              >
                <ul className="space-y-0.5">
                  {plan.scheduled.slice(0, PREVIEW_LIMIT).map((entry) => (
                    <li key={entry.pair.fileName} className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-mono text-[11px] text-foreground">
                        {entry.pair.fileName}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        → day {entry.dayNumber} ·{' '}
                        {dateFormat.format(entry.scheduledDate)}
                      </span>
                      <span className="line-clamp-1 flex-1 text-[10px] text-muted-foreground/80">
                        {entry.pair.caption}
                        {entry.pair.hashtags ? ` ${entry.pair.hashtags}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {/*
              Matched perfectly well and left out anyway, because the campaign
              ran out of open days. Its own section rather than a line in the
              errors: nothing is wrong with these files, and the operator's next
              move — extend the plan, free a day, upload them later — is a
              different decision from fixing a mismatch.
            */}
            {plan.unscheduled.length > 0 && (
              <Section
                tone="warn"
                title={`${plan.unscheduled.length} matched poster(s) will NOT be scheduled — no open delivery day left`}
              >
                <p className="mb-1 text-[10px] text-muted-foreground">
                  The campaign runs to {dateFormat.format(new Date(endDate))} and its remaining
                  days are taken. These are not uploaded at all; the plan is not extended.
                </p>
                <ul className="flex flex-wrap gap-x-3 gap-y-0.5">
                  {plan.unscheduled.map((pair) => (
                    <li key={pair.fileName} className="font-mono text-[11px] text-warning-ink">
                      day-{pair.day}
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {match.unmatchedImages.length > 0 && (
              <Section
                tone="error"
                title={`${match.unmatchedImages.length} image(s) have no caption row`}
              >
                <ul className="space-y-0.5">
                  {match.unmatchedImages.slice(0, PREVIEW_LIMIT).map((image) => (
                    <li key={image.fileName} className="text-[11px] text-danger-ink">
                      <span className="font-mono">{image.fileName}</span> — {image.reason}
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {match.unmatchedRows.length > 0 && (
              <Section
                tone="error"
                title={`${match.unmatchedRows.length} sheet row(s) have no image`}
              >
                <ul className="space-y-0.5">
                  {match.unmatchedRows.slice(0, PREVIEW_LIMIT).map((row) => (
                    <li key={row.day} className="text-[11px] text-danger-ink">
                      <span className="font-mono">day {row.day}</span> — {row.reason}
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {parse.problems.length > 0 && (
              <Section
                tone="error"
                title={`${parse.problems.length} sheet row(s) could not be read`}
              >
                <ul className="space-y-0.5">
                  {parse.problems.slice(0, PREVIEW_LIMIT).map((problem, index) => (
                    <li key={index} className="text-[11px] text-danger-ink">
                      <span className="font-mono">line {problem.line}</span> — {problem.issue}
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {parse.ignoredColumns.length > 0 && (
              <p className="text-[10px] text-muted-foreground">
                Ignored column(s):{' '}
                <span className="font-mono">{parse.ignoredColumns.join(', ')}</span>.
              </p>
            )}
          </div>
        )}

        {/* ---- What actually happened ---- */}
        {results !== null && (
          <div className="space-y-2 border-t border-border pt-3">
            <p className="flex items-center gap-1.5 text-[11px] text-success-ink">
              <Check className="h-3.5 w-3.5" />
              {saved} poster(s) scheduled and approved for {companyName}
              {refused > 0 ? `, ${refused} not scheduled` : ''}.
            </p>
            <ul className="space-y-0.5">
              {results.map((outcome) => (
                <li
                  key={outcome.fileName}
                  className={
                    outcome.ok
                      ? 'text-[11px] text-muted-foreground'
                      : 'text-[11px] text-danger-ink'
                  }
                >
                  <span className="font-mono">{outcome.fileName}</span>
                  {outcome.ok
                    ? ` → day ${outcome.dayNumber} · ${outcome.scheduledLabel}`
                    : ` — ${outcome.refused}`}
                </li>
              ))}
            </ul>
            <p className="text-[10px] text-muted-foreground/80">
              These rows are already approved and will be sent by the ordinary cron on their
              scheduled day. Nothing further is needed.
            </p>
          </div>
        )}

        {upload.error && results === null && (
          <p role="alert" className="text-[11px] text-danger-ink">
            {upload.error}
          </p>
        )}

        <DialogFooter>
          {progress && (
            <span className="mr-auto self-center text-[11px] text-muted-foreground">
              {progress}
            </span>
          )}
          <Button
            type="button"
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={upload.pending}
          >
            {results === null ? 'Cancel' : 'Close'}
          </Button>
          {results === null && (
            <Button type="button" onClick={handleSave} disabled={!ready}>
              {upload.pending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              {plan.scheduled.length === 0
                ? 'Nothing to schedule'
                : `Save & schedule ${plan.scheduled.length}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One titled block of the confirm screen, coloured by what it means. */
function Section({
  tone,
  title,
  children,
}: {
  tone: 'ok' | 'warn' | 'error';
  title: string;
  children: React.ReactNode;
}) {
  const border =
    tone === 'ok'
      ? 'border-border'
      : tone === 'warn'
        ? 'border-warning-ink/30 bg-warning-ink/5'
        : 'border-danger/25 bg-danger/5';

  const heading =
    tone === 'ok'
      ? 'text-muted-foreground'
      : tone === 'warn'
        ? 'text-warning-ink'
        : 'text-danger-ink';

  return (
    <div className={`space-y-1 rounded-md border px-2.5 py-2 ${border}`}>
      <p className={`text-[10px] font-semibold uppercase tracking-[0.14em] ${heading}`}>
        {title}
      </p>
      {children}
    </div>
  );
}
