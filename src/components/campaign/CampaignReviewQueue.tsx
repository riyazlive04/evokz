'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

import { AlertTriangle, Check, ImageOff, Loader2, Search } from 'lucide-react';

import { approveCampaignDayPosterAction, approveCampaignPostersAction } from '@/app/admin/campaigns/actions';
import { CampaignDayDetail } from '@/components/campaign/CampaignDayDetail';
import { badgeVariants } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAction } from '@/hooks/use-action';
import type { PosterState } from '@/lib/campaign/poster-generation';
import { matchesFilter, type ReviewFilter } from '@/lib/campaign/review';
import { describeDays } from '@/lib/campaign/template-mapping';
import { studioImageUrl } from '@/lib/poster-studio/limits';
import { cn } from '@/lib/utils';

type Variant = 'default' | 'secondary' | 'outline' | 'slate' | 'amber' | 'emerald' | 'destructive';

export type ReviewFilterView = ReviewFilter;

export interface ReviewDayView {
  dayId: string;
  dayNumber: number;
  dateLabel: string;
  headline: string | null;
  contentTypeLabel: string | null;
  templateLabel: string | null;
  templateSource: 'AUTO' | 'MANUAL' | null;
  state: PosterState;
  stateLabel: string;
  generationId: string | null;
  versionNumber: number | null;
  versionCount: number;
  rejection: { label: string; detail: string | null } | null;
  warning: string | null;
  canApprove: boolean;
  /** Why this day cannot be approved, when it cannot. */
  approvalRefusal: string | null;
  inWindow: boolean;
  unmapped: boolean;
  activeVersionId: string | null;
}

export interface ReviewSummaryView {
  total: number;
  needsReview: number;
  approved: number;
  rejected: number;
  outdated: number;
  failed: number;
  unmapped: number;
  notGenerated: number;
  generating: number;
  attention: number;
}

export interface ReadinessView {
  content: { done: number; total: number };
  templates: { done: number; total: number };
  posters: { done: number; total: number };
  approved: { done: number; total: number };
  attention: number;
  deliveryReady: number;
  windowReady: boolean;
  description: string;
}

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

function Tag({ variant, children }: { variant: Variant; children: React.ReactNode }) {
  return <span className={badgeVariants({ variant })}>{children}</span>;
}

/**
 * The campaign's review queue (Phase 5): what still needs a decision, and the
 * decisions themselves.
 *
 * Every state shown is Phase 4's derived poster state; approving writes through
 * Phase 1's approval on the day's active version. Bulk approval never touches an
 * outdated, rejected, failed, generating, missing or unmapped day — the server
 * plans the same way and reports what it skipped.
 */
