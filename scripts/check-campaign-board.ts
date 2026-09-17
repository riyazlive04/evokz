/**
 * Fixture suite for the one-screen campaign board — its pure rules.
 *
 * No database, no network: card status, the URL filters, week paging and the
 * insert-and-shift move planner from `src/lib/campaign/board.ts`. The
 * database-backed half is `check-campaign-board-db.ts`.
 *
 * Run: npm run check:campaign-board
 */
import type { CampaignDeliveryStatus } from '@prisma/client';

import {
  BOARD_PAGE_SIZE,
  BOARD_STATUSES,
  boardStatusOf,
  clampPage,
  countBoardStatuses,
  describeBookingMoment,
  formatPageLabel,
  isFilteredQuery,
  matchesBoardSearch,
  MAX_BOARD_SEARCH,
  pageCount,
  pageSlice,
  parseBoardQuery,
  planPostMove,
  planSlotPermutation,
  serializeBoardQuery,
  slotLockOf,
  todayPage,
  weekOf,
  type MovableDay,
  type PostMovePlan,
} from '@/lib/campaign/board';
import type { PosterState } from '@/lib/campaign/poster-generation';
import { addZonedDays, startOfZonedDay } from '@/lib/time';

let bad = 0;
const t = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) bad += 1;
};
const section = (title: string) => console.log(`\n--- ${title} ${'-'.repeat(Math.max(0, 58 - title.length))}`);
const snapshot = (value: unknown) => JSON.stringify(value);

const TZ = 'Asia/Kolkata';

// ---------------------------------------------------------------------------
section('card status');
// ---------------------------------------------------------------------------
{
  const status = (posterState: PosterState, delivery: { status: CampaignDeliveryStatus; posterVersionId: string } | null = null, activeVersionId: string | null = 'v2') =>
    boardStatusOf({ posterState, activeVersionId, delivery });
  const pinned = (s: CampaignDeliveryStatus) => ({ status: s, posterVersionId: 'v2' });
  const stale = (s: CampaignDeliveryStatus) => ({ status: s, posterVersionId: 'v1' });

  t('no poster, nothing blocking → draft', status('not-generated', null, null) === 'draft');
  t('generating → generating', status('generating', null, null) === 'generating');
  t('pending review → needs approval', status('needs-approval') === 'needs-approval');
  t('approved, nothing booked → approved', status('approved') === 'approved');
  t('approved and booked → scheduled', status('approved', pinned('SCHEDULED')) === 'scheduled');
  t('sending → scheduled (on its way)', status('approved', pinned('SENDING')) === 'scheduled');
  t('sent → sent', status('approved', pinned('SENT')) === 'sent');
  t('sent wins over everything, even a newer poster being generated', status('generating', stale('SENT')) === 'sent');
  t('a failed delivery of the active poster → failed', status('approved', pinned('FAILED')) === 'failed');
  t('a failed generation with no poster → failed', status('failed', null, null) === 'failed');
  t('outdated → needs attention', status('outdated') === 'attention');
  t('rejected → needs attention', status('rejected') === 'attention');
  t('blocked (template, Brand Canvas) → needs attention', status('needs-attention', null, null) === 'attention');
  t('an outdated poster with a booking is attention, not scheduled', status('outdated', pinned('SCHEDULED')) === 'attention');
  t('a booking pinned to a replaced poster does not speak for the day', status('needs-approval', stale('SCHEDULED')) === 'needs-approval');
  t('…nor does a failure pinned to a replaced poster', status('approved', stale('FAILED')) === 'approved');
  t('approved with a cancelled booking → approved', status('approved', pinned('CANCELLED')) === 'approved');
  t('approved with a skipped booking → approved', status('approved', pinned('SKIPPED')) === 'approved');
  t('generating wins over a failed delivery', status('generating', pinned('FAILED')) === 'generating');

  const counts = countBoardStatuses(['draft', 'draft', 'sent', 'attention']);
  t('counts per status plus all', counts.all === 4 && counts.draft === 2 && counts.sent === 1 && counts.attention === 1 && counts.scheduled === 0);
  t('every status has a count, even at zero', BOARD_STATUSES.every((key) => countBoardStatuses([])[key] === 0));
}

