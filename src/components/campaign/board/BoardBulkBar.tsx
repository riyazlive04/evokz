'use client';

import * as React from 'react';

import { Check, Clock, LayoutTemplate, Loader2, Play, Sparkles, Square, WandSparkles } from 'lucide-react';

import { approveCampaignPostersAction, cancelQueuedGenerationAction } from '@/app/admin/campaigns/actions';
import {
  cloneTemplatesIntoCampaignAction,
  queueCampaignDayPostersAction,
  rewriteDraftDaysAction,
  runNextQueuedPosterAction,
} from '@/app/admin/campaigns/clone-actions';
import type { ConfirmRequest } from '@/components/campaign/board/board-ui';
import type { BoardDayView } from '@/components/campaign/board/types';
import { Button } from '@/components/ui/button';
import { useAction } from '@/hooks/use-action';
import { describeDays } from '@/lib/campaign/template-mapping';

export interface BoardNotice {
  tone: 'success' | 'warning' | 'danger';
  lines: string[];
}

/** "days 1–7" → "Days 1–7". */
function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

interface GenerationRun {
  running: boolean;
  total: number;
  done: number;
  generated: number[];
  skipped: Array<{ dayNumber: number | null; message: string }>;
  failed: Array<{ dayNumber: number | null; message: string }>;
  stoppedReason: string | null;
}

/**
 * Bulk actions for the posts in view, in one row: the two primary actions, then
 * a compact group of secondary ones.
 *
 * **Generate all not generated** queues the eligible drafts in view (spending
 * nothing), then — while this tab is open — asks the server for one queued
 * poster at a time (`runNextQueuedPosterAction`), showing "Generating 2 of 9…".
 * Stop withdraws what is still queued after the poster in progress. If the tab
 * closes, the queued days stay queued for the cron sweep. The count is confirmed
 * first: every poster is a billed high-quality image generation.
 *
 * **Approve all needing approval** is Phase 5's bulk approval, which re-checks
 * every day as it writes and books each approved day for delivery.
 *
 * **Resume generating** appears when the campaign still has posters waiting in
 * the queue — a bulk run whose tab closed, on a deployment without the cron
 * sweep — and drives the same one-at-a-time loop over them, without queueing
 * anything new.
 *
 * **Fill empty days** clones the vertical's read templates into days with no
 * poster (no AI call). **Rewrite all drafts** gives the drafts in view fresh
 * wording, one short text call per day.
 */
