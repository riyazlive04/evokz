'use server';

import { DeliveryStatus, Prisma } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { describeError, runCreativePipeline } from '@/lib/ai-pipeline';
import { tokenizeClientBrand } from '@/lib/ai/brand-tokenizer';
import { generateContentCalendar } from '@/lib/ai/calendar-generator';
import {
  extractWebsiteColors,
  toBrandColors,
  WebsiteColorError,
  type ExtractionReport,
} from '@/lib/brand/website-colors';
import { parseBrandGuideline, type BrandGuideline } from '@/lib/types/brand';
import { applyCalendarImport, type CalendarImportResult } from '@/lib/calendar-import';
import type { CalendarImportInput } from '@/lib/calendar-parse';
import {
  ensureVerticalTemplateFolder,
  trashDriveFile,
  uploadClientAsset,
} from '@/lib/google-drive';
import { readImageDimensions } from '@/lib/poster/image-info';
import { keyLogoBackground, type LogoKeySkipReason } from '@/lib/poster/logo-key';
import { isImageSizePresetId } from '@/lib/image-sizes';
import {
  clientProvisionSchema,
  normalizeWhatsappNumber,
  provisionClient,
  repairClientDriveFolder,
} from '@/lib/onboarding';
import { mapWithConcurrency } from '@/lib/cron-worker';
import { intEnv } from '@/lib/env';
import { prisma } from '@/lib/prisma';
import {
  describeDeliveryDays,
  formatDisplayDate,
  getAppTimeZone,
  HH_MM_PATTERN,
  normalizeDeliveryDays,
  nthDeliveryDate,
} from '@/lib/time';

/**
 * Server actions for the admin dashboard.
 *
 * Every action returns a discriminated `ActionResult` instead of throwing:
 * an unhandled server-action rejection reaches the client as an opaque digest,
 * which is useless to an operator staring at a failed row.
 */

/**
 * Clears the client router cache for the whole console after a mutation.
 *
 * The admin surfaces are all `force-dynamic`, so nothing is cached on the
 * server — but a mutated record is visible from several sections at once
 * (a plan on `/admin/plans`, its client count on `/admin/clients`), and
 * scoping revalidation to one page would leave the others showing the
 * pre-mutation RSC payload after a soft navigation.
 */
function revalidateAdmin(): void {
  revalidatePath('/admin', 'layout');
}

export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

function success(): ActionResult<undefined>;
function success<T>(data: T): ActionResult<T>;
function success<T>(data?: T): ActionResult<T | undefined> {
  return { ok: true, data };
}

function failure(error: string, fieldErrors?: Record<string, string[]>): ActionResult<never> {
  return { ok: false, error, ...(fieldErrors ? { fieldErrors } : {}) };
}

/** Maps thrown errors — including Prisma constraint codes — to operator copy. */
function toFailure(error: unknown, context: string): ActionResult<never> {
  if (error instanceof z.ZodError) {
    const fieldErrors = Object.fromEntries(
      Object.entries(error.flatten().fieldErrors).filter(
        (entry): entry is [string, string[]] => Array.isArray(entry[1]),
      ),
    );
    const first = Object.values(fieldErrors)[0]?.[0];
    return failure(first ?? 'Validation failed', fieldErrors);
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    switch (error.code) {
      case 'P2002':
        return failure('That record already exists.');
      case 'P2003':
        return failure('Cannot delete: clients are still attached to this record.');
      case 'P2025':
        return failure('That record no longer exists.');
      default:
        break;
    }
  }

  console.error(`[ace:admin] ${context} failed:`, describeError(error));
  return failure(`${context} failed. Check the server logs for details.`);
}

// ---------------------------------------------------------------------------
// Plan CRUD
// ---------------------------------------------------------------------------

const planSchema = z.object({
  name: z.string().trim().min(2, 'Plan name must be at least 2 characters').max(120),
  durationDays: z
    .number({ invalid_type_error: 'Duration must be a number' })
    .int('Duration must be a whole number')
    .min(1, 'Duration must be at least 1 day')
    .max(3650, 'Duration cannot exceed 3650 days'),
  // Nullable rather than defaulted: an unpriced plan must show as "unknown
  // margin" on the dashboard, not as a ₹0 fee that implies a total loss.
  priceInr: z
    .number({ invalid_type_error: 'Price must be a number' })
    .int('Price must be whole rupees')
    .min(0, 'Price cannot be negative')
    .max(100_000_000, 'Price is implausibly large')
    .nullable()
    .default(null),
});

export type PlanInput = z.input<typeof planSchema>;

export async function createPlan(input: PlanInput): Promise<ActionResult> {
  try {
    const data = planSchema.parse(input);
    await prisma.plan.create({ data });
    revalidateAdmin();
    return success();
  } catch (error) {
    return toFailure(error, 'Creating plan');
  }
}

export async function updatePlan(id: string, input: PlanInput): Promise<ActionResult> {
  try {
    const data = planSchema.parse(input);
    await prisma.plan.update({ where: { id: z.string().uuid().parse(id) }, data });
    revalidateAdmin();
    return success();
  } catch (error) {
    return toFailure(error, 'Updating plan');
  }
}

export async function deletePlan(id: string): Promise<ActionResult> {
  try {
    const planId = z.string().uuid().parse(id);

    // onDelete: Restrict would surface as P2003; checking first lets the
    // operator see how many clients block the delete.
    const attached = await prisma.client.count({ where: { planId } });
    if (attached > 0) {
      return failure(
        `Cannot delete: ${attached} client${attached === 1 ? '' : 's'} still use this plan.`,
      );
    }

    await prisma.plan.delete({ where: { id: planId } });
    revalidateAdmin();
    return success();
  } catch (error) {
    return toFailure(error, 'Deleting plan');
  }
}

// ---------------------------------------------------------------------------
// Category CRUD
// ---------------------------------------------------------------------------

const categorySchema = z.object({
  name: z.string().trim().min(2, 'Category name must be at least 2 characters').max(120),
});

export type CategoryInput = z.infer<typeof categorySchema>;

export async function createCategory(input: CategoryInput): Promise<ActionResult> {
  try {
    const data = categorySchema.parse(input);
    await prisma.category.create({ data });
    revalidateAdmin();
    return success();
  } catch (error) {
    return toFailure(error, 'Creating category');
  }
}

export async function updateCategory(
  id: string,
  input: CategoryInput,
): Promise<ActionResult> {
  try {
    const data = categorySchema.parse(input);
    await prisma.category.update({ where: { id: z.string().uuid().parse(id) }, data });
    revalidateAdmin();
    return success();
  } catch (error) {
    return toFailure(error, 'Updating category');
  }
}

export async function deleteCategory(id: string): Promise<ActionResult> {
  try {
    const categoryId = z.string().uuid().parse(id);

    const attached = await prisma.client.count({ where: { categoryId } });
    if (attached > 0) {
      return failure(
        `Cannot delete: ${attached} client${attached === 1 ? '' : 's'} still use this vertical.`,
      );
    }

    // Template rows cascade with the vertical, but their Drive files do not —
    // binning them here is the only chance to, because once the rows are gone
    // nothing records which files they were.
    const templates = await prisma.categoryTemplate.findMany({
      where: { categoryId },
      select: { gDriveFileId: true },
    });

    await prisma.category.delete({ where: { id: categoryId } });

    // After the delete: `trashDriveFile` never throws, and a leftover file is a
    // tidiness problem, whereas failing here would leave the vertical undeleted.
    for (const template of templates) {
      await trashDriveFile(template.gDriveFileId);
    }

    revalidateAdmin();
    return success();
  } catch (error) {
    return toFailure(error, 'Deleting category');
  }
}

