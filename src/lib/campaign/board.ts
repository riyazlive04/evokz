import type { CampaignDeliveryStatus } from '@prisma/client';

import { deliveryInstant, isDue } from '@/lib/campaign/delivery';
import type { PosterState } from '@/lib/campaign/poster-generation';
import { getZonedParts, startOfZonedDay } from '@/lib/time';

/**
 * The one-screen campaign board — its pure rules.
 *
 * What status a day's card shows, how the header's counters filter the board,
 * how the board is paged, and how a post is moved to another day. No database,
 * no network, no React: `board-service.ts` applies these to rows, the board's
 * client components reuse the same functions for their optimistic preview, and
 * `npm run check:campaign-board` pins every rule here.
 *
 * **Nothing here re-decides a Phase 4–6 rule.** A card's status is built from
 * Phase 4's derived poster state (`derivePosterState`) and Phase 6's delivery
 * row; whether a day may be generated, approved or sent is still answered by
 * those phases' own gates in the service. This module only arranges their
 * answers for one screen.
 */

// ---------------------------------------------------------------------------
// Card status
// ---------------------------------------------------------------------------

export const BOARD_STATUSES = [
  'draft',
  'generating',
  'needs-approval',
  'approved',
  'scheduled',
  'sent',
  'failed',
  'attention',
] as const;

export type BoardStatus = (typeof BOARD_STATUSES)[number];

export const BOARD_STATUS_LABELS: Record<BoardStatus, string> = {
  draft: 'Draft',
  generating: 'Generating',
  'needs-approval': 'Needs approval',
  approved: 'Approved',
  scheduled: 'Scheduled',
  sent: 'Sent',
  failed: 'Failed',
  attention: 'Needs attention',
};

export function isBoardStatus(value: string): value is BoardStatus {
  return (BOARD_STATUSES as readonly string[]).includes(value);
}

export interface BoardStatusInput {
  /** Phase 4's derived state of the day's poster. */
  posterState: PosterState;
  /** The day's active version, which is the only one a delivery may carry. */
  activeVersionId: string | null;
  /** The day's one delivery row (Phase 6), when it has one. */
  delivery: { status: CampaignDeliveryStatus; posterVersionId: string } | null;
}

/**
 * The single status a card shows, first match wins:
 *
 * | status           | when                                                                  |
 * |------------------|-----------------------------------------------------------------------|
 * | `sent`           | the delivery is SENT — terminal, whatever changed since               |
 * | `scheduled`      | the delivery is SENDING (on its way right now)                        |
 * | `generating`     | a generation is queued or running                                     |
 * | `failed`         | the delivery of the active poster FAILED, or generation failed and    |
 * |                  | there is no poster                                                    |
 * | `attention`      | the poster is outdated or rejected, or the day is blocked by          |
 * |                  | something a person must fix (template, Brand Canvas, format)          |
 * | `scheduled`      | the poster is approved and its delivery is booked (SCHEDULED)         |
 * | `approved`       | the poster is approved, nothing booked (paused, not configured,       |
 * |                  | cancelled or missed)                                                  |
 * | `needs-approval` | the poster is current and pending review                              |
 * | `draft`          | no poster yet, nothing blocking                                       |
 *
 * A delivery row only speaks for the day while it carries the day's active
 * version: a booking pinned to a replaced poster is stale (the sender refuses
 * it), so the card shows the new poster's state instead. SENT and SENDING are
 * the exceptions — a message that left, or is leaving, is a fact.
 */
export function boardStatusOf(input: BoardStatusInput): BoardStatus {
  const delivery = input.delivery;
  if (delivery?.status === 'SENT') return 'sent';
  if (delivery?.status === 'SENDING') return 'scheduled';

  const state = input.posterState;
  if (state === 'generating') return 'generating';

  const pinnedToActive = delivery !== null && input.activeVersionId !== null && delivery.posterVersionId === input.activeVersionId;
  if (pinnedToActive && delivery.status === 'FAILED') return 'failed';
  if (state === 'failed') return 'failed';

  if (state === 'outdated' || state === 'rejected' || state === 'needs-attention') return 'attention';

  if (state === 'approved') return pinnedToActive && delivery.status === 'SCHEDULED' ? 'scheduled' : 'approved';
  if (state === 'needs-approval') return 'needs-approval';
  return 'draft';
}

