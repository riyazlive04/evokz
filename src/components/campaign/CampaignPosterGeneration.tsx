'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { AlertTriangle, Check, Eye, ImageOff, Loader2, Pause, Pencil, Play, RefreshCw, Search, Sparkles, Square, X, ServerCog } from 'lucide-react';

import {
  approveCampaignDayPosterAction,
  changeCampaignStatusAction,
  generateCampaignDayPosterAction,
  planPosterBatchAction,
  queueCampaignPostersAction,
} from '@/app/admin/campaigns/actions';
import { CampaignDayDetail } from '@/components/campaign/CampaignDayDetail';
import { badgeVariants } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAction } from '@/hooks/use-action';
import type { PosterState } from '@/lib/campaign/poster-generation';
import type { PosterBatchPlan } from '@/lib/campaign/poster-generation-service';
import { describeDays } from '@/lib/campaign/template-mapping';
import { studioImageUrl } from '@/lib/poster-studio/limits';
import { cn } from '@/lib/utils';

export interface PosterDayView {
  id: string;
  dayNumber: number;
  dateLabel: string;
  headline: string | null;
  templateLabel: string | null;
  templateSource: 'AUTO' | 'MANUAL' | null;
  state: PosterState;
  stateLabel: string;
  /** Why the day cannot be generated now, or the last failure. */
  note: string | null;
  generating: boolean;
  active: { versionId: string; versionNumber: number; generationId: string | null } | null;
  versionCount: number;
  canGenerate: boolean;
  canRegenerate: boolean;
}

export interface PosterSummaryView {
  days: number;
  generated: number;
  needsApproval: number;
  approved: number;
  outdated: number;
  failed: number;
  generating: number;
  notGenerated: number;
  needsAttention: number;
  unmapped: number;
}

type Variant = 'default' | 'secondary' | 'outline' | 'slate' | 'amber' | 'emerald' | 'destructive';

const STATE_VARIANT: Record<PosterState, Variant> = {
  'not-generated': 'slate',
  generating: 'secondary',
  failed: 'destructive',
  'needs-approval': 'amber',
  approved: 'emerald',
  rejected: 'destructive',
  outdated: 'amber',
  'needs-attention': 'amber',
};

function Tag({ variant, className, children }: { variant: Variant; className?: string; children: React.ReactNode }) {
  return <span className={cn(badgeVariants({ variant }), className)}>{children}</span>;
}

interface RunState {
  running: boolean;
  label: string;
  total: number;
  done: number;
  currentDay: number | null;
  generated: number;
  skipped: number;
  failed: Array<{ dayNumber: number; message: string }>;
  stoppedReason: string | null;
}

interface PendingPlan extends PosterBatchPlan {
  label: string;
}

/**
 * Rolling poster generation for one campaign (Phase 4).
 *
 * Posters are generated one day per request, in sequence, from the browser — the
 * same shape as content generation — so a batch shows progress, can be stopped
 * between posters, and keeps everything already made if the tab closes. A batch
 * always starts with a confirmation of exactly how many images will be
 * generated; nothing is generated when that number is zero.
 */