// ---------------------------------------------------------------------------
// Client mutations
// ---------------------------------------------------------------------------

const cronTimeSchema = z
  .string()
  .trim()
  .regex(HH_MM_PATTERN, 'Delivery time must use 24-hour HH:MM format');

/**
 * Company name and WhatsApp number — the two provisioning facts nothing else
 * could change.
 *
 * Everything else on the tenant record already has an owner: cron time, spend
 * cap and output size in `ClientControls`, plan/vertical/delivery days in
 * `ClientAssignment`, and the poster contact bar in `PosterIdentityPanel`. This
 * exists because those two were written once at onboarding — by a Razorpay
 * checkout, in the usual case — and a typo in either was permanent.
 *
 * Validated against the same rules `clientProvisionSchema` applies, and through
 * the same `normalizeWhatsappNumber`, so an edited number is byte-identical to
 * one that arrived through provisioning. Without that, "9876543210" typed here
 * and the same number from a checkout would be two different rows to the
 * duplicate check in `provisionClient`.
 */
const clientProfileSchema = z.object({
  companyName: z.string().trim().min(2, 'Company name is required').max(160),
  whatsappNumber: z
    .string()
    .trim()
    .min(8, 'WhatsApp number is required')
    .transform(normalizeWhatsappNumber)
    .refine((value) => /^\d{10,15}$/.test(value), {
      message: 'WhatsApp number must be 10–15 digits in international format',
    }),
});

export type ClientProfileInput = z.input<typeof clientProfileSchema>;

export interface ClientProfileOutcome {
  companyName: string;
  whatsappNumber: string;
  /** Non-blocking note about a number collision; see below. */
  warning: string | null;
}

export async function updateClientProfile(
  clientId: string,
  input: ClientProfileInput,
): Promise<ActionResult<ClientProfileOutcome>> {
  try {
    const id = z.string().uuid().parse(clientId);
    const data = clientProfileSchema.parse(input);

    const client = await prisma.client.findUnique({
      where: { id },
      select: { whatsappNumber: true, isDemo: true, planId: true },
    });
    if (!client) return failure('That client no longer exists.');

    // Warn, do not block. There is no unique index on the column and two
    // tenants legitimately share a number when an agency runs campaigns for
    // its own clients — but `provisionClient` dedupes on
    // (whatsappNumber, planId, live window, isDemo), so a collision on all four
    // would make the next checkout resolve to the wrong row.
    let warning: string | null = null;
    if (data.whatsappNumber !== client.whatsappNumber) {
      const collision = await prisma.client.findFirst({
        where: {
          id: { not: id },
          whatsappNumber: data.whatsappNumber,
          planId: client.planId,
          isDemo: client.isDemo,
          endDate: { gte: new Date() },
        },
        select: { companyName: true },
      });
      if (collision) {
        warning =
          `${collision.companyName} already runs this plan on the same number. ` +
          'A future payment for that plan may resolve to whichever row is found first.';
      }
    }

    await prisma.client.update({
      where: { id },
      data: { companyName: data.companyName, whatsappNumber: data.whatsappNumber },
    });

    revalidateAdmin();
    // The warning rides on a success rather than becoming a failure: the edit did
    // happen, and refusing it would strand an operator who genuinely needs two
    // tenants on one number.
    return success({
      warning,
      companyName: data.companyName,
      whatsappNumber: data.whatsappNumber,
    });
  } catch (error) {
    return toFailure(error, 'Updating client details');
  }
}

export async function updateClientCronTime(
  clientId: string,
  cronTime: string,
): Promise<ActionResult<{ cronTime: string }>> {
  try {
    const parsedTime = cronTimeSchema.parse(cronTime);
    await prisma.client.update({
      where: { id: z.string().uuid().parse(clientId) },
      data: { cronTime: parsedTime },
    });
    revalidateAdmin();
    return success({ cronTime: parsedTime });
  } catch (error) {
    return toFailure(error, 'Updating delivery time');
  }
}

/**
 * Sets or clears the client's monthly spend cap.
 *
 * `null` clears it, which silences the dashboard's budget alert for this client
 * rather than pinning it to a ₹0 cap it would breach on the first send.
 */
export async function updateClientBudget(
  clientId: string,
  monthlyBudgetInr: number | null,
): Promise<ActionResult<{ monthlyBudgetInr: number | null }>> {
  try {
    const parsed = z
      .number()
      .int('Budget must be whole rupees')
      .min(0, 'Budget cannot be negative')
      .max(100_000_000, 'Budget is implausibly large')
      .nullable()
      .parse(monthlyBudgetInr);

    await prisma.client.update({
      where: { id: z.string().uuid().parse(clientId) },
      data: { monthlyBudgetInr: parsed },
    });

    revalidateAdmin();
    return success({ monthlyBudgetInr: parsed });
  } catch (error) {
    return toFailure(error, 'Updating spend cap');
  }
}

/**
 * Sets the client's output-size preset.
 *
 * Applies from the next render onward only. Already-GENERATED and DELIVERED
 * rows keep the asset they were rendered at — re-shaping them would mean
 * re-billing fal.ai for every past day of the campaign, so an operator who
 * wants a resize picks the days and hits regenerate.
 *
 * `null` reverts the client to the fleet default.
 */
export async function updateClientImageSize(
  clientId: string,
  imageSizePreset: string | null,
): Promise<ActionResult<{ imageSizePreset: string | null }>> {
  try {
    const parsed = z
      .string()
      .trim()
      .refine(isImageSizePresetId, 'That image size is not in the catalogue')
      .nullable()
      .parse(imageSizePreset);

    await prisma.client.update({
      where: { id: z.string().uuid().parse(clientId) },
      data: { imageSizePreset: parsed },
    });

    revalidateAdmin();
    return success({ imageSizePreset: parsed });
  } catch (error) {
    return toFailure(error, 'Updating image size');
  }
}

/**
 * Reassigns the client's vertical.
 *
 * Safe and unguarded: `category.name` only feeds the LLM system prefix
 * (`Industry: …`) for *future* generation. Days already seeded keep the copy
 * written for the old vertical — reseeding them is the operator's call.
 */
export async function updateClientCategory(
  clientId: string,
  categoryId: string,
): Promise<ActionResult> {
  try {
    const id = z.string().uuid().parse(clientId);
    const nextId = z.string().uuid('A valid vertical must be selected').parse(categoryId);

    const category = await prisma.category.findUnique({
      where: { id: nextId },
      select: { id: true },
    });
    if (!category) return failure('That vertical no longer exists.');

    await prisma.client.update({ where: { id }, data: { categoryId: nextId } });

    revalidateAdmin();
    return success();
  } catch (error) {
    return toFailure(error, 'Updating vertical');
  }
}