/**
 * What a card offers. Each flag is the answer of the phase that owns the rule —
 * poster eligibility, approval, the delivery gate, the move lock — computed on
 * the server; the server re-checks every one of them when the action runs.
 */
export interface BoardDayActions {
  /** Generate the first poster (Phase 4 `missing`, explicit). */
  canGenerate: boolean;
  /** Generate a new version over an existing poster (Phase 4 `regenerate`, explicit). */
  canRegenerate: boolean;
  canApprove: boolean;
  canReject: boolean;
  /** The delivery gate passes now (Send Now ignores only the moment). */
  canSendNow: boolean;
  /** Put a failed, cancelled or skipped delivery back in the queue. */
  canRetry: boolean;
  canCancel: boolean;
  canMove: boolean;
}

export type BoardCounts = Record<BoardStatus | 'all', number>;

/** Counts per status, plus `all` — the header's counters, which are also its filters. */
export function countBoardStatuses(statuses: Iterable<BoardStatus>): BoardCounts {
  const counts = Object.fromEntries([['all', 0], ...BOARD_STATUSES.map((status) => [status, 0])]) as BoardCounts;
  for (const status of statuses) {
    counts[status] += 1;
    counts.all += 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Filters in the URL
// ---------------------------------------------------------------------------

export type BoardFilter = BoardStatus | 'all';

export interface BoardQuery {
  status: BoardFilter;
  /** 1-based page. Null means "the page with today on it" (week view) or the first page (filtered view). */
  week: number | null;
  /** Normalised search text; empty for none. */
  q: string;
}

export const MAX_BOARD_SEARCH = 80;

/**
 * The query strings of the retired review and delivery queues, still linked
 * from the client page and from bookmarks. Each maps onto the board status that
 * shows the same days, so an old link opens the right view rather than nothing.
 */
const LEGACY_REVIEW_FILTERS: Record<string, BoardFilter> = {
  all: 'all',
  'needs-review': 'needs-approval',
  approved: 'approved',
  failed: 'failed',
  rejected: 'attention',
  outdated: 'attention',
  unmapped: 'attention',
  attention: 'attention',
};

const LEGACY_DELIVERY_FILTERS: Record<string, BoardFilter> = {
  all: 'all',
  scheduled: 'scheduled',
  sent: 'sent',
  failed: 'failed',
};

type ParamSource = URLSearchParams | Record<string, string | string[] | undefined> | undefined;

function readParam(params: ParamSource, key: string): string | null {
  if (!params) return null;
  if (params instanceof URLSearchParams) return params.get(key);
  const value = params[key];
  return typeof value === 'string' ? value : Array.isArray(value) ? (value[0] ?? null) : null;
}

/** Collapses whitespace and caps the length, so the URL and the matcher agree. */
export function normalizeBoardSearch(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_BOARD_SEARCH);
}

/**
 * `?status=&week=&q=` → a query. Anything malformed falls back to the default
 * rather than failing: a hand-edited URL opens the board, not an error page.
 */
export function parseBoardQuery(params: ParamSource): BoardQuery {
  const rawStatus = readParam(params, 'status');
  let status: BoardFilter = 'all';
  if (rawStatus && (rawStatus === 'all' || isBoardStatus(rawStatus))) {
    status = rawStatus;
  } else {
    const legacy = readParam(params, 'review') ?? '';
    const legacyDelivery = readParam(params, 'delivery') ?? '';
    status = LEGACY_REVIEW_FILTERS[legacy] ?? LEGACY_DELIVERY_FILTERS[legacyDelivery] ?? 'all';
  }

  const rawWeek = readParam(params, 'week');
  const week = rawWeek && /^\d{1,4}$/.test(rawWeek) && Number(rawWeek) >= 1 ? Number(rawWeek) : null;

  return { status, week, q: normalizeBoardSearch(readParam(params, 'q')) };
}

/** A query → `?status=…&week=…&q=…`, omitting defaults. Empty string when nothing is set. */
export function serializeBoardQuery(query: Partial<BoardQuery>): string {
  const params = new URLSearchParams();
  if (query.status && query.status !== 'all') params.set('status', query.status);
  if (query.week) params.set('week', String(query.week));
  const q = normalizeBoardSearch(query.q);
  if (q) params.set('q', q);
  const text = params.toString();
  return text ? `?${text}` : '';
}

/** A filter or a search is active: the board lists matching days across the campaign. */
export function isFilteredQuery(query: Pick<BoardQuery, 'status' | 'q'>): boolean {
  return query.status !== 'all' || query.q.length > 0;
}

/**
 * Whether a day matches the search box: its headline (case-insensitive), or its
 * day number when the search is one — "12", "day 12", "#12".
 */
export function matchesBoardSearch(day: { dayNumber: number; headline: string | null }, query: string): boolean {
  const q = normalizeBoardSearch(query).toLowerCase();
  if (!q) return true;
  const number = /^(?:day\s*|#)?(\d{1,4})$/.exec(q);
  if (number && Number(number[1]) === day.dayNumber) return true;
  return (day.headline ?? '').toLowerCase().includes(q);
}

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

/**
 * Seven posts per page.
 *
 * **Pages are runs of seven consecutive day numbers, not calendar weeks.** Day
 * numbers are the campaign's post slots in order (`planCampaignSlots`), so page
 * k is days 7k−6 … 7k and every column of the board is exactly one post slot —
 * which is what a drop target has to be. A calendar-week page would leave empty
 * columns on a Mon/Wed/Fri campaign and put a varying number of posts on each
 * page. "Today" stays one lookup: the page of the first day dated today or
 * later. The label still reads as dates ("17–23 Sept"), from the first and last
 * slot on the page.
 */
export const BOARD_PAGE_SIZE = 7;

/** The 1-based page a day number is on. */
export function weekOf(dayNumber: number): number {
  return Math.max(1, Math.ceil(dayNumber / BOARD_PAGE_SIZE));
}

export function pageCount(total: number): number {
  return Math.max(1, Math.ceil(total / BOARD_PAGE_SIZE));
}

export function clampPage(page: number, count: number): number {
  if (!Number.isFinite(page)) return 1;
  return Math.min(Math.max(1, Math.trunc(page)), Math.max(1, count));
}

/** The items on one page of a list already in board order. */
export function pageSlice<T>(items: readonly T[], page: number): T[] {
  const start = (page - 1) * BOARD_PAGE_SIZE;
  return items.slice(start, start + BOARD_PAGE_SIZE);
}

/**
 * The page "Today" jumps to: the one holding the first day dated today or later.
 * A campaign that has not started opens on page 1; one that has finished, on
 * its last page.
 */
export function todayPage(
  days: ReadonlyArray<{ dayNumber: number; scheduledDate: Date }>,
  now: Date,
  timeZone: string,
): number {
  if (days.length === 0) return 1;
  const today = startOfZonedDay(now, timeZone).getTime();
  const ordered = [...days].sort((a, b) => a.dayNumber - b.dayNumber);
  const upcoming = ordered.find((day) => day.scheduledDate.getTime() >= today);
  return weekOf((upcoming ?? ordered[ordered.length - 1]!).dayNumber);
}

const MONTH_FORMAT = new Map<string, Intl.DateTimeFormat>();

function monthName(date: Date, timeZone: string): string {
  let format = MONTH_FORMAT.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone });
    MONTH_FORMAT.set(timeZone, format);
  }
  return format.format(date);
}

