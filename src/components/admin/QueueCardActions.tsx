'use client';

import * as React from 'react';

import { Check, Loader2, RefreshCw, Send, Trash2, X } from 'lucide-react';

import {
  deleteCalendarEntry,
  forceResendCreative,
  regenerateCreative,
} from '@/app/admin/dashboard/actions';
import { Button } from '@/components/ui/button';
import { useAction } from '@/hooks/use-action';

/**
 * Manual pipeline intervention for one calendar entry.
 *
 * "Send now" reuses the stored Drive asset when one exists (no fal.ai spend);
 * "Regenerate" forces a fresh Flux.1 render and re-upload.
 */
export function QueueCardActions({
  calendarId,
  hasAsset,
  deletable = false,
}: {
  calendarId: string;
  hasAsset: boolean;
  /** Offers a permanent delete — used on failed rows nobody intends to chase. */
  deletable?: boolean;
}) {
  const resend = useAction(forceResendCreative);
  const regenerate = useAction(regenerateCreative);
  const remove = useAction(deleteCalendarEntry);
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

  const busy = resend.pending || regenerate.pending || remove.pending;

  async function handleResend() {
    const result = await resend.run(calendarId);
    if (result.ok) {
      setFlash(result.data.reusedAsset ? 'Sent from Drive' : 'Generated & sent');
    }
  }

  async function handleRegenerate() {
    const result = await regenerate.run(calendarId);
    if (result.ok) setFlash('Regenerated & sent');
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
        <Button
          size="sm"
          onClick={handleResend}
          disabled={busy}
          className="flex-1"
          title={
            hasAsset
              ? 'Re-send the stored Drive asset over WhatsApp now'
              : 'Generate and send this creative immediately'
          }
        >
          {resend.pending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
          {hasAsset ? 'Send now' : 'Generate & send'}
        </Button>

        <Button
          size="sm"
          variant="outline"
          onClick={handleRegenerate}
          disabled={busy}
          aria-label="Regenerate creative"
          title="Discard the stored asset, re-render with Flux.1, then send"
        >
          {regenerate.pending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
        </Button>

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

      {(resend.error ?? regenerate.error ?? remove.error) && (
        <p role="alert" className="line-clamp-3 text-[11px] text-danger-ink">
          {resend.error ?? regenerate.error ?? remove.error}
        </p>
      )}
    </div>
  );
}
