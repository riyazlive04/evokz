'use client';

import * as React from 'react';

import { Check, Loader2, RotateCcw } from 'lucide-react';

import { retryFailedDeliveries } from '@/app/admin/dashboard/actions';
import { Button } from '@/components/ui/button';
import { useAction } from '@/hooks/use-action';

/**
 * Bulk retry over the most recent failed deliveries.
 *
 * Capped server-side per invocation, so the label says "up to N" and the result
 * reports what is left — running it twice is expected and cheap.
 */
export function RetryFailedButton({
  clientId,
  failedCount,
}: {
  /** Omit to retry across every client (the dashboard-wide surface). */
  clientId?: string;
  failedCount: number;
}) {
  const retry = useAction(retryFailedDeliveries);
  const [flash, setFlash] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (flash === null) return undefined;
    const timer = setTimeout(() => setFlash(null), 8_000);
    return () => clearTimeout(timer);
  }, [flash]);

  if (failedCount === 0) return null;

  async function handleRetry() {
    const result = await retry.run(clientId);
    if (!result.ok) return;

    const { delivered, failed, remaining } = result.data;
    setFlash(
      remaining > 0
        ? `${delivered} sent, ${failed} still failing — ${remaining} left. Run again to continue.`
        : `${delivered} sent, ${failed} still failing. Nothing left in the queue.`,
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" onClick={handleRetry} disabled={retry.pending}>
        {retry.pending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <RotateCcw className="h-4 w-4" />
        )}
        {retry.pending ? 'Retrying…' : 'Retry failed'}
      </Button>

      <span className="text-[11px] text-muted-foreground">
        Re-sends the stored Drive asset where one exists. Rows that failed before the
        upload are re-rendered, which bills fal.ai again.
      </span>

      {flash && (
        <span className="flex items-center gap-1.5 text-[11px] text-success-ink">
          <Check className="h-3.5 w-3.5" />
          {flash}
        </span>
      )}

      {retry.error && (
        <span role="alert" className="text-[11px] text-danger-ink">
          {retry.error}
        </span>
      )}
    </div>
  );
}
