import { Prisma, type CampaignDeliveryStatus, type CampaignStatus, type PosterApprovalStatus } from '@prisma/client';

import {
  buildDeliveryCaption,
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
import { CampaignDomainError, type CampaignDb } from '@/lib/campaign/service';
import { getAppTimeZone } from '@/lib/time';
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
  posterTemplateId: true,
  suggestedTemplateId: true,
  activePosterVersionId: true,
  activePosterVersion: {
    select: { id: true, contentRevision: true, approvalStatus: true, imageDriveFileId: true, imageMimeType: true },
  },
  client: { select: { whatsappNumber: true } },
  campaign: { select: { id: true, status: true, deliveryTime: true } },
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
interface CandidateSource {
  campaignId: string | null;
  contentStatus: DeliveryDayRow['contentStatus'];
  contentRevision: number;
  posterTemplateId: string | null;
  suggestedTemplateId: string | null;
  activePosterVersion: { id: string; contentRevision: number; approvalStatus: PosterApprovalStatus } | null;
  client: { whatsappNumber: string } | null;
  campaign: { status: CampaignStatus } | null;
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
function scheduledInstantFor(dayId: string, scheduledDate: Date, deliveryTime: string, timeZone: string): Date {
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

function candidateFrom(day: CandidateSource, deps: DeliveryDeps) {
  return {
    campaignId: day.campaignId,
    campaignStatus: (day.campaign?.status ?? 'DRAFT') as CampaignStatus,
    contentReady: day.contentStatus === 'READY',
    hasTemplate: Boolean(day.posterTemplateId ?? day.suggestedTemplateId),
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

export interface ScheduleOutcome {
  scheduled: number[];
  /** Days that could not be booked, grouped by why. */
  skipped: Array<{ reason: DeliveryRefusal; message: string; dayNumbers: number[] }>;
  cancelled: number[];
  missed: number[];
}

/**
 * Books a delivery for every day whose approved poster is ready, and keeps the
 * existing bookings honest.
 *
 * Safe to run repeatedly — on every campaign page load, after an approval, and
 * at the start of each sweep. The unique constraint on `calendarDayId` means a
 * second run can only ever update, never duplicate. It never sends.
 */
export async function scheduleCampaignDeliveries(
  db: CampaignDb,
  campaignId: string,
  deps: DeliveryDeps = defaultDeliveryDeps(),
): Promise<ScheduleOutcome> {
  const campaign = await db.campaign.findUnique({
    where: { id: campaignId },
    select: { id: true, status: true, deliveryTime: true },
  });
  if (!campaign) throw new CampaignDomainError('not-found', 'Campaign does not exist.');

  const days = await db.contentCalendar.findMany({
    where: { campaignId },
    select: deliveryDaySelect,
    orderBy: { dayNumber: 'asc' },
  });

  const now = deps.now();
  const outcome: ScheduleOutcome = { scheduled: [], skipped: [], cancelled: [], missed: [] };
  const groups = new Map<DeliveryRefusal, { reason: DeliveryRefusal; message: string; dayNumbers: number[] }>();

  for (const day of days) {
    const scheduledFor = scheduledInstantFor(day.id, day.scheduledDate, campaign.deliveryTime, deps.timeZone);
    const existing = day.delivery;

    // ---- Keep an existing booking consistent (§8, §17) ---------------------
    if (existing) {
      if (existing.status === 'SCHEDULED') {
        // The approved poster was replaced: cancel rather than send either one.
        if (day.activePosterVersionId && existing.posterVersionId !== day.activePosterVersionId) {
          await db.campaignDelivery.updateMany({
            where: { id: existing.id, status: 'SCHEDULED' },
            data: {
              status: 'CANCELLED',
              failureReason: 'The approved poster was replaced before this went out. Review the new version, then schedule it again.',
            },
          });
          outcome.cancelled.push(day.dayNumber);
          continue;
        }
        // Its moment passed a whole local day ago: it is not late, it is missed.
        if (isMissed(existing.scheduledFor, now, deps.timeZone)) {
          await db.campaignDelivery.updateMany({
            where: { id: existing.id, status: 'SCHEDULED' },
            data: {
              status: 'SKIPPED',
              failureReason: 'Its delivery day passed before it was sent.',
            },
          });
          outcome.missed.push(day.dayNumber);
          continue;
        }
        // A rescheduled campaign moves its bookings; it never sends because of it.
        if (existing.scheduledFor.getTime() !== scheduledFor.getTime()) {
          await db.campaignDelivery.updateMany({
            where: { id: existing.id, status: 'SCHEDULED' },
            data: { scheduledFor },
          });
        }
      }
      continue;
    }

    // ---- Book a new one ----------------------------------------------------
    const eligibility = evaluateDeliveryEligibility(candidateFrom(day, deps), now);
    if (!eligibility.eligible) {
      const group = groups.get(eligibility.reason) ?? {
        reason: eligibility.reason,
        message: eligibility.message,
        dayNumbers: [],
      };
      group.dayNumbers.push(day.dayNumber);
      groups.set(eligibility.reason, group);
      continue;
    }

    // A day whose moment is long past is never booked retroactively.
    if (isMissed(scheduledFor, now, deps.timeZone)) {
      outcome.missed.push(day.dayNumber);
      continue;
    }

    try {
      await db.campaignDelivery.create({
        data: {
          campaignId,
          calendarDayId: day.id,
          posterVersionId: day.activePosterVersion!.id,
          scheduledFor,
          status: 'SCHEDULED',
        },
      });
      outcome.scheduled.push(day.dayNumber);
    } catch (error) {
      // P2002 on calendarDayId: another request booked it first. That is the
      // constraint doing its job, not a failure.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    }
  }

  outcome.skipped = [...groups.values()];
  return outcome;
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
  const eligibility = evaluateDeliveryEligibility(candidateFrom(day, deps), now);
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
      return await claimAndSend(db, day, created.id, deps, now);
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

  return claimAndSend(db, day, delivery.id, deps, now);
}

/**
 * The atomic step and everything after it.
 *
 * The claim is a conditional update that restates the status: only one caller's
 * update can match, so two sweeps, two tabs or a sweep racing a Send Now cannot
 * both proceed. A SENDING row older than the stale window is reclaimable, which
 * is how an attempt killed mid-flight is recovered.
 */
async function claimAndSend(
  db: CampaignDb,
  day: DeliveryDayRow,
  deliveryId: string,
  deps: DeliveryDeps,
  now: Date,
): Promise<SendOutcome> {
  const staleBefore = new Date(now.getTime() - STALE_SENDING_MS);

  const claimed = await db.campaignDelivery.updateMany({
    where: {
      id: deliveryId,
      OR: [
        { status: 'SCHEDULED' },
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
  const recheck = evaluateDeliveryEligibility({ ...candidateFrom(fresh, deps), delivery: null }, now);
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
      caption: buildDeliveryCaption({
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
      // Only a running campaign delivers: a paused or cancelled one leaves its
      // future bookings untouched and unsent.
      campaign: { status: 'ACTIVE' },
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

/**
 * Puts a cancelled, skipped or failed day back in the queue.
 *
 * Re-pins the current active version and clears the failure, so a retry always
 * sends what is approved now — never a stale pin. Refused for a sent day.
 */
export async function rescheduleCampaignDelivery(
  db: CampaignDb,
  dayId: string,
  deps: DeliveryDeps = defaultDeliveryDeps(),
): Promise<void> {
  const day = await loadDeliveryDay(db, dayId);
  if (day.delivery?.status === 'SENT') {
    throw new CampaignDomainError('invalid-transition', 'This day was already delivered.');
  }

  const eligibility = evaluateDeliveryEligibility({ ...candidateFrom(day, deps), delivery: null }, deps.now());
  if (!eligibility.eligible) throw new CampaignDomainError('invalid-transition', eligibility.message);

  const scheduledFor = scheduledInstantFor(day.id, day.scheduledDate, day.campaign!.deliveryTime, deps.timeZone);
  await db.campaignDelivery.upsert({
    where: { calendarDayId: dayId },
    create: {
      campaignId: day.campaignId!,
      calendarDayId: dayId,
      posterVersionId: day.activePosterVersion!.id,
      scheduledFor,
      status: 'SCHEDULED',
    },
    update: {
      posterVersionId: day.activePosterVersion!.id,
      scheduledFor,
      status: 'SCHEDULED',
      attempts: 0,
      failureReason: null,
      failurePermanent: false,
      sendingStartedAt: null,
    },
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
    const eligibility = evaluateDeliveryEligibility(candidateFrom(day as DeliveryDayRow, deps), now);
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