export function CampaignPosterGeneration({
  campaignId,
  status,
  closed,
  windowLabel,
  windowDays,
  summary,
  days,
  durationDays,
  blockers,
}: {
  campaignId: string;
  status: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';
  closed: boolean;
  windowLabel: string;
  /** The rolling window's length (the campaign's `generationWindowDays`). */
  windowDays: number;
  summary: PosterSummaryView;
  /** The days inside the rolling window. */
  days: PosterDayView[];
  durationDays: number;
  /** Campaign-wide reasons nothing can be generated (inactive campaign, Brand Canvas, format). */
  blockers: string[];
}) {
  const router = useRouter();
  const planAction = useAction(planPosterBatchAction);
  const generate = useAction(generateCampaignDayPosterAction);
  const approve = useAction(approveCampaignDayPosterAction);
  const statusAction = useAction(changeCampaignStatusAction);
  const queueAction = useAction(queueCampaignPostersAction);
  const [queueNotice, setQueueNotice] = React.useState<string | null>(null);

  const [plan, setPlan] = React.useState<PendingPlan | null>(null);
  const [run, setRun] = React.useState<RunState | null>(null);
  const [attentionOnly, setAttentionOnly] = React.useState(false);
  const [confirmRegenerate, setConfirmRegenerate] = React.useState<string | null>(null);
  const [confirmStatus, setConfirmStatus] = React.useState(false);
  const [viewing, setViewing] = React.useState<string | null>(null);
  const [fromText, setFromText] = React.useState('');
  const [toText, setToText] = React.useState('');
  const stopRequested = React.useRef(false);

  const running = run?.running === true;
  const busy = running || planAction.pending || approve.pending || statusAction.pending;

  // A batch keeps running on the server for the poster in progress, but the
  // loop driving the rest lives in this tab.
  React.useEffect(() => {
    if (!running) return undefined;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [running]);

  async function preparePlan(label: string, request: { mode: 'missing' | 'upcoming' | 'regenerate'; fromDay?: number; toDay?: number }) {
    setRun(null);
    setPlan(null);
    const result = await planAction.run(campaignId, request);
    if (result.ok) setPlan({ ...result.data, label });
  }

  async function execute(batch: PendingPlan) {
    setPlan(null);
    stopRequested.current = false;
    const state: RunState = { running: true, label: batch.label, total: batch.days.length, done: 0, currentDay: null, generated: 0, skipped: 0, failed: [], stoppedReason: null };
    setRun({ ...state });

    for (const entry of batch.days) {
      state.currentDay = entry.dayNumber;
      setRun({ ...state });
      const result = await generate.run(campaignId, entry.dayId, { mode: batch.mode, explicit: batch.explicit });
      state.done += 1;
      if (!result.ok) {
        state.failed.push({ dayNumber: entry.dayNumber, message: result.error });
        state.stoppedReason = 'The request did not complete. Posters already made are kept; run again to continue.';
        break;
      }
      const outcome = result.data;
      if (outcome.outcome === 'generated') state.generated += 1;
      else if (outcome.outcome === 'skipped') state.skipped += 1;
      else {
        state.failed.push({ dayNumber: outcome.dayNumber, message: outcome.message });
        if (outcome.stopBatch) {
          state.stoppedReason = `Stopped: ${outcome.message}`;
          break;
        }
      }
      setRun({ ...state });
      router.refresh();
      if (stopRequested.current) {
        state.stoppedReason = 'Stopped after this poster. Posters already made are kept; the rest stay available for another run.';
        break;
      }
    }

    setRun({ ...state, running: false, currentDay: null });
    router.refresh();
  }

  const from = Number(fromText);
  const to = Number(toText);
  const rangeValid = Number.isInteger(from) && Number.isInteger(to) && from >= 1 && to <= durationDays && from <= to;
  const visible = attentionOnly ? days.filter((day) => ['failed', 'needs-attention', 'outdated'].includes(day.state)) : days;
  const attentionCount = summary.failed + summary.needsAttention + summary.outdated;
  const regenerations = plan?.days.filter((day) => day.action === 'regenerate').length ?? 0;
  const retries = plan?.days.filter((day) => day.retry).length ?? 0;

  return (
    <div className="space-y-4">
      {/* ---- Window and campaign status ---- */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="text-sm text-foreground">
          <span className="font-semibold">Next {windowDays} days</span> <span className="text-muted-foreground">· {windowLabel}{summary.days !== windowDays ? ` · ${summary.days} campaign ${summary.days === 1 ? 'day' : 'days'} in this window` : ''}</span>
        </p>
        <div className="flex flex-wrap items-center gap-1.5 sm:ml-auto">
          <Tag variant={status === 'ACTIVE' ? 'emerald' : 'slate'}>{status}</Tag>
          {!closed && (status === 'DRAFT' || status === 'PAUSED' || status === 'ACTIVE') && (
            !confirmStatus ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmStatus(true)}>
                {status === 'ACTIVE' ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                {status === 'DRAFT' ? 'Activate campaign' : status === 'PAUSED' ? 'Resume campaign' : 'Pause campaign'}
              </Button>
            ) : (
              <span className="flex flex-wrap items-center gap-1.5 rounded-md border border-warning/30 bg-warning/5 px-2 py-1 text-[11px] text-warning-ink">
                {status === 'ACTIVE'
                  ? 'Pause? Poster generation stops until the campaign is resumed.'
                  : 'Activate? Posters can then be generated. Nothing is sent — delivery is not connected to campaigns yet.'}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={async () => {
                    setConfirmStatus(false);
                    const result = await statusAction.run(campaignId, status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE');
                    if (result.ok) router.refresh();
                  }}
                >
                  {status === 'ACTIVE' ? 'Pause' : status === 'DRAFT' ? 'Activate' : 'Resume'}
                </Button>
                <Button size="icon" variant="ghost" onClick={() => setConfirmStatus(false)} aria-label="Cancel status change">
                  <X className="h-4 w-4" />
                </Button>
              </span>
            )
          )}
        </div>
      </div>

      {/* ---- Summary ---- */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8" aria-label="Poster summary">
        {(
          [
            ['Generated', summary.generated, 'emerald'],
            ['Needs approval', summary.needsApproval, summary.needsApproval > 0 ? 'amber' : 'slate'],
            ['Approved', summary.approved, 'slate'],
            ['Outdated', summary.outdated, summary.outdated > 0 ? 'amber' : 'slate'],
            ['Failed', summary.failed, summary.failed > 0 ? 'destructive' : 'slate'],
            ['Needs attention', summary.needsAttention, summary.needsAttention > 0 ? 'amber' : 'slate'],
            ['Not generated', summary.notGenerated, 'slate'],
            ['Unmapped', summary.unmapped, summary.unmapped > 0 ? 'amber' : 'slate'],
          ] as const
        ).map(([label, value, tone]) => (
          <div key={label} className="rounded-md border border-border px-2.5 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{label}</p>
            <p className={cn('font-mono text-lg font-semibold', tone === 'emerald' ? 'text-success-ink' : tone === 'amber' ? 'text-warning-ink' : tone === 'destructive' ? 'text-danger-ink' : 'text-foreground')}>{value}</p>
          </div>
        ))}
      </div>

      {blockers.length > 0 && (
        <div role="status" className="space-y-0.5 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-[12px] text-warning-ink">
          {blockers.map((blocker) => (
            <p key={blocker} className="flex items-start gap-1.5">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {blocker}
            </p>
          ))}
        </div>
      )}

      {queueNotice && <p className="text-[12px] text-muted-foreground">{queueNotice}</p>}

      {/* ---- Actions ---- */}
      {!closed && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={busy} onClick={() => void preparePlan(`Generate upcoming (next ${windowDays} days)`, { mode: 'upcoming' })}>
              {planAction.pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              Generate Upcoming
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void preparePlan(`Generate missing (next ${windowDays} days)`, { mode: 'missing' })}>
              Generate Missing
            </Button>
            {/*
              Hand the batch to the server instead of running it here (Phase 7).
              The days are marked QUEUED and the cron sweep generates them, so
              this tab may be closed — which is the whole point of the button.
            */}
            <Button
              size="sm"
              variant="outline"
              disabled={busy || queueAction.pending}
              onClick={async () => {
                const result = await queueAction.run(campaignId, { mode: 'upcoming' });
                if (result.ok) {
                  const count = result.data.queued.length;
                  setQueueNotice(
                    count > 0
                      ? `Queued ${count} day${count === 1 ? '' : 's'}. The server will generate them — you can close this page.`
                      : result.data.alreadyQueued.length > 0
                        ? `${result.data.alreadyQueued.length} day(s) are already queued.`
                        : 'Nothing eligible to queue.',
                  );
                  router.refresh();
                }
              }}
            >
              {queueAction.pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ServerCog className="h-4 w-4" />}
              Queue on server
            </Button>
            <Button size="sm" variant={attentionOnly ? 'secondary' : 'outline'} disabled={running} onClick={() => setAttentionOnly((value) => !value)}>
              <Search className="h-4 w-4" />
              Review Attention ({attentionCount})
            </Button>
            {running && (
              <Button size="sm" variant="ghost" onClick={() => { stopRequested.current = true; }}>
                <Square className="h-4 w-4" />
                Stop after this poster
              </Button>
            )}
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <span className="space-y-1">
              <label htmlFor="poster-from" className="block text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">From day</label>
              <Input id="poster-from" type="number" min={1} max={durationDays} value={fromText} onChange={(event) => setFromText(event.target.value)} className="h-8 w-20" disabled={busy} />
            </span>
            <span className="space-y-1">
              <label htmlFor="poster-to" className="block text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">To day</label>
              <Input id="poster-to" type="number" min={1} max={durationDays} value={toText} onChange={(event) => setToText(event.target.value)} className="h-8 w-20" disabled={busy} />
            </span>
            <Button size="sm" variant="outline" disabled={busy || !rangeValid} onClick={() => void preparePlan(`Generate missing, days ${from}–${to}`, { mode: 'missing', fromDay: from, toDay: to })}>
              Generate days
            </Button>
            <Button size="sm" variant="outline" disabled={busy || !rangeValid} onClick={() => void preparePlan(`Regenerate days ${from}–${to}`, { mode: 'regenerate', fromDay: from, toDay: to })}>
              <RefreshCw className="h-4 w-4" />
              Regenerate days
            </Button>
            <p className="text-[11px] text-muted-foreground">A specific range may reach beyond the next {windowDays} days.</p>
          </div>
        </div>
      )}

      {(planAction.error ?? statusAction.error ?? approve.error) && (
        <p role="alert" className="text-[12px] text-danger-ink">
          {planAction.error ?? statusAction.error ?? approve.error}
        </p>
      )}

      {/* ---- Cost confirmation ---- */}
      {plan && (
        <section aria-label="Confirm poster generation" className="space-y-2 rounded-lg border border-warning/30 bg-warning/5 p-3">
          <h3 className="text-sm font-semibold text-foreground">{plan.label}</h3>
          <p className="text-[12px] text-foreground">
            Eligible days: <span className="font-semibold">{plan.days.length}</span> · Estimated generations:{' '}
            <span className="font-semibold">{plan.estimatedGenerations}</span>
            {regenerations > 0 && ` · ${regenerations} replace an existing poster (it is kept as history)`}
            {retries > 0 && ` · ${retries} retry a failed attempt`}
          </p>
          {plan.skipped.length > 0 && (
            <ul className="space-y-0.5 text-[11px] text-muted-foreground">
              {plan.skipped.map((group) => (
                <li key={`${group.reason}-${group.message}`} className={cn(group.attention && 'text-warning-ink')}>
                  <span className="capitalize">{describeDays(group.dayNumbers)}</span> not included — {group.message}
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {plan.estimatedGenerations > 0 ? (
              <Button size="sm" onClick={() => void execute(plan)}>
                <Sparkles className="h-4 w-4" />
                Generate {plan.estimatedGenerations} {plan.estimatedGenerations === 1 ? 'poster' : 'posters'}
              </Button>
            ) : (
              <p className="text-[12px] font-medium text-foreground">Nothing to generate.</p>
            )}
            <Button size="sm" variant="ghost" onClick={() => setPlan(null)}>
              Cancel
            </Button>
          </div>
        </section>
      )}

      {/* ---- Progress ---- */}
      {run && (
        <div role="status" aria-live="polite" className="space-y-1 rounded-md border border-border px-3 py-2 text-[12px]">
          <p className="flex items-center gap-2 text-foreground">
            {run.running && <Loader2 className="h-4 w-4 animate-spin" />}
            {run.running ? `${run.label}: generating day ${run.currentDay} (${run.done + 1} of ${run.total})…` : `${run.label}: finished.`}
          </p>
          <p className="text-muted-foreground">
            {run.generated} generated · {run.failed.length} failed · {run.skipped} skipped
          </p>
          {run.failed.map((failure) => (
            <p key={failure.dayNumber} className="text-danger-ink">
              Day {failure.dayNumber}: {failure.message}
            </p>
          ))}
          {run.stoppedReason && <p className="text-warning-ink">{run.stoppedReason}</p>}
        </div>
      )}

      {/* ---- Days in the window ---- */}
      <ol className="divide-y divide-border rounded-lg border border-border">
        {visible.map((day) => (
          <li key={day.id} data-poster-day={day.dayNumber} className="grid grid-cols-[3rem_minmax(0,1fr)] gap-3 px-3 py-2.5 sm:grid-cols-[3rem_minmax(0,1fr)_auto] sm:items-center">
            <div className="flex h-[5.3rem] w-12 items-center justify-center overflow-hidden rounded-sm border border-border bg-muted">
              {day.active?.generationId ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={studioImageUrl(day.active.generationId, { width: 160 })} alt={`Day ${day.dayNumber} poster v${day.active.versionNumber}`} loading="lazy" className="h-full w-full object-cover" />
              ) : (
                <ImageOff className="h-4 w-4 text-muted-foreground" />
              )}
            </div>

            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-semibold text-foreground">Day {day.dayNumber}</span>
                <span className="font-mono text-[11px] text-muted-foreground">{day.dateLabel}</span>
                <Tag variant={STATE_VARIANT[day.state]}>
                  {day.generating && <Loader2 className="h-3 w-3 animate-spin" />}
                  {day.stateLabel}
                </Tag>
                {day.active && <span className="text-[10px] text-muted-foreground">v{day.active.versionNumber}{day.versionCount > 1 ? ` of ${day.versionCount}` : ''}</span>}
              </div>
              {day.headline && <p className="truncate text-[12px] text-foreground">{day.headline}</p>}
              <p className="text-[10px] text-muted-foreground">
                Template: {day.templateLabel ?? 'not mapped'}
                {day.templateSource ? ` · ${day.templateSource === 'MANUAL' ? 'Manual' : 'Auto'}` : ''}
              </p>
              {day.note && (
                <p className={cn('flex items-start gap-1 text-[11px]', day.state === 'failed' || day.state === 'needs-attention' ? 'text-warning-ink' : 'text-muted-foreground')}>
                  {(day.state === 'failed' || day.state === 'needs-attention') && <AlertTriangle className="mt-px h-3 w-3 shrink-0" />}
                  {day.note}
                </p>
              )}
            </div>

            <div className="col-span-2 flex flex-wrap items-center gap-1.5 sm:col-span-1 sm:justify-end">
              {!closed && day.canGenerate && !day.active && (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void execute({ label: `Generate day ${day.dayNumber}`, mode: 'missing', explicit: true, days: [{ dayId: day.id, dayNumber: day.dayNumber, action: 'generate', retry: day.state === 'failed' }], estimatedGenerations: 1, skipped: [] })}>
                  <Sparkles className="h-3.5 w-3.5" />
                  {day.state === 'failed' ? 'Retry' : 'Generate'}
                </Button>
              )}
              {!closed && day.canRegenerate && day.active && (
                confirmRegenerate === day.id ? (
                  <span className="flex items-center gap-1">
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => { setConfirmRegenerate(null); void execute({ label: `Regenerate day ${day.dayNumber}`, mode: 'regenerate', explicit: true, days: [{ dayId: day.id, dayNumber: day.dayNumber, action: 'regenerate', retry: false }], estimatedGenerations: 1, skipped: [] }); }}>
                      Generate 1 new version
                    </Button>
                    <Button size="icon" variant="ghost" onClick={() => setConfirmRegenerate(null)} aria-label="Cancel regenerate">
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </span>
                ) : (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmRegenerate(day.id)}>
                    <RefreshCw className="h-3.5 w-3.5" />
                    Regenerate
                  </Button>
                )
              )}
              {day.versionCount > 0 && (
                <Button size="sm" variant="ghost" onClick={() => setViewing(day.id)}>
                  <Eye className="h-3.5 w-3.5" />
                  View
                </Button>
              )}
              {!closed && day.active?.generationId && (
                <Button asChild size="sm" variant="ghost">
                  <Link href={`/admin/poster-studio?campaignDay=${day.id}`}>
                    <Pencil className="h-3.5 w-3.5" />
                    Edit
                  </Link>
                </Button>
              )}
              {!closed && day.state === 'needs-approval' && day.active && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={async () => {
                    const result = await approve.run(day.id, day.active!.versionId);
                    if (result.ok) router.refresh();
                  }}
                >
                  <Check className="h-3.5 w-3.5" />
                  Approve
                </Button>
              )}
            </div>
          </li>
        ))}
        {visible.length === 0 && <li className="px-3 py-6 text-center text-[12px] text-muted-foreground">{attentionOnly ? 'Nothing needs attention in the next days.' : 'No campaign days fall in this window.'}</li>}
      </ol>

      <CampaignDayDetail dayId={viewing} onClose={() => setViewing(null)} onChanged={() => router.refresh()} />
    </div>
  );
}
