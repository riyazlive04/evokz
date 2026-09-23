'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  Download,
  ExternalLink,
  ImageOff,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  SkipForward,
  SlidersHorizontal,
  Square,
  Trash2,
} from 'lucide-react';

import {
  cancelStudioBatchAction,
  customizeBatchItemAction,
  deleteDraftStudioBatchAction,
  loadStudioBatchViewAction,
  pauseStudioBatchAction,
  resumeStudioBatchAction,
  retryStudioBatchAction,
  runNextBatchItemAction,
  startStudioBatchAction,
} from '@/app/admin/poster-studio/bulk/actions';
import { CustomizePanel, type CustomizeSettings } from '@/components/studio/CustomizePanel';
import type { BatchCostEstimate } from '@/lib/poster-studio/batch-service';
import type { BatchItemView, BatchView } from '@/lib/poster-studio/batch-view';
import { findStudioFestival } from '@/lib/poster-studio/festivals';
import { studioImageUrl } from '@/lib/poster-studio/limits';
import { cn } from '@/lib/utils';

const STATUS_LABEL: Record<BatchView['status'], string> = {
  DRAFT: 'Draft — not started',
  RUNNING: 'Generating',
  PAUSED: 'Paused',
  DONE: 'Finished',
  CANCELLED: 'Cancelled',
};

/** Rough per-image time for the "how long" line; measured runs were 30–90 s. */
const SECONDS_PER_IMAGE = 60;