// ---------------------------------------------------------------------------
section('filters in the URL');
// ---------------------------------------------------------------------------
{
  t('empty → defaults', snapshot(parseBoardQuery({})) === snapshot({ status: 'all', week: null, q: '' }));
  t('undefined params → defaults', parseBoardQuery(undefined).status === 'all');
  t('a status is read', parseBoardQuery({ status: 'needs-approval' }).status === 'needs-approval');
  t('an unknown status falls back to all', parseBoardQuery({ status: 'bogus' }).status === 'all');
  t('a week is read', parseBoardQuery({ week: '3' }).week === 3);
  t('week 0, negative, text and huge fall back', [ '0', '-1', 'x', '2.5', '99999' ].every((week) => parseBoardQuery({ week }).week === null));
  t('search is trimmed and collapsed', parseBoardQuery({ q: '  Diwali   offer ' }).q === 'Diwali offer');
  t('search is capped', parseBoardQuery({ q: 'x'.repeat(500) }).q.length === MAX_BOARD_SEARCH);
  t('an array value uses its first entry', parseBoardQuery({ status: ['sent', 'failed'] }).status === 'sent');
  t('URLSearchParams work too', snapshot(parseBoardQuery(new URLSearchParams('status=failed&week=2&q=hi'))) === snapshot({ status: 'failed', week: 2, q: 'hi' }));
  t('old ?review=needs-review opens Needs approval', parseBoardQuery({ review: 'needs-review' }).status === 'needs-approval');
  t('old ?review=rejected|outdated|unmapped opens Needs attention', ['rejected', 'outdated', 'unmapped', 'attention'].every((review) => parseBoardQuery({ review }).status === 'attention'));
  t('old ?delivery=sent opens Sent', parseBoardQuery({ delivery: 'sent' }).status === 'sent');
  t('a real status wins over an old alias', parseBoardQuery({ status: 'draft', review: 'approved' }).status === 'draft');

  t('defaults serialise to nothing', serializeBoardQuery({ status: 'all', week: null, q: '' }) === '');
  t('set values serialise', serializeBoardQuery({ status: 'scheduled', week: 4, q: 'sale now' }) === '?status=scheduled&week=4&q=sale+now');
  const round = { status: 'failed' as const, week: 2, q: 'day 12' };
  t('serialise → parse round-trips', snapshot(parseBoardQuery(new URLSearchParams(serializeBoardQuery(round).slice(1)))) === snapshot(round));
  t('filtered means a status or a search', isFilteredQuery({ status: 'draft', q: '' }) && isFilteredQuery({ status: 'all', q: 'x' }) && !isFilteredQuery({ status: 'all', q: '' }));

  const day = { dayNumber: 12, headline: 'Monsoon Care Camp' };
  t('search matches the headline, case-insensitively', matchesBoardSearch(day, 'monsoon care'));
  t('search matches the day number', ['12', 'day 12', 'Day12', '#12'].every((q) => matchesBoardSearch(day, q)));
  t('a different number does not match', !matchesBoardSearch(day, '13'));
  t('an empty search matches everything', matchesBoardSearch({ dayNumber: 1, headline: null }, '  '));
  t('a missing headline does not match text', !matchesBoardSearch({ dayNumber: 1, headline: null }, 'care'));
}

