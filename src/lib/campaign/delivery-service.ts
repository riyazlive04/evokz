import {
  Prisma,
  type CampaignDeliveryStatus,
  type CampaignStatus,
  type PosterApprovalStatus,
  type TemplateMappingMode,
} from '@prisma/client';

import {
  buildDeliveryMessage,
  buildDeliveryFileName,
  canRetryDelivery,
  DELIVERY_STATUS_LABELS,
  deliveryInstant,
  deliverySpreadSeconds,
  evaluateDeliveryEligibility,
  isDue,
  isMissed,
  isStaleClaim,
  isValidRecipient,
  MAX_CAPTION_LENGTH,
  normalizeDeliveryLink,
  retryDelayMs,
  STALE_SENDING_MS,
  summarizeDeliveries,
  type DeliveryRefusal,
  type DeliverySummary,
} from '@/lib/campaign/delivery';
import {
  buildDeliveryMediaUrl,
  isMediaDeliveryConfigured,
  MediaUrlNotConfiguredError,
} from '@/lib/campaign/delivery-media';
import { campaignAllowsChanges, effectiveTemplateId } from '@/lib/campaign/model';
import { CampaignDomainError, runInCampaignTransaction, type CampaignDb } from '@/lib/campaign/service';
import { getAppTimeZone, startOfZonedDay } from '@/lib/time';
import { recordWhatsAppUsage } from '@/lib/usage';
import { redactWhatsAppSecrets, sendWhatsAppMedia, WhatsAppError } from '@/lib/whatsapp';

/**
 * Campaign WhatsApp delivery — database operations of Phase 6.
 *
 * Booking a day, claiming it atomically, sending it through the one Evolution
 * integration, and recording what happened. The rules live in `delivery.ts`;
 * this module applies them to rows and is pinned by
 * `npm run check:campaign-delivery-db`.
 *
 * Three properties this file exists to guarantee:
 *
 * 1. **The gate is server-side.** `sendCampaignDelivery` re-reads the campaign,
 *    the day and the active version from the database and re-runs eligibility
 *    *after* it has claimed the row, immediately before the provider call. No
 *    action, route or UI state can skip it, and `manual` changes nothing except
 *    whether the scheduled moment has to have arrived.
 * 2. **A day is sent at most once.** `CampaignDelivery.calendarDayId` is unique,
 *    so a day can never have two delivery rows, and the claim is a conditional
 *    update: only the worker whose update returns a row proceeds.
 * 3. **The approved version is the one sent.** The delivery pins
 *    `posterVersionId` when it is booked and refuses if that is no longer the
 *    day's active version, rather than sending whatever is active now.
 *
 * Nothing here generates a poster, edits content, approves anything, or touches
 * the legacy delivery columns.
 */

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** Every outside effect, injected so the tests can run the real logic offline. */
export interface DeliveryDeps {
  sendMedia: typeof sendWhatsAppMedia;
  buildMediaUrl: (posterVersionId: string) => Promise<string>;
  mediaConfigured: () => boolean;
  whatsappConfigured: () => boolean;
  now: () => Date;
  timeZone: string;
}

/** True when both Evolution variables are set. Names only — never values. */
export function isWhatsAppConfigured(): boolean {
  return Boolean(process.env.EVOLUTION_API_URL?.trim() && process.env.EVOLUTION_API_KEY?.trim());
}

