'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

import {
  AlertTriangle,
  Check,
  CircleDashed,
  Loader2,
  Pencil,
  PencilLine,
  RefreshCw,
  Sparkles,
  Square,
  X,
} from 'lucide-react';

import {
  generateCampaignContentAction,
  markCampaignDayReviewedAction,
  regenerateCampaignDayAction,
} from '@/app/admin/campaigns/actions';
import { CampaignDayEditor } from '@/components/campaign/CampaignDayEditor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAction } from '@/hooks/use-action';
import { cn } from '@/lib/utils';

export interface CampaignDayView {
  id: string;
  dayNumber: number;
  dateLabel: string;
  contentStatus: 'NOT_GENERATED' | 'READY' | 'NEEDS_REVIEW';
  contentIssues: string[];
  contentType: string | null;
  theme: string | null;
  headline: string | null;
  supportingText: string | null;
  cta: string | null;
  caption: string;
  hashtags: string;
  imagePrompt: string;
  suggestedTemplateType: string | null;
  suggestedTemplateTypeLabel: string | null;
  contentRevision: number;
  /** The selected template's label, else the suggested one's. */
  templateLabel: string | null;
  /** Active poster: none, made from the current content, or made from older content. */
  poster: 'none' | 'current' | 'outdated';
}

type Filter = 'all' | CampaignDayView['contentStatus'];

interface RunProgress {
  mode: 'missing' | 'overwrite';
  running: boolean;
  requests: number;
  written: number;
  needsReview: number;
  missing: number;
  changedMeanwhile: number;
  postersOutdated: number;
  lastRange: string | null;
}

const STATUS: Record<CampaignDayView['contentStatus'], { label: string; icon: typeof Check; className: string }> = {
  READY: { label: 'Content ready', icon: Check, className: 'text-success-ink' },
  NEEDS_REVIEW: { label: 'Needs review', icon: PencilLine, className: 'text-warning-ink' },
  NOT_GENERATED: { label: 'Not generated', icon: CircleDashed, className: 'text-muted-foreground' },
};

/**
 * The campaign's days, with content generation driven from the browser.
 *
 * A run is a loop of single-chunk requests (`generateCampaignContentAction`
 * handles at most 30 days per call), so a 365-day campaign shows progress
 * request by request, keeps everything already written if the tab closes, and
 * resumes from the failed chunk when run again.
 */