function usd(micros: number): string {
  const value = micros / 1_000_000;
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

function duration(seconds: number): string {
  if (seconds < 90) return `about ${Math.max(1, Math.round(seconds / 60))} min`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `about ${minutes} min` : `about ${(minutes / 60).toFixed(1)} h`;
}

export function BatchWorkspace({
  initial,
  estimate,
  concurrency,
  defaultQuality,
}: {
  initial: BatchView;
  estimate: BatchCostEstimate;
  /** Rows this page makes at once while it is open. */
  concurrency: number;
  defaultQuality: string;
}) {
  const router = useRouter();
  const [view, setView] = useState<BatchView>(initial);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Draft only: the operator chose to customize the schedule before starting. */
  const [customizing, setCustomizing] = useState(false);
  const [draining, setDraining] = useState(false);
  const drainRef = useRef(false);
  const viewRef = useRef(view);
  viewRef.current = view;

  const accept = useCallback((next: BatchView | null) => {
    if (next) setView(next);
  }, []);

  const run = async (label: string, action: () => Promise<{ ok: true; view: BatchView | null } | { ok: false; error: string }>, done?: string) => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const result = await action();
      if (!result.ok) {
        setError(result.error);
        return false;
      }
      accept(result.view);
      if (done) setNotice(done);
      return true;
    } catch {
      setError(`${label} did not complete. Your session may have expired — reload the page.`);
      return false;
    } finally {
      setBusy(false);
    }
  };

  // ---- The page's worker: drains the queue while the batch is running ------
  const drain = useCallback(async () => {
    if (drainRef.current) return;
    drainRef.current = true;
    setDraining(true);
    let waitMs = 0;
    const worker = async () => {
      while (drainRef.current && viewRef.current.status === 'RUNNING') {
        if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
        let result;
        try {
          result = await runNextBatchItemAction(viewRef.current.id);
        } catch {
          setError('The connection dropped while generating. The server keeps going every few minutes; reload to see progress.');
          return;
        }
        if (!result.ok) {
          setError(result.error);
          return;
        }
        accept(result.view);
        const outcome = result.outcome;
        if (!outcome) return; // nothing left to claim
        if (outcome.kind === 'requeued') {
          // Rate limited: slow down for everyone.
          waitMs = Math.min(Math.max(waitMs * 2, 20_000), 120_000);
          setNotice('OpenAI asked us to slow down; the batch continues more slowly.');
        } else {
          waitMs = 0;
        }
        if (outcome.kind === 'paused') {
          setError(`The batch paused itself: ${outcome.message}`);
          return;
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: concurrency }, worker));
    } finally {
      drainRef.current = false;
      setDraining(false);
    }
  }, [accept, concurrency]);

  useEffect(() => {
    if (view.status === 'RUNNING' && !drainRef.current) void drain();
  }, [view.status, drain]);

  useEffect(
    () => () => {
      drainRef.current = false;
    },
    [],
  );

  // A batch the cron is working (or another tab) refreshes on its own.
  useEffect(() => {
    if (view.status !== 'RUNNING' || draining) return;
    const timer = window.setInterval(async () => {
      const result = await loadStudioBatchViewAction(view.id).catch(() => null);
      if (result?.ok) accept(result.view);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [view.status, view.id, draining, accept]);

  const total = view.items.length;
  const done = view.counts.SUCCEEDED;
  const failed = view.counts.FAILED;
  const open = view.counts.QUEUED + view.counts.GENERATING;
  const toMake = view.status === 'DRAFT' ? total : open;
  const boardHref =
    view.target === 'CAMPAIGN' && view.clientId && view.campaignId ? `/admin/clients/${view.clientId}/campaigns/${view.campaignId}` : null;

  const applyItem = (item: BatchItemView) => (settings: CustomizeSettings) =>
    void run(
      'Saving the row',
      () =>
        customizeBatchItemAction(view.id, item.id, {
          prompt: settings.prompt,
          aspectRatio: settings.aspectRatio,
          festival: settings.festival,
          textFree: settings.textFree,
          quality: settings.quality,
        }),
      view.status === 'DRAFT' ? `Day ${item.dayLabel} saved.` : `Day ${item.dayLabel} will be made again with the new settings.`,
    );

  return (
    <div className="space-y-5">
      {/* ---- Summary and controls ------------------------------------------ */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
              {view.target === 'CAMPAIGN' ? 'Campaign days' : 'Studio images'} · {STATUS_LABEL[view.status]}
            </p>
            <p className="text-sm text-foreground">
              {view.target === 'CAMPAIGN' ? (
                <>
                  Fills <strong>{view.campaignName ?? 'a removed campaign'}</strong> ({view.clientName}) — each image becomes a new poster version on its
                  day, waiting for review.
                </>
              ) : view.clientName ? (
                <>
                  Branded for <strong>{view.clientName}</strong>
                  {view.overlayElements.length > 0 ? ` (${view.overlayElements.join(', ')})` : ' (no identity footer)'}.
                </>
              ) : (
                'Generic images, no client branding.'
              )}
            </p>
            <p className="text-[11px] text-muted-foreground">
              Defaults: {view.defaults.aspectRatio}
              {view.defaults.festival ? ` · ${findStudioFestival(view.defaults.festival)?.label}` : ''} · quality {view.defaults.quality ?? defaultQuality}
              {view.defaults.textFree ? ' · text-free' : ''}
              {view.sourceFileName ? ` · from ${view.sourceFileName}` : ''}
            </p>
          </div>
          {boardHref && (
            <a href={boardHref} className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-to hover:underline">
              <CalendarDays className="w-3.5 h-3.5" /> Open the campaign board
            </a>
          )}
        </div>

        {view.status !== 'DRAFT' && (
          <div className="space-y-1.5">
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
              <div className="h-full bg-primary transition-all" style={{ width: `${total ? Math.round(((done + failed) / total) * 100) : 0}%` }} />
            </div>
            <p className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
              {done} of {total} made{failed ? ` · ${failed} failed` : ''}
              {open ? ` · ${open} to go` : ''}
              {view.status === 'RUNNING'
                ? draining
                  ? ` · generating ${concurrency} at a time here — ${duration((open * SECONDS_PER_IMAGE) / concurrency)} left`
                  : ' · the server continues every few minutes'
                : ''}
            </p>
          </div>
        )}

        {toMake > 0 && (
          <p className="text-[11px] text-muted-foreground">
            {toMake} image{toMake === 1 ? '' : 's'} to make ·{' '}
            {estimate.totalMicros !== null && estimate.perImageMicros !== null
              ? `about ${usd(estimate.perImageMicros * toMake)} (≈ ${usd(estimate.perImageMicros)} each, from the last ${estimate.sampleSize} studio images)`
              : estimate.sampleSize > 0
                ? `cost not estimated — image pricing (PRICE_OPENAI_IMAGE_*) is not configured; recent images averaged ${estimate.averageOutputTokens?.toLocaleString('en-IN')} output tokens`
                : 'cost not estimated yet — no studio images to measure from'}
            {view.status === 'DRAFT' ? ` · ${duration((toMake * SECONDS_PER_IMAGE) / concurrency)} with this page open` : ''}
          </p>
        )}

        {view.pausedReason && (
          <p role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="w-4 h-4 shrink-0" /> Paused by the server: {view.pausedReason} Fix it, then Resume.
          </p>
        )}
        {error && (
          <p role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="w-4 h-4 shrink-0" /> {error}
          </p>
        )}
        {notice && (
          <p role="status" className="flex items-start gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs text-foreground">
            <CheckCircle2 className="w-4 h-4 shrink-0 text-brand-to" /> {notice}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {view.status === 'DRAFT' && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run('Starting', () => startStudioBatchAction(view.id))}
                className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-brand px-3 py-2 text-xs font-semibold text-white shadow-sm disabled:opacity-50"
              >
                <Play className="w-3.5 h-3.5" /> Start generating {total}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  if (!window.confirm('Discard this draft? Nothing has been generated for it.')) return;
                  const result = await deleteDraftStudioBatchAction(view.id);
                  if (!result.ok) setError(result.error);
                  else router.push('/admin/poster-studio/bulk');
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-muted-foreground hover:text-destructive disabled:opacity-50"
              >
                <Trash2 className="w-3.5 h-3.5" /> Discard draft
              </button>
            </>
          )}
          {view.status === 'RUNNING' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                drainRef.current = false;
                void run('Pausing', () => pauseStudioBatchAction(view.id), 'Paused. Rows already being made will finish.');
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted disabled:opacity-50"
            >
              <Pause className="w-3.5 h-3.5" /> Pause
            </button>
          )}
          {view.status === 'PAUSED' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run('Resuming', () => resumeStudioBatchAction(view.id))}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              <Play className="w-3.5 h-3.5" /> Resume
            </button>
          )}
          {(view.status === 'RUNNING' || view.status === 'PAUSED') && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (!window.confirm('Stop this batch? Rows not yet made are left unmade; you can retry them later.')) return;
                drainRef.current = false;
                void run('Cancelling', () => cancelStudioBatchAction(view.id), 'Stopped. Rows being made right now will still finish.');
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-muted-foreground hover:text-destructive disabled:opacity-50"
            >
              <Square className="w-3.5 h-3.5" /> Stop
            </button>
          )}
          {view.status !== 'DRAFT' && (failed > 0 || (view.status === 'CANCELLED' && view.counts.NOT_REQUESTED > 0)) && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run('Retrying', () => retryStudioBatchAction(view.id), 'Queued again.')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted disabled:opacity-50"
            >
              <RotateCcw className="w-3.5 h-3.5" /> Retry {view.status === 'CANCELLED' ? 'unmade and failed' : 'failed'} rows
            </button>
          )}
        </div>
      </div>

      {/* ---- Draft: Customize schedule, or Skip ------------------------------ */}
      {view.status === 'DRAFT' && !customizing && (
        <div className="rounded-xl border border-primary/30 bg-primary/5 p-5 space-y-3">
          <p className="text-sm font-semibold text-foreground flex items-center gap-2">
            <SlidersHorizontal className="w-4 h-4 text-brand-to" /> Customize schedule?
          </p>
          <p className="text-xs text-muted-foreground">
            Set a different aspect ratio, festival, quality or prompt for particular days before anything is generated — free. Or skip and
            generate every day with the settings above. Each image keeps its own Customize after it is made either way.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setCustomizing(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:opacity-90"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" /> Customize schedule
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run('Starting', () => startStudioBatchAction(view.id))}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted disabled:opacity-50"
            >
              <SkipForward className="w-3.5 h-3.5" /> Skip — generate all {total}
            </button>
          </div>
        </div>
      )}

      {/* ---- Rows ------------------------------------------------------------ */}
      <div className={cn('grid gap-4', view.status === 'DRAFT' ? 'grid-cols-1 lg:grid-cols-2' : 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3')}>
        {view.items.map((item) => (
          <BatchItemCard
            key={item.id}
            item={item}
            batch={view}
            busy={busy}
            showCustomize={view.status !== 'DRAFT' || customizing}
            defaultQuality={defaultQuality}
            onApply={applyItem(item)}
          />
        ))}
      </div>
    </div>
  );
}