export function defaultDeliveryDeps(overrides: Partial<DeliveryDeps> = {}): DeliveryDeps {
  return {
    sendMedia: sendWhatsAppMedia,
    buildMediaUrl: (posterVersionId) => buildDeliveryMediaUrl(posterVersionId, process.env.SESSION_SECRET ?? ''),
    mediaConfigured: isMediaDeliveryConfigured,
    whatsappConfigured: isWhatsAppConfigured,
    now: () => new Date(),
    timeZone: getAppTimeZone(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Everything the gate needs about one day, read fresh. */
const deliveryDaySelect = {
  id: true,
  campaignId: true,
  clientId: true,
  dayNumber: true,
  scheduledDate: true,
  contentStatus: true,
  contentRevision: true,
  headline: true,
  supportingText: true,
  cta: true,
  // The message: the saved caption and link. `internalNotes` is deliberately
  // not selected — nothing on the send path can read it.
  caption: true,
  deliveryLink: true,
  posterTemplateId: true,
  suggestedTemplateId: true,
  activePosterVersionId: true,
  activePosterVersion: {
    select: { id: true, contentRevision: true, approvalStatus: true, imageDriveFileId: true, imageMimeType: true },
  },
  client: { select: { whatsappNumber: true, isActive: true } },
  campaign: { select: { id: true, status: true, deliveryTime: true, templateMappingMode: true } },
  delivery: {
    select: {
      id: true,
      status: true,
      posterVersionId: true,
      attempts: true,
      failurePermanent: true,
      sendingStartedAt: true,
      scheduledFor: true,
    },
  },
} satisfies Prisma.ContentCalendarSelect;

type DeliveryDayRow = Prisma.ContentCalendarGetPayload<{ select: typeof deliveryDaySelect }>;

/**
 * The shape the gate reads. Structural rather than a Prisma payload type, so
 * the dashboard's wider select and the sender's narrow one share one function —
 * and therefore one set of rules.
 */
export interface CandidateSource {
  campaignId: string | null;
  contentStatus: DeliveryDayRow['contentStatus'];
  contentRevision: number;
  posterTemplateId: string | null;
  suggestedTemplateId: string | null;
  activePosterVersion: { id: string; contentRevision: number; approvalStatus: PosterApprovalStatus } | null;
  client: { whatsappNumber: string; isActive: boolean } | null;
  campaign: { status: CampaignStatus; templateMappingMode: TemplateMappingMode } | null;
  delivery: {
    status: CampaignDeliveryStatus;
    posterVersionId: string;
    attempts: number;
    failurePermanent: boolean;
    sendingStartedAt: Date | null;
  } | null;
}

/**
 * When a day should go out: its configured moment plus a stable per-day spread,
 * so a fleet sharing one delivery time does not hand the provider everything in
 * the same second (Phase 7 §7). The offset is derived from the day id, so it
 * never moves between runs.
 */
export function scheduledInstantFor(dayId: string, scheduledDate: Date, deliveryTime: string, timeZone: string): Date {
  const base = deliveryInstant(scheduledDate, deliveryTime, timeZone);
  return new Date(base.getTime() + deliverySpreadSeconds(dayId) * 1000);
}

async function loadDeliveryDay(db: CampaignDb, dayId: string): Promise<DeliveryDayRow> {
  const day = await db.contentCalendar.findUnique({ where: { id: dayId }, select: deliveryDaySelect });
  if (!day) throw new CampaignDomainError('not-found', 'Campaign day does not exist.');
  if (!day.campaignId || !day.campaign) {
    throw new CampaignDomainError('not-a-campaign-day', 'This calendar row is not part of a campaign.');
  }
  return day;
}

/**
 * A day as the delivery gate reads it. Exported so the campaign board asks the
 * gate exactly the question the sender will, rather than a copy of it.
 *
 * `hasTemplate` is the campaign's effective template (`effectiveTemplateId`):
 * under MANUAL a stored suggestion is only a hint, so it does not count.
 */
export function deliveryCandidateFrom(day: CandidateSource, deps: Pick<DeliveryDeps, 'whatsappConfigured' | 'mediaConfigured'>) {
  return {
    campaignId: day.campaignId,
    campaignStatus: (day.campaign?.status ?? 'DRAFT') as CampaignStatus,
    clientActive: day.client?.isActive ?? false,
    contentReady: day.contentStatus === 'READY',
    hasTemplate: Boolean(effectiveTemplateId(day.campaign?.templateMappingMode ?? 'MANUAL', day)),
    dayContentRevision: day.contentRevision,
    activeVersion: day.activePosterVersion
      ? {
          id: day.activePosterVersion.id,
          contentRevision: day.activePosterVersion.contentRevision,
          approvalStatus: day.activePosterVersion.approvalStatus,
        }
      : null,
    recipient: day.client?.whatsappNumber ?? null,
    whatsappConfigured: deps.whatsappConfigured() && deps.mediaConfigured(),
    delivery: day.delivery
      ? {
          status: day.delivery.status,
          posterVersionId: day.delivery.posterVersionId,
          attempts: day.delivery.attempts,
          failurePermanent: day.delivery.failurePermanent,
          sendingStartedAt: day.delivery.sendingStartedAt,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/**
 * What keeping one day's booking honest did.
 *
 * `booked`       a new SCHEDULED row was created
 * `rebooked`     a CANCELLED row that was never attempted was put back in the
 *                queue for the active poster
 * `repinned`     a SCHEDULED row now carries the newly approved active poster
 * `rescheduled`  a SCHEDULED row's moment moved to follow its day
 * `cancelled`    a SCHEDULED row was withdrawn: its poster was replaced by one
 *                that cannot go out, or is no longer approved, current or ready
 * `missed`       its moment passed a whole local day ago (SKIPPED, or never booked)
 * `not-bookable` no row, and the gate refuses one — `refusal` says why
 * `unchanged`    nothing to do (including SENT, SENDING, FAILED and SKIPPED rows)
 */
export type BookingResult = 'booked' | 'rebooked' | 'repinned' | 'rescheduled' | 'cancelled' | 'missed' | 'not-bookable' | 'unchanged';

export interface DayBookingOutcome {
  dayId: string;
  dayNumber: number;
  result: BookingResult;
  refusal: { reason: DeliveryRefusal; message: string } | null;
  /** When the day's booking goes out after this sync, if it is SCHEDULED. */
  scheduledFor: Date | null;
}

/**
 * Refusals that mean the poster itself may no longer go out, as opposed to the
 * campaign or its client being paused or WhatsApp being unconfigured. Only these
 * withdraw a booking: pausing must leave every booking exactly where it is
 * (Phase 6), and a configuration problem is fixed by configuring, not by losing
 * the queue.
 */
export const WITHDRAWING_REFUSALS: ReadonlySet<DeliveryRefusal> = new Set([
  'content-not-ready',
  'no-poster',
  'poster-outdated',
  'poster-rejected',
  'awaiting-approval',
]);

/** Refusals that hold for every day of a campaign at once. */
const CAMPAIGN_WIDE_REFUSALS: ReadonlySet<DeliveryRefusal> = new Set([
  'not-a-campaign-day',
  'campaign-not-active',
  'client-paused',
  'whatsapp-not-configured',
  'invalid-recipient',
]);

export interface BookingSyncOptions {
  /**
   * The operator just approved this day's poster. A booking they cancelled
   * before belongs to an earlier decision, so a fresh approval books the day
   * again. Without it, a CANCELLED row is re-booked only when a different poster
   * has become the approved active one since.
   */
  reapproved?: boolean;
}

/**
 * Serialises a booking write with moves of the same campaign.
 *
 * `FOR SHARE` on the campaign row: it waits for a move in progress (which holds
 * `FOR NO KEY UPDATE`, see `moveCampaignPost`) and blocks a move from starting,
 * but does not block other booking writes. Taken first, before the day is
 * re-read, so the date a booking is computed from is the one after any move.
 */
export async function lockCampaignForBooking(tx: Prisma.TransactionClient, campaignId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Campaign" WHERE id = ${campaignId} FOR SHARE`;
}

interface BookingPlan {
  outcome: DayBookingOutcome;
  /** The one conditional write, or null when nothing needs writing. Returns the rows changed. */
  write: ((db: CampaignDb) => Promise<number>) | null;
}

/**
 * The one rule set that books, re-pins, reschedules and withdraws a day's
 * delivery, decided from one read of the day. No I/O: `syncDayBooking` runs it,
 * then re-runs it on a fresh read under the campaign lock before writing.
 *
 * The Phase 6 guarantees hold by construction:
 * - **One row per day.** A new booking is `createMany … skipDuplicates`, so a
 *   racing request meets the unique `calendarDayId` and books nothing (and,
 *   unlike a caught P2002, does not abort an enclosing transaction).
 * - **The gate, twice.** A booking is only made, re-pinned or re-booked for a
 *   day the full delivery gate passes (`evaluateDeliveryEligibility` with no
 *   delivery); the sender still re-runs that gate after claiming the row.
 * - **Version pinning.** A row is only ever pinned to the approved active
 *   poster, and every write restates the status and pin it read.
 * - **SENT, SENDING and FAILED rows are never touched** here: sent is final,
 *   sending is in flight, and a failure belongs to the bounded retry sweep and
 *   the operator.
 * - **Pause protection.** A paused campaign's — or a paused client's — bookings
 *   stay exactly as they are (only a missed one is marked, as before): neither
 *   refusal withdraws a booking. Nothing here sends.
 */
function planDayBooking(day: DeliveryDayRow, deps: DeliveryDeps, now: Date, options: BookingSyncOptions): BookingPlan {
  const plan = (
    result: BookingResult,
    write: BookingPlan['write'] = null,
    extra: { refusal?: DayBookingOutcome['refusal']; scheduledFor?: Date | null } = {},
  ): BookingPlan => ({
    outcome: { dayId: day.id, dayNumber: day.dayNumber, result, refusal: extra.refusal ?? null, scheduledFor: extra.scheduledFor ?? null },
    write,
  });
  if (!day.campaignId || !day.campaign) return plan('unchanged');
  const campaignId = day.campaignId;

  const scheduledFor = scheduledInstantFor(day.id, day.scheduledDate, day.campaign.deliveryTime, deps.timeZone);
  const existing = day.delivery;
  const active = day.activePosterVersion;
  // Would the gate accept a booking made now? `delivery: null` because that is
  // exactly the question a new, re-pinned or re-booked row has to answer.
  const fresh = evaluateDeliveryEligibility({ ...deliveryCandidateFrom(day, deps), delivery: null }, now);
  const bookable = fresh.eligible && active !== null && !isMissed(scheduledFor, now, deps.timeZone);

  // ---- No booking yet --------------------------------------------------------
  if (!existing) {
    if (!fresh.eligible) return plan('not-bookable', null, { refusal: { reason: fresh.reason, message: fresh.message } });
    // A day whose moment is long past is never booked retroactively.
    if (!bookable || !active) return plan('missed');
    return plan(
      'booked',
      async (db) =>
        (
          await db.campaignDelivery.createMany({
            data: [{ campaignId, calendarDayId: day.id, posterVersionId: active.id, scheduledFor, status: 'SCHEDULED' }],
            skipDuplicates: true,
          })
        ).count,
      { scheduledFor },
    );
  }

  // ---- Keep a SCHEDULED booking consistent (§8, §17) --------------------------
  if (existing.status === 'SCHEDULED') {
    if (active && existing.posterVersionId !== active.id) {
      // The poster was replaced. An approved, deliverable replacement takes the
      // booking over; anything else cancels it rather than sending either one.
      if (bookable) {
        return plan(
          'repinned',
          async (db) =>
            (
              await db.campaignDelivery.updateMany({
                where: { id: existing.id, status: 'SCHEDULED', posterVersionId: existing.posterVersionId },
                data: { posterVersionId: active.id, scheduledFor },
              })
            ).count,
          { scheduledFor },
        );
      }
      return plan('cancelled', async (db) =>
        (
          await db.campaignDelivery.updateMany({
            where: { id: existing.id, status: 'SCHEDULED', posterVersionId: existing.posterVersionId },
            data: {
              status: 'CANCELLED',
              failureReason: 'The approved poster was replaced before this went out. It is booked again once the new version is approved.',
            },
          })
        ).count,
      );
    }

    // Its moment passed a whole local day ago: it is not late, it is missed.
    if (isMissed(existing.scheduledFor, now, deps.timeZone)) {
      return plan('missed', async (db) =>
        (
          await db.campaignDelivery.updateMany({
            where: { id: existing.id, status: 'SCHEDULED', scheduledFor: existing.scheduledFor },
            data: { status: 'SKIPPED', failureReason: 'Its delivery day passed before it was sent.' },
          })
        ).count,
      );
    }

    // The same poster, but it may no longer go out (rejected, outdated, approval
    // withdrawn): withdraw the booking now instead of leaving it armed.
    if (!fresh.eligible && WITHDRAWING_REFUSALS.has(fresh.reason)) {
      const refusal = { reason: fresh.reason, message: fresh.message };
      return plan(
        'cancelled',
        async (db) =>
          (
            await db.campaignDelivery.updateMany({
              where: { id: existing.id, status: 'SCHEDULED', posterVersionId: existing.posterVersionId },
              data: { status: 'CANCELLED', failureReason: `Withdrawn before it went out: ${fresh.message}` },
            })
          ).count,
        { refusal },
      );
    }

    // A moved day moves its booking; it never sends because of it.
    if (existing.scheduledFor.getTime() !== scheduledFor.getTime()) {
      return plan(
        'rescheduled',
        async (db) =>
          (
            await db.campaignDelivery.updateMany({
              where: { id: existing.id, status: 'SCHEDULED', scheduledFor: existing.scheduledFor },
              data: { scheduledFor },
            })
          ).count,
        { scheduledFor },
      );
    }
    return plan('unchanged', null, { scheduledFor: existing.scheduledFor });
  }

  // ---- A withdrawn booking, and a poster approved since ------------------------
  // Only a booking that never reached the provider (`attempts === 0`) is put back
  // automatically. One that was attempted and then cancelled may have been an
  // ambiguous failure that actually delivered; re-sending that day stays an
  // explicit, confirmed operator Retry.
  if (existing.status === 'CANCELLED' && active && existing.attempts === 0) {
    const replaced = existing.posterVersionId !== active.id;
    if ((options.reapproved || replaced) && bookable) {
      return plan(
        'rebooked',
        async (db) =>
          (
            await db.campaignDelivery.updateMany({
              where: { id: existing.id, status: 'CANCELLED', attempts: 0, posterVersionId: existing.posterVersionId },
              data: {
                status: 'SCHEDULED',
                posterVersionId: active.id,
                scheduledFor,
                failureReason: null,
                failurePermanent: false,
                sendingStartedAt: null,
              },
            })
          ).count,
        { scheduledFor },
      );
    }
    if (!fresh.eligible) return plan('unchanged', null, { refusal: { reason: fresh.reason, message: fresh.message } });
  }

  return plan('unchanged');
}

/**
 * Keeps one day's booking in line with its poster (`planDayBooking`).
 *
 * `day` may be a read taken earlier — a whole campaign loaded at once. It only
 * decides whether anything needs writing; a write happens in its own short
 * transaction that first takes the campaign's booking lock
 * (`lockCampaignForBooking`), then re-reads the day and re-plans from that
 * fresh row. A move that commits between the first read and the write can
 * therefore never have its new date overwritten by a moment computed from the
 * old one.
 */
async function syncDayBooking(
  db: CampaignDb,
  day: DeliveryDayRow,
  deps: DeliveryDeps,
  now: Date,
  options: BookingSyncOptions = {},
): Promise<DayBookingOutcome> {
  const first = planDayBooking(day, deps, now, options);
  const campaignId = day.campaignId;
  if (!first.write || !campaignId) return first.outcome;

  return runInCampaignTransaction(db, async (tx) => {
    await lockCampaignForBooking(tx, campaignId);
    const fresh = await tx.contentCalendar.findUnique({ where: { id: day.id }, select: deliveryDaySelect });
    if (!fresh || fresh.campaignId !== campaignId) return { ...first.outcome, result: 'unchanged', refusal: null, scheduledFor: null };
    const planned = planDayBooking(fresh, deps, now, options);
    if (!planned.write) return planned.outcome;
    const changed = await planned.write(tx);
    if (changed === 1) return planned.outcome;
    return {
      ...planned.outcome,
      result: 'unchanged',
      scheduledFor: fresh.delivery?.status === 'SCHEDULED' ? fresh.delivery.scheduledFor : null,
    };
  });
}

export interface ScheduleOutcome {
  scheduled: number[];
  /** Days that could not be booked, grouped by why. */
  skipped: Array<{ reason: DeliveryRefusal; message: string; dayNumbers: number[] }>;
  cancelled: number[];
  missed: number[];
  /** Bookings moved onto a newly approved active poster. */
  repinned: number[];
  /** Bookings whose moment moved with their day. */
  rescheduled: number[];
}

/**
 * Books a delivery for every day of one campaign whose approved poster is
 * ready, and keeps the existing bookings honest (`syncDayBooking`).
 *
 * Called when a campaign is activated or resumed, and by the Schedule action.
 * It does **not** run on page load, and the cron sweep does not call it per
 * campaign: the sweep uses the narrower `syncActiveCampaignBookings`, and an
 * approval books its own day through `bookCampaignDay`. Safe to run repeatedly:
 * the unique constraint on `calendarDayId` means a second run can only ever
 * update, never duplicate. It never sends.
 */
export async function scheduleCampaignDeliveries(
  db: CampaignDb,
  campaignId: string,
  deps: DeliveryDeps = defaultDeliveryDeps(),
): Promise<ScheduleOutcome> {
  const campaign = await db.campaign.findUnique({ where: { id: campaignId }, select: { id: true } });
  if (!campaign) throw new CampaignDomainError('not-found', 'Campaign does not exist.');

  const days = await db.contentCalendar.findMany({
    where: { campaignId },
    select: deliveryDaySelect,
    orderBy: { dayNumber: 'asc' },
  });

  const now = deps.now();
  const outcome: ScheduleOutcome = { scheduled: [], skipped: [], cancelled: [], missed: [], repinned: [], rescheduled: [] };
  const groups = new Map<DeliveryRefusal, { reason: DeliveryRefusal; message: string; dayNumbers: number[] }>();

  for (const day of days) {
    const result = await syncDayBooking(db, day, deps, now);
    switch (result.result) {
      case 'booked':
      case 'rebooked':
        outcome.scheduled.push(result.dayNumber);
        break;
      case 'repinned':
        outcome.repinned.push(result.dayNumber);
        break;
      case 'rescheduled':
        outcome.rescheduled.push(result.dayNumber);
        break;
      case 'cancelled':
        outcome.cancelled.push(result.dayNumber);
        break;
      case 'missed':
        outcome.missed.push(result.dayNumber);
        break;
      case 'not-bookable': {
        if (!result.refusal) break;
        const refusal = result.refusal;
        const group = groups.get(refusal.reason) ?? { reason: refusal.reason, message: refusal.message, dayNumbers: [] };
        group.dayNumbers.push(result.dayNumber);
        groups.set(refusal.reason, group);
        break;
      }
      default:
        break;
    }
  }

  outcome.skipped = [...groups.values()];
  return outcome;
}

/**
 * Brings ONE day's booking in line with its poster, right after something
 * changed it: an approval (`reapproved`), a new version, a rejection.
 *
 * This is what books an approved poster without anyone pressing Schedule. Same
 * rules as the campaign-wide run, and the same lock before any write.
 */
export async function bookCampaignDay(
  db: CampaignDb,
  dayId: string,
  options: BookingSyncOptions & { deps?: DeliveryDeps } = {},
): Promise<DayBookingOutcome> {
  const deps = options.deps ?? defaultDeliveryDeps();
  const day = await loadDeliveryDay(db, dayId);
  return syncDayBooking(db, day, deps, deps.now(), options);
}

/**
 * `bookCampaignDay` for paths whose own write has already succeeded — an
 * approval, a generated or saved poster, a rejection. A booking problem must
 * never turn a completed approval into an error: it is logged with safe
 * identifiers only, and the cron sweep's sync repairs the day on its next tick.
 */
export async function bookCampaignDayQuietly(
  db: CampaignDb,
  dayId: string,
  options: BookingSyncOptions & { deps?: DeliveryDeps } = {},
): Promise<DayBookingOutcome | null> {
  try {
    return await bookCampaignDay(db, dayId, options);
  } catch (error) {
    console.error(`[campaign:delivery] booking sync failed for dayId=${dayId}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

export interface BookingSweepResult {
  considered: number;
  booked: number;
  repinned: number;
  cancelled: number;
  missed: number;
}

/**
 * Where the unbooked-approvals pass of the last sweep stopped, so the next one
 * continues after it instead of re-reading the same first days. Per process and
 * best effort: losing it (a restart) only means starting from the soonest day
 * again, which is still bounded.
 */
let unbookedCursor: { scheduledDate: Date; id: string } | null = null;

/** Starts the unbooked-approvals pass from the soonest day again. For tests. */
export function resetBookingSyncCursor(): void {
  unbookedCursor = null;
}

/**
 * The campaigns the cron sweeps act on without an operator: ACTIVE, of a client
 * that is active (not paused) and not a demo. Pausing a client therefore stops
 * its automatic generation, booking sync and sends; resuming lets them continue
 * from the rows as they were. Operator actions on one campaign are not filtered
 * by this — the delivery gate refuses a paused client's sends itself.
 */
export const AUTOMATIC_CAMPAIGNS = {
  status: 'ACTIVE',
  client: { isActive: true, isDemo: false },
} as const satisfies Prisma.CampaignWhereInput;

/**
 * The cron sweep's cheap, self-healing pass over ACTIVE campaigns' bookings
 * (of active, non-demo clients: `AUTOMATIC_CAMPAIGNS`).
 *
 * Rather than re-reading every day of every campaign each minute, three narrow,
 * bounded queries find only the days whose booking may be out of line, and
 * each goes through `syncDayBooking` (so every write takes the campaign's
 * booking lock and re-reads the day first):
 *
 * 1. **Stale bookings** — SCHEDULED rows pinned to a poster that is no longer
 *    its day's active one, or whose moment passed before today.
 * 2. **Withdrawn bookings** — SCHEDULED rows whose active poster is no longer
 *    approved, or whose content is no longer ready.
 * 3. **Unbooked approvals** — days from today on whose active poster is
 *    approved, with no booking or only a never-attempted CANCELLED one pinned to
 *    an older poster. Skipped entirely while WhatsApp is not configured; limited
 *    to campaigns whose client has a valid WhatsApp number; a campaign whose
 *    first day is refused for a campaign-wide reason is skipped for the rest of
 *    the pass; and the pass resumes after where the previous sweep stopped
 *    (`unbookedCursor`), so days the gate keeps refusing (an outdated poster)
 *    cannot starve the days behind them.
 *
 * The first two drop out of their query once fixed. An outdated-but-approved
 * booking cannot be told apart in a query (it compares two tables' revisions);
 * the sender refuses it, and any other sync of that day withdraws it.
 */
export async function syncActiveCampaignBookings(
  db: CampaignDb,
  deps: DeliveryDeps = defaultDeliveryDeps(),
  options: { limit?: number } = {},
): Promise<BookingSweepResult> {
  const now = deps.now();
  const limit = Math.max(1, options.limit ?? 200);
  const today = startOfZonedDay(now, deps.timeZone);
  const result: BookingSweepResult = { considered: 0, booked: 0, repinned: 0, cancelled: 0, missed: 0 };
  const order = [{ scheduledDate: 'asc' as const }, { dayNumber: 'asc' as const }];

  const stale = await db.contentCalendar.findMany({
    where: {
      campaign: AUTOMATIC_CAMPAIGNS,
      delivery: {
        is: {
          status: 'SCHEDULED',
          OR: [{ scheduledFor: { lt: today } }, { posterVersion: { activeForDay: { none: {} } } }],
        },
      },
    },
    select: deliveryDaySelect,
    orderBy: order,
    take: limit,
  });
  const withdrawn = await db.contentCalendar.findMany({
    where: {
      campaign: AUTOMATIC_CAMPAIGNS,
      delivery: { is: { status: 'SCHEDULED' } },
      OR: [{ contentStatus: { not: 'READY' } }, { activePosterVersion: { is: { approvalStatus: { not: 'APPROVED' } } } }],
    },
    select: deliveryDaySelect,
    orderBy: order,
    take: limit,
  });

  let unbooked: DeliveryDayRow[] = [];
  if (deps.whatsappConfigured() && deps.mediaConfigured()) {
    // Campaigns that could book at all: a client with a usable number.
    const campaigns = await db.campaign.findMany({
      where: AUTOMATIC_CAMPAIGNS,
      select: { id: true, client: { select: { whatsappNumber: true } } },
    });
    const bookableCampaigns = campaigns.filter((campaign) => isValidRecipient(campaign.client.whatsappNumber)).map((campaign) => campaign.id);

    if (bookableCampaigns.length > 0) {
      if (unbookedCursor && unbookedCursor.scheduledDate.getTime() < today.getTime()) unbookedCursor = null;
      const cursor = unbookedCursor;
      unbooked = await db.contentCalendar.findMany({
        where: {
          campaignId: { in: bookableCampaigns },
          scheduledDate: { gte: today },
          contentStatus: 'READY',
          activePosterVersion: { is: { approvalStatus: 'APPROVED' } },
          AND: [
            {
              OR: [
                { delivery: { is: null } },
                { delivery: { is: { status: 'CANCELLED', attempts: 0, posterVersion: { activeForDay: { none: {} } } } } },
              ],
            },
            ...(cursor
              ? [{ OR: [{ scheduledDate: { gt: cursor.scheduledDate } }, { scheduledDate: cursor.scheduledDate, id: { gt: cursor.id } }] }]
              : []),
          ],
        },
        select: deliveryDaySelect,
        orderBy: [{ scheduledDate: 'asc' }, { id: 'asc' }],
        take: limit,
      });
      const last = unbooked[unbooked.length - 1];
      // A full page means there may be more after it; a short one wraps around.
      unbookedCursor = unbooked.length === limit && last ? { scheduledDate: last.scheduledDate, id: last.id } : null;
    }
  }

  const seen = new Set<string>();
  const skippedCampaigns = new Set<string>();
  const unbookedIds = new Set(unbooked.map((day) => day.id));
  for (const day of [...stale, ...withdrawn, ...unbooked]) {
    if (seen.has(day.id)) continue;
    seen.add(day.id);
    if (unbookedIds.has(day.id) && day.campaignId && skippedCampaigns.has(day.campaignId)) continue;
    result.considered += 1;
    try {
      const outcome = await syncDayBooking(db, day, deps, now);
      if (outcome.result === 'booked' || outcome.result === 'rebooked') result.booked += 1;
      else if (outcome.result === 'repinned') result.repinned += 1;
      else if (outcome.result === 'cancelled') result.cancelled += 1;
      else if (outcome.result === 'missed') result.missed += 1;
      if (outcome.refusal && CAMPAIGN_WIDE_REFUSALS.has(outcome.refusal.reason) && day.campaignId) skippedCampaigns.add(day.campaignId);
    } catch (error) {
      // One day's failure must not stop the rest of the sync.
      console.error(`[campaign:delivery] booking sync failed for dayId=${day.id}:`, error instanceof Error ? error.message : error);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export type SendOutcome =
  | { ok: true; dayNumber: number; providerMessageId: string | null }
  | { ok: false; dayNumber: number; reason: DeliveryRefusal | 'provider-failed'; message: string; permanent: boolean };

export interface SendOptions {
  /**
   * An operator pressed Send Now. The only gate this relaxes is the scheduled
   * moment — approval, version, campaign status, recipient and the duplicate
   * constraint all still apply exactly as they do to the sweep.
   */
  manual?: boolean;
}

/**
 * Sends one campaign day's approved poster, or explains why it did not.
 *
 * The order matters and is the whole point:
 * read → gate → **claim** → gate again on the claimed row → provider → settle.
 */
export async function sendCampaignDelivery(
  db: CampaignDb,
  dayId: string,
  deps: DeliveryDeps = defaultDeliveryDeps(),
  options: SendOptions = {},
): Promise<SendOutcome> {
  const day = await loadDeliveryDay(db, dayId);
  const now = deps.now();

  const refuse = (reason: DeliveryRefusal | 'provider-failed', message: string, permanent = true): SendOutcome => ({
    ok: false,
    dayNumber: day.dayNumber,
    reason,
    message,
    permanent,
  });

  // ---- Gate, before anything is claimed ------------------------------------
  const eligibility = evaluateDeliveryEligibility(deliveryCandidateFrom(day, deps), now);
  if (!eligibility.eligible) {
    if (eligibility.reason === 'version-changed' && day.delivery) {
      await db.campaignDelivery.updateMany({
        where: { id: day.delivery.id, status: { in: ['SCHEDULED', 'FAILED'] } },
        data: { status: 'CANCELLED', failureReason: eligibility.message },
      });
    }
    return refuse(eligibility.reason, eligibility.message);
  }

  const delivery = day.delivery;
  if (!delivery) {
    // Send Now on an unbooked day books it first, through the same rules.
    if (!options.manual) return refuse('not-due', 'This day has no delivery booked.');
    const scheduledFor = scheduledInstantFor(day.id, day.scheduledDate, day.campaign!.deliveryTime, deps.timeZone);
    try {
      const created = await db.campaignDelivery.create({
        data: {
          campaignId: day.campaignId!,
          calendarDayId: day.id,
          posterVersionId: day.activePosterVersion!.id,
          scheduledFor,
          status: 'SCHEDULED',
        },
        select: { id: true },
      });
      return await claimAndSend(db, day, created.id, deps, now, true);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return refuse('sending', 'Another request is already delivering this day.');
      }
      throw error;
    }
  }

  if (!options.manual && !isDue(delivery.scheduledFor, now)) {
    return refuse('not-due', 'Not due yet.');
  }
  if (delivery.status === 'FAILED' && !canRetryDelivery(delivery)) {
    return refuse(
      delivery.failurePermanent ? 'permanent-failure' : 'attempts-exhausted',
      delivery.failurePermanent
        ? 'The last failure will repeat until something changes.'
        : 'Every retry has been used. Check the error before trying again.',
    );
  }

  return claimAndSend(db, day, delivery.id, deps, now, options.manual === true);
}

/**
 * The atomic step and everything after it.
 *
 * The claim is a conditional update that restates the status: only one caller's
 * update can match, so two sweeps, two tabs or a sweep racing a Send Now cannot
 * both proceed. A SENDING row older than the stale window is reclaimable, which
 * is how an attempt killed mid-flight is recovered.
 *
 * A scheduled (non-manual) claim of a SCHEDULED row also restates that its
 * moment has come: the sweep chose the row from an earlier read, and a post
 * moved to a later day meanwhile must not be sent on its old slot.
 */
async function claimAndSend(
  db: CampaignDb,
  day: DeliveryDayRow,
  deliveryId: string,
  deps: DeliveryDeps,
  now: Date,
  manual: boolean,
): Promise<SendOutcome> {
  const staleBefore = new Date(now.getTime() - STALE_SENDING_MS);

  const claimed = await db.campaignDelivery.updateMany({
    where: {
      id: deliveryId,
      OR: [
        manual ? { status: 'SCHEDULED' } : { status: 'SCHEDULED', scheduledFor: { lte: now } },
        { status: 'FAILED', failurePermanent: false },
        // Recover an attempt whose worker died.
        { status: 'SENDING', sendingStartedAt: { lt: staleBefore } },
      ],
    },
    data: { status: 'SENDING', sendingStartedAt: now, lastAttemptAt: now, attempts: { increment: 1 } },
  });

  if (claimed.count === 0) {
    return {
      ok: false,
      dayNumber: day.dayNumber,
      reason: 'sending',
      message: 'Another request is already delivering this day.',
      permanent: false,
    };
  }

  /*
   * The hard gate, on the claimed row.
   *
   * Everything checked before the claim could have changed while we waited for
   * it — an approval withdrawn, a poster regenerated, the campaign paused. This
   * re-read is the last word before any credit is spent or any message leaves,
   * and it is inside the server, not the UI.
   */
  const fresh = await loadDeliveryDay(db, day.id);
  const pinnedVersionId = fresh.delivery?.posterVersionId ?? null;
  // `delivery: null` because our own row is now SENDING and would refuse itself;
  // the version pin it carries is therefore checked explicitly below.
  const recheck = evaluateDeliveryEligibility({ ...deliveryCandidateFrom(fresh, deps), delivery: null }, now);
  if (!recheck.eligible) {
    await releaseClaim(db, deliveryId, now, recheck.message, true, false);
    return { ok: false, dayNumber: day.dayNumber, reason: recheck.reason, message: recheck.message, permanent: true };
  }

  if (pinnedVersionId && pinnedVersionId !== fresh.activePosterVersionId) {
    const message =
      'The approved poster was replaced while this was being sent. Nothing was delivered — review the new version first.';
    await releaseClaim(db, deliveryId, now, message, true, true);
    return { ok: false, dayNumber: day.dayNumber, reason: 'version-changed', message, permanent: true };
  }

  const version = fresh.activePosterVersion!;
  const recipient = fresh.client!.whatsappNumber;
  if (!isValidRecipient(recipient)) {
    const message = "The client's WhatsApp number is missing or not a valid international number.";
    await releaseClaim(db, deliveryId, now, message, true, false);
    return { ok: false, dayNumber: day.dayNumber, reason: 'invalid-recipient', message, permanent: true };
  }

  // ---- Provider call -------------------------------------------------------
  let providerMessageId: string | null = null;
  try {
    const mediaUrl = await deps.buildMediaUrl(version.id);
    const result = await deps.sendMedia({
      number: recipient,
      mediaUrl,
      // Read from the claimed row's fresh load, so a retry sends the caption
      // and link as they are saved now.
      caption: buildDeliveryMessage({
        caption: fresh.caption,
        link: fresh.deliveryLink,
        headline: fresh.headline,
        supportingText: fresh.supportingText,
        cta: fresh.cta,
      }),
      fileName: buildDeliveryFileName(fresh.dayNumber, version.imageMimeType),
    });
    providerMessageId = result.providerMessageId;
  } catch (error) {
    const permanent = error instanceof WhatsAppError ? !error.retryable : !(error instanceof MediaUrlNotConfiguredError);
    const message = redactWhatsAppSecrets(
      error instanceof Error ? error.message : 'The WhatsApp provider could not be reached.',
    );
    await releaseClaim(db, deliveryId, now, message, permanent, false);
    return { ok: false, dayNumber: day.dayNumber, reason: 'provider-failed', message, permanent };
  }

  // ---- Settle --------------------------------------------------------------
  const settled = await db.campaignDelivery.updateMany({
    // Guarded on our own claim: a newer attempt must not be overwritten.
    where: { id: deliveryId, status: 'SENDING', sendingStartedAt: now },
    data: {
      status: 'SENT',
      sentAt: now,
      providerMessageId,
      sendingStartedAt: null,
      failureReason: null,
      failurePermanent: false,
    },
  });

  if (settled.count === 1) {
    // Billing is best-effort by design (see src/lib/usage.ts) and must never
    // turn a delivered message into a failed one.
    await recordWhatsAppUsage({ clientId: fresh.clientId, calendarId: fresh.id });
  }

  return { ok: true, dayNumber: day.dayNumber, providerMessageId };
}

// ---------------------------------------------------------------------------
// The message: caption, link and internal notes
// ---------------------------------------------------------------------------

/** Longest internal note a day keeps. */
export const MAX_INTERNAL_NOTES_LENGTH = 2000;

export interface DayMessageInput {
  caption: string;
  link: string | null;
  notes: string | null;
}

export interface DayMessage {
  caption: string;
  /** Normalised: `www.x.com` is saved as `https://www.x.com`. */
  link: string | null;
  notes: string | null;
}

/**
 * Saves the words sent with a day's poster — Caption and Link — and the team's
 * internal Notes, which are never sent.
 *
 * Content beside the poster, not a poster input: the day's revision, its
 * poster versions, their approval and its booking are all left exactly as they
 * are, so an approved, scheduled post stays approved and scheduled. The sender
 * reads the saved caption and link fresh when it claims the delivery, so a
 * retry sends what is saved at that moment.
 *
 * Refused once the day's message is being sent or has been sent — what left
 * must stay what the record says — and for a closed campaign. The refusal is
 * part of the update itself, so it holds against a delivery claimed between
 * the read and the write.
 */
export async function saveCampaignDayMessage(
  db: CampaignDb,
  campaignId: string,
  dayId: string,
  input: DayMessageInput,
): Promise<DayMessage> {
  const caption = input.caption.replace(/\r\n?/g, '\n').trim();
  const notes = (input.notes ?? '').replace(/\r\n?/g, '\n').trim() || null;
  let link: string | null;
  try {
    link = normalizeDeliveryLink(input.link);
  } catch (error) {
    throw new CampaignDomainError('invalid-input', error instanceof Error ? error.message : 'That is not a valid web link.');
  }
  const messageLength = caption.length + (link ? link.length + 2 : 0);
  if (messageLength > MAX_CAPTION_LENGTH) {
    throw new CampaignDomainError(
      'invalid-input',
      `WhatsApp allows ${MAX_CAPTION_LENGTH.toLocaleString('en-IN')} characters for the caption and link together; this is ${messageLength.toLocaleString('en-IN')}.`,
    );
  }
  if (notes && notes.length > MAX_INTERNAL_NOTES_LENGTH) {
    throw new CampaignDomainError('invalid-input', `Keep notes under ${MAX_INTERNAL_NOTES_LENGTH.toLocaleString('en-IN')} characters.`);
  }

  const day = await db.contentCalendar.findUnique({
    where: { id: dayId },
    select: { campaignId: true, dayNumber: true, campaign: { select: { status: true } }, delivery: { select: { status: true } } },
  });
  if (!day || day.campaignId !== campaignId || !day.campaign) {
    throw new CampaignDomainError('not-found', 'That day is not part of this campaign.');
  }
  if (!campaignAllowsChanges(day.campaign.status)) {
    throw new CampaignDomainError('campaign-closed', `The campaign is ${day.campaign.status.toLowerCase()}.`);
  }
  const lockedMessage = (status: CampaignDeliveryStatus) =>
    status === 'SENT'
      ? `Day ${day.dayNumber} has been sent — its message can no longer change.`
      : `Day ${day.dayNumber} is being sent right now — its message can no longer change.`;
  if (day.delivery && (day.delivery.status === 'SENT' || day.delivery.status === 'SENDING')) {
    throw new CampaignDomainError('invalid-transition', lockedMessage(day.delivery.status));
  }

  const updated = await db.contentCalendar.updateMany({
    where: {
      id: dayId,
      campaignId,
      OR: [{ delivery: { is: null } }, { delivery: { is: { status: { notIn: ['SENDING', 'SENT'] } } } }],
    },
    data: { caption, deliveryLink: link, internalNotes: notes },
  });
  if (updated.count === 0) {
    throw new CampaignDomainError('invalid-transition', lockedMessage('SENDING'));
  }
  return { caption, link, notes };
}

/** Returns a claimed row to a settled state after a refusal or a failure. */
async function releaseClaim(
  db: CampaignDb,
  deliveryId: string,
  claimedAt: Date,
  reason: string,
  permanent: boolean,
  cancelled: boolean,
): Promise<void> {
  await db.campaignDelivery.updateMany({
    where: { id: deliveryId, status: 'SENDING', sendingStartedAt: claimedAt },
    data: {
      status: cancelled ? 'CANCELLED' : 'FAILED',
      failureReason: reason.slice(0, 4000),
      failurePermanent: permanent,
      sendingStartedAt: null,
    },
  });
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

export interface SweepResult {
  considered: number;
  sent: number[];
  failed: Array<{ dayNumber: number; message: string }>;
  skipped: Array<{ dayNumber: number; reason: DeliveryRefusal | 'provider-failed' }>;
}

/**
 * Sends every campaign delivery that is due, plus retries whose backoff has
 * elapsed. Called once per cron tick.
 *
 * Sequential on purpose: these all go to real phones through one provider
 * instance, and the batch is small because only due days qualify. One day's
 * failure never stops the rest — a failure on day 5 must not hold up day 6.
 */
export async function runDueCampaignDeliveries(
  db: CampaignDb,
  deps: DeliveryDeps = defaultDeliveryDeps(),
  options: { limit?: number } = {},
): Promise<SweepResult> {
  const now = deps.now();
  const limit = options.limit ?? 25;
  const result: SweepResult = { considered: 0, sent: [], failed: [], skipped: [] };

  const due = await db.campaignDelivery.findMany({
    where: {
      // Only a running campaign of an active client delivers: a paused or
      // cancelled campaign, or a paused client, leaves its bookings untouched
      // and unsent.
      campaign: AUTOMATIC_CAMPAIGNS,
      OR: [
        { status: 'SCHEDULED', scheduledFor: { lte: now } },
        { status: 'FAILED', failurePermanent: false, attempts: { lt: 3 } },
        { status: 'SENDING', sendingStartedAt: { lt: new Date(now.getTime() - STALE_SENDING_MS) } },
      ],
    },
    select: {
      id: true,
      calendarDayId: true,
      status: true,
      attempts: true,
      lastAttemptAt: true,
      scheduledFor: true,
      sendingStartedAt: true,
    },
    orderBy: { scheduledFor: 'asc' },
    take: limit,
  });

  for (const delivery of due) {
    // Respect the backoff between automatic retries.
    if (delivery.status === 'FAILED') {
      const waitUntil = (delivery.lastAttemptAt?.getTime() ?? 0) + retryDelayMs(delivery.attempts);
      if (now.getTime() < waitUntil) continue;
    }
    if (delivery.status === 'SENDING' && !isStaleClaim(delivery.sendingStartedAt, now)) continue;

    result.considered += 1;
    const outcome = await sendCampaignDelivery(db, delivery.calendarDayId, deps);
    if (outcome.ok) {
      result.sent.push(outcome.dayNumber);
    } else if (outcome.reason === 'provider-failed') {
      result.failed.push({ dayNumber: outcome.dayNumber, message: outcome.message });
    } else {
      result.skipped.push({ dayNumber: outcome.dayNumber, reason: outcome.reason });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Operator actions
// ---------------------------------------------------------------------------

/** Withdraws a booking that has not gone out. A sent day is never touched. */
export async function cancelCampaignDelivery(db: CampaignDb, dayId: string): Promise<void> {
  const updated = await db.campaignDelivery.updateMany({
    where: { calendarDayId: dayId, status: { in: ['SCHEDULED', 'FAILED'] } },
    data: { status: 'CANCELLED', failureReason: 'Cancelled by an operator.', sendingStartedAt: null },
  });
  if (updated.count === 0) {
    throw new CampaignDomainError('invalid-transition', 'There is nothing to cancel for this day.');
  }
}

export const ATTEMPTED_DELIVERY_WARNING = 'This delivery was attempted before and may already have reached WhatsApp.';

/**
 * Puts a cancelled, skipped or failed day back in the queue.
 *
 * Re-pins the current active version and clears the failure, so a retry always
 * sends what is approved now — never a stale pin. Refused for a sent day or one
 * being sent.
 *
 * A cancelled or skipped delivery that was already attempted may have reached
 * WhatsApp (an ambiguous failure), so booking it again needs `confirmAttempted`
 * — the operator saw that warning.
 *
 * Runs under the campaign's booking lock and computes the moment from a fresh
 * read, so it cannot write a date a move has just replaced.
 */
export async function rescheduleCampaignDelivery(
  db: CampaignDb,
  dayId: string,
  deps: DeliveryDeps = defaultDeliveryDeps(),
  options: { confirmAttempted?: boolean } = {},
): Promise<void> {
  const { campaignId } = await loadDeliveryDay(db, dayId);

  await runInCampaignTransaction(db, async (tx) => {
    await lockCampaignForBooking(tx, campaignId!);
    const day = await loadDeliveryDay(tx, dayId);
    const existing = day.delivery;
    if (existing?.status === 'SENT') {
      throw new CampaignDomainError('invalid-transition', 'This day was already delivered.');
    }
    if (existing?.status === 'SENDING') {
      throw new CampaignDomainError('invalid-transition', 'This day is being sent right now.');
    }
    if (existing && (existing.status === 'CANCELLED' || existing.status === 'SKIPPED') && existing.attempts > 0 && !options.confirmAttempted) {
      throw new CampaignDomainError('invalid-transition', `${ATTEMPTED_DELIVERY_WARNING} Confirm to book it again.`);
    }

    const eligibility = evaluateDeliveryEligibility({ ...deliveryCandidateFrom(day, deps), delivery: null }, deps.now());
    if (!eligibility.eligible) throw new CampaignDomainError('invalid-transition', eligibility.message);

    const version = day.activePosterVersion!;
    const scheduledFor = scheduledInstantFor(day.id, day.scheduledDate, day.campaign!.deliveryTime, deps.timeZone);
    if (!existing) {
      const created = await tx.campaignDelivery.createMany({
        data: [{ campaignId: day.campaignId!, calendarDayId: dayId, posterVersionId: version.id, scheduledFor, status: 'SCHEDULED' }],
        skipDuplicates: true,
      });
      if (created.count !== 1) throw new CampaignDomainError('conflict', 'This day was booked by someone else meanwhile. Refresh and try again.');
      return;
    }
    const updated = await tx.campaignDelivery.updateMany({
      where: { id: existing.id, status: existing.status },
      data: {
        posterVersionId: version.id,
        scheduledFor,
        status: 'SCHEDULED',
        attempts: 0,
        failureReason: null,
        failurePermanent: false,
        sendingStartedAt: null,
      },
    });
    if (updated.count !== 1) throw new CampaignDomainError('conflict', 'This delivery changed meanwhile. Refresh and try again.');
  });
}

// ---------------------------------------------------------------------------
// The dashboard
// ---------------------------------------------------------------------------

export interface DeliveryDayView {
  dayId: string;
  dayNumber: number;
  scheduledDate: Date;
  headline: string | null;
  /** The studio row behind the active poster, for the preview thumbnail. */
  generationId: string | null;
  versionNumber: number | null;
  approvalStatus: string | null;
  status: CampaignDeliveryStatus | null;
  statusLabel: string;
  scheduledFor: Date | null;
  attempts: number;
  lastAttemptAt: Date | null;
  sentAt: Date | null;
  providerMessageId: string | null;
  failureReason: string | null;
  failurePermanent: boolean;
  /** Why it cannot be sent right now, when it cannot. */
  refusal: string | null;
  canSendNow: boolean;
  canRetry: boolean;
  canCancel: boolean;
}

export interface CampaignDeliveryOverview {
  campaign: { id: string; clientId: string; name: string; status: CampaignStatus; deliveryTime: string };
  /** The destination, stated plainly because it is the business's own number. */
  recipient: { number: string | null; valid: boolean };
  whatsappConfigured: boolean;
  mediaConfigured: boolean;
  days: DeliveryDayView[];
  summary: DeliverySummary;
}

/** The delivery dashboard for one campaign. Read-only; sends nothing. */
export async function loadCampaignDeliveryOverview(
  db: CampaignDb,
  campaignId: string,
  deps: DeliveryDeps = defaultDeliveryDeps(),
): Promise<CampaignDeliveryOverview> {
  const campaign = await db.campaign.findUnique({
    where: { id: campaignId },
    select: {
      id: true,
      clientId: true,
      name: true,
      status: true,
      deliveryTime: true,
      client: { select: { whatsappNumber: true } },
    },
  });
  if (!campaign) throw new CampaignDomainError('not-found', 'Campaign does not exist.');

  const days = await db.contentCalendar.findMany({
    where: { campaignId },
    select: {
      ...deliveryDaySelect,
      activePosterVersion: {
        select: {
          id: true,
          contentRevision: true,
          approvalStatus: true,
          imageDriveFileId: true,
          imageMimeType: true,
          versionNumber: true,
          studioGenerationId: true,
        },
      },
      delivery: {
        select: {
          id: true,
          status: true,
          posterVersionId: true,
          attempts: true,
          failurePermanent: true,
          sendingStartedAt: true,
          scheduledFor: true,
          lastAttemptAt: true,
          sentAt: true,
          providerMessageId: true,
          failureReason: true,
        },
      },
    },
    orderBy: { dayNumber: 'asc' },
  });

  const now = deps.now();
  const views: DeliveryDayView[] = days.map((day) => {
    const eligibility = evaluateDeliveryEligibility(deliveryCandidateFrom(day as DeliveryDayRow, deps), now);
    const delivery = day.delivery;
    return {
      dayId: day.id,
      dayNumber: day.dayNumber,
      scheduledDate: day.scheduledDate,
      headline: day.headline,
      generationId: day.activePosterVersion?.studioGenerationId ?? null,
      versionNumber: day.activePosterVersion?.versionNumber ?? null,
      approvalStatus: day.activePosterVersion?.approvalStatus ?? null,
      status: delivery?.status ?? null,
      statusLabel: delivery ? DELIVERY_STATUS_LABELS[delivery.status] : 'Not scheduled',
      scheduledFor: delivery?.scheduledFor ?? null,
      attempts: delivery?.attempts ?? 0,
      lastAttemptAt: delivery?.lastAttemptAt ?? null,
      sentAt: delivery?.sentAt ?? null,
      providerMessageId: delivery?.providerMessageId ?? null,
      failureReason: delivery?.failureReason ?? null,
      failurePermanent: delivery?.failurePermanent ?? false,
      refusal: eligibility.eligible ? null : eligibility.message,
      canSendNow: eligibility.eligible,
      canRetry:
        delivery !== null &&
        delivery !== undefined &&
        (delivery.status === 'FAILED' || delivery.status === 'CANCELLED' || delivery.status === 'SKIPPED') &&
        eligibility.eligible,
      canCancel: delivery?.status === 'SCHEDULED' || delivery?.status === 'FAILED',
    };
  });

  return {
    campaign: {
      id: campaign.id,
      clientId: campaign.clientId,
      name: campaign.name,
      status: campaign.status,
      deliveryTime: campaign.deliveryTime,
    },
    recipient: {
      number: campaign.client?.whatsappNumber ?? null,
      valid: isValidRecipient(campaign.client?.whatsappNumber ?? null),
    },
    whatsappConfigured: deps.whatsappConfigured(),
    mediaConfigured: deps.mediaConfigured(),
    days: views,
    summary: summarizeDeliveries(
      views.map((view) => ({ status: view.status, scheduledFor: view.scheduledFor })),
      now,
    ),
  };
}