export function CampaignReviewQueue({
  campaignId,
  closed,
  days,
  summary,
  readiness,
  windowDays,
  initialFilter = 'all',
}: {
  campaignId: string;
  closed: boolean;
  days: ReviewDayView[];
  summary: ReviewSummaryView;
  readiness: ReadinessView;
  windowDays: number;
  initialFilter?: ReviewFilterView;
}) {
  const router = useRouter();
  const approve = useAction(approveCampaignDayPosterAction);
  const bulk = useAction(approveCampaignPostersAction);

  const [filter, setFilter] = React.useState<ReviewFilterView>(initialFilter);
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set());
  const [openDay, setOpenDay] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<{ tone: 'success' | 'warning'; lines: string[] } | null>(null);

  const busy = approve.pending || bulk.pending;
  const visible = days.filter((day) => matchesFilter(day, filter));
  const selectedDays = days.filter((day) => selected.has(day.dayId));
  const canApproveCount = selectedDays.filter((day) => day.canApprove).length;
  const skippedCount = selectedDays.length - canApproveCount;

  function toggle(dayId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(dayId)) next.delete(dayId);
      else next.add(dayId);
      return next;
    });
  }

  async function approveSelected() {
    setResult(null);
    const outcome = await bulk.run(campaignId, [...selected]);
    if (!outcome.ok) return;
    const data = outcome.data;
    const lines = [
      data.approved.length > 0
        ? `Approved ${data.approved.length} poster(s): ${describeDays(data.approved)}.`
        : 'Nothing was approved.',
      ...data.skipped.map((group) => `Skipped ${describeDays(group.dayNumbers)} — ${group.message}`),
      ...(data.conflicts.length > 0 ? [`${describeDays(data.conflicts)} changed while approving and were left alone.`] : []),
    ];
    setResult({ tone: data.skippedCount > 0 || data.conflicts.length > 0 ? 'warning' : 'success', lines });
    setSelected(new Set());
    router.refresh();
  }

  const counts: Array<{ filter: ReviewFilterView; label: string; value: number; tone: Variant }> = [
    { filter: 'needs-review', label: 'Needs review', value: summary.needsReview, tone: summary.needsReview > 0 ? 'amber' : 'slate' },
    { filter: 'rejected', label: 'Rejected', value: summary.rejected, tone: summary.rejected > 0 ? 'destructive' : 'slate' },
    { filter: 'outdated', label: 'Outdated', value: summary.outdated, tone: summary.outdated > 0 ? 'amber' : 'slate' },
    { filter: 'failed', label: 'Failed', value: summary.failed, tone: summary.failed > 0 ? 'destructive' : 'slate' },
    { filter: 'approved', label: 'Approved', value: summary.approved, tone: 'emerald' },
    { filter: 'unmapped', label: 'Unmapped', value: summary.unmapped, tone: summary.unmapped > 0 ? 'amber' : 'slate' },
  ];

  return (
    <section aria-label="Campaign review" className="space-y-4">
      {/* ---- Readiness ---- */}
      <section aria-label="Campaign readiness" className="space-y-2 rounded-lg border border-border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-foreground">Campaign readiness</h3>
          <Tag variant={readiness.windowReady ? 'emerald' : 'amber'}>
            {readiness.windowReady ? `Ready for the next ${windowDays} days` : 'Not ready'}
          </Tag>
        </div>
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {[
            ['Content', `${readiness.content.done} / ${readiness.content.total}`],
            ['Templates', `${readiness.templates.done} / ${readiness.templates.total}`],
            [`Posters (next ${windowDays}d)`, `${readiness.posters.done} / ${readiness.posters.total}`],
            ['Approved', `${readiness.approved.done} / ${readiness.approved.total}`],
            ['Attention', String(readiness.attention)],
          ].map(([label, value]) => (
            <div key={label} className="rounded-md border border-border px-2.5 py-2">
              <dt className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{label}</dt>
              <dd className="font-mono text-base font-semibold text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="text-[11px] text-muted-foreground">{readiness.description}</p>
      </section>

      {/* ---- Needs attention counts, each a filter ---- */}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant={filter === 'attention' ? 'secondary' : 'outline'} onClick={() => setFilter('attention')}>
          <AlertTriangle className="h-4 w-4" />
          Needs attention ({summary.attention})
        </Button>
        {counts.map((count) => (
          <Button
            key={count.filter}
            size="sm"
            variant="ghost"
            onClick={() => setFilter(count.filter)}
            aria-label={`${count.label} (${count.value})`}
            aria-pressed={filter === count.filter}
            className={cn(filter === count.filter && 'bg-accent')}
          >
            <span className={cn('font-mono font-semibold', count.tone === 'emerald' ? 'text-success-ink' : count.tone === 'amber' ? 'text-warning-ink' : count.tone === 'destructive' ? 'text-danger-ink' : 'text-foreground')}>
              {count.value}
            </span>
            {count.label}
          </Button>
        ))}
        <Button size="sm" variant={filter === 'all' ? 'secondary' : 'ghost'} onClick={() => setFilter('all')}>
          <Search className="h-4 w-4" />
          All ({summary.total})
        </Button>
      </div>

      {/* ---- Selection and bulk approval ---- */}
      {!closed && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2">
          <Button size="sm" variant="outline" onClick={() => setSelected(new Set(visible.map((day) => day.dayId)))} disabled={busy || visible.length === 0}>
            Select shown ({visible.length})
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())} disabled={busy || selected.size === 0}>
            Clear selection
          </Button>
          <p className="text-[12px] text-foreground">
            Selected: <span className="font-semibold">{selectedDays.length}</span> · Can approve:{' '}
            <span className="font-semibold text-success-ink">{canApproveCount}</span> · Skipped:{' '}
            <span className={cn('font-semibold', skippedCount > 0 && 'text-warning-ink')}>{skippedCount}</span>
          </p>
          <Button size="sm" onClick={() => void approveSelected()} disabled={busy || canApproveCount === 0}>
            {bulk.pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Approve selected ({canApproveCount})
          </Button>
        </div>
      )}

      {result && (
        <div role="status" className={cn('space-y-0.5 rounded-md border px-3 py-2 text-[12px]', result.tone === 'success' ? 'border-success/30 bg-success/5 text-success-ink' : 'border-warning/30 bg-warning/5 text-warning-ink')}>
          {result.lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}
      {(approve.error ?? bulk.error) && (
        <p role="alert" className="text-[12px] text-danger-ink">
          {approve.error ?? bulk.error}
        </p>
      )}

      {/* ---- Queue ---- */}
      <ol className="divide-y divide-border rounded-lg border border-border">
        {visible.map((day) => (
          <li key={day.dayId} data-review-day={day.dayNumber} className="grid grid-cols-[auto_2.5rem_minmax(0,1fr)] items-start gap-3 px-3 py-2.5 sm:grid-cols-[auto_2.5rem_minmax(0,1fr)_auto] sm:items-center">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 sm:mt-0"
              checked={selected.has(day.dayId)}
              onChange={() => toggle(day.dayId)}
              aria-label={`Select day ${day.dayNumber}`}
              disabled={closed}
            />
            <div className="flex h-[3.6rem] w-10 items-center justify-center overflow-hidden rounded-sm border border-border bg-muted">
              {day.generationId ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={studioImageUrl(day.generationId, { width: 120 })} alt={`Day ${day.dayNumber} poster`} loading="lazy" className="h-full w-full object-cover" />
              ) : (
                <ImageOff className="h-3.5 w-3.5 text-muted-foreground" />
              )}
            </div>

            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-semibold text-foreground">Day {day.dayNumber}</span>
                <span className="font-mono text-[11px] text-muted-foreground">{day.dateLabel}</span>
                <Tag variant={STATE_VARIANT[day.state]}>{day.stateLabel}</Tag>
                {day.versionNumber !== null && (
                  <span className="text-[10px] text-muted-foreground">
                    v{day.versionNumber}
                    {day.versionCount > 1 ? ` of ${day.versionCount}` : ''}
                  </span>
                )}
                {day.contentTypeLabel && <Tag variant="outline">{day.contentTypeLabel}</Tag>}
              </div>
              {day.headline && <p className="truncate text-[12px] text-foreground">{day.headline}</p>}
              <p className="text-[10px] text-muted-foreground">
                Template: {day.templateLabel ?? 'not mapped'}
                {day.templateSource ? ` · ${day.templateSource === 'MANUAL' ? 'Manual' : 'Auto'}` : ''}
              </p>
              {day.rejection && (
                <p className="flex items-start gap-1 text-[11px] text-danger-ink">
                  <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                  {day.rejection.label}
                  {day.rejection.detail ? ` — ${day.rejection.detail}` : ''}
                </p>
              )}
              {!day.rejection && day.warning && (
                <p className="flex items-start gap-1 text-[11px] text-warning-ink">
                  <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                  {day.warning}
                </p>
              )}
              {selected.has(day.dayId) && day.approvalRefusal && (
                <p className="text-[11px] text-muted-foreground">Skipped by Approve selected — {day.approvalRefusal}</p>
              )}
            </div>

            <div className="col-span-3 flex flex-wrap items-center gap-1.5 sm:col-span-1 sm:justify-end">
              <Button size="sm" variant="outline" onClick={() => setOpenDay(day.dayId)}>
                Review
              </Button>
              {!closed && day.canApprove && day.activeVersionId && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={async () => {
                    const outcome = await approve.run(day.dayId, day.activeVersionId!);
                    if (outcome.ok) {
                      setResult({ tone: 'success', lines: [`Day ${day.dayNumber} approved.`] });
                      router.refresh();
                    }
                  }}
                >
                  <Check className="h-3.5 w-3.5" />
                  Approve
                </Button>
              )}
            </div>
          </li>
        ))}
        {visible.length === 0 && (
          <li className="px-3 py-6 text-center text-[12px] text-muted-foreground">
            {filter === 'attention' ? 'Nothing needs attention.' : 'No days in this view.'}
          </li>
        )}
      </ol>

      <CampaignDayDetail dayId={openDay} onClose={() => setOpenDay(null)} onChanged={() => router.refresh()} />
    </section>
  );
}