/**
 * "17–23 Sept", "28 Sept – 4 Oct", "29 Dec 2026 – 4 Jan 2027", or "17 Sept" for
 * a single day — the local dates of a page's first and last slot.
 */
export function formatPageLabel(first: Date, last: Date, timeZone: string): string {
  const a = getZonedParts(first, timeZone);
  const b = getZonedParts(last, timeZone);
  const monthA = monthName(first, timeZone);
  const monthB = monthName(last, timeZone);
  if (a.year === b.year && a.month === b.month) {
    return a.day === b.day ? `${a.day} ${monthA}` : `${a.day}–${b.day} ${monthA}`;
  }
  if (a.year === b.year) return `${a.day} ${monthA} – ${b.day} ${monthB}`;
  return `${a.day} ${monthA} ${a.year} – ${b.day} ${monthB} ${b.year}`;
}

// ---------------------------------------------------------------------------
// Moving a post
// ---------------------------------------------------------------------------

/**
 * Why a slot keeps its post whatever else moves.
 *
 * `sent`     the message left — the day's history is fixed.
 * `sending`  a worker holds the delivery claim right now.
 * `due`      the booking's moment has arrived and the sweep may be sending it
 *            this minute. The sender does not re-check the moment after its
 *            claim, so moving a due post could deliver it on its old slot; it
 *            is held in place instead, exactly like SENDING.
 * `past`     the slot's date is before local today: there is nothing to
 *            rearrange in the past.
 * `closed`   the slot is today and today's delivery time has already come
 *            (`deliveryInstant`, the booking's own base moment). A post moved
 *            into it would be due at once and sent on the next sweep, and the
 *            post already on it is about to go — so nothing moves into or out
 *            of it. Sending it now is what Send now is for.
 *
 * Generation in progress does not lock a slot: a poster being made belongs to
 * the post, and the post keeps its identity wherever it goes.
 */
