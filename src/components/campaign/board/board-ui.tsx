'use client';

import * as React from 'react';

import { Loader2 } from 'lucide-react';

import { badgeVariants } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { BoardStatus } from '@/lib/campaign/board';
import { cn } from '@/lib/utils';

/**
 * Small pieces the campaign board's components share: the status chip, its
 * colours, and one confirmation dialog for every action that spends money or
 * puts a message on a client's phone.
 */

export type ChipVariant = 'default' | 'secondary' | 'outline' | 'slate' | 'amber' | 'emerald' | 'destructive';

export const BOARD_STATUS_VARIANT: Record<BoardStatus, ChipVariant> = {
  draft: 'slate',
  generating: 'secondary',
  'needs-approval': 'default',
  approved: 'emerald',
  scheduled: 'emerald',
  sent: 'slate',
  failed: 'destructive',
  attention: 'amber',
};

/** Ink for a count in the header, by the status it counts. */
export const BOARD_STATUS_INK: Record<BoardStatus, string> = {
  draft: 'text-muted-foreground',
  generating: 'text-foreground',
  'needs-approval': 'text-foreground',
  approved: 'text-success-ink',
  scheduled: 'text-success-ink',
  sent: 'text-muted-foreground',
  failed: 'text-danger-ink',
  attention: 'text-warning-ink',
};

export function Chip({ variant, className, children }: { variant: ChipVariant; className?: string; children: React.ReactNode }) {
  return <span className={cn(badgeVariants({ variant }), 'whitespace-nowrap px-2 text-[10px]', className)}>{children}</span>;
}

export interface ConfirmRequest {
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  /** Destructive styling for cancelling or sending. */
  tone?: 'default' | 'destructive';
  onConfirm: () => Promise<void> | void;
}

/** One confirmation at a time, for the whole board. */
export function ConfirmDialog({ request, onClose }: { request: ConfirmRequest | null; onClose: () => void }) {
  const [running, setRunning] = React.useState(false);

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open && !running) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        {request && (
          <>
            <DialogHeader>
              <DialogTitle>{request.title}</DialogTitle>
              <DialogDescription asChild>
                <div className="space-y-1.5 text-[12px] text-muted-foreground">{request.body}</div>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={onClose} disabled={running}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant={request.tone === 'destructive' ? 'destructive' : 'default'}
                disabled={running}
                onClick={async () => {
                  setRunning(true);
                  try {
                    await request.onConfirm();
                  } finally {
                    setRunning(false);
                    onClose();
                  }
                }}
              >
                {running && <Loader2 className="h-4 w-4 animate-spin" />}
                {request.confirmLabel}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
