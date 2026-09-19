'use client';

import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';

import { AlertTriangle, CalendarX2, X } from 'lucide-react';

import {
  approveCampaignDayPosterAction,
  cancelCampaignDeliveryAction,
  changeCampaignStatusAction,
  generateCampaignDayPosterAction,
  retryCampaignDeliveryAction,
  sendCampaignDayNowAction,
} from '@/app/admin/campaigns/actions';
import { moveCampaignPostAction, setCampaignApprovalPolicyAction } from '@/app/admin/campaigns/board-actions';
import { BoardBulkBar, type BoardNotice } from '@/components/campaign/board/BoardBulkBar';
import { BoardDayCard, type CardActionKind } from '@/components/campaign/board/BoardDayCard';
import { BoardHeader } from '@/components/campaign/board/BoardHeader';
import { ConfirmDialog, type ConfirmRequest } from '@/components/campaign/board/board-ui';
import { DayDetailsDialog } from '@/components/campaign/board/DayDetailsDialog';
import { MovePostDialog } from '@/components/campaign/board/MovePostDialog';
import type { BoardDayView, BoardView } from '@/components/campaign/board/types';
import { Button } from '@/components/ui/button';
import { useAction } from '@/hooks/use-action';
import { planSlotPermutation, serializeBoardQuery, type BoardQuery } from '@/lib/campaign/board';
import { cn } from '@/lib/utils';

const DRAG_TYPE = 'application/x-evokz-board-day';

