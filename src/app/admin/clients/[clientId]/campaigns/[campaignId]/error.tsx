'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';

import { AlertTriangle, RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';

/**
 * The campaign board could not be loaded. The details stay in the server log;
 * the operator gets a retry and a way back to the client.
 *
 * "Try again" refreshes the route before resetting the boundary: `reset()` alone
 * re-renders the same failed server payload, so the page would fail again
 * without ever asking the server.
 */
export default function CampaignBoardError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const params = useParams<{ clientId: string }>();
  const router = useRouter();
  const [retrying, startRetry] = React.useTransition();

  return (
    <div role="alert" className="flex flex-col items-center gap-3 rounded-lg border border-danger/30 bg-danger/5 px-4 py-12 text-center">
      <AlertTriangle className="h-6 w-6 text-danger-ink" aria-hidden />
      <p className="text-sm font-medium text-foreground">The campaign board could not be loaded.</p>
      <p className="max-w-md text-[12px] text-muted-foreground">Nothing was changed. Try again; if it keeps failing, the reason is in the server logs.</p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button
          size="sm"
          disabled={retrying}
          onClick={() =>
            startRetry(() => {
              router.refresh();
              reset();
            })
          }
        >
          <RotateCcw className="h-4 w-4" />
          Try again
        </Button>
        {params?.clientId && (
          <Button asChild size="sm" variant="ghost">
            <Link href={`/admin/clients/${params.clientId}`}>Back to the client</Link>
          </Button>
        )}
      </div>
    </div>
  );
}
