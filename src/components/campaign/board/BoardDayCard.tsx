'use client';

import * as React from 'react';
import Link from 'next/link';

import {
  ArrowRightLeft,
  Ban,
  Check,
  Info,
  Loader2,
  Lock,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  RotateCcw,
  Send,
  Sparkles,
  TextSearch,
  X,
  type LucideIcon,
} from 'lucide-react';

import { BOARD_STATUS_VARIANT, Chip } from '@/components/campaign/board/board-ui';
import { DayMessageFields } from '@/components/campaign/board/DayMessageFields';
import type { BoardDayView } from '@/components/campaign/board/types';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type CardActionKind = 'generate' | 'regenerate' | 'approve' | 'reject' | 'send' | 'retry' | 'cancel' | 'move' | 'details';

interface CardAction {
  kind: CardActionKind;
  label: string;
  icon: LucideIcon;
}

const ACTIONS: Record<CardActionKind, CardAction> = {
  generate: { kind: 'generate', label: 'Generate', icon: Sparkles },
  regenerate: { kind: 'regenerate', label: 'Regenerate', icon: RefreshCw },
  approve: { kind: 'approve', label: 'Approve', icon: Check },
  reject: { kind: 'reject', label: 'Reject…', icon: X },
  send: { kind: 'send', label: 'Send now', icon: Send },
  retry: { kind: 'retry', label: 'Retry', icon: RotateCcw },
  cancel: { kind: 'cancel', label: 'Cancel delivery', icon: Ban },
  move: { kind: 'move', label: 'Move to day…', icon: ArrowRightLeft },
  details: { kind: 'details', label: 'Details', icon: Info },
};

/**
 * The one action a card leads with, by its status: Generate a draft, Approve a
 * poster waiting for review, Send now an approved poster that is not booked,
 * Retry a failed delivery, Regenerate a poster that needs attention. Every
 * other valid action is in the card's menu.
 */
export function primaryActionOf(day: BoardDayView): CardAction | null {
  const { actions } = day;
  switch (day.status) {
    case 'draft':
      return actions.canGenerate ? ACTIONS.generate : null;
    case 'failed':
      if (day.delivery?.status === 'FAILED' && day.delivery.pinnedToActive) return actions.canRetry ? ACTIONS.retry : null;
      if (actions.canGenerate) return { ...ACTIONS.generate, label: 'Try again', icon: RefreshCw };
      return actions.canRegenerate ? ACTIONS.regenerate : null;
    case 'needs-approval':
      return actions.canApprove ? ACTIONS.approve : null;
    case 'approved':
      return actions.canSendNow ? ACTIONS.send : actions.canRetry ? ACTIONS.retry : null;
    case 'attention':
      return actions.canRegenerate ? ACTIONS.regenerate : actions.canGenerate ? ACTIONS.generate : null;
    default:
      return null;
  }
}

function menuActionsOf(day: BoardDayView, primary: CardAction | null): CardAction[] {
  const { actions } = day;
  const items: CardAction[] = [];
  const add = (allowed: boolean, action: CardAction) => {
    if (allowed && action.kind !== primary?.kind) items.push(action);
  };
  add(actions.canRegenerate, ACTIONS.regenerate);
  add(actions.canApprove, ACTIONS.approve);
  add(actions.canReject, ACTIONS.reject);
  add(actions.canSendNow, ACTIONS.send);
  add(actions.canRetry, ACTIONS.retry);
  add(actions.canMove, ACTIONS.move);
  add(actions.canCancel, ACTIONS.cancel);
  items.push(ACTIONS.details);
  return items;
}

const NOTE_INK: Record<NonNullable<BoardDayView['note']>['tone'], string> = {
  danger: 'text-danger-ink',
  warning: 'text-warning-ink',
  muted: 'text-muted-foreground',
};

