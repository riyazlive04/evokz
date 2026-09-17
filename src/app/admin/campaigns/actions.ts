'use server';

import { Prisma } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import type { ActionResult } from '@/app/admin/dashboard/actions';
import { LlmError } from '@/lib/ai/openai';
import { cloneTemplatesIntoCampaign } from '@/lib/campaign/clone-queue';
import { describeBookingMoment } from '@/lib/campaign/board';
import { changeCampaignStatusWithBookings } from '@/lib/campaign/board-service';
import { CampaignDomainError, createCampaign } from '@/lib/campaign/service';
import {
  approveCampaignDayPoster,
  generateCampaignDayPoster,
  saveStudioPosterToCampaignDay,
  type GenerateDayPosterResult,
} from '@/lib/campaign/poster-generation-service';
import {
  cancelCampaignDelivery,
  defaultDeliveryDeps,
  type BookingResult,
  type DayBookingOutcome,
  rescheduleCampaignDelivery,
  sendCampaignDelivery,
  type SendOutcome,
} from '@/lib/campaign/delivery-service';
import { cancelQueuedGeneration } from '@/lib/campaign/generation-queue';
import { MAX_REJECTION_DETAIL } from '@/lib/campaign/review';
import {
  approveCampaignDayPosters,
  rejectCampaignDayPoster,
  type BulkApprovalResult,
} from '@/lib/campaign/review-service';
import { setTemplateActive } from '@/lib/campaign/template-mapping-service';
import { prisma } from '@/lib/prisma';
import { getAppTimeZone } from '@/lib/time';

/**
 * Campaign actions used by the campaign board, the client page, the vertical
 * page and Poster Studio: create a campaign, activate or pause it, generate,
 * approve and reject posters, and deliver them.
 *
 * Thin wrappers over `src/lib/campaign`: parse the wire input, call one service,
 * map failures to operator copy. Behind the admin session like every other
 * action (`src/middleware.ts` gates `/admin/*`, which is where these POST).
 *
 * Only the poster actions render posters or write poster versions, and only the
 * delivery actions near the end of this file can send anything. The board's own
 * actions (moves, Fill empty days, rewrite, bulk generate) live in
 * `board-actions.ts` and `clone-actions.ts`.
 */

const uuid = z.string().uuid();

function revalidateAdmin(): void {
  revalidatePath('/admin', 'layout');
}

function failure(error: string): ActionResult<never> {
  return { ok: false, error };
}

function toFailure(error: unknown, context: string): ActionResult<never> {
  if (error instanceof CampaignDomainError) return failure(error.message);
  if (error instanceof LlmError) return failure(error.message);
  if (error instanceof z.ZodError) return failure(error.issues[0]?.message ?? 'The request was not valid.');
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
    return failure('That record no longer exists.');
  }
  console.error(`[campaign:action] ${context} failed:`, error);
  return failure(`${context} failed. Check the server logs for details.`);
}

// ---------------------------------------------------------------------------

const createInputSchema = z.object({
  name: z.string().trim().min(1, 'Name the campaign').max(160),
  /** A calendar date, YYYY-MM-DD, in the app timezone. */
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a start date'),
  durationDays: z.number().int().min(1).max(730).optional(),
  /** Still accepted for compatibility; the form no longer asks, and new campaigns default to MANUAL. */
  templateMappingMode: z.enum(['AUTO', 'MANUAL']).optional(),
});