/**
 * Reassigns the client's plan, and moves the campaign window with it.
 *
 * Two things make this more than a column update:
 *
 * 1. **`endDate` must be recomputed.** It is derived from the plan duration at
 *    provisioning (`lib/onboarding.ts`) and has never had a second writer, so
 *    leaving it alone would keep the dispatcher on the old window — a longer
 *    plan would stop delivering at the old end date while the UI showed more
 *    days remaining.
 *
 * 2. **A shortening that would strand days is refused.** Those rows keep their
 *    `scheduledDate`, but once `endDate` moves back they fall outside the
 *    dispatcher's `endDate >= start` filter and are silently never delivered.
 *    Clearing the calendar first is the deliberate, visible alternative.
 */
export async function updateClientPlan(
  clientId: string,
  planId: string,
): Promise<ActionResult<{ durationDays: number }>> {
  try {
    const id = z.string().uuid().parse(clientId);
    const nextId = z.string().uuid('A valid plan must be selected').parse(planId);

    const [client, plan] = await Promise.all([
      prisma.client.findUnique({
        where: { id },
        select: { startDate: true, planId: true, deliveryDays: true },
      }),
      prisma.plan.findUnique({
        where: { id: nextId },
        select: { name: true, durationDays: true },
      }),
    ]);

    if (!client) return failure('That client no longer exists.');
    if (!plan) return failure('That plan no longer exists.');
    if (plan.durationDays < 1) {
      return failure(`Plan "${plan.name}" has an invalid duration (${plan.durationDays}).`);
    }
    if (client.planId === nextId) return failure('That is already this client’s plan.');

    const stranded = await prisma.contentCalendar.count({
      where: { clientId: id, dayNumber: { gt: plan.durationDays } },
    });
    if (stranded > 0) {
      return failure(
        `${stranded} calendar day(s) fall beyond a ${plan.durationDays}-day plan and would never be delivered. ` +
          'Clear the calendar first, then change the plan.',
      );
    }

    await prisma.client.update({
      where: { id },
      data: {
        planId: nextId,
        endDate: nthDeliveryDate(
          client.startDate,
          plan.durationDays,
          client.deliveryDays,
          getAppTimeZone(),
        ),
      },
    });

    revalidateAdmin();
    return success({ durationDays: plan.durationDays });
  } catch (error) {
    return toFailure(error, 'Updating plan');
  }
}

/** Reschedule writes per transaction, matching the bulk importer's chunking. */
const RESCHEDULE_CHUNK = 25;

/**
 * Sets the weekdays a client accepts delivery on, and moves everything that
 * depends on them.
 *
 * The dispatcher is deliberately untouched by this feature: it already selects
 * rows whose `scheduledDate` falls inside today, so a day with no row simply
 * never sends. All the work is in placing dates correctly.
 *
 * Three things move together:
 *  - `deliveryDays` itself.
 *  - Every PENDING row's `scheduledDate`, recomputed from its day number under
 *    the new weekday set. GENERATED and DELIVERED rows keep their dates —
 *    those record what actually happened, and rewriting history to match a new
 *    preference would be a lie.
 *  - `endDate`, since the last deliverable day moves with the weekdays.
 */
export async function updateClientDeliveryDays(
  clientId: string,
  days: number[],
): Promise<
  ActionResult<{ rescheduled: number; kept: number; endsOn: string; label: string }>
> {
  try {
    const id = z.string().uuid().parse(clientId);
    const parsed = normalizeDeliveryDays(
      z.array(z.number().int().min(1).max(7)).parse(days),
    );

    // An empty set would mean a client who never receives anything. Pausing is
    // what that is for, and it is reversible without touching the calendar.
    if (parsed.length === 0) {
      return failure('Pick at least one delivery day, or pause the campaign instead.');
    }

    const client = await prisma.client.findUnique({
      where: { id },
      select: { startDate: true, plan: { select: { durationDays: true } } },
    });
    if (!client) return failure('That client no longer exists.');

    const timeZone = getAppTimeZone();
    const stored = parsed.length === 7 ? [] : parsed;

    const pending = await prisma.contentCalendar.findMany({
      where: { clientId: id, deliveryStatus: DeliveryStatus.PENDING },
      select: { id: true, dayNumber: true },
      orderBy: { dayNumber: 'asc' },
    });
    const kept = await prisma.contentCalendar.count({
      where: { clientId: id, deliveryStatus: { not: DeliveryStatus.PENDING } },
    });

    const endDate = nthDeliveryDate(
      client.startDate,
      client.plan.durationDays,
      stored,
      timeZone,
    );

    await prisma.client.update({
      where: { id },
      data: { deliveryDays: stored, endDate },
    });

    for (let offset = 0; offset < pending.length; offset += RESCHEDULE_CHUNK) {
      const chunk = pending.slice(offset, offset + RESCHEDULE_CHUNK);
      await prisma.$transaction(
        chunk.map((row) =>
          prisma.contentCalendar.update({
            where: { id: row.id },
            data: {
              scheduledDate: nthDeliveryDate(
                client.startDate,
                row.dayNumber,
                stored,
                timeZone,
              ),
            },
          }),
        ),
      );
    }

    revalidateAdmin();
    return success({
      rescheduled: pending.length,
      kept,
      endsOn: formatDisplayDate(endDate, timeZone),
      label: describeDeliveryDays(stored),
    });
  } catch (error) {
    return toFailure(error, 'Updating delivery days');
  }
}

/**
 * Rows retried per invocation.
 *
 * Capped because this runs as a single server action, and `vercel.json` raises
 * `maxDuration` only for `/api/cron` and the Razorpay webhook — not for actions.
 * An uncapped loop over a few hundred failures works in dev and is killed in
 * production, which is the worst place to discover it.
 */
const RETRY_BATCH_LIMIT = 10;

/**
 * Re-runs the pipeline over the most recent failed deliveries.
 *
 * Uses `reuseExistingAsset`, so a row that already reached GENERATED re-sends
 * its stored Drive file for free. A row that failed before the upload has no
 * asset to reuse and will re-bill fal.ai — surfaced in the UI rather than
 * hidden, since the two look identical on the card.
 */
export async function retryFailedDeliveries(
  clientId?: string,
): Promise<
  ActionResult<{ attempted: number; delivered: number; failed: number; remaining: number }>
> {
  try {
    const id = clientId ? z.string().uuid().parse(clientId) : null;
    const where = {
      deliveryStatus: DeliveryStatus.FAILED,
      ...(id ? { clientId: id } : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.contentCalendar.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        take: RETRY_BATCH_LIMIT,
        select: { id: true },
      }),
      prisma.contentCalendar.count({ where }),
    ]);

    if (rows.length === 0) return failure('No failed deliveries to retry.');

    const results = await mapWithConcurrency(
      rows,
      Math.max(1, intEnv('CRON_MAX_CONCURRENCY', 4)),
      async (row) => ({
        outcome: await runCreativePipeline(row.id, {
          reuseExistingAsset: true,
          allowRedelivery: true,
        }),
      }),
    );

    const delivered = results.filter((result) => result.outcome.ok).length;

    revalidateAdmin();
    return success({
      attempted: results.length,
      delivered,
      failed: results.length - delivered,
      remaining: Math.max(0, total - delivered),
    });
  } catch (error) {
    return toFailure(error, 'Retrying failed deliveries');
  }
}