export type SlotLock = 'sent' | 'sending' | 'due' | 'past' | 'closed';

export const SLOT_LOCK_LABELS: Record<SlotLock, string> = {
  sent: 'Sent — this day is fixed.',
  sending: 'Being sent right now.',
  due: 'Due to be sent now.',
  past: 'This day has passed.',
  closed: "Today's delivery time has passed.",
};

export interface MovableDay {
  id: string;
  dayNumber: number;
  /** Local midnight of the slot's date. */
  scheduledDate: Date;
  delivery: { status: CampaignDeliveryStatus; scheduledFor: Date } | null;
}

/**
 * @param deliveryTime The campaign's "HH:MM". Without it the `closed` lock is
 *   not decided — only callers that know the campaign should omit it.
 */
export function slotLockOf(day: MovableDay, now: Date, timeZone: string, deliveryTime?: string): SlotLock | null {
  if (day.delivery?.status === 'SENT') return 'sent';
  if (day.delivery?.status === 'SENDING') return 'sending';
  // A past day is `past` even when a stale booking on it is technically due:
  // it is never sent late (the sync marks it missed), and Send now is not offered.
  const today = startOfZonedDay(now, timeZone).getTime();
  if (day.scheduledDate.getTime() < today) return 'past';
  if (day.delivery?.status === 'SCHEDULED' && day.delivery.scheduledFor.getTime() <= now.getTime()) return 'due';
  if (
    deliveryTime !== undefined &&
    startOfZonedDay(day.scheduledDate, timeZone).getTime() === today &&
    deliveryInstant(day.scheduledDate, deliveryTime, timeZone).getTime() <= now.getTime()
  ) {
    return 'closed';
  }
  return null;
}

export type PostMoveRefusal = 'not-found' | 'no-op' | 'out-of-range' | 'source-locked' | 'target-locked';

export const POST_MOVE_REFUSAL_MESSAGES: Record<PostMoveRefusal, string> = {
  'not-found': 'That post is not part of this campaign.',
  'no-op': 'The post is already on that day.',
  'out-of-range': 'Choose a day within the campaign.',
  'source-locked': "This post can no longer be moved — it has been sent, is being sent, or its day or today's delivery time has passed.",
  'target-locked': "That day can no longer change — its post has been sent, is being sent, or its day or today's delivery time has passed.",
};

/** One row whose slot changes. The row keeps its id, content, versions, approval and delivery. */
export interface PostMoveChange {
  dayId: string;
  fromDayNumber: number;
  toDayNumber: number;
  /** The new slot's date. */
  scheduledDate: Date;
}

export type PostMovePlan =
  | { ok: true; moves: PostMoveChange[] }
  | { ok: false; reason: PostMoveRefusal; message: string };

/** A slot as the permutation sees it: where it is, and whether it may change. */
export interface PlannedSlot {
  id: string;
  dayNumber: number;
  scheduledDate: Date;
  locked: boolean;
}

function refuseMove(reason: PostMoveRefusal): PostMovePlan {
  return { ok: false, reason, message: POST_MOVE_REFUSAL_MESSAGES[reason] };
}

