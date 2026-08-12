'use client';

import * as React from 'react';

import {
  Check,
  Loader2,
  RefreshCw,
  Send,
  ThumbsUp,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';

import {
  approveCreative,
  deleteCalendarEntry,
  forceResendCreative,
  regenerateCreative,
  unapproveCreative,
} from '@/app/admin/dashboard/actions';
import { Button } from '@/components/ui/button';
import { useAction } from '@/hooks/use-action';

/**
 * Manual pipeline intervention for one calendar entry.
 *
 * "Approve" releases a reviewed poster to deliver on its scheduled day; "Send
 * now" pushes it immediately regardless, reusing the stored Drive asset when one
 * exists (no fal.ai spend); "Regenerate" discards the asset, re-renders, and
 * withdraws approval so the replacement is reviewed too.
 *
 * Approve leads on unapproved rows because it is the one that belongs to the
 * normal daily loop. "Send now" sits beside it as the override it is — it bypasses
 * the approval gate entirely, which is correct for a poster the operator is
 * looking at and wrong as a habit.
 */
export function QueueCardActions({
  calendarId,
  hasAsset,
  deletable = false,
  awaitingApproval = false,
  canWithdrawApproval = false,
}: {
  calendarId: string;
  hasAsset: boolean;
  /** Offers a permanent delete — used on failed rows nobody intends to chase. */
  deletable?: boolean;
  /** Generated but unapproved: nothing will send it until someone acts. */
  awaitingApproval?: boolean;
  /** Approved with no send booked yet, so the approval is still reversible. */
  canWithdrawApproval?: boolean;
}) {
  const resend = useAction(forceResendCreative);
  const regenerate = useAction(regenerateCreative);
  const remove = useAction(deleteCalendarEntry);
  const approve = useAction(approveCreative);
  const withdraw = useAction(unapproveCreative);
  const [flash, setFlash] = React.useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);

  React.useEffect(() => {
    if (flash === null) return undefined;
    const timer = setTimeout(() => setFlash(null), 2_500);
    return () => clearTimeout(timer);
  }, [flash]);

  // A confirm prompt left open on a card the operator scrolled past is a trap;
  // it drops itself if nothing follows.
  React.useEffect(() => {
    if (!confirmingDelete) return undefined;
    const timer = setTimeout(() => setConfirmingDelete(false), 6_000);
    return () => clearTimeout(timer);
  }, [confirmingDelete]);

  const busy =
    resend.pending ||
    regenerate.pending ||
    remove.pending ||
    approve.pending ||
    withdraw.pending;

  async function handleResend() {
    const result = await resend.run(calendarId);
    if (result.ok) {
      setFlash(result.data.reusedAsset ? 'Sent from Drive' : 'Generated & sent');
    }
  }

  async function handleRegenerate() {
    const result = await regenerate.run(calendarId);
    if (result.ok) setFlash('Re-rendered — review it again');
  }

  async function handleApprove() {
    const result = await approve.run(calendarId);
    if (result.ok) {
      // The two outcomes look identical on the card otherwise, and they are not:
      // one goes out in minutes, the other on a day that has not arrived.
      setFlash(result.data.sendsNow ? 'Approved — sending shortly' : 'Approved for its day');
    }
  }

  async function handleWithdraw() {
    const result = await withdraw.run(calendarId);
    if (result.ok) setFlash('Approval withdrawn');
  }

  async function handleDelete() {
    const result = await remove.run(calendarId);
    // On success the row disappears with the next revalidation, so this
    // component unmounts; only the failure path needs the prompt reset.
    if (!result.ok) setConfirmingDelete(false);
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        {awaitingApproval && (
          <Button
            size="sm"
            onClick={handleApprove}
            disabled={busy}
            className="flex-1"
            title="Release this poster to deliver on its scheduled day"
          >
            {approve.pending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ThumbsUp className="h-4 w-4" />
            )}
            Approve
          </Button>
        )}

        <Button
          size="sm"
          variant={awaitingApproval ? 'outline' : 'default'}
          onClick={handleResend}
          disabled={busy}
          className={awaitingApproval ? undefined : 'flex-1'}
          aria-label={awaitingApproval ? 'Send this poster now' : undefined}
          title={
            awaitingApproval
              ? 'Skip the approval gate and send this poster over WhatsApp now'
              : hasAsset
                ? 'Re-send the stored Drive asset over WhatsApp now'
                : 'Generate and send this creative immediately'
          }
        >
          {resend.pending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
          {awaitingApproval ? '' : hasAsset ? 'Send now' : 'Generate & send'}
        </Button>

        <Button
          size="sm"
          variant="outline"
          onClick={handleRegenerate}
          disabled={busy}
          aria-label="Regenerate creative"
          title="Discard the stored asset, re-render with Flux.1, and hold the result for approval"
        >
          {regenerate.pending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
        </Button>

        {canWithdrawApproval && (
          <Button
            size="sm"
            variant="outline"
            onClick={handleWithdraw}
            disabled={busy}
            aria-label="Withdraw approval"
            title="Take this poster back off the schedule — only possible until a send is booked"
          >
            {withdraw.pending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Undo2 className="h-4 w-4" />
            )}
          </Button>
        )}

        {deletable && !confirmingDelete && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setConfirmingDelete(true)}
            disabled={busy}
            aria-label="Delete this calendar entry"
            title="Delete this calendar entry permanently"
            className="text-danger-ink hover:bg-danger/10 hover:text-danger-ink"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>

      {deletable && confirmingDelete && (
        <div className="flex items-center gap-2 rounded-md border border-danger/25 bg-danger/5 p-2">
          <span className="flex-1 text-[10px] leading-relaxed text-danger-ink">
            Delete this entry? The day is freed and can be re-seeded later.
          </span>
          <Button
            size="sm"
            variant="destructive"
            onClick={handleDelete}
            disabled={busy}
            title="Confirm delete"
          >
            {remove.pending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
            Delete
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setConfirmingDelete(false)}
            disabled={remove.pending}
            aria-label="Cancel delete"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}

      {flash && (
        <p className="flex items-center gap-1.5 text-[11px] text-success-ink transition-opacity duration-300">
          <Check className="h-3.5 w-3.5" />
          {flash}
        </p>
      )}

      {(resend.error ??
        regenerate.error ??
        remove.error ??
        approve.error ??
        withdraw.error) && (
        <p role="alert" className="line-clamp-3 text-[11px] text-danger-ink">
          {resend.error ?? regenerate.error ?? remove.error ?? approve.error ?? withdraw.error}
        </p>
      )}
    </div>
  );
}