const ITEM_STATUS: Record<BatchItemView['status'], { label: string; tone: string }> = {
  NOT_REQUESTED: { label: 'Not started', tone: 'bg-muted text-muted-foreground border-border' },
  QUEUED: { label: 'Queued', tone: 'bg-muted text-foreground border-border' },
  GENERATING: { label: 'Generating…', tone: 'bg-primary/10 text-primary border-primary/30' },
  SUCCEEDED: { label: 'Done', tone: 'bg-success/10 text-success-ink border-success/30' },
  FAILED: { label: 'Failed', tone: 'bg-destructive/10 text-destructive border-destructive/30' },
};

function BatchItemCard({
  item,
  batch,
  busy,
  showCustomize,
  defaultQuality,
  onApply,
}: {
  item: BatchItemView;
  batch: BatchView;
  busy: boolean;
  showCustomize: boolean;
  defaultQuality: string;
  onApply: (settings: CustomizeSettings) => void;
}) {
  const [broken, setBroken] = useState(false);
  const status = ITEM_STATUS[item.status];
  const draft = batch.status === 'DRAFT';
  return (
    <div className="rounded-xl border border-border bg-card p-3 space-y-3 shadow-sm min-w-0">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-foreground truncate">
            {item.dayNumber !== null && /^\d+$/.test(item.dayLabel) ? `Day ${item.dayLabel}` : item.dayLabel}
          </p>
          <p className="text-[10px] text-muted-foreground">
            {item.settings.aspectRatio}
            {item.settings.festival ? ` · ${findStudioFestival(item.settings.festival)?.label}` : ''} · {item.settings.quality ?? defaultQuality}
            {item.settings.textFree ? ' · text-free' : ''}
            {item.customized ? ' · customized' : ''}
          </p>
        </div>
        {!draft && <span className={cn('shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold', status.tone)}>{status.label}</span>}
      </div>

      {!draft && (
        <div className="flex items-center justify-center rounded-lg border border-border bg-muted min-h-[180px] overflow-hidden">
          {item.image && !broken ? (
            // eslint-disable-next-line @next/next/no-img-element -- session-gated Drive proxy
            <img
              src={studioImageUrl(item.image.generationId, { width: 640 })}
              alt={`Day ${item.dayLabel}: ${item.prompt}`}
              loading="lazy"
              onError={() => setBroken(true)}
              className="block max-h-[420px] w-auto max-w-full object-contain"
            />
          ) : item.status === 'GENERATING' ? (
            <RefreshCw className="w-6 h-6 text-muted-foreground animate-spin" aria-label="Generating" />
          ) : broken ? (
            <ImageOff className="w-6 h-6 text-muted-foreground" aria-label="Image unavailable" />
          ) : (
            <span className="text-[11px] text-muted-foreground">No image yet</span>
          )}
        </div>
      )}

      <p className="text-[11px] text-foreground leading-snug line-clamp-3 [overflow-wrap:anywhere]" title={item.prompt}>
        {item.prompt}
      </p>
      {item.error && <p className="text-[11px] text-destructive leading-snug">{item.error}</p>}

      {!draft && item.image && (
        <div className="flex flex-wrap gap-2 text-[11px]">
          <a
            href={studioImageUrl(item.image.generationId, { download: true })}
            download
            className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 font-semibold text-foreground hover:bg-muted"
          >
            <Download className="w-3 h-3" /> Download
          </a>
          {item.day && (
            <a
              href={`/admin/poster-studio?campaignDay=${item.day.calendarDayId}`}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 font-semibold text-foreground hover:bg-muted"
            >
              <ExternalLink className="w-3 h-3" /> Open day
              {item.day.versionNumber ? ` · v${item.day.versionNumber}` : ''}
              {item.day.approvalStatus ? ` · ${item.day.approvalStatus.toLowerCase()}` : ''}
            </a>
          )}
          {item.imageCount > 1 && <span className="self-center text-muted-foreground">{item.imageCount} images made</span>}
        </div>
      )}

      {showCustomize && (
        <CustomizePanel
          id={`row-${item.id}`}
          title={draft ? 'Customize this day' : 'Customize'}
          initial={{
            prompt: item.prompt,
            aspectRatio: item.settings.aspectRatio,
            festival: item.settings.festival,
            quality: item.settings.quality,
            textFree: item.settings.textFree,
            clientId: batch.clientId,
            overlayElements: [],
            logoBackground: 'ORIGINAL',
            footerBackground: 'AUTO',
          }}
          clients={[]}
          brandControls={false}
          defaultQuality={defaultQuality}
          disabled={busy || item.status === 'GENERATING'}
          lockedAspectRatio={item.lockedAspect ? item.settings.aspectRatio : undefined}
          applyLabel={draft ? 'Save for this day' : 'Regenerate this day'}
          note={
            draft
              ? 'Free — nothing is generated until the batch starts.'
              : `One more generation. The current image stays in this row's history${item.day ? ' and on the day as an older version' : ''}.`
          }
          onApply={onApply}
        />
      )}
    </div>
  );
}