/**
 * INSERT-AND-SHIFT over slots whose locks are already known.
 *
 * The ordered (dayNumber, scheduledDate) slots of the **unlocked** rows are
 * kept; the rows are re-ordered among them. The moving row is taken out and
 * inserted at the target's position, so every unlocked row between the two
 * positions shifts one unlocked slot towards the gap: moving day 3 to day 6
 * puts days 4–6 on 3–5; moving day 6 to day 3 puts days 3–5 on 4–6. Locked
 * rows keep their slots and are stepped over, and no row can be moved into or
 * out of a locked slot. Rows outside the span do not change.
 *
 * Returns only the rows whose slot changed, in their new order. The client
 * board uses this directly for its optimistic preview with locks computed on
 * the server; `planPostMove` computes the locks itself.
 */
export function planSlotPermutation(slots: readonly PlannedSlot[], movingDayId: string, targetDayNumber: number): PostMovePlan {
  const ordered = [...slots].sort((a, b) => a.dayNumber - b.dayNumber);
  const moving = ordered.find((slot) => slot.id === movingDayId);
  if (!moving) return refuseMove('not-found');

  if (!Number.isInteger(targetDayNumber)) return refuseMove('out-of-range');
  const target = ordered.find((slot) => slot.dayNumber === targetDayNumber);
  if (!target) return refuseMove('out-of-range');
  if (target.id === moving.id) return refuseMove('no-op');
  if (moving.locked) return refuseMove('source-locked');
  if (target.locked) return refuseMove('target-locked');

  const unlocked = ordered.filter((slot) => !slot.locked);
  const places = unlocked.map((slot) => ({ dayNumber: slot.dayNumber, scheduledDate: slot.scheduledDate }));
  const targetIndex = unlocked.findIndex((slot) => slot.id === target.id);

  const rows = unlocked.filter((slot) => slot.id !== moving.id);
  rows.splice(targetIndex, 0, moving);

  const moves: PostMoveChange[] = [];
  rows.forEach((row, index) => {
    const place = places[index]!;
    if (place.dayNumber !== row.dayNumber) {
      moves.push({ dayId: row.id, fromDayNumber: row.dayNumber, toDayNumber: place.dayNumber, scheduledDate: place.scheduledDate });
    }
  });
  return { ok: true, moves };
}

/**
 * Plans moving one post to another day of its campaign, by id.
 *
 * Locks are decided from each row's delivery, date and the campaign's delivery
 * time (`slotLockOf`) at `now`,
 * then `planSlotPermutation` does the rest. The caller writes the result in one
 * transaction; nothing here touches content, versions, approval or bookings.
 */
export function planPostMove(
  days: readonly MovableDay[],
  movingDayId: string,
  targetDayNumber: number,
  now: Date,
  timeZone: string,
  deliveryTime?: string,
): PostMovePlan {
  return planSlotPermutation(
    days.map((day) => ({ id: day.id, dayNumber: day.dayNumber, scheduledDate: day.scheduledDate, locked: slotLockOf(day, now, timeZone, deliveryTime) !== null })),
    movingDayId,
    targetDayNumber,
  );
}

// ---------------------------------------------------------------------------
// Booking messages
// ---------------------------------------------------------------------------

const MOMENT_FORMAT = new Map<string, Intl.DateTimeFormat>();

/**
 * How to tell an operator when a booked poster goes out: "09:05 today", or
 * "Thu 18 Sept 09:03". `immediate` when that moment has already come — the next
 * sweep (within a minute) sends it.
 */
export function describeBookingMoment(scheduledFor: Date, now: Date, timeZone: string): { label: string; today: boolean; immediate: boolean } {
  const parts = getZonedParts(scheduledFor, timeZone);
  const clock = `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
  const today = startOfZonedDay(scheduledFor, timeZone).getTime() === startOfZonedDay(now, timeZone).getTime();
  let format = MOMENT_FORMAT.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone });
    MOMENT_FORMAT.set(timeZone, format);
  }
  return {
    label: today ? `${clock} today` : `${format.format(scheduledFor)} ${clock}`,
    today,
    immediate: isDue(scheduledFor, now),
  };
}