export async function setClientActive(
  clientId: string,
  isActive: boolean,
): Promise<ActionResult> {
  try {
    await prisma.client.update({
      where: { id: z.string().uuid().parse(clientId) },
      data: { isActive: z.boolean().parse(isActive) },
    });
    revalidateAdmin();
    return success();
  } catch (error) {
    return toFailure(error, 'Updating client status');
  }
}

/**
 * Manual onboarding — bypasses the payment gateway while running the exact
 * same provisioning path the Razorpay webhook uses.
 */
export async function createClientManually(
  input: z.input<typeof clientProvisionSchema>,
): Promise<ActionResult<{ clientId: string; created: boolean; driveWarning?: string }>> {
  try {
    const result = await provisionClient(input);
    revalidateAdmin();

    return success({
      clientId: result.clientId,
      created: result.created,
      ...(result.driveWarning ? { driveWarning: result.driveWarning } : {}),
    });
  } catch (error) {
    return toFailure(error, 'Onboarding client');
  }
}

export async function repairDriveFolder(
  clientId: string,
): Promise<ActionResult<{ gDriveFolderId: string }>> {
  try {
    const gDriveFolderId = await repairClientDriveFolder(
      z.string().uuid().parse(clientId),
    );
    revalidateAdmin();
    return success({ gDriveFolderId });
  } catch (error) {
    return toFailure(error, 'Provisioning Drive folder');
  }
}

// ---------------------------------------------------------------------------
// Manual pipeline intervention
// ---------------------------------------------------------------------------

/**
 * Immediately pushes one calendar entry to WhatsApp, bypassing cron.
 *
 * `reuseExistingAsset` keeps this cheap: an entry that already reached
 * GENERATED/DELIVERED re-sends its stored Drive asset instead of re-billing
 * fal.ai. A PENDING entry generates first, exactly as the scheduler would.
 */
export async function forceResendCreative(
  calendarId: string,
): Promise<ActionResult<{ status: string; reusedAsset: boolean }>> {
  try {
    const id = z.string().uuid().parse(calendarId);

    const outcome = await runCreativePipeline(id, {
      reuseExistingAsset: true,
      allowRedelivery: true,
    });

    revalidateAdmin();

    if (!outcome.ok) {
      return failure(`Delivery failed at "${outcome.stage}": ${outcome.error}`);
    }

    return success({ status: outcome.status, reusedAsset: outcome.reusedAsset });
  } catch (error) {
    return toFailure(error, 'Force re-send');
  }
}

/**
 * Drops one calendar entry for good.
 *
 * Aimed at failed rows an operator has decided not to chase: the Drive asset
 * (if any) is left alone, and the freed `dayNumber` is picked up again by the
 * next calendar seed, which fills whichever days are missing.
 */
export async function deleteCalendarEntry(
  calendarId: string,
): Promise<ActionResult<{ dayNumber: number }>> {
  try {
    const deleted = await prisma.contentCalendar.delete({
      where: { id: z.string().uuid().parse(calendarId) },
      select: { dayNumber: true },
    });

    revalidateAdmin();
    return success({ dayNumber: deleted.dayNumber });
  } catch (error) {
    return toFailure(error, 'Deleting calendar entry');
  }
}

/** Statuses a bulk clear may remove: nothing that owns a delivered creative. */
const CLEARABLE: DeliveryStatus[] = [DeliveryStatus.PENDING, DeliveryStatus.FAILED];

/**
 * Drops every unsent calendar day for one client.
 *
 * Scoped to PENDING and FAILED deliberately. GENERATED and DELIVERED rows are
 * the record of what a client actually received, so an operator correcting a
 * bad seed must not be able to erase delivery history with one button.
 *
 * This is the recovery path for the worst mistake the console allows — seeding
 * a whole campaign before extracting brand tokens. Without it, the only remedy
 * is deleting rows one at a time, because `generateContentCalendar` fills gaps
 * and never overwrites.
 */
export async function clearClientCalendar(
  clientId: string,
): Promise<ActionResult<{ deleted: number; kept: number }>> {
  try {
    const id = z.string().uuid().parse(clientId);

    const [removable, kept] = await Promise.all([
      prisma.contentCalendar.findMany({
        where: { clientId: id, deliveryStatus: { in: CLEARABLE } },
        select: { id: true, gDriveFileId: true },
      }),
      prisma.contentCalendar.count({
        where: { clientId: id, deliveryStatus: { notIn: CLEARABLE } },
      }),
    ]);

    if (removable.length === 0) {
      return failure(
        kept > 0
          ? `Nothing to clear — all ${kept} day(s) are already generated or delivered, and those are never removed.`
          : 'This client has no calendar days to clear.',
      );
    }

    const { count } = await prisma.contentCalendar.deleteMany({
      where: { id: { in: removable.map((row) => row.id) } },
    });

    // A FAILED row can still own an asset — upload succeeded, broadcast did
    // not. Bin those so the vault does not accumulate unreachable files.
    // `trashDriveFile` never throws, so a Drive fault cannot fail the clear.
    for (const row of removable) {
      if (row.gDriveFileId) await trashDriveFile(row.gDriveFileId);
    }

    revalidateAdmin();
    return success({ deleted: count, kept });
  } catch (error) {
    return toFailure(error, 'Clearing calendar');
  }
}

/**
 * Removes a client outright. The only irreversible action in the console.
 *
 * Guarded by an exact company-name match rather than a click-twice confirm:
 * everything else here is recoverable, this is not.
 *
 * Side effects are all deliberate:
 *  - The Drive folder is trashed, not purged. Drive treats a folder as a file,
 *    so `trashDriveFile` works unmodified and the contents go with it —
 *    recoverable from the bin for 30 days.
 *  - `ContentCalendar` cascades at the database level (schema.prisma).
 *  - `UsageEvent.clientId` is SetNull, so spend survives and reappears on the
 *    spend panel under "Removed clients". Money spent still counts.
 */
export async function deleteClient(
  clientId: string,
  confirmName: string,
): Promise<ActionResult<{ companyName: string; calendarDays: number }>> {
  try {
    const id = z.string().uuid().parse(clientId);

    const client = await prisma.client.findUnique({
      where: { id },
      select: {
        companyName: true,
        gDriveFolderId: true,
        _count: { select: { calendarDays: true } },
      },
    });
    if (!client) return failure('That client no longer exists.');

    if (confirmName.trim() !== client.companyName) {
      return failure(`Type "${client.companyName}" exactly to confirm deletion.`);
    }

    // Trashed before the row is deleted — `gDriveFolderId` is only readable
    // from it, and losing the reference would orphan the folder permanently.
    if (client.gDriveFolderId) {
      await trashDriveFile(client.gDriveFolderId);
    }

    await prisma.client.delete({ where: { id } });

    revalidateAdmin();
    return success({
      companyName: client.companyName,
      calendarDays: client._count.calendarDays,
    });
  } catch (error) {
    return toFailure(error, 'Deleting client');
  }
}

// ---------------------------------------------------------------------------
// Demo workspace
// ---------------------------------------------------------------------------

const demoCreativeSchema = z.object({
  theme: z.string().trim().min(2, 'Theme is required').max(120),
  caption: z
    .string()
    .trim()
    .min(10, 'Caption must be at least 10 characters')
    .max(2_000, 'Caption is too long'),
  hashtags: z.string().trim().max(400, 'Hashtags are too long').default(''),
  imagePrompt: z
    .string()
    .trim()
    .min(10, 'Image prompt must be at least 10 characters')
    .max(2_000, 'Image prompt is too long'),
});

