'use client';

import * as React from 'react';

import { ArrowRightLeft, Loader2 } from 'lucide-react';

import type { BoardDayView } from '@/components/campaign/board/types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * "Move to day…" — the keyboard, touch and long-distance route for what drag
 * and drop does on one page: the post is inserted on the chosen day and the
 * posts in between shift by one. The server plans and checks the move; this
 * dialog only asks where.
 */
export function MovePostDialog({
  day,
  totalDays,
  pending,
  error,
  onClose,
  onMove,
}: {
  day: BoardDayView | null;
  totalDays: number;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  /** Resolves true when the move succeeded. */
  onMove: (day: BoardDayView, targetDayNumber: number) => Promise<boolean>;
}) {
  return (
    <Dialog
      open={day !== null}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent className="max-w-sm">
        {day && (
          // Keyed by the post, not the row object: a board refresh (after a
          // refused move, say) must not throw away the day being typed.
          <MoveForm key={day.id} day={day} totalDays={totalDays} pending={pending} error={error} onClose={onClose} onMove={onMove} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function MoveForm({
  day,
  totalDays,
  pending,
  error,
  onClose,
  onMove,
}: {
  day: BoardDayView;
  totalDays: number;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onMove: (day: BoardDayView, targetDayNumber: number) => Promise<boolean>;
}) {
  const [target, setTarget] = React.useState(() => String(day.dayNumber));

  const value = Number(target);
  const valid = Number.isInteger(value) && value >= 1 && value <= totalDays && value !== day.dayNumber;
  const direction = valid ? (value > day.dayNumber ? 'earlier' : 'later') : null;

  return (
    <form
      className="grid gap-3.5 sm:gap-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!valid) return;
        if (await onMove(day, value)) onClose();
      }}
    >
      <DialogHeader>
        <DialogTitle>Move day {day.dayNumber}</DialogTitle>
        <DialogDescription>
          {day.headline ? `“${day.headline}” ` : 'This post '}keeps its poster, approval and booking. Sent, sending and past days — and today, once its delivery time has passed — keep their place.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-1.5">
        <Label htmlFor="move-target">Move to day</Label>
        <Input
          id="move-target"
          type="number"
          inputMode="numeric"
          min={1}
          max={totalDays}
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          autoFocus
          aria-describedby="move-target-help"
        />
        <p id="move-target-help" className="text-[11px] text-muted-foreground">
          {direction
            ? `The posts from day ${Math.min(day.dayNumber, value) + (direction === 'earlier' ? 1 : 0)} to day ${Math.max(day.dayNumber, value) - (direction === 'later' ? 1 : 0)} move one day ${direction}.`
            : `Choose a day from 1 to ${totalDays}.`}
        </p>
      </div>

      {error && (
        <p role="alert" className="text-[12px] text-danger-ink">
          {error}
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!valid || pending}>
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRightLeft className="h-4 w-4" />}
          Move
        </Button>
      </DialogFooter>
    </form>
  );
}