export function BoardBulkBar({
  campaignId,
  campaignActive,
  queuedCount,
  days,
  disabled,
  onConfirm,
  onNotice,
  onRefresh,
  onRunningChange,
}: {
  campaignId: string;
  /** Queued posters are only generated while the campaign is active. */
  campaignActive: boolean;
  /** Posters of the whole campaign waiting in the queue. */
  queuedCount: number;
  /** The posts in view. */
  days: BoardDayView[];
  disabled: boolean;
  onConfirm: (request: ConfirmRequest) => void;
  onNotice: (notice: BoardNotice) => void;
  onRefresh: () => void;
  onRunningChange: (running: boolean) => void;
}) {
  const queue = useAction(queueCampaignDayPostersAction);
  const next = useAction(runNextQueuedPosterAction);
  const cancelQueued = useAction(cancelQueuedGenerationAction);
  const approve = useAction(approveCampaignPostersAction);
  const fill = useAction(cloneTemplatesIntoCampaignAction);
  const rewrite = useAction(rewriteDraftDaysAction);
  const [run, setRun] = React.useState<GenerationRun | null>(null);
  const [stopping, setStopping] = React.useState(false);
  const stopRequested = React.useRef(false);

  const toGenerate = days.filter((day) => day.actions.canGenerate);
  const toApprove = days.filter((day) => day.actions.canApprove);
  const drafts = days.filter((day) => !day.poster && day.lock === null && day.template !== null && day.status !== 'generating');
  const generating = run?.running === true;
  const busy = generating || queue.pending || approve.pending || fill.pending || rewrite.pending || cancelQueued.pending;
  const blocked = disabled || busy;

  React.useEffect(() => {
    onRunningChange(busy);
  }, [busy, onRunningChange]);

  React.useEffect(() => {
    if (!generating) return undefined;
    // The loop driving the run lives in this tab; the cron sweep only continues it where configured.
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [generating]);

  async function generateAll(batch: BoardDayView[]) {
    stopRequested.current = false;
    setStopping(false);
    const queued = await queue.run(campaignId, batch.map((day) => day.id));
    if (!queued.ok) {
      onNotice({ tone: 'danger', lines: [queued.error] });
      onRefresh();
      return;
    }
    const outcome = queued.data;
    const state: GenerationRun = {
      running: true,
      total: outcome.queued.length + outcome.alreadyQueued.length,
      done: 0,
      generated: [],
      skipped: outcome.skipped.flatMap((group) => group.dayNumbers.map((dayNumber) => ({ dayNumber, message: group.message }))),
      failed: [],
      stoppedReason: null,
    };
    if (state.total === 0) {
      onNotice({ tone: 'warning', lines: ['Nothing was queued.', ...state.skipped.map((entry) => `Day ${entry.dayNumber} skipped — ${entry.message}`)] });
      onRefresh();
      return;
    }
    setRun({ ...state });
    onRefresh();
    await drain(state);
  }

  /**
   * Generates this campaign's queued posters one at a time until none is left,
   * the admin stops, or a failure would repeat for every poster — then reports.
   */
  async function drain(state: GenerationRun) {
    for (;;) {
      if (stopRequested.current) {
        const cancelled = await cancelQueued.run(campaignId);
        const left = cancelled.ok ? cancelled.data.cancelled : 0;
        state.stoppedReason = `Stopped. Posters already made are kept${left > 0 ? `; ${left} queued poster${left === 1 ? ' was' : 's were'} withdrawn` : ''}.`;
        break;
      }
      const result = await next.run(campaignId);
      if (!result.ok) {
        state.failed.push({ dayNumber: null, message: result.error });
        state.stoppedReason = 'Stopped: the request did not complete. Queued posters stay queued; press Generate again to continue.';
        break;
      }
      const step = result.data;
      if (step.outcome === 'idle') break;
      state.done += 1;
      if (step.outcome === 'generated' && step.dayNumber !== null) state.generated.push(step.dayNumber);
      else if (step.outcome === 'skipped') state.skipped.push({ dayNumber: step.dayNumber, message: step.message });
      else if (step.outcome === 'failed') state.failed.push({ dayNumber: step.dayNumber, message: step.message });
      state.total = Math.max(state.total, state.done + step.remaining);
      setRun({ ...state });
      onRefresh();
      if (step.stopped) {
        state.stoppedReason = `Stopped: ${step.message} Queued posters stay queued.`;
        break;
      }
      if (step.remaining === 0) break;
    }

    setRun({ ...state, running: false });
    setStopping(false);
    onRefresh();
    const lines = [
      state.generated.length > 0 ? `Generated ${state.generated.length} poster(s): ${describeDays(state.generated)}.` : 'No poster was generated.',
      ...state.skipped.map((entry) => `${entry.dayNumber !== null ? `Day ${entry.dayNumber}` : 'A day'} skipped — ${entry.message}`),
      ...state.failed.map((entry) => `${entry.dayNumber !== null ? `Day ${entry.dayNumber} failed` : 'Failed'} — ${entry.message}`),
      ...(state.stoppedReason ? [state.stoppedReason] : []),
    ];
    onNotice({ tone: state.failed.length > 0 ? 'danger' : state.skipped.length > 0 || state.stoppedReason ? 'warning' : 'success', lines });
  }

  async function resumeQueued() {
    stopRequested.current = false;
    setStopping(false);
    const state: GenerationRun = { running: true, total: queuedCount, done: 0, generated: [], skipped: [], failed: [], stoppedReason: null };
    setRun({ ...state });
    await drain(state);
  }

  async function approveAll(batch: BoardDayView[]) {
    const result = await approve.run(campaignId, batch.map((day) => day.id));
    onRefresh();
    if (!result.ok) {
      onNotice({ tone: 'danger', lines: [result.error] });
      return;
    }
    const data = result.data;
    onNotice({
      tone: data.skippedCount > 0 || data.conflicts.length > 0 ? 'warning' : 'success',
      lines: [
        data.approved.length > 0 ? `Approved ${data.approved.length} poster(s): ${describeDays(data.approved)}.` : 'Nothing was approved.',
        ...data.skipped.map((group) => `Skipped ${describeDays(group.dayNumbers)} — ${group.message}`),
        ...(data.conflicts.length > 0 ? [`${describeDays(data.conflicts)} changed while approving and were left alone.`] : []),
      ],
    });
  }

  async function fillEmptyDays() {
    const result = await fill.run(campaignId);
    onRefresh();
    if (!result.ok) {
      onNotice({ tone: 'danger', lines: [result.error] });
      return;
    }
    const data = result.data;
    if (data.templates === 0) {
      onNotice({ tone: 'warning', lines: ['No day was filled: this vertical has no active template that has been read. Open the vertical and press Read now.'] });
      return;
    }
    const locked = data.skipped.locked.length;
    onNotice({
      tone: data.conflicts.length > 0 ? 'warning' : 'success',
      lines: [
        data.filled.length > 0 ? `Filled ${data.filled.length} day(s) with templates: ${describeDays(data.filled)}.` : 'Every empty day already has its template.',
        ...(data.skipped.hasPoster.length > 0 ? [`${capitalized(describeDays(data.skipped.hasPoster))} kept their posters.`] : []),
        ...(data.skipped.alreadyCloned.length > 0 ? [`${capitalized(describeDays(data.skipped.alreadyCloned))} already had their template's words and kept them.`] : []),
        ...(locked > 0 ? [`${locked} day(s) that have passed or been sent were left alone.`] : []),
        ...(data.skipped.generating.length > 0 ? [`${capitalized(describeDays(data.skipped.generating))} are generating and were left alone.`] : []),
        ...(data.conflicts.length > 0 ? [`${capitalized(describeDays(data.conflicts))} changed meanwhile and were left alone.`] : []),
      ],
    });
  }

  async function rewriteDrafts(batch: BoardDayView[]) {
    const result = await rewrite.run(campaignId, batch.map((day) => day.id));
    onRefresh();
    if (!result.ok) {
      onNotice({ tone: 'danger', lines: [result.error] });
      return;
    }
    const data = result.data;
    onNotice({
      tone: data.failed.length > 0 ? 'danger' : data.skipped.length > 0 || data.stopped ? 'warning' : 'success',
      lines: [
        data.rewritten.length > 0 ? `Rewrote ${data.rewritten.length} draft(s): ${describeDays(data.rewritten)}.` : 'No draft was rewritten.',
        ...data.skipped.map((entry) => `Day ${entry.dayNumber} skipped — ${entry.reason}`),
        ...data.failed.map((entry) => `Day ${entry.dayNumber} failed — ${entry.message}`),
        ...(data.stopped ? ['Stopped: the AI service is not configured or rejected the request.'] : []),
      ],
    });
  }

  if (generating && run) {
    return (
      <section aria-label="Bulk actions for the posts in view" className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
        <p className="flex items-center gap-2 text-[12px] text-foreground" role="status">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Generating {Math.min(run.done + 1, Math.max(run.total, 1))} of {Math.max(run.total, 1)}…
          <span className="text-muted-foreground">each poster takes about two minutes</span>
        </p>
        <Button
          size="sm"
          variant="outline"
          className="h-8"
          disabled={stopping}
          onClick={() => {
            stopRequested.current = true;
            setStopping(true);
          }}
        >
          {stopping ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
          {stopping ? 'Stopping after this poster…' : 'Stop'}
        </Button>
      </section>
    );
  }

  return (
    <section aria-label="Bulk actions for the posts in view" className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
      {queuedCount > 0 && (
        <p className="flex w-full flex-wrap items-center gap-2 border-b border-border pb-2 text-[12px] text-foreground">
          <Clock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          {queuedCount} poster{queuedCount === 1 ? '' : 's'} waiting
          {campaignActive ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              disabled={blocked}
              onClick={() =>
                onConfirm({
                  title: `Resume generating ${queuedCount} poster${queuedCount === 1 ? '' : 's'}?`,
                  body: (
                    <>
                      <p>They were queued earlier and have not been made yet — one high-quality AI image generation each, billed to this client.</p>
                      <p>They are made one at a time while this board is open. You can stop between posters.</p>
                    </>
                  ),
                  confirmLabel: 'Resume generating',
                  onConfirm: () => {
                    void resumeQueued();
                  },
                })
              }
            >
              <Play className="h-3.5 w-3.5" />
              Resume generating
            </Button>
          ) : (
            <span className="text-muted-foreground">— activate the campaign to generate them.</span>
          )}
        </p>
      )}
      <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">In view</span>
      {toGenerate.length > 0 && (
        <Button
          size="sm"
          variant="outline"
          className="h-8"
          disabled={blocked}
          onClick={() => {
            const batch = [...toGenerate];
            onConfirm({
              title: `Generate ${batch.length} poster${batch.length === 1 ? '' : 's'}?`,
              body: (
                <>
                  <p>
                    {capitalized(describeDays(batch.map((day) => day.dayNumber)))} — one high-quality AI image generation each, billed to this
                    client.
                  </p>
                  <p>They are queued and made one at a time while this board is open. You can stop between posters; any poster already made is kept.</p>
                </>
              ),
              confirmLabel: `Generate ${batch.length}`,
              onConfirm: () => {
                void generateAll(batch);
              },
            });
          }}
        >
          {queue.pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          Generate all not generated ({toGenerate.length})
        </Button>
      )}
      {toApprove.length > 0 && (
        <Button
          size="sm"
          variant="outline"
          className="h-8"
          disabled={blocked}
          onClick={() => {
            const batch = [...toApprove];
            onConfirm({
              title: `Approve ${batch.length} poster${batch.length === 1 ? '' : 's'}?`,
              body: (
                <>
                  <p>{capitalized(describeDays(batch.map((day) => day.dayNumber)))} will be approved.</p>
                  <p>In an active campaign each approved poster is booked and sent to the client&apos;s WhatsApp on its day.</p>
                </>
              ),
              confirmLabel: `Approve ${batch.length}`,
              onConfirm: () => approveAll(batch),
            });
          }}
        >
          {approve.pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          Approve all needing approval ({toApprove.length})
        </Button>
      )}

      <div className="ml-auto flex items-center gap-1" role="group" aria-label="More bulk actions">
        <Button
          size="sm"
          variant="ghost"
          className="h-8 px-2 text-[12px]"
          disabled={blocked}
          onClick={() =>
            onConfirm({
              title: 'Fill empty days with templates?',
              body: (
                <>
                  <p>Every day without a poster that has no template words yet gets the vertical&apos;s next active template, in upload order, ready to generate.</p>
                  <p>Days with a poster, days whose words you already edited, and days that have passed are left alone. No AI is used.</p>
                </>
              ),
              confirmLabel: 'Fill empty days',
              onConfirm: () => fillEmptyDays(),
            })
          }
        >
          {fill.pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LayoutTemplate className="h-3.5 w-3.5" />}
          Fill empty days
        </Button>
        {drafts.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            className="h-8 px-2 text-[12px]"
            disabled={blocked}
            onClick={() => {
              const batch = [...drafts];
              onConfirm({
                title: `Rewrite ${batch.length} draft${batch.length === 1 ? '' : 's'}?`,
                body: (
                  <>
                    <p>
                      {capitalized(describeDays(batch.map((day) => day.dayNumber)))} get fresh wording for the template&apos;s words — one short AI text
                      call each. Business name, phone, website and logo are not changed.
                    </p>
                    <p>Words you typed on these days are replaced.</p>
                  </>
                ),
                confirmLabel: `Rewrite ${batch.length}`,
                onConfirm: () => rewriteDrafts(batch),
              });
            }}
          >
            {rewrite.pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <WandSparkles className="h-3.5 w-3.5" />}
            Rewrite all drafts ({drafts.length})
          </Button>
        )}
      </div>
    </section>
  );
}