/** A small menu that opens upwards, inside the card, so the board's scroller never clips it. */
function CardMenu({ label, items, disabled, onSelect }: { label: string; items: CardAction[]; disabled: boolean; onSelect: (kind: CardActionKind) => void }) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const menuId = React.useId();

  React.useEffect(() => {
    if (!open) return undefined;
    const close = (event: MouseEvent | TouchEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('touchstart', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('touchstart', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="h-8 w-8 xl:max-2xl:w-7"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <MoreHorizontal className="h-4 w-4" />
      </Button>
      {open && (
        <ul
          id={menuId}
          role="menu"
          aria-label={label}
          className="absolute bottom-full right-0 z-20 mb-1 min-w-[10.5rem] overflow-hidden rounded-md border border-border bg-popover py-1 text-popover-foreground shadow-xl"
        >
          {items.map((item) => (
            <li key={item.kind} role="none">
              <button
                type="button"
                role="menuitem"
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-accent focus-visible:bg-accent focus-visible:outline-none',
                  (item.kind === 'cancel' || item.kind === 'reject') && 'text-danger-ink',
                )}
                onClick={() => {
                  setOpen(false);
                  onSelect(item.kind);
                }}
              >
                <item.icon className="h-3.5 w-3.5 shrink-0" />
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One day's post on the campaign board: the poster (or its template, dimmed),
 * day and date, headline, one status chip, the text-check badge, the delivery
 * time, and a compact action row — the lead action, Edit in Poster Studio, and
 * a menu with everything else.
 *
 * `slot` is where the card is drawn and `day` is the post: during a drag the
 * board previews a move by drawing posts in their new slots before the server
 * has answered.
 */
export function BoardDayCard({
  campaignId,
  day,
  slot,
  closed,
  busyKind,
  disabled,
  draggable,
  previewing,
  onAction,
  onDragStart,
  onDragEnd,
  onMessageSaved,
}: {
  campaignId: string;
  day: BoardDayView;
  slot: { dayNumber: number; dateLabel: string; isToday: boolean };
  closed: boolean;
  /** The action running on this card, if any. */
  busyKind: CardActionKind | null;
  /** Another action is running somewhere on the board. */
  disabled: boolean;
  draggable: boolean;
  previewing: boolean;
  onAction: (kind: CardActionKind, day: BoardDayView) => void;
  onDragStart: (event: React.DragEvent<HTMLElement>, day: BoardDayView) => void;
  onDragEnd: () => void;
  onMessageSaved: () => void;
}) {
  const [editingMessage, setEditingMessage] = React.useState(false);
  const primary = primaryActionOf(day);
  const menu = menuActionsOf(day, primary);
  const delivery = day.delivery;
  const showTime = delivery && (delivery.status === 'SENT' || (delivery.pinnedToActive && (delivery.status === 'SCHEDULED' || delivery.status === 'SENDING')));
  const busy = busyKind !== null;

  return (
    <article
      aria-label={`Day ${slot.dayNumber}, ${slot.dateLabel}: ${day.statusLabel}${day.headline ? ` — ${day.headline}` : ''}`}
      data-board-day={slot.dayNumber}
      draggable={draggable && !editingMessage}
      onDragStart={(event) => onDragStart(event, day)}
      onDragEnd={onDragEnd}
      className={cn(
        'relative flex h-full flex-col rounded-lg border bg-card text-card-foreground shadow-sm transition-shadow',
        slot.isToday ? 'border-primary/70' : 'border-border',
        draggable && 'cursor-grab active:cursor-grabbing',
        previewing && 'ring-2 ring-primary/50',
        busy && 'opacity-80',
      )}
    >
      {/* ---- Poster ---- */}
      <button
        type="button"
        onClick={() => onAction('details', day)}
        className="relative block aspect-[3/4] w-full overflow-hidden rounded-t-lg bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Open details for day ${slot.dayNumber}`}
      >
        {day.poster?.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={day.poster.imageUrl} alt="" draggable={false} loading="lazy" className="h-full w-full object-contain" />
        ) : day.template ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={day.template.thumbnailUrl} alt="" draggable={false} loading="lazy" className="h-full w-full object-contain opacity-35 grayscale" />
            <span className="absolute inset-x-0 bottom-2 mx-auto w-fit rounded-full border border-border bg-background/90 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {day.poster ? 'No preview' : 'Not generated'}
            </span>
          </>
        ) : (
          <span className="flex h-full w-full items-center justify-center px-3 text-center text-[11px] text-muted-foreground">
            {day.poster ? 'No preview' : 'No template yet'}
          </span>
        )}

        {day.status === 'generating' && (
          <span className="absolute inset-0 flex items-center justify-center bg-background/60">
            <Loader2 className="h-5 w-5 animate-spin text-foreground" aria-hidden />
          </span>
        )}
        {day.lock && (
          <span className="absolute left-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full border border-border bg-background/90 text-muted-foreground" title={day.lockLabel ?? undefined}>
            <Lock className="h-3 w-3" aria-hidden />
            <span className="sr-only">{day.lockLabel}</span>
          </span>
        )}
        {day.textCheckIssues > 0 && (
          <span className="absolute right-1.5 top-1.5 inline-flex items-center gap-1 rounded-full border border-warning/40 bg-background/90 px-1.5 py-0.5 text-[10px] font-semibold text-warning-ink">
            <TextSearch className="h-3 w-3" aria-hidden />
            {day.textCheckIssues}
            <span className="sr-only">{day.textCheckIssues === 1 ? 'text check difference' : 'text check differences'}</span>
          </span>
        )}
      </button>

      {/* ---- Words ---- */}
      <div className="flex flex-1 flex-col gap-1.5 p-2.5">
        <p className="flex flex-wrap items-center gap-x-1 text-[11px] text-muted-foreground">
          <span className="font-semibold text-foreground">Day {slot.dayNumber}</span>
          <span aria-hidden>·</span>
          <span>{slot.dateLabel}</span>
          {/* Negative margin: the chip is taller than the line, and would push today's words below its neighbours'. */}
          {slot.isToday && <Chip variant="default" className="-my-1 ml-auto">Today</Chip>}
        </p>
        <p className="line-clamp-2 min-h-[2.5rem] text-[12px] font-medium leading-5 text-foreground" title={day.headline ?? undefined}>
          {/* A template with no headline element (a tips list, say) still has its words: name the template rather than suggest something is missing. */}
          {day.headline ??
            (day.template ? (
              <span className="font-normal text-muted-foreground">{day.template.label}</span>
            ) : (
              <span className="font-normal italic text-muted-foreground">No headline yet</span>
            ))}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip variant={BOARD_STATUS_VARIANT[day.status]}>{day.statusLabel}</Chip>
          {showTime && delivery && (
            <span className="font-mono text-[10px] text-muted-foreground" title={delivery.whenLabel}>
              {delivery.status === 'SENDING' ? 'sending…' : delivery.status === 'SENT' ? `sent ${delivery.timeLabel}` : delivery.timeLabel}
            </span>
          )}
        </div>
        {day.note && (
          <p className={cn('line-clamp-2 text-[11px] leading-4', NOTE_INK[day.note.tone])} title={day.note.text}>
            {day.note.text}
          </p>
        )}

        {/* ---- Ready to send: what goes out with the poster ---- */}
        {day.message.shown && (
          <DayMessageFields campaignId={campaignId} day={day} onEditingChange={setEditingMessage} onSaved={onMessageSaved} />
        )}

        {/* ---- Actions ---- */}
        {/* In the seven-column week (xl up to 2xl) a card is ~140–180px wide: the
            lead action drops its icon and the two icon buttons narrow, so its label
            is not cut to "Gener…". */}
        <div className="mt-auto flex items-center gap-1 pt-1">
          {primary ? (
            <Button
              type="button"
              size="sm"
              variant={primary.kind === 'approve' || primary.kind === 'generate' ? 'default' : 'outline'}
              className="h-8 min-w-0 flex-1 gap-1.5 px-2 text-xs"
              disabled={disabled || busy}
              title={primary.label}
              onClick={() => onAction(primary.kind, day)}
            >
              {busyKind === primary.kind ? <Loader2 className="animate-spin" /> : <primary.icon className="xl:max-2xl:hidden" />}
              <span className="truncate">{busyKind === 'generate' || busyKind === 'regenerate' ? 'Generating…' : primary.label}</span>
            </Button>
          ) : busy ? (
            <span className="flex flex-1 items-center gap-1.5 text-[11px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Working…
            </span>
          ) : (
            <span className="flex-1" />
          )}
          {!closed && (
            <Button asChild size="icon" variant="ghost" className="h-8 w-8 shrink-0 xl:max-2xl:w-7">
              <Link href={`/admin/poster-studio?campaignDay=${day.id}`} aria-label={`Edit day ${slot.dayNumber} in Poster Studio`} title="Edit in Poster Studio">
                <Pencil className="h-4 w-4" />
              </Link>
            </Button>
          )}
          <CardMenu label={`More actions for day ${slot.dayNumber}`} items={menu} disabled={busy || disabled} onSelect={(kind) => onAction(kind, day)} />
        </div>
      </div>
    </article>
  );
}