// ---------------------------------------------------------------------------
section('week paging');
// ---------------------------------------------------------------------------
{
  t('pages are seven day slots', BOARD_PAGE_SIZE === 7 && weekOf(1) === 1 && weekOf(7) === 1 && weekOf(8) === 2 && weekOf(365) === 53);
  t('page counts', pageCount(0) === 1 && pageCount(7) === 1 && pageCount(30) === 5 && pageCount(365) === 53);
  t('pages are clamped', clampPage(0, 5) === 1 && clampPage(9, 5) === 5 && clampPage(3, 5) === 3 && clampPage(Number.NaN, 5) === 1);
  const items = Array.from({ length: 16 }, (_, index) => index + 1);
  t('a page slice', snapshot(pageSlice(items, 3)) === snapshot([15, 16]) && pageSlice(items, 4).length === 0);

  const start = startOfZonedDay(new Date('2026-09-17T12:00:00Z'), TZ);
  const everyDay = Array.from({ length: 30 }, (_, index) => ({ dayNumber: index + 1, scheduledDate: addZonedDays(start, index, TZ) }));
  t('Today before the campaign starts → page 1', todayPage(everyDay, new Date('2026-09-01T06:00:00Z'), TZ) === 1);
  t('Today on day 9 → page 2', todayPage(everyDay, new Date(addZonedDays(start, 8, TZ).getTime() + 3_600_000), TZ) === 2);
  t('Today after the campaign → its last page', todayPage(everyDay, new Date('2027-01-01T06:00:00Z'), TZ) === 5);
  // Mon/Wed/Fri: today (a Tuesday) has no slot, so Today opens the next one.
  const restricted = [0, 2, 4, 7, 9, 11, 14, 16, 18].map((offset, index) => ({ dayNumber: index + 1, scheduledDate: addZonedDays(start, offset, TZ) }));
  t('Today with no slot today → the next slot\'s page', todayPage(restricted, addZonedDays(start, 15, TZ), TZ) === 2);
  t('Today with no days → page 1', todayPage([], new Date(), TZ) === 1);

  const month = (date: Date) => new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: TZ }).format(date);
  const sept17 = start;
  const sept23 = addZonedDays(start, 6, TZ);
  const oct4 = addZonedDays(start, 17, TZ);
  t('a page within a month', formatPageLabel(sept17, sept23, TZ) === `17–23 ${month(sept17)}`, formatPageLabel(sept17, sept23, TZ));
  t('a page across months', formatPageLabel(addZonedDays(start, 11, TZ), oct4, TZ) === `28 ${month(sept17)} – 4 ${month(oct4)}`, formatPageLabel(addZonedDays(start, 11, TZ), oct4, TZ));
  const dec29 = startOfZonedDay(new Date('2026-12-29T12:00:00Z'), TZ);
  const jan4 = addZonedDays(dec29, 6, TZ);
  t('a page across years names both', formatPageLabel(dec29, jan4, TZ) === `29 ${month(dec29)} 2026 – 4 ${month(jan4)} 2027`, formatPageLabel(dec29, jan4, TZ));
  t('a one-day page', formatPageLabel(sept17, sept17, TZ) === `17 ${month(sept17)}`);
}

// ---------------------------------------------------------------------------
section('slot locks');
// ---------------------------------------------------------------------------
{
  const now = new Date('2026-09-20T06:30:00Z'); // 12:00 in Kolkata
  const today = startOfZonedDay(now, TZ);
  const day = (offset: number, delivery: MovableDay['delivery'] = null): MovableDay => ({ id: `d${offset}`, dayNumber: 10 + offset, scheduledDate: addZonedDays(today, offset, TZ), delivery });

  t('a sent post is locked, even on a future day', slotLockOf(day(3, { status: 'SENT', scheduledFor: now }), now, TZ) === 'sent');
  t('a post being sent is locked', slotLockOf(day(2, { status: 'SENDING', scheduledFor: now }), now, TZ) === 'sending');
  t('a booking whose moment has come is locked', slotLockOf(day(0, { status: 'SCHEDULED', scheduledFor: new Date(now.getTime() - 60_000) }), now, TZ) === 'due');
  t('a booking later today is not', slotLockOf(day(0, { status: 'SCHEDULED', scheduledFor: new Date(now.getTime() + 60_000) }), now, TZ) === null);
  t('a past day is locked', slotLockOf(day(-1), now, TZ) === 'past');
  t('today is not past', slotLockOf(day(0), now, TZ) === null);
  t('a failed, cancelled or skipped delivery does not lock', (['FAILED', 'CANCELLED', 'SKIPPED'] as const).every((status) => slotLockOf(day(1, { status, scheduledFor: new Date(now.getTime() - 86_400_000) }), now, TZ) === null));
  t('a past day with a stale booking is past, not due', slotLockOf(day(-2, { status: 'SCHEDULED', scheduledFor: addZonedDays(today, -2, TZ) }), now, TZ) === 'past');

  // Today's slot closes when today's delivery time comes (12:00 in Kolkata now).
  t("today closes once today's delivery time has come", slotLockOf(day(0), now, TZ, '11:59') === 'closed' && slotLockOf(day(0), now, TZ, '12:00') === 'closed');
  t('…and not before', slotLockOf(day(0), now, TZ, '12:01') === null);
  t('…only today: tomorrow at an earlier time is open', slotLockOf(day(1), now, TZ, '06:00') === null);
  t('…and without a delivery time nothing closes', slotLockOf(day(0), now, TZ) === null);
  const closedDays = [day(0), day(1), day(2)].map((entry, index) => ({ ...entry, id: `c${index}`, dayNumber: index + 1 }));
  const into = planPostMove(closedDays, 'c2', 1, now, TZ, '09:00');
  const outOf = planPostMove(closedDays, 'c0', 3, now, TZ, '09:00');
  t('nothing moves into a closed today', !into.ok && into.reason === 'target-locked');
  t('…or out of it', !outOf.ok && outOf.reason === 'source-locked');
  const later = planPostMove(closedDays, 'c2', 2, now, TZ, '18:00');
  t('before the delivery time the same days move', later.ok);
}