export type DemoCreativeInput = z.input<typeof demoCreativeSchema>;

/**
 * Demo-only: writes one `ContentCalendar` row from hand-typed copy and runs the
 * creative pipeline on it immediately — fal.ai render, Drive upload, WhatsApp
 * send — instead of waiting for the tenant's cron minute.
 *
 * The pipeline itself is untouched; this only supplies it a row to work on.
 *
 * Refuses on a non-demo client. It bypasses every scheduling guard, and an
 * accidental send to a paying tenant's number cannot be recalled.
 */
export async function runDemoCreativeNow(
  clientId: string,
  input: DemoCreativeInput,
): Promise<
  ActionResult<{
    calendarId: string;
    dayNumber: number;
    status: string;
    viewUrl: string | null;
  }>
> {
  try {
    const id = z.string().uuid().parse(clientId);
    const data = demoCreativeSchema.parse(input);

    const client = await prisma.client.findUnique({
      where: { id },
      select: { isDemo: true, gDriveFolderId: true },
    });

    if (!client) return failure('That demo tenant no longer exists.');
    if (!client.isDemo) {
      return failure('Instant sends are restricted to demo tenants.');
    }
    if (!client.gDriveFolderId) {
      return failure(
        'Provision the Drive folder first — the upload stage has nowhere to write.',
      );
    }

    // Appended after every existing row: @@unique([clientId, dayNumber]) means a
    // fixed number would collide with the seeded calendar on the second send.
    const last = await prisma.contentCalendar.findFirst({
      where: { clientId: id },
      orderBy: { dayNumber: 'desc' },
      select: { dayNumber: true },
    });

    const entry = await prisma.contentCalendar.create({
      data: {
        clientId: id,
        dayNumber: (last?.dayNumber ?? 0) + 1,
        // Dated now: a demo row is delivered on the spot, never queued for a day.
        scheduledDate: new Date(),
        theme: data.theme,
        caption: data.caption,
        hashtags: data.hashtags,
        imagePrompt: data.imagePrompt,
      },
      select: { id: true, dayNumber: true },
    });

    const outcome = await runCreativePipeline(entry.id, {
      reuseExistingAsset: false,
      allowRedelivery: true,
    });

    revalidateAdmin();

    if (!outcome.ok) {
      // The row is deliberately left behind: it carries the stage and error
      // message, and its card offers re-send / regenerate / delete.
      return failure(`Demo send failed at "${outcome.stage}": ${outcome.error}`);
    }

    return success({
      calendarId: entry.id,
      dayNumber: entry.dayNumber,
      status: outcome.status,
      viewUrl: outcome.gDriveViewUrl,
    });
  } catch (error) {
    if (error instanceof z.ZodError) return toFailure(error, 'Demo send');
    console.error('[ace:admin] Demo send failed:', describeError(error));
    return failure(describeError(error));
  }
}

// ---------------------------------------------------------------------------
// LLM-backed content stages
// ---------------------------------------------------------------------------

/**
 * Extracts brand design tokens from raw material and persists them to
 * `Client.brandGuideline` (blueprint §3B).
 */
export async function extractBrandGuideline(
  clientId: string,
  sourceMaterial: string,
): Promise<ActionResult<{ colors: number; headingFont: string | null }>> {
  try {
    const guideline = await tokenizeClientBrand(
      z.string().uuid().parse(clientId),
      z.string().min(40, 'Provide at least a few sentences of brand material').parse(
        sourceMaterial,
      ),
    );

    revalidateAdmin();

    return success({
      colors: guideline.colors.length,
      headingFont: guideline.typography?.headingFont ?? null,
    });
  } catch (error) {
    // Surface the underlying message: an operator needs to know whether this
    // was a missing API key, a refusal, or thin source material.
    if (error instanceof z.ZodError) return toFailure(error, 'Extracting brand tokens');
    console.error('[ace:admin] Extracting brand tokens failed:', describeError(error));
    return failure(describeError(error));
  }
}

/**
 * Reads a website's CSS and returns the palette it declares. Persists nothing.
 *
 * Split from `applyWebsiteColors` so an operator sees what was found before it
 * can reach a live client. There is no undo on the poster a client already
 * received, so the confirmation step is the safeguard.
 */
export async function previewWebsiteColors(
  url: string,
): Promise<ActionResult<ExtractionReport>> {
  try {
    return success(await extractWebsiteColors(z.string().min(1, 'Enter a website address').parse(url)));
  } catch (error) {
    // These messages name only a host and a reason, so they are safe to show and
    // are the only way an operator can tell "site blocks us" from "no CSS here".
    if (error instanceof WebsiteColorError) return failure(error.message);
    if (error instanceof z.ZodError) return toFailure(error, 'Reading website colours');
    console.error('[ace:admin] Reading website colours failed:', describeError(error));
    return failure(describeError(error));
  }
}

/**
 * Persists an extracted palette to `Client.brandGuideline`.
 *
 * Replaces `colors` only. Typography, layout directives and the asset ledger are
 * carried through untouched: they came from the tokenizer or the operator, and a
 * colour extraction has no evidence to offer about any of them.
 */
export async function applyWebsiteColors(
  clientId: string,
  url: string,
): Promise<ActionResult<{ colors: number; url: string }>> {
  try {
    const id = z.string().uuid().parse(clientId);
    const report = await extractWebsiteColors(
      z.string().min(1, 'Enter a website address').parse(url),
    );

    const client = await prisma.client.findUnique({
      where: { id },
      select: { brandGuideline: true },
    });
    if (!client) return failure('That client no longer exists.');

    const guideline: BrandGuideline = {
      ...parseBrandGuideline(client.brandGuideline),
      colors: toBrandColors(report.colors),
    };

    await prisma.client.update({
      where: { id },
      // Cast: Prisma types Json input as InputJsonValue, which a structural
      // interface does not satisfy without a widening step.
      data: { brandGuideline: guideline as unknown as object },
    });

    revalidateAdmin();

    return success({ colors: guideline.colors.length, url: report.url });
  } catch (error) {
    if (error instanceof WebsiteColorError) return failure(error.message);
    if (error instanceof z.ZodError) return toFailure(error, 'Applying website colours');
    console.error('[ace:admin] Applying website colours failed:', describeError(error));
    return failure(describeError(error));
  }
}

/**
 * Seeds `ContentCalendar` rows for a client. Runs the LLM copy stage in
 * sequential batches, so this is deliberately slow — it is the expensive call
 * in the whole system.
 */
export async function seedContentCalendar(
  clientId: string,
  limit?: number,
): Promise<
  ActionResult<{
    inserted: number;
    requested: number;
    remaining: number;
    batches: number;
  }>
> {
  try {
    const result = await generateContentCalendar(z.string().uuid().parse(clientId), {
      ...(limit === undefined ? {} : { limit: z.number().int().min(1).max(365).parse(limit) }),
    });

    revalidateAdmin();

    if (result.requested === 0) {
      return failure('This client already has a complete calendar.');
    }

    return success({
      inserted: result.inserted,
      requested: result.requested,
      remaining: result.remaining,
      batches: result.batches,
    });
  } catch (error) {
    if (error instanceof z.ZodError) return toFailure(error, 'Generating calendar');
    console.error('[ace:admin] Generating calendar failed:', describeError(error));
    return failure(describeError(error));
  }
}