export async function createCampaignAction(
  clientId: string,
  input: z.input<typeof createInputSchema>,
): Promise<ActionResult<{ campaignId: string; dayCount: number; filledDays: number }>> {
  try {
    const data = createInputSchema.parse(input);
    // Midday UTC on that calendar date falls on the same local date in every
    // timezone the console is run in; slot planning truncates it to local midnight.
    const startDate = new Date(`${data.startDate}T12:00:00Z`);
    const result = await createCampaign(prisma, {
      clientId: uuid.parse(clientId),
      name: data.name,
      startDate,
      durationDays: data.durationDays,
      templateMappingMode: data.templateMappingMode,
    });
    // The days fill themselves with the vertical's read templates (no AI call).
    // Best-effort: the campaign exists either way, and "Fill empty days" on the
    // board runs the same fill again.
    let filledDays = 0;
    try {
      filledDays = (await cloneTemplatesIntoCampaign(prisma, result.campaignId)).filled.length;
    } catch (error) {
      console.error(`[campaign:action] filling campaign=${result.campaignId} with templates failed:`, error instanceof Error ? error.message : error);
    }
    revalidateAdmin();
    return { ok: true, data: { campaignId: result.campaignId, dayCount: result.dayCount, filledDays } };
  } catch (error) {
    return toFailure(error, 'Creating the campaign');
  }
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/** Retires or restores a template for new campaign days. Days already using it keep it and are flagged. */
export async function setTemplateActiveAction(
  templateId: string,
  active: boolean,
): Promise<ActionResult<{ active: boolean; campaignDaysAffected: number }>> {
  try {
    const result = await setTemplateActive(prisma, uuid.parse(templateId), z.boolean().parse(active));
    revalidateAdmin();
    return { ok: true, data: result };
  } catch (error) {
    return toFailure(error, 'Changing the template status');
  }
}

// ---------------------------------------------------------------------------
// Poster generation. Generates posters; never sends anything.
// ---------------------------------------------------------------------------

const posterModeSchema = z.enum(['missing', 'upcoming', 'regenerate']);

/**
 * Generates ONE day's poster if it is eligible now — the board card's Generate.
 * Bulk generation queues days for the server instead (`clone-actions.ts`).
 */
export async function generateCampaignDayPosterAction(
  campaignId: string,
  dayId: string,
  request: { mode: 'missing' | 'upcoming' | 'regenerate'; explicit?: boolean },
): Promise<ActionResult<GenerateDayPosterResult>> {
  try {
    const result = await generateCampaignDayPoster(prisma, uuid.parse(campaignId), uuid.parse(dayId), {
      mode: posterModeSchema.parse(request.mode),
      explicit: z.boolean().optional().parse(request.explicit),
    });
    revalidateAdmin();
    return { ok: true, data: result };
  } catch (error) {
    return toFailure(error, 'Generating the poster');
  }
}

/**
 * What approving did to a day's delivery, worded for the operator. Dates are
 * formatted here, in the app timezone, so the browser never re-derives a day.
 */
export interface BookingNotice {
  dayNumber: number;
  result: BookingResult;
  /** "09:05 today" / "Thu 18 Sept 09:03" — when the booking goes out. */
  whenLabel: string | null;
  /** The moment has already come: the next sweep sends it within a minute. */
  immediate: boolean;
  /** Why it was not booked, when it was not. */
  refusal: string | null;
}

function toBookingNotice(outcome: DayBookingOutcome): BookingNotice {
  const moment = outcome.scheduledFor ? describeBookingMoment(outcome.scheduledFor, new Date(), getAppTimeZone()) : null;
  return {
    dayNumber: outcome.dayNumber,
    result: outcome.result,
    whenLabel: moment?.label ?? null,
    immediate: moment?.immediate ?? false,
    refusal: outcome.refusal?.message ?? null,
  };
}

export async function approveCampaignDayPosterAction(dayId: string, versionId: string): Promise<ActionResult<{ booking: BookingNotice | null }>> {
  try {
    const { booking } = await approveCampaignDayPoster(prisma, uuid.parse(dayId), uuid.parse(versionId));
    revalidateAdmin();
    return { ok: true, data: { booking: booking ? toBookingNotice(booking) : null } };
  } catch (error) {
    return toFailure(error, 'Approving the poster');
  }
}

/** Saves a Poster Studio poster (usually an Edit of the day's poster) as the day's new active version. */
export async function saveStudioPosterToCampaignDayAction(
  dayId: string,
  generationId: string,
): Promise<ActionResult<{ versionId: string; versionNumber: number; alreadySaved: boolean }>> {
  try {
    const result = await saveStudioPosterToCampaignDay(prisma, uuid.parse(dayId), uuid.parse(generationId));
    revalidateAdmin();
    return { ok: true, data: result };
  } catch (error) {
    return toFailure(error, 'Saving the poster to the campaign day');
  }
}

/**
 * Activate, pause or resume a campaign.
 *
 * Activating (or resuming) books every approved day for delivery at once — the
 * same booking an approval makes — so nobody has to press Schedule. It sends
 * nothing itself: bookings go out at their moments through the delivery gate.
 * Pausing touches no booking; the sweep simply skips a paused campaign.
 */
export async function changeCampaignStatusAction(
  campaignId: string,
  status: 'ACTIVE' | 'PAUSED',
): Promise<ActionResult<{ from: string; to: string; booked: number }>> {
  try {
    const result = await changeCampaignStatusWithBookings(prisma, uuid.parse(campaignId), z.enum(['ACTIVE', 'PAUSED']).parse(status));
    revalidateAdmin();
    return { ok: true, data: result };
  } catch (error) {
    return toFailure(error, 'Changing the campaign status');
  }
}

// ---------------------------------------------------------------------------
// Review and approval. Reviews posters; never sends or deletes anything.
// ---------------------------------------------------------------------------

const rejectionSchema = z.object({
  reason: z.string().trim().min(1, 'Choose a reason for sending this poster back.'),
  detail: z.string().trim().max(MAX_REJECTION_DETAIL).optional(),
});

/**
 * Sends the day's active poster back with a reason. Nothing is deleted: the
 * version and its files stay, and the day keeps it until a new version is made.
 */
export async function rejectCampaignDayPosterAction(
  dayId: string,
  versionId: string,
  input: z.input<typeof rejectionSchema>,
): Promise<ActionResult<{ note: string }>> {
  try {
    const data = rejectionSchema.parse(input);
    const result = await rejectCampaignDayPoster(prisma, uuid.parse(dayId), uuid.parse(versionId), data);
    revalidateAdmin();
    return { ok: true, data: result };
  } catch (error) {
    return toFailure(error, 'Rejecting the poster');
  }
}

/** Approves the active poster of every selected day that may be approved, and reports the rest. */
export async function approveCampaignPostersAction(
  campaignId: string,
  dayIds: string[],
): Promise<ActionResult<Omit<BulkApprovalResult, 'bookings'> & { bookings: BookingNotice[] }>> {
  try {
    const ids = z.array(uuid).min(1, 'Select at least one day.').max(730).parse(dayIds);
    const result = await approveCampaignDayPosters(prisma, uuid.parse(campaignId), ids);
    revalidateAdmin();
    return { ok: true, data: { ...result, bookings: result.bookings.map(toBookingNotice) } };
  } catch (error) {
    return toFailure(error, 'Approving the selected posters');
  }
}

// ---------------------------------------------------------------------------
// Delivery
//
// These are the only actions in this file that can put a message on the wire.
// None of them decides whether a day may be sent: every one calls the delivery
// service, which re-reads the campaign, the day and the active version from the
// database and re-runs the full gate after claiming the row. An action cannot
// bypass approval, and neither can a hand-made request to it.
// ---------------------------------------------------------------------------

/**
 * Confirms a day belongs to the campaign the caller named (Phase 7).
 *
 * The console has one shared login, so this is not an authorization boundary —
 * it is blast radius. `sendCampaignDayNowAction` is the one action that puts a
 * message on a real client's phone, and taking the pair makes a stale tab or a
 * mistyped id unable to deliver another client's day. Poster generation has
 * required the pair since Phase 4; delivery now matches it.
 */
async function assertDayInCampaign(campaignId: string, dayId: string): Promise<void> {
  const day = await prisma.contentCalendar.findFirst({
    where: { id: dayId, campaignId },
    select: { id: true },
  });
  if (!day) throw new CampaignDomainError('not-found', 'That day is not part of this campaign.');
}

/**
 * Send Now for one day.
 *
 * The only gate this relaxes is the scheduled moment. Approval, the active
 * version, campaign status, the recipient and the one-delivery-per-day
 * constraint all still apply, server-side.
 */
export async function sendCampaignDayNowAction(
  campaignId: string,
  dayId: string,
): Promise<ActionResult<SendOutcome>> {
  try {
    const campaign = uuid.parse(campaignId);
    const day = uuid.parse(dayId);
    await assertDayInCampaign(campaign, day);
    const outcome = await sendCampaignDelivery(prisma, day, defaultDeliveryDeps(), { manual: true });
    revalidateAdmin();
    // A refusal is a result, not an error: the caller shows the reason.
    return { ok: true, data: outcome };
  } catch (error) {
    return toFailure(error, 'Sending the poster');
  }
}

/**
 * Puts a failed, cancelled or skipped day back in the queue at its own time.
 *
 * A cancelled or skipped delivery that was already attempted may have reached
 * WhatsApp; booking it again needs `confirmAttempted` — the operator was warned.
 */
export async function retryCampaignDeliveryAction(
  campaignId: string,
  dayId: string,
  options: { confirmAttempted?: boolean } = {},
): Promise<ActionResult<null>> {
  try {
    const campaign = uuid.parse(campaignId);
    const day = uuid.parse(dayId);
    await assertDayInCampaign(campaign, day);
    await rescheduleCampaignDelivery(prisma, day, defaultDeliveryDeps(), { confirmAttempted: z.boolean().optional().parse(options.confirmAttempted) });
    revalidateAdmin();
    return { ok: true, data: null };
  } catch (error) {
    return toFailure(error, 'Rescheduling the delivery');
  }
}

/** Withdraws a booking that has not gone out. A sent day is never touched. */
export async function cancelCampaignDeliveryAction(campaignId: string, dayId: string): Promise<ActionResult<null>> {
  try {
    const campaign = uuid.parse(campaignId);
    const day = uuid.parse(dayId);
    await assertDayInCampaign(campaign, day);
    await cancelCampaignDelivery(prisma, day);
    revalidateAdmin();
    return { ok: true, data: null };
  } catch (error) {
    return toFailure(error, 'Cancelling the delivery');
  }
}

// ---------------------------------------------------------------------------
// Server-side poster generation
// ---------------------------------------------------------------------------

/** Withdraws queued days no worker has taken yet. Work in flight is left alone. */
export async function cancelQueuedGenerationAction(campaignId: string): Promise<ActionResult<{ cancelled: number }>> {
  try {
    const cancelled = await cancelQueuedGeneration(prisma, uuid.parse(campaignId));
    revalidateAdmin();
    return { ok: true, data: { cancelled } };
  } catch (error) {
    return toFailure(error, 'Cancelling the queued generation');
  }
}