export function CampaignCalendar({
  campaignId,
  durationDays,
  days,
  pillars,
  closed,
}: {
  campaignId: string;
  durationDays: number;
  days: CampaignDayView[];
  pillars: Array<{ key: string; label: string }>;
  /** COMPLETED or CANCELLED: read-only. */
  closed: boolean;
}) {
  const router = useRouter();
  const generate = useAction(generateCampaignContentAction);

  const [fromText, setFromText] = React.useState('1');
  const [toText, setToText] = React.useState(String(durationDays));
  const [anchor, setAnchor] = React.useState<number | null>(null);
  const [filter, setFilter] = React.useState<Filter>('all');
  const [editing, setEditing] = React.useState<CampaignDayView | null>(null);
  const [confirmOverwrite, setConfirmOverwrite] = React.useState(false);
  const [progress, setProgress] = React.useState<RunProgress | null>(null);
  const [runError, setRunError] = React.useState<string | null>(null);
  const stopRequested = React.useRef(false);

  const from = Number(fromText);
  const to = Number(toText);
  const rangeValid = Number.isInteger(from) && Number.isInteger(to) && from >= 1 && to <= durationDays && from <= to;
  const wholeCampaign = rangeValid && from === 1 && to === durationDays;
  const inRange = rangeValid ? days.filter((day) => day.dayNumber >= from && day.dayNumber <= to) : [];
  const missingInRange = inRange.filter((day) => day.contentStatus === 'NOT_GENERATED').length;
  const writtenInRange = inRange.length - missingInRange;
  const postersInRange = inRange.filter((day) => day.poster !== 'none').length;
  const running = progress?.running === true;
  const labelFor = (key: string | null) => pillars.find((pillar) => pillar.key === key)?.label ?? key;

  function selectDay(dayNumber: number, extend: boolean) {
    if (extend && anchor !== null) {
      setFromText(String(Math.min(anchor, dayNumber)));
      setToText(String(Math.max(anchor, dayNumber)));
    } else {
      setAnchor(dayNumber);
      setFromText(String(dayNumber));
      setToText(String(dayNumber));
    }
    setConfirmOverwrite(false);
  }

  async function run(mode: RunProgress['mode']) {
    if (!rangeValid) return;
    stopRequested.current = false;
    setConfirmOverwrite(false);
    setRunError(null);

    const totals: RunProgress = { mode, running: true, requests: 0, written: 0, needsReview: 0, missing: 0, changedMeanwhile: 0, postersOutdated: 0, lastRange: null };
    setProgress({ ...totals });

    let cursor = from;
    for (;;) {
      const result = await generate.run(campaignId, { fromDay: cursor, toDay: to, mode });
      if (!result.ok) break;

      const chunk = result.data.chunks[0];
      if (!chunk) break;
      totals.requests += 1;
      totals.written += chunk.written.length;
      totals.needsReview += chunk.needsReview.length;
      totals.changedMeanwhile += chunk.changedMeanwhile.length;
      totals.postersOutdated += chunk.postersOutdated.length;
      totals.missing = chunk.missing.length;
      totals.lastRange = `${chunk.fromDay}–${chunk.toDay}`;
      setProgress({ ...totals });
      router.refresh();

      if (chunk.error) {
        setRunError(`Days ${chunk.errorFromDay ?? chunk.fromDay}–${chunk.toDay} failed: ${chunk.error} Everything before them is saved; run again to continue from there.`);
        break;
      }
      if (result.data.nextFromDay === null) break;
      if (mode === 'missing' && chunk.written.length === 0) {
        setRunError('The model returned no usable content for the remaining days. Try again.');
        break;
      }
      if (stopRequested.current) break;
      cursor = result.data.nextFromDay;
    }

    setProgress({ ...totals, running: false });
  }

  const visible = filter === 'all' ? days : days.filter((day) => day.contentStatus === filter);

  return (
    <div className="space-y-5">
      {/* ---- Range and generation ---- */}
      <div className="space-y-3 rounded-lg border border-border p-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label htmlFor="range-from" className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              From day
            </label>
            <Input id="range-from" type="number" min={1} max={durationDays} value={fromText} onChange={(event) => setFromText(event.target.value)} className="w-24" disabled={running} />
          </div>
          <div className="space-y-1">
            <label htmlFor="range-to" className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              To day
            </label>
            <Input id="range-to" type="number" min={1} max={durationDays} value={toText} onChange={(event) => setToText(event.target.value)} className="w-24" disabled={running} />
          </div>
          {!wholeCampaign && (
            <Button size="sm" variant="ghost" onClick={() => { setFromText('1'); setToText(String(durationDays)); setAnchor(null); }} disabled={running}>
              Whole campaign
            </Button>
          )}
          <p className="text-[11px] text-muted-foreground">
            {rangeValid
              ? `${inRange.length} day(s) selected · ${missingInRange} not generated · ${writtenInRange} written.`
              : `Enter a range within days 1–${durationDays}.`}{' '}
            Click a day to select it, shift-click another to select the span.
          </p>
        </div>

        {!closed && (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => void run('missing')} disabled={!rangeValid || running || missingInRange === 0}>
              {running && progress?.mode === 'missing' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              Generate missing ({missingInRange})
            </Button>

            {!confirmOverwrite ? (
              <Button size="sm" variant="outline" onClick={() => setConfirmOverwrite(true)} disabled={!rangeValid || running || writtenInRange === 0}>
                <RefreshCw className="h-4 w-4" />
                Regenerate range
              </Button>
            ) : (
              <span className="flex flex-wrap items-center gap-2 rounded-md border border-warning/30 bg-warning/5 px-2.5 py-1.5 text-[11px] text-warning-ink">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                Replace the content of days {from}–{to} ({inRange.length} days, including edited ones)?
                {postersInRange > 0 && ` ${postersInRange} poster(s) will be marked outdated — they are kept, not deleted.`}
                <Button size="sm" variant="outline" onClick={() => void run('overwrite')}>
                  Regenerate {inRange.length} days
                </Button>
                <Button size="icon" variant="ghost" onClick={() => setConfirmOverwrite(false)} aria-label="Cancel">
                  <X className="h-4 w-4" />
                </Button>
              </span>
            )}

            {running && (
              <Button size="sm" variant="ghost" onClick={() => { stopRequested.current = true; }}>
                <Square className="h-4 w-4" />
                Stop after this request
              </Button>
            )}
          </div>
        )}
        {closed && <p className="text-[11px] text-muted-foreground">This campaign is closed; its content is read-only.</p>}

        {progress && (
          <p className="text-[11px] text-muted-foreground" aria-live="polite">
            {progress.running ? 'Writing content… ' : 'Finished. '}
            {progress.requests} request(s){progress.lastRange ? `, last days ${progress.lastRange}` : ''} · {progress.written} day(s) written
            {progress.needsReview > 0 && ` · ${progress.needsReview} need review`}
            {progress.missing > 0 && ` · ${progress.missing} not returned in the last request`}
            {progress.changedMeanwhile > 0 && ` · ${progress.changedMeanwhile} skipped because they were edited meanwhile`}
            {progress.postersOutdated > 0 && ` · ${progress.postersOutdated} poster(s) now outdated`}
          </p>
        )}
        {(runError ?? generate.error) && (
          <p role="alert" className="text-[11px] text-danger-ink">
            {runError ?? generate.error}
          </p>
        )}
      </div>

      {/* ---- Filter ---- */}
      <div className="flex flex-wrap gap-1.5">
        {(['all', 'NOT_GENERATED', 'NEEDS_REVIEW', 'READY'] as const).map((value) => {
          const n = value === 'all' ? days.length : days.filter((day) => day.contentStatus === value).length;
          return (
            <Button key={value} size="sm" variant={filter === value ? 'secondary' : 'ghost'} onClick={() => setFilter(value)}>
              {value === 'all' ? 'All' : STATUS[value].label} ({n})
            </Button>
          );
        })}
      </div>

      {/* ---- Days ---- */}
      <ol className="divide-y divide-border rounded-lg border border-border">
        {visible.map((day) => {
          const status = STATUS[day.contentStatus];
          const StatusIcon = status.icon;
          const selected = rangeValid && !wholeCampaign && day.dayNumber >= from && day.dayNumber <= to;
          return (
            <li key={day.id} className={cn('grid gap-2 px-3 py-2.5 sm:grid-cols-[7.5rem_9rem_1fr_auto] sm:items-start', selected && 'bg-accent/60')}>
              <button
                type="button"
                onClick={(event) => selectDay(day.dayNumber, event.shiftKey)}
                className="text-left"
                aria-pressed={selected}
                title="Click to select; shift-click to select a span"
              >
                <span className="block text-sm font-semibold text-foreground">Day {day.dayNumber}</span>
                <span className="block font-mono text-[11px] text-muted-foreground">{day.dateLabel}</span>
              </button>

              <span className={cn('flex items-center gap-1.5 text-[12px] font-medium', status.className)}>
                <StatusIcon className="h-3.5 w-3.5 shrink-0" />
                {status.label}
              </span>

              <div className="min-w-0 space-y-1">
                {day.contentStatus === 'NOT_GENERATED' ? (
                  <p className="text-[12px] text-muted-foreground">No content yet.</p>
                ) : (
                  <>
                    {/* A div, not a p: Badge renders a div, which a p cannot contain. */}
                    <div className="flex flex-wrap items-center gap-2">
                      {day.contentType && <Badge variant="outline">{labelFor(day.contentType)}</Badge>}
                      <span className="text-sm font-medium text-foreground">{day.theme}</span>
                    </div>
                    {day.headline && <p className="truncate text-[12px] text-muted-foreground">{day.headline}</p>}
                  </>
                )}
                {day.contentIssues.length > 0 && (
                  <ul className="space-y-0.5">
                    {day.contentIssues.map((issue) => (
                      <li key={issue} className="flex items-start gap-1.5 text-[11px] text-warning-ink">
                        <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                        {issue}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="flex flex-wrap gap-1.5 text-[10px] text-muted-foreground">
                  {day.suggestedTemplateTypeLabel && <span>Layout hint: {day.suggestedTemplateTypeLabel}</span>}
                  <span>Template: {day.templateLabel ?? 'not assigned'}</span>
                  <span>
                    Poster:{' '}
                    {day.poster === 'none' ? 'not generated' : day.poster === 'current' ? 'current' : <span className="text-warning-ink">outdated — needs regeneration</span>}
                  </span>
                </p>
              </div>

              {!closed && (
                <DayActions day={day} disabled={running} onEdit={() => setEditing(day)} onChanged={() => router.refresh()} />
              )}
            </li>
          );
        })}
        {visible.length === 0 && <li className="px-3 py-6 text-center text-[12px] text-muted-foreground">No days match this filter.</li>}
      </ol>

      <CampaignDayEditor
        day={editing}
        pillars={pillars}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          router.refresh();
        }}
      />
    </div>
  );
}

function DayActions({
  day,
  disabled,
  onEdit,
  onChanged,
}: {
  day: CampaignDayView;
  disabled: boolean;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const regenerate = useAction(regenerateCampaignDayAction);
  const review = useAction(markCampaignDayReviewedAction);
  const [confirming, setConfirming] = React.useState(false);

  React.useEffect(() => {
    if (!confirming) return undefined;
    const timer = setTimeout(() => setConfirming(false), 8_000);
    return () => clearTimeout(timer);
  }, [confirming]);

  const busy = disabled || regenerate.pending || review.pending;

  return (
    <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
      <Button size="sm" variant="ghost" onClick={onEdit} disabled={busy}>
        <Pencil className="h-3.5 w-3.5" />
        Edit
      </Button>

      {day.contentStatus === 'NEEDS_REVIEW' && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={async () => {
            const result = await review.run(day.id);
            if (result.ok) onChanged();
          }}
        >
          {review.pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          Mark reviewed
        </Button>
      )}

      {!confirming ? (
        <Button size="sm" variant="ghost" onClick={() => setConfirming(true)} disabled={busy}>
          {regenerate.pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          {day.contentStatus === 'NOT_GENERATED' ? 'Generate' : 'Regenerate'}
        </Button>
      ) : (
        <span className="flex items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={async () => {
              setConfirming(false);
              const result = await regenerate.run(day.id);
              if (result.ok) onChanged();
            }}
          >
            {day.contentStatus === 'NOT_GENERATED' ? `Generate day ${day.dayNumber}` : `Replace day ${day.dayNumber}`}
          </Button>
          <Button size="icon" variant="ghost" onClick={() => setConfirming(false)} aria-label="Cancel">
            <X className="h-3.5 w-3.5" />
          </Button>
        </span>
      )}

      {(regenerate.error ?? review.error) && (
        <p role="alert" className="w-full text-[11px] text-danger-ink sm:text-right">
          {regenerate.error ?? review.error}
        </p>
      )}
    </div>
  );
}