// ---------------------------------------------------------------------------
section('booking messages');
// ---------------------------------------------------------------------------
{
  const now = new Date('2026-09-17T06:30:00Z'); // Thu 17 Sept, 12:00 in Kolkata
  const month = new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: TZ }).format(now);
  const later = describeBookingMoment(new Date('2026-09-17T09:35:00Z'), now, TZ);
  t('later today reads as a time today', later.label === '15:05 today' && later.today && !later.immediate, snapshot(later));
  const passed = describeBookingMoment(new Date('2026-09-17T03:35:00Z'), now, TZ);
  t('a moment already come is immediate', passed.label === '09:05 today' && passed.immediate, snapshot(passed));
  const tomorrow = describeBookingMoment(new Date('2026-09-18T03:33:00Z'), now, TZ);
  t('another day names the day', tomorrow.label === `Fri 18 ${month} 09:03` && !tomorrow.today && !tomorrow.immediate, snapshot(tomorrow));
}

// ---------------------------------------------------------------------------
section('moving a post: insert and shift');
// ---------------------------------------------------------------------------
{
  const now = new Date('2026-09-17T06:30:00Z');
  const start = startOfZonedDay(now, TZ);
  const make = (count: number, locked: Record<number, CampaignDeliveryStatus | 'past'> = {}): MovableDay[] =>
    Array.from({ length: count }, (_, index) => {
      const dayNumber = index + 1;
      const lock = locked[dayNumber];
      return {
        id: `post-${dayNumber}`,
        dayNumber,
        scheduledDate: addZonedDays(start, lock === 'past' ? index - 100 : index, TZ),
        delivery: lock && lock !== 'past' ? { status: lock, scheduledFor: addZonedDays(start, index + 1, TZ) } : null,
      };
    });
  const order = (days: MovableDay[], plan: PostMovePlan): string[] => {
    const at = new Map(days.map((day) => [day.dayNumber, day.id]));
    if (plan.ok) for (const move of plan.moves) at.set(move.toDayNumber, move.dayId);
    return [...at.entries()].sort((a, b) => a[0] - b[0]).map(([, id]) => id.replace('post-', ''));
  };

  const ten = make(10);
  const forward = planPostMove(ten, 'post-3', 6, now, TZ);
  t('forward: day 3 → 6 puts 4–6 on 3–5', forward.ok && order(ten, forward).join(',') === '1,2,4,5,6,3,7,8,9,10', order(ten, forward).join(','));
  t('…and changes exactly the four rows in the span', forward.ok && forward.moves.length === 4);
  const backward = planPostMove(ten, 'post-6', 3, now, TZ);
  t('backward: day 6 → 3 puts 3–5 on 4–6', backward.ok && order(ten, backward).join(',') === '1,2,6,3,4,5,7,8,9,10', order(ten, backward).join(','));
  t('a moved post takes its slot\'s date', forward.ok && forward.moves.find((move) => move.dayId === 'post-3')?.scheduledDate.getTime() === ten[5]!.scheduledDate.getTime());
  t('a shifted post takes the date of the slot it lands on', forward.ok && forward.moves.find((move) => move.dayId === 'post-4')?.scheduledDate.getTime() === ten[2]!.scheduledDate.getTime());
  const adjacent = planPostMove(ten, 'post-5', 6, now, TZ);
  t('neighbours swap', adjacent.ok && order(ten, adjacent).join(',') === '1,2,3,4,6,5,7,8,9,10' && adjacent.moves.length === 2);
  const toEnd = planPostMove(ten, 'post-1', 10, now, TZ);
  t('first to last shifts everything once', toEnd.ok && order(ten, toEnd).join(',') === '2,3,4,5,6,7,8,9,10,1');

  const refusal = (plan: PostMovePlan) => (plan.ok ? 'ok' : plan.reason);
  t('no-op is refused', refusal(planPostMove(ten, 'post-4', 4, now, TZ)) === 'no-op');
  t('out of range is refused', ['0', '11', '2.5', '-3'].every((target) => refusal(planPostMove(ten, 'post-4', Number(target), now, TZ)) === 'out-of-range'));
  t('an unknown post is refused', refusal(planPostMove(ten, 'post-99', 3, now, TZ)) === 'not-found');

  const locked = make(10, { 2: 'SENT', 5: 'SENDING', 8: 'past' });
  t('a sent source is refused', refusal(planPostMove(locked, 'post-2', 4, now, TZ)) === 'source-locked');
  t('a past source is refused', refusal(planPostMove(locked, 'post-8', 9, now, TZ)) === 'source-locked');
  t('a sent target is refused', refusal(planPostMove(locked, 'post-3', 2, now, TZ)) === 'target-locked');
  t('a sending target is refused', refusal(planPostMove(locked, 'post-3', 5, now, TZ)) === 'target-locked');
  t('a past target is refused', refusal(planPostMove(locked, 'post-3', 8, now, TZ)) === 'target-locked');

  const over = planPostMove(locked, 'post-3', 9, now, TZ);
  t('forward over locked slots steps over them', over.ok && order(locked, over).join(',') === '1,2,4,6,5,7,9,8,3,10', order(locked, over).join(','));
  t('…locked rows keep their slots', over.ok && order(locked, over)[1] === '2' && order(locked, over)[4] === '5' && order(locked, over)[7] === '8');
  t('…and never appear among the changes', over.ok && over.moves.every((move) => !['post-2', 'post-5', 'post-8'].includes(move.dayId)));
  const back = planPostMove(locked, 'post-9', 1, now, TZ);
  t('backward over locked slots steps over them', back.ok && order(locked, back).join(',') === '9,2,1,3,5,4,6,8,7,10', order(locked, back).join(','));

  // Due bookings lock too.
  const due = make(4);
  due[2] = { ...due[2]!, delivery: { status: 'SCHEDULED', scheduledFor: new Date(now.getTime() - 1000) } };
  t('a due booking cannot be moved', refusal(planPostMove(due, 'post-3', 1, now, TZ)) === 'source-locked');

  // Pure permutation over slots with locks already known (the client preview).
  const slots = ten.map((day) => ({ id: day.id, dayNumber: day.dayNumber, scheduledDate: day.scheduledDate, locked: day.dayNumber === 4 }));
  const client = planSlotPermutation(slots, 'post-2', 6);
  t('the preview planner agrees with the server planner', client.ok && snapshot(client.moves) === snapshot((planPostMove(make(10, { 4: 'SENT' }), 'post-2', 6, now, TZ) as { moves: unknown }).moves));

  // Property: any allowed move is a permutation of unlocked slots.
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  let checked = 0;
  let violations = 0;
  for (let round = 0; round < 400; round += 1) {
    const size = 2 + Math.floor(random() * 20);
    const locks: Record<number, 'SENT' | 'past'> = {};
    for (let n = 1; n <= size; n += 1) if (random() < 0.2) locks[n] = random() < 0.5 ? 'SENT' : 'past';
    const days = make(size, locks);
    const mover = days[Math.floor(random() * size)]!;
    const target = 1 + Math.floor(random() * size);
    const plan = planPostMove(days, mover.id, target, now, TZ);
    if (!plan.ok) continue;
    checked += 1;
    const after = new Map(days.map((day) => [day.id, day.dayNumber]));
    for (const move of plan.moves) after.set(move.dayId, move.toDayNumber);
    const numbers = [...after.values()].sort((a, b) => a - b);
    const bijective = numbers.every((n, index) => n === index + 1);
    const lockedKept = days.every((day) => !locks[day.dayNumber] || after.get(day.id) === day.dayNumber);
    const landed = after.get(mover.id) === target;
    const others = days.filter((day) => day.id !== mover.id && !locks[day.dayNumber]).sort((a, b) => a.dayNumber - b.dayNumber);
    const relative = others.every((day, index) => index === 0 || after.get(others[index - 1]!.id)! < after.get(day.id)!);
    const dated = plan.moves.every((move) => move.scheduledDate.getTime() === days.find((day) => day.dayNumber === move.toDayNumber)!.scheduledDate.getTime());
    if (!(bijective && lockedKept && landed && relative && dated)) violations += 1;
  }
  t('random moves: a bijection, locks kept, mover lands, order kept, dates follow slots', violations === 0 && checked > 100, `${checked} moves, ${violations} violation(s)`);
}

console.log(`\n${bad === 0 ? 'All campaign board checks passed.' : `${bad} check(s) FAILED.`}`);
process.exit(bad === 0 ? 0 : 1);