/** Re-runs generation from scratch, ignoring any previously uploaded asset. */
export async function regenerateCreative(
  calendarId: string,
): Promise<ActionResult<{ status: string }>> {
  try {
    const id = z.string().uuid().parse(calendarId);
    const outcome = await runCreativePipeline(id, {
      reuseExistingAsset: false,
      allowRedelivery: true,
    });

    revalidateAdmin();

    if (!outcome.ok) {
      return failure(`Regeneration failed at "${outcome.stage}": ${outcome.error}`);
    }
    return success({ status: outcome.status });
  } catch (error) {
    return toFailure(error, 'Regenerating creative');
  }
}

// ---------------------------------------------------------------------------
// Operator-authored content import
// ---------------------------------------------------------------------------

/**
 * Bulk-writes calendar days from a sheet the Evokz team authored themselves —
 * theme, caption, hashtags, image prompt — instead of asking the generator for
 * them. No LLM call, so no spend and no waiting on sequential batches.
 *
 * The rows arrive already parsed and validated by the panel; everything is
 * re-checked here, because a server action is a public endpoint and the
 * browser's copy of the plan duration and seeded days may be stale.
 */
export async function importCalendarEntries(
  clientId: string,
  input: CalendarImportInput,
): Promise<ActionResult<CalendarImportResult>> {
  try {
    const result = await applyCalendarImport(z.string().uuid().parse(clientId), input);

    revalidateAdmin();

    if (result.created === 0 && result.updated === 0) {
      // Every row bounced. Naming the reason matters: "already seeded" and
      // "past the plan duration" call for completely different fixes.
      return failure(describeImportRejection(result));
    }

    return success(result);
  } catch (error) {
    if (error instanceof z.ZodError) return toFailure(error, 'Importing calendar');
    console.error('[ace:admin] Importing calendar failed:', describeError(error));
    return failure(describeError(error));
  }
}

function describeImportRejection(result: CalendarImportResult): string {
  const reasons: string[] = [];

  if (result.skippedExisting > 0) {
    reasons.push(
      `${result.skippedExisting} row(s) target days that are already written — switch the conflict mode to Overwrite to replace them`,
    );
  }
  if (result.blockedDelivered > 0) {
    reasons.push(
      `${result.blockedDelivered} row(s) target days that are already generated or delivered, which an import will not rewrite`,
    );
  }
  if (result.outOfRange > 0) {
    reasons.push(
      `${result.outOfRange} row(s) fall past the plan's ${result.totalDays}-day duration`,
    );
  }
  if (result.noFreeDay > 0) {
    reasons.push(
      `${result.noFreeDay} row(s) asked to be appended but all ${result.totalDays} campaign days are already written — number them explicitly and overwrite instead`,
    );
  }
  if (result.duplicateDay > 0) {
    reasons.push(`${result.duplicateDay} row(s) repeat a day number claimed earlier in the file`);
  }

  return reasons.length > 0
    ? `Nothing was imported: ${reasons.join('; ')}.`
    : 'Nothing was imported.';
}

// ---------------------------------------------------------------------------
// Poster identity
// ---------------------------------------------------------------------------

/**
 * The logo, tagline, phone and website composited onto every creative by the
 * poster renderer.
 *
 * Held as real columns on `Client` rather than inside `brandGuideline` because the
 * brand tokenizer rewrites that column wholesale — an operator-uploaded logo has
 * to survive a re-extraction.
 */

/** Formats a logo file has to be in for satori to rasterise it. */
const LOGO_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/svg+xml',
]);

const MAX_LOGO_BYTES = 4 * 1024 * 1024;

/**
 * What happened to a logo, for the panel to report.
 *
 * `skipped` is present only on an upload the keyer declined, and is *not* an
 * error: the file stored fine, its background simply could not be removed
 * safely. The panel prints `describeSkip(reason)` beside the preview so the
 * operator knows whether to supply a different file or leave it.
 */
export interface LogoOutcome {
  logoUrl: string;
  backgroundRemoved: boolean;
  skipped?: LogoKeySkipReason;
}

// ---------------------------------------------------------------------------
// Vertical reference templates
// ---------------------------------------------------------------------------

/**
 * Raster only. These are reference *posters* — photographs of finished
 * creatives — and an SVG here would almost certainly be a logo filed in the
 * wrong place.
 */
const TEMPLATE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** Comfortably under the 8 MB Server Action body limit set in next.config.mjs. */
const MAX_TEMPLATE_BYTES = 6 * 1024 * 1024;

/**
 * Per-vertical cap. Not a database constraint — the limit exists to keep the
 * gallery navigable and the eventual extraction pass bounded, which is an
 * application judgement, not an invariant of the data.
 */
const MAX_TEMPLATES_PER_CATEGORY = 20;

/**
 * Stores one reference poster against a vertical.
 *
 * Nothing in the render pipeline reads these yet. They are a library for the
 * layout work that follows, so this action deliberately does no interpretation —
 * it stores the bytes, the dimensions and where they came from.
 */