/** Height of the console's own sticky header, so the board header sticks just below it. */
function useConsoleHeaderHeight(): number {
  const [height, setHeight] = React.useState(0);
  React.useEffect(() => {
    const header = document.querySelector('body header');
    if (!header) return undefined;
    const update = () => setHeight(Math.round(header.getBoundingClientRect().height));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);
  return height;
}

const NOTICE_CLASS: Record<BoardNotice['tone'], string> = {
  success: 'border-success/30 bg-success/5 text-success-ink',
  warning: 'border-warning/30 bg-warning/5 text-warning-ink',
  danger: 'border-danger/30 bg-danger/5 text-danger-ink',
};

/**
 * The campaign board: a sticky header whose counters are the filters, a bulk
 * bar for the posts in view, and seven day columns with one card each.
 *
 * Every write is an existing server action (generate, approve, send, retry,
 * cancel, status) or a board action (move, auto-approve), each re-checked on
 * the server; after one succeeds the board calls `router.refresh()`, because
 * server-action revalidation does not reliably re-render this page.
 *
 * **Drag and drop** (week view): drop a card on another day column to insert
 * the post there and shift the posts in between. The move is previewed at once
 * with the same planner the server uses (`planSlotPermutation`, with the locks
 * the server computed), then sent; a refusal clears the preview and says why.
 * "Move to day…" in the card menu is the keyboard, touch and long-distance route.
 */
export function CampaignBoard({ board }: { board: BoardView }) {
  const router = useRouter();
  const pathname = usePathname();
  const [navigating, startNavigation] = React.useTransition();
  const headerOffset = useConsoleHeaderHeight();

  const generate = useAction(generateCampaignDayPosterAction);
  const approve = useAction(approveCampaignDayPosterAction);
  const send = useAction(sendCampaignDayNowAction);
  const retry = useAction(retryCampaignDeliveryAction);
  const cancel = useAction(cancelCampaignDeliveryAction);
  const move = useAction(moveCampaignPostAction);
  const statusAction = useAction(changeCampaignStatusAction);
  const policyAction = useAction(setCampaignApprovalPolicyAction);

  const [busy, setBusy] = React.useState<{ dayId: string; kind: CardActionKind } | null>(null);
  const [bulkRunning, setBulkRunning] = React.useState(false);
  const [notice, setNotice] = React.useState<BoardNotice | null>(null);
  const [confirm, setConfirm] = React.useState<ConfirmRequest | null>(null);
  const [detailsFor, setDetailsFor] = React.useState<{ dayId: string; reject: boolean } | null>(null);
  const [moveFor, setMoveFor] = React.useState<string | null>(null);
  const [dragId, setDragId] = React.useState<string | null>(null);
  const [dragOver, setDragOver] = React.useState<number | null>(null);
  /** Optimistic move preview: slot day number → the post shown there. */
  const [preview, setPreview] = React.useState<Map<number, string> | null>(null);

  const refresh = React.useCallback(() => router.refresh(), [router]);

  // New server data replaces any preview.
  React.useEffect(() => {
    setPreview(null);
  }, [board.days]);

  // Posters being generated (here, in another tab or by the server queue): keep the board current.
  const anyGenerating = board.days.some((day) => day.status === 'generating');
  React.useEffect(() => {
    if (!anyGenerating) return undefined;
    const timer = window.setInterval(refresh, 15_000);
    return () => window.clearInterval(timer);
  }, [anyGenerating, refresh]);

  const { filter, q, page } = board;
  const navigate = React.useCallback(
    (next: Partial<BoardQuery>) => {
      const query: BoardQuery = { status: filter, q, week: page.index, ...next };
      setNotice(null);
      startNavigation(() => router.push(`${pathname}${serializeBoardQuery(query)}`, { scroll: false }));
    },
    [filter, q, page.index, pathname, router],
  );

  const byId = React.useMemo(() => new Map(board.days.map((day) => [day.id, day])), [board.days]);
  const weekMode = board.mode === 'week';
  const canDrag = weekMode && !board.closed && !bulkRunning && busy === null && !move.pending;
  const anyBusy = busy !== null || bulkRunning || move.pending;

  function say(tone: BoardNotice['tone'], ...lines: string[]) {
    setNotice({ tone, lines });
  }

  async function withBusy<T>(day: BoardDayView, kind: CardActionKind, work: () => Promise<T>): Promise<T> {
    setBusy({ dayId: day.id, kind });
    try {
      return await work();
    } finally {
      setBusy(null);
    }
  }

  // ---- Card actions -------------------------------------------------------------

  async function runGenerate(day: BoardDayView, mode: 'missing' | 'regenerate') {
    const result = await withBusy(day, mode === 'missing' ? 'generate' : 'regenerate', () =>
      generate.run(board.campaignId, day.id, { mode, explicit: true }),
    );
    refresh();
    if (!result.ok) return say('danger', `Day ${day.dayNumber}: ${result.error}`);
    const outcome = result.data;
    if (outcome.outcome === 'generated') say('success', outcome.message);
    else say(outcome.outcome === 'failed' ? 'danger' : 'warning', `Day ${outcome.dayNumber}: ${outcome.message}`);
  }

  async function runApprove(day: BoardDayView) {
    if (!day.poster) return;
    const versionId = day.poster.versionId;
    const result = await withBusy(day, 'approve', () => approve.run(day.id, versionId));
    refresh();
    if (!result.ok) return say('danger', `Day ${day.dayNumber}: ${result.error}`);
    const booking = result.data.booking;
    const approved = `Day ${day.dayNumber} approved.`;
    if (!booking) return say('success', approved);
    switch (booking.result) {
      case 'booked':
      case 'rebooked':
      case 'repinned':
      case 'rescheduled':
      case 'unchanged':
        if (booking.whenLabel) {
          return booking.immediate
            ? say('warning', `${approved} Booked for ${booking.whenLabel} — it will be sent within a minute.`)
            : say('success', `${approved} Booked for ${booking.whenLabel}.`);
        }
        return say('success', board.status === 'ACTIVE' ? approved : `${approved} It is booked when the campaign is active.`);
      case 'missed':
        return say('warning', `${approved} Its delivery day has passed, so it was not booked.`);
      default:
        return say('warning', `${approved} Not booked${booking.refusal ? `: ${booking.refusal}` : '.'}`);
    }
  }

  async function runSend(day: BoardDayView) {
    const result = await withBusy(day, 'send', () => send.run(board.campaignId, day.id));
    refresh();
    if (!result.ok) return say('danger', `Day ${day.dayNumber}: ${result.error}`);
    if (result.data.ok) say('success', `Day ${day.dayNumber} was sent to the client's WhatsApp.`);
    else say('warning', `Day ${day.dayNumber} was not sent: ${result.data.message}`);
  }

  async function runRetry(day: BoardDayView, confirmAttempted = false) {
    const result = await withBusy(day, 'retry', () => retry.run(board.campaignId, day.id, { confirmAttempted }));
    refresh();
    if (!result.ok) return say('danger', `Day ${day.dayNumber}: ${result.error}`);
    say('success', `Day ${day.dayNumber} is booked again for its delivery time.`);
  }

  async function runCancel(day: BoardDayView) {
    const result = await withBusy(day, 'cancel', () => cancel.run(board.campaignId, day.id));
    refresh();
    if (!result.ok) return say('danger', `Day ${day.dayNumber}: ${result.error}`);
    say('success', `Delivery for day ${day.dayNumber} cancelled. It will not be sent.`);
  }

  function onAction(kind: CardActionKind, day: BoardDayView) {
    setNotice(null);
    switch (kind) {
      case 'details':
        setDetailsFor({ dayId: day.id, reject: false });
        return;
      case 'reject':
        setDetailsFor({ dayId: day.id, reject: true });
        return;
      case 'move':
        move.reset();
        setMoveFor(day.id);
        return;
      case 'generate':
        void runGenerate(day, 'missing');
        return;
      case 'regenerate':
        setConfirm({
          title: `Make a new poster for day ${day.dayNumber}?`,
          body: (
            <>
              <p>This is one AI image generation, billed to this client.</p>
              <p>The new version replaces the current poster and needs approval again (unless auto-approve is on). The current one stays in the day&apos;s history.</p>
              {day.poster?.source === 'POSTER_STUDIO' && (
                <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[12px] font-medium text-amber-600 dark:text-amber-400">
                  ⚠️ This poster contains custom chat edits (e.g. custom footer or details) which will be discarded on regenerate.
                </p>
              )}
            </>
          ),
          confirmLabel: 'Generate new version',
          onConfirm: () => {
            void runGenerate(day, 'regenerate');
          },
        });
        return;
      case 'approve':
        if (day.lock === 'closed' && board.status === 'ACTIVE') {
          setConfirm({
            title: `Approve day ${day.dayNumber} now?`,
            body: (
              <>
                <p>Today&apos;s delivery time has already passed.</p>
                <p>Approving books it straight away, so it will be sent to the client&apos;s WhatsApp within a minute.</p>
              </>
            ),
            confirmLabel: 'Approve and send',
            tone: 'destructive',
            onConfirm: () => runApprove(day),
          });
          return;
        }
        void runApprove(day);
        return;
      case 'send':
        setConfirm({
          title: `Send day ${day.dayNumber} now?`,
          body: (
            <>
              <p>The approved poster goes to the client&apos;s own WhatsApp number straight away, instead of at its delivery time.</p>
              <p>A day is only ever sent once.</p>
            </>
          ),
          confirmLabel: 'Send now',
          tone: 'destructive',
          onConfirm: () => runSend(day),
        });
        return;
      case 'retry':
        if (day.delivery && (day.delivery.status === 'CANCELLED' || day.delivery.status === 'SKIPPED') && day.delivery.attempts > 0) {
          setConfirm({
            title: `Book day ${day.dayNumber} again?`,
            body: (
              <>
                <p>This delivery was attempted before and may already have reached WhatsApp.</p>
                <p>Booking it again can send the client the same poster twice.</p>
              </>
            ),
            confirmLabel: 'Book again',
            tone: 'destructive',
            onConfirm: () => runRetry(day, true),
          });
          return;
        }
        void runRetry(day);
        return;
      case 'cancel':
        setConfirm({
          title: `Cancel day ${day.dayNumber}'s delivery?`,
          body: <p>It will not be sent. Retry books it again, and approving a new poster books it again automatically.</p>,
          confirmLabel: 'Cancel delivery',
          tone: 'destructive',
          onConfirm: () => runCancel(day),
        });
        return;
    }
  }

  // ---- Moving -------------------------------------------------------------------

  async function moveTo(day: BoardDayView, targetDayNumber: number): Promise<boolean> {
    setNotice(null);
    if (weekMode) {
      const plan = planSlotPermutation(
        board.days.map((candidate) => ({ id: candidate.id, dayNumber: candidate.dayNumber, scheduledDate: new Date(0), locked: candidate.lock !== null })),
        day.id,
        targetDayNumber,
      );
      const visible = new Set(board.days.map((candidate) => candidate.dayNumber));
      if (plan.ok && plan.moves.every((change) => visible.has(change.toDayNumber))) {
        const shown = new Map(board.days.map((candidate) => [candidate.dayNumber, candidate.id]));
        for (const change of plan.moves) shown.set(change.toDayNumber, change.dayId);
        setPreview(shown);
      }
    }

    const result = await move.run(board.campaignId, day.id, targetDayNumber);
    if (!result.ok) {
      setPreview(null);
      say('danger', `Day ${day.dayNumber} was not moved: ${result.error}`);
      refresh();
      return false;
    }
    const data = result.data;
    const shifted = data.moves.length - 1;
    say(
      'success',
      `Moved day ${day.dayNumber} to day ${targetDayNumber}${shifted > 0 ? `; ${shifted} other post${shifted === 1 ? '' : 's'} shifted by one day` : ''}.`,
      ...(data.rescheduled.length > 0 ? [`Delivery times follow the new dates (${data.rescheduled.length} booking${data.rescheduled.length === 1 ? '' : 's'}).`] : []),
      ...(data.rebooked.length > 0 ? [`A failed delivery now waits for its new day (day ${data.rebooked.join(', ')}).`] : []),
      ...(data.cancelled.length > 0 ? [`A failed delivery was withdrawn because its poster can no longer go out (day ${data.cancelled.join(', ')}).`] : []),
    );
    refresh();
    return true;
  }

  function onDragStart(event: React.DragEvent<HTMLElement>, day: BoardDayView) {
    if (!canDrag || !day.actions.canMove) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData(DRAG_TYPE, day.id);
    event.dataTransfer.effectAllowed = 'move';
    setDragId(day.id);
  }

  function onDragEnd() {
    setDragId(null);
    setDragOver(null);
  }

  // ---- Header switches ----------------------------------------------------------

  function toggleStatus() {
    const to = board.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
    setConfirm(
      to === 'PAUSED'
        ? {
            title: 'Pause this campaign?',
            body: <p>Nothing is generated or sent while it is paused. Bookings are kept and continue when you resume.</p>,
            confirmLabel: 'Pause',
            onConfirm: async () => {
              const result = await statusAction.run(board.campaignId, 'PAUSED');
              if (!result.ok) {
                refresh();
                return say('danger', result.error);
              }
              say('success', 'Campaign paused.');
              refresh();
            },
          }
        : {
            title: board.status === 'DRAFT' ? 'Activate this campaign?' : 'Resume this campaign?',
            body: (
              <>
                <p>Posters can then be generated, and every approved poster is booked for delivery.</p>
                <p>Booked posters are sent to the client&apos;s WhatsApp automatically on their days.</p>
              </>
            ),
            confirmLabel: board.status === 'DRAFT' ? 'Activate' : 'Resume',
            onConfirm: async () => {
              const result = await statusAction.run(board.campaignId, 'ACTIVE');
              if (!result.ok) {
                refresh();
                return say('danger', result.error);
              }
              say('success', `Campaign ${board.status === 'DRAFT' ? 'activated' : 'resumed'}.${result.data.booked > 0 ? ` ${result.data.booked} approved poster${result.data.booked === 1 ? ' is' : 's are'} now booked.` : ''}`);
              refresh();
            },
          },
    );
  }

  async function setPolicy(policy: 'MANUAL_REVIEW' | 'AUTO_APPROVE') {
    const result = await policyAction.run(board.campaignId, policy);
    if (!result.ok) {
      refresh();
      return say('danger', result.error);
    }
    say('success', policy === 'AUTO_APPROVE' ? 'Auto-approve is on. New posters are approved as they are made.' : 'Auto-approve is off. New posters wait for your approval.');
    refresh();
  }

  function togglePolicy() {
    setNotice(null);
    if (board.approvalPolicy === 'AUTO_APPROVE') {
      void setPolicy('MANUAL_REVIEW');
      return;
    }
    setConfirm({
      title: 'Turn on auto-approve?',
      body: (
        <>
          <p>Every poster generated from now on is approved as soon as it is made, and — while the campaign is active — booked and sent on its day without review.</p>
          <p>Posters already waiting for approval are not changed.</p>
        </>
      ),
      confirmLabel: 'Turn on',
      onConfirm: () => setPolicy('AUTO_APPROVE'),
    });
  }

  // ---- Render -------------------------------------------------------------------

  const detailsDay = detailsFor ? (byId.get(detailsFor.dayId) ?? null) : null;
  const moveDay = moveFor ? (byId.get(moveFor) ?? null) : null;
  const slots = board.days;

  return (
    <div className="space-y-4">
      <div
        role="region"
        aria-label="Campaign header"
        className="z-30 -mx-4 border-b border-border bg-background/95 px-4 pb-3 pt-2 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:-mx-8 sm:px-8 md:sticky"
        style={{ top: headerOffset }}
      >
        <BoardHeader
          board={board}
          navigating={navigating}
          statusPending={statusAction.pending}
          policyPending={policyAction.pending}
          onNavigate={navigate}
          onToggleStatus={toggleStatus}
          onTogglePolicy={togglePolicy}
        />
      </div>

      {board.warnings.length > 0 && (
        <ul className="space-y-1" aria-label="Campaign warnings">
          {board.warnings.map((warning) => (
            <li key={warning} className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-1.5 text-[12px] text-warning-ink">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              {warning}
            </li>
          ))}
        </ul>
      )}

      {notice && (
        <div role="status" className={cn('flex items-start gap-2 rounded-md border px-3 py-2 text-[12px]', NOTICE_CLASS[notice.tone])}>
          <div className="min-w-0 flex-1 space-y-0.5">
            {notice.lines.map((line, index) => (
              <p key={`${index}-${line}`}>{line}</p>
            ))}
          </div>
          <button type="button" aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100" onClick={() => setNotice(null)}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {!board.closed && (
        <BoardBulkBar
          campaignId={board.campaignId}
          campaignActive={board.status === 'ACTIVE'}
          queuedCount={board.queuedCount}
          days={board.days}
          disabled={anyBusy}
          onConfirm={setConfirm}
          onNotice={setNotice}
          onRefresh={refresh}
          onRunningChange={setBulkRunning}
        />
      )}

      {slots.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-4 py-12 text-center">
          <CalendarX2 className="h-6 w-6 text-muted-foreground" aria-hidden />
          <p className="text-sm text-foreground">{board.mode === 'filtered' ? 'No posts match this view.' : 'This campaign has no days.'}</p>
          {board.mode === 'filtered' && (
            <Button size="sm" variant="outline" onClick={() => navigate({ status: 'all', q: '', week: null })}>
              Show all posts
            </Button>
          )}
        </div>
      ) : (
        <ol
          aria-label={weekMode ? `Days ${slots[0]!.dayNumber} to ${slots[slots.length - 1]!.dayNumber}` : 'Matching posts'}
          aria-busy={navigating}
          className={cn(
            '-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-3 sm:-mx-8 sm:px-8 xl:mx-0 xl:grid xl:grid-cols-7 xl:overflow-visible xl:px-0 xl:pb-0',
            navigating && 'opacity-60 transition-opacity',
          )}
        >
          {slots.map((slot) => {
            const shownId = preview?.get(slot.dayNumber) ?? slot.id;
            const day = byId.get(shownId) ?? slot;
            const dropTarget = weekMode && dragId !== null && dragId !== slot.id && slot.lock === null;
            return (
              <li
                key={slot.id}
                className={cn(
                  'w-[72vw] max-w-[15rem] shrink-0 snap-start rounded-lg sm:w-56 xl:w-auto xl:max-w-none',
                  dragOver === slot.dayNumber && 'outline-dashed outline-2 outline-offset-2 outline-primary',
                )}
                onDragOver={(event) => {
                  if (!dropTarget) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  if (dragOver !== slot.dayNumber) setDragOver(slot.dayNumber);
                }}
                onDragLeave={() => setDragOver((current) => (current === slot.dayNumber ? null : current))}
                onDrop={(event) => {
                  event.preventDefault();
                  const id = event.dataTransfer.getData(DRAG_TYPE) || dragId;
                  setDragOver(null);
                  setDragId(null);
                  const moving = id ? byId.get(id) : undefined;
                  if (!moving || !dropTarget || moving.dayNumber === slot.dayNumber) return;
                  void moveTo(moving, slot.dayNumber);
                }}
              >
                <BoardDayCard
                  day={day}
                  slot={{ dayNumber: slot.dayNumber, dateLabel: slot.dateLabel, isToday: slot.isToday }}
                  closed={board.closed}
                  busyKind={busy?.dayId === day.id ? busy.kind : null}
                  disabled={anyBusy}
                  draggable={canDrag && day.actions.canMove && preview === null}
                  previewing={preview !== null && day.id !== slot.id}
                  onAction={onAction}
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                />
              </li>
            );
          })}
        </ol>
      )}

      {weekMode && !board.closed && slots.length > 0 && (
        <p className="text-[11px] text-muted-foreground">
          Drag a post onto another day to move it there; the posts in between shift by one day. Sent, sending and past days — and today, once its delivery time has passed — keep their place.
        </p>
      )}

      <DayDetailsDialog
        campaignId={board.campaignId}
        day={detailsDay}
        closed={board.closed}
        startRejecting={detailsFor?.reject ?? false}
        busyKind={busy && detailsDay && busy.dayId === detailsDay.id ? busy.kind : null}
        onClose={() => setDetailsFor(null)}
        onAction={onAction}
        onChanged={refresh}
      />
      <MovePostDialog
        day={moveDay}
        totalDays={board.totalDays}
        pending={move.pending}
        error={move.error}
        onClose={() => setMoveFor(null)}
        onMove={moveTo}
      />
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
