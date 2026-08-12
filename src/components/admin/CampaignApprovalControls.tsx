'use client';

import * as React from 'react';

import { Check, Loader2, Sparkles, ThumbsUp } from 'lucide-react';

import {
  approveAllCreatives,
  queueCampaignGeneration,
} from '@/app/admin/dashboard/actions';
import { Button } from '@/components/ui/button';
import { useAction } from '@/hooks/use-action';

/**
 * The two campaign-wide actions on the approval surface.
 *
 * Both are deliberately shallow. "Generate" only marks rows and returns — the
 * rendering happens on the sweep, minutes later, which is why the copy talks
 * about starting rather than finishing. "Approve all" only approves; it does not
 * release back-dated posters, so the count of those is reported rather than
 * quietly acted on.
 */
export function CampaignApprovalControls({
  clientId,
  ungenerated,
  inFlight,
  awaiting,
}: {
  clientId: string;
  /** PENDING days with no poster and no pre-generation mark. */
  ungenerated: number;
  /** PENDING days already marked, waiting for the sweep to reach them. */
  inFlight: number;
  /** Generated posters nobody has approved. */
  awaiting: number;
}) {
  const queue = useAction(queueCampaignGeneration);
  const approveAll = useAction(approveAllCreatives);
  const [flash, setFlash] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (flash === null) return undefined;
    const timer = setTimeout(() => setFlash(null), 8_000);
    return () => clearTimeout(timer);
  }, [flash]);

  const busy = queue.pending || approveAll.pending;

  async function handleQueue() {
    const result = await queue.run(clientId);
    if (result.ok) {
      setFlash(
        `${result.data.queued} day(s) queued. Posters appear here as the dispatcher renders them — a few every minute. Leaving this page does not stop it.`,
      );
    }
  }

  async function handleApproveAll() {
    const result = await approveAll.run(clientId);
    if (!result.ok) return;

    setFlash(
      result.data.overdue > 0
        ? `Approved ${result.data.approved} poster(s). ${result.data.overdue} of them were scheduled for a day that has already passed, so they were not released — send those individually if you still want them to go out.`
        : `Approved ${result.data.approved} poster(s). Each delivers at its client's cron time on its scheduled day.`,
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        {(ungenerated > 0 || inFlight > 0) && (
          <Button
            type="button"
            onClick={handleQueue}
            disabled={busy || ungenerated === 0}
            title={
              ungenerated === 0
                ? 'Every remaining day is already queued'
                : 'Render every remaining day ahead of its delivery date'
            }
          >
            {queue.pending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            {ungenerated > 0
              ? `Generate ${ungenerated} poster(s)`
              : 'All remaining days queued'}
          </Button>
        )}

        {awaiting > 0 && (
          <Button
            type="button"
            variant="outline"
            onClick={handleApproveAll}
            disabled={busy}
            title="Approve every poster currently waiting on this page"
          >
            {approveAll.pending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ThumbsUp className="h-4 w-4" />
            )}
            Approve all {awaiting}
          </Button>
        )}

        {inFlight > 0 && (
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {inFlight} rendering — refresh to see them arrive
          </span>
        )}
      </div>

      {flash && (
        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-success-ink">
          <Check className="mt-px h-3.5 w-3.5 shrink-0" />
          {flash}
        </p>
      )}

      {(queue.error ?? approveAll.error) && (
        <p role="alert" className="text-[11px] text-danger-ink">
          {queue.error ?? approveAll.error}
        </p>
      )}
    </div>
  );
}