export async function uploadVerticalTemplate(
  categoryId: string,
  formData: FormData,
): Promise<ActionResult<{ id: string; label: string }>> {
  try {
    const id = z.string().uuid().parse(categoryId);

    const file = formData.get('template');
    if (!(file instanceof File) || file.size === 0) {
      return failure('Choose an image to upload.');
    }
    if (!TEMPLATE_MIME_TYPES.has(file.type)) {
      return failure(
        `"${file.type || 'unknown'}" is not a supported format. Use PNG, JPEG or WebP.`,
      );
    }
    if (file.size > MAX_TEMPLATE_BYTES) {
      return failure(
        `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${
          MAX_TEMPLATE_BYTES / 1024 / 1024
        } MB.`,
      );
    }

    const category = await prisma.category.findUnique({
      where: { id },
      select: { name: true, _count: { select: { templates: true } } },
    });
    if (!category) return failure('That vertical no longer exists.');
    if (category._count.templates >= MAX_TEMPLATES_PER_CATEGORY) {
      return failure(
        `${category.name} already has ${MAX_TEMPLATES_PER_CATEGORY} templates. Delete one before adding another.`,
      );
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    // Best-effort: a header we cannot parse costs a size badge in the gallery,
    // never the upload.
    const dimensions = readImageDimensions(bytes);

    const folderId = await ensureVerticalTemplateFolder(category.name);
    const uploaded = await uploadClientAsset({
      folderId,
      fileName: file.name,
      body: bytes,
      mimeType: file.type,
    });

    const created = await prisma.categoryTemplate.create({
      data: {
        categoryId: id,
        label: file.name.replace(/\.[^.]+$/, '').slice(0, 120) || 'Untitled',
        gDriveFileId: uploaded.fileId,
        gDriveViewUrl: uploaded.viewUrl,
        mimeType: file.type,
        width: dimensions?.width ?? null,
        height: dimensions?.height ?? null,
      },
      select: { id: true, label: true },
    });

    revalidateAdmin();
    return success(created);
  } catch (error) {
    return toFailure(error, 'Uploading template');
  }
}

/**
 * Removes one reference template.
 *
 * The row goes first and the Drive file second. Reversing it risks a row
 * pointing at a binned file — a broken thumbnail an operator cannot clear —
 * whereas this order's worst case is an untidy Drive folder. `trashDriveFile`
 * never throws, so a Drive failure is logged and the delete still succeeds.
 */
export async function deleteVerticalTemplate(
  templateId: string,
): Promise<ActionResult> {
  try {
    const id = z.string().uuid().parse(templateId);

    const template = await prisma.categoryTemplate.findUnique({
      where: { id },
      select: { gDriveFileId: true },
    });
    if (!template) return failure('That template no longer exists.');

    await prisma.categoryTemplate.delete({ where: { id } });
    await trashDriveFile(template.gDriveFileId);

    revalidateAdmin();
    return success();
  } catch (error) {
    return toFailure(error, 'Deleting template');
  }
}

const posterIdentitySchema = z.object({
  // Empty strings normalise to null so clearing a field in the form actually
  // clears the column instead of storing "".
  brandTagline: z
    .string()
    .trim()
    .max(60, 'Tagline must be 60 characters or fewer')
    .transform((value) => value || null)
    .nullable(),
  websiteUrl: z
    .string()
    .trim()
    .max(120, 'Website must be 120 characters or fewer')
    // Stored as typed; the renderer strips the scheme for display. Validated
    // loosely on purpose — a bare host like "example.com" is the common input and
    // is not a parseable URL.
    .refine(
      (value) => value === '' || /^[a-z0-9.-]+\.[a-z]{2,}/i.test(value.replace(/^[a-z]+:\/\//i, '')),
      'That does not look like a domain',
    )
    .transform((value) => value || null)
    .nullable(),
  displayPhone: z
    .string()
    .trim()
    .max(32, 'Phone must be 32 characters or fewer')
    .refine(
      (value) => value === '' || /^[+0-9()\s-]{6,}$/.test(value),
      'Phone may contain only digits, spaces, brackets, + and -',
    )
    .transform((value) => value || null)
    .nullable(),
});

export type PosterIdentityInput = z.input<typeof posterIdentitySchema>;

/**
 * Saves the contact-bar and tagline values.
 *
 * `displayPhone` is stored exactly as typed. An operator who writes
 * "+91 98765 43210" chose that grouping, and the renderer must not reformat it —
 * only the fallback path (when this is null) derives a format from
 * `whatsappNumber`.
 */
export async function updateClientPosterIdentity(
  clientId: string,
  input: PosterIdentityInput,
): Promise<ActionResult> {
  try {
    const data = posterIdentitySchema.parse(input);

    await prisma.client.update({
      where: { id: z.string().uuid().parse(clientId) },
      data,
    });

    revalidateAdmin();
    return success();
  } catch (error) {
    return toFailure(error, 'Saving poster identity');
  }
}

/**
 * Uploads a logo into the client's Drive folder and records its direct-download
 * URL.
 *
 * Drive is the store rather than a new blob provider because the folder, the
 * service-account credentials and the anyone-with-link publishing step already
 * exist for the creatives themselves. The renderer fetches the URL server-side, so
 * the file genuinely has to be link-readable — which `uploadClientAsset` does.
 */
export async function uploadClientLogo(
  clientId: string,
  formData: FormData,
): Promise<ActionResult<LogoOutcome>> {
  try {
    const id = z.string().uuid().parse(clientId);

    const file = formData.get('logo');
    if (!(file instanceof File) || file.size === 0) {
      return failure('Choose a logo file to upload.');
    }
    if (!LOGO_MIME_TYPES.has(file.type)) {
      return failure(
        `"${file.type || 'unknown'}" is not a supported logo format. Use PNG, JPEG, WebP or SVG.`,
      );
    }
    if (file.size > MAX_LOGO_BYTES) {
      return failure(
        `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_LOGO_BYTES / 1024 / 1024} MB.`,
      );
    }

    const client = await prisma.client.findUnique({
      where: { id },
      select: {
        gDriveFolderId: true,
        logoDriveFileId: true,
        logoOriginalDriveFileId: true,
      },
    });
    if (!client) return failure('That client no longer exists.');
    if (!client.gDriveFolderId) {
      return failure(
        'This client has no Drive folder yet. Repair the Drive folder first, then upload the logo.',
      );
    }

    const bytes = Buffer.from(await file.arrayBuffer());

    // The file as supplied goes up first and unconditionally. Keying is a
    // judgement call, and one that has to be reversible without asking the
    // operator to find the file again.
    const original = await uploadClientAsset({
      folderId: client.gDriveFolderId,
      fileName: `Brand_Logo_Original${logoExtension(file.type)}`,
      body: bytes,
      mimeType: file.type,
    });

    const keyed = await keyLogoBackground(bytes, file.type);
    const stored = keyed.keyed
      ? await uploadClientAsset({
          folderId: client.gDriveFolderId,
          // Always PNG. The input is frequently JPEG, which has no alpha channel
          // at all — which is precisely why its background was baked in.
          fileName: 'Brand_Logo.png',
          body: keyed.png,
          mimeType: 'image/png',
        })
      : null;

    await prisma.client.update({
      where: { id },
      data: stored
        ? {
            logoUrl: stored.viewUrl,
            logoDriveFileId: stored.fileId,
            logoOriginalUrl: original.viewUrl,
            logoOriginalDriveFileId: original.fileId,
            logoBackgroundRemoved: true,
          }
        : {
            // Nothing was keyed, so there is no second file and no "original" to
            // revert to — the invariant in schema.prisma requires these null.
            logoUrl: original.viewUrl,
            logoDriveFileId: original.fileId,
            logoOriginalUrl: null,
            logoOriginalDriveFileId: null,
            logoBackgroundRemoved: false,
          },
    });

    // After the row is updated, so a failure here cannot leave the client
    // pointing at a file that has just been binned.
    await trashSupersededLogos(
      [client.logoDriveFileId, client.logoOriginalDriveFileId],
      [original.fileId, stored?.fileId],
    );

    revalidateAdmin();
    return success(
      stored
        ? { logoUrl: stored.viewUrl, backgroundRemoved: true }
        : {
            logoUrl: original.viewUrl,
            backgroundRemoved: false,
            skipped: keyed.keyed ? undefined : keyed.reason,
          },
    );
  } catch (error) {
    return toFailure(error, 'Uploading logo');
  }
}

/**
 * Keys the background out of the logo already on file.
 *
 * This is what reaches the logos uploaded before the feature existed, and the
 * only route that reaches an externally-linked one — `setClientLogoUrl` never
 * sees bytes, so a pasted URL is otherwise never processed at all.
 *
 * A logo it declines to key is reported as a failure rather than a quiet no-op:
 * the operator pressed a button expecting a visible change, and "your logo's
 * background is a gradient" is the answer, not silence.
 */
export async function removeClientLogoBackground(
  clientId: string,
): Promise<ActionResult<LogoOutcome>> {
  try {
    const id = z.string().uuid().parse(clientId);

    const client = await prisma.client.findUnique({
      where: { id },
      select: {
        gDriveFolderId: true,
        logoUrl: true,
        logoDriveFileId: true,
        logoBackgroundRemoved: true,
      },
    });
    if (!client) return failure('That client no longer exists.');
    if (!client.logoUrl) return failure('There is no logo to process yet.');
    if (client.logoBackgroundRemoved) {
      return failure('This logo has already had its background removed.');
    }
    if (!client.gDriveFolderId) {
      return failure(
        'This client has no Drive folder yet. Repair the Drive folder first, then try again.',
      );
    }

    const fetched = await fetchLogoBytes(client.logoUrl);
    if (!fetched) {
      return failure(
        'That logo could not be downloaded. Check the link still resolves to an image.',
      );
    }

    const keyed = await keyLogoBackground(fetched.bytes, fetched.mimeType);
    if (!keyed.keyed) return failure(describeSkip(keyed.reason));

    const stored = await uploadClientAsset({
      folderId: client.gDriveFolderId,
      fileName: 'Brand_Logo.png',
      body: keyed.png,
      mimeType: 'image/png',
    });

    await prisma.client.update({
      where: { id },
      data: {
        logoUrl: stored.viewUrl,
        logoDriveFileId: stored.fileId,
        // Whatever was live becomes the original. For an external URL that is a
        // link we do not own, which is why the file id can be null here while
        // the URL is not — revert points back at the client's own host.
        logoOriginalUrl: client.logoUrl,
        logoOriginalDriveFileId: client.logoDriveFileId,
        logoBackgroundRemoved: true,
      },
    });

    revalidateAdmin();
    return success({ logoUrl: stored.viewUrl, backgroundRemoved: true });
  } catch (error) {
    return toFailure(error, 'Removing the logo background');
  }
}

/**
 * Puts the pre-removal logo back.
 *
 * The keyed file is binned rather than parked for a later toggle: keying the same
 * bytes is deterministic, so `removeClientLogoBackground` reproduces it exactly,
 * and keeping it would mean carrying a third state the schema comment would have
 * to describe.
 */
export async function revertClientLogoBackground(
  clientId: string,
): Promise<ActionResult<LogoOutcome>> {
  try {
    const id = z.string().uuid().parse(clientId);

    const client = await prisma.client.findUnique({
      where: { id },
      select: {
        logoDriveFileId: true,
        logoOriginalUrl: true,
        logoOriginalDriveFileId: true,
        logoBackgroundRemoved: true,
      },
    });
    if (!client) return failure('That client no longer exists.');
    if (!client.logoBackgroundRemoved || !client.logoOriginalUrl) {
      return failure('There is no earlier version of this logo to restore.');
    }

    const keyedFileId = client.logoDriveFileId;

    await prisma.client.update({
      where: { id },
      data: {
        logoUrl: client.logoOriginalUrl,
        logoDriveFileId: client.logoOriginalDriveFileId,
        logoOriginalUrl: null,
        logoOriginalDriveFileId: null,
        logoBackgroundRemoved: false,
      },
    });

    await trashSupersededLogos([keyedFileId], [client.logoOriginalDriveFileId]);

    revalidateAdmin();
    return success({ logoUrl: client.logoOriginalUrl, backgroundRemoved: false });
  } catch (error) {
    return toFailure(error, 'Restoring the original logo');
  }
}

/**
 * Points the client at a logo we do not host, or clears the logo entirely.
 *
 * The URL is not fetched here. A link that 404s degrades to the generated wordmark
 * lockup at render time with a warning in the logs, and blocking the save on a
 * reachability check would reject perfectly good URLs that are momentarily down.
 */
export async function setClientLogoUrl(
  clientId: string,
  logoUrl: string | null,
): Promise<ActionResult> {
  try {
    const id = z.string().uuid().parse(clientId);

    const parsed = z
      .string()
      .trim()
      .max(2048)
      .refine(
        (value) => value === '' || /^https?:\/\/\S+$/i.test(value),
        'Enter a full http(s) URL',
      )
      .transform((value) => value || null)
      .nullable()
      .parse(logoUrl);

    const client = await prisma.client.findUnique({
      where: { id },
      select: { logoDriveFileId: true, logoOriginalDriveFileId: true },
    });
    if (!client) return failure('That client no longer exists.');

    await prisma.client.update({
      where: { id },
      // The Drive file ids are dropped too: they no longer describe where the logo
      // lives, and keeping them would make a later re-upload trash an unrelated
      // file. The removal state goes with them — this URL is the file as supplied,
      // which is the `false` branch of the invariant in schema.prisma.
      data: {
        logoUrl: parsed,
        logoDriveFileId: null,
        logoOriginalUrl: null,
        logoOriginalDriveFileId: null,
        logoBackgroundRemoved: false,
      },
    });

    await trashSupersededLogos(
      [client.logoDriveFileId, client.logoOriginalDriveFileId],
      [],
    );

    revalidateAdmin();
    return success();
  } catch (error) {
    return toFailure(error, 'Updating logo');
  }
}

/**
 * Bins logo files the client no longer points at.
 *
 * Takes the survivors explicitly rather than assuming: the upload path writes two
 * files whose ids can coincide with nothing, while revert keeps the very file it
 * is switching to. Trashing by "everything that was there before" would bin the
 * new logo the moment an id was reused. Nulls are tolerated so callers can pass
 * columns straight in — an externally-linked logo has no file id at all.
 */
async function trashSupersededLogos(
  previous: Array<string | null | undefined>,
  keep: Array<string | null | undefined>,
): Promise<void> {
  const survivors = new Set(keep.filter(Boolean) as string[]);
  const doomed = new Set(
    (previous.filter(Boolean) as string[]).filter((id) => !survivors.has(id)),
  );

  // Sequential, and never throwing: `trashDriveFile` swallows its own errors, so
  // an untidy Drive folder is the worst case here rather than a failed action.
  for (const fileId of doomed) {
    await trashDriveFile(fileId);
  }
}

/** Operator-facing explanation for each reason the keyer declined. */
function describeSkip(reason: LogoKeySkipReason): string {
  switch (reason) {
    case 'already-transparent':
      return 'This logo already has a transparent background — nothing to remove.';
    case 'background-not-flat':
      return "This logo's background is not a flat colour (it looks like a gradient or a photo), so removing it automatically would damage the mark. Supply a PNG with a transparent background instead.";
    case 'nothing-to-remove':
      return 'No background was found around the edges of this logo.';
    case 'would-erase-logo':
      return 'The logo is the same colour as its border, so removing the background would erase the mark itself.';
    case 'vector':
      return 'SVG logos are vector artwork and have no background to remove.';
    case 'undecodable':
      return 'That file could not be read as an image.';
  }
}

/**
 * Downloads a logo we already published, for reprocessing.
 *
 * Deliberately narrow — this is not a general fetcher. It mirrors the renderer's
 * own `fetchLogo` checks (timeout, `image/*` content type, size cap) because the
 * same failure modes apply: a Drive link that has lost its sharing grant answers
 * with an HTML interstitial and a 200.
 */
async function fetchLogoBytes(
  url: string,
): Promise<{ bytes: Buffer; mimeType: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    intEnv('POSTER_LOGO_TIMEOUT_MS', 15_000),
  );

  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) return null;

    const mimeType = (response.headers.get('content-type') ?? '')
      .split(';')[0]
      ?.trim()
      .toLowerCase();
    if (!mimeType) return null;
    if (!mimeType.startsWith('image/')) return null;

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_LOGO_BYTES) return null;

    return { bytes, mimeType };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function logoExtension(mimeType: string): string {
  switch (mimeType) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'image/svg+xml':
      return '.svg';
    default:
      return '.png';
  }
}
