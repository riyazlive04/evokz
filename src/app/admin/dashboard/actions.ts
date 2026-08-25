'use server';

import { DeliveryStatus, Prisma, UsageKeySource } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import {
  describeError,
  getFalEndpoint,
  probeFalKey,
  runCreativePipeline,
} from '@/lib/ai-pipeline';
import { tokenizeClientBrand } from '@/lib/ai/brand-tokenizer';
import { generateContentCalendar } from '@/lib/ai/calendar-generator';
import {
  extractWebsiteColors,
  toBrandColors,
  WebsiteColorError,
  type ExtractionReport,
} from '@/lib/brand/website-colors';
import {
  BRAND_COLOR_ROLES,
  parseBrandGuideline,
  type BrandGuideline,
} from '@/lib/types/brand';
import { applyCalendarImport, type CalendarImportResult } from '@/lib/calendar-import';
import type { CalendarImportInput } from '@/lib/calendar-parse';
import { extractLayoutSpec } from '@/lib/ai/layout-extractor';
import {
  downloadDriveFile,
  ensureVerticalTemplateFolder,
  trashDriveFile,
  uploadClientAsset,
} from '@/lib/google-drive';
import {
  normalizeLayoutSpec,
  parseLayoutSpec,
  posterLayoutSpecSchema,
  validateLayoutSpec,
} from '@/lib/types/layout-spec';
import { readImageDimensions } from '@/lib/poster/image-info';
import { keyLogoBackground, type LogoKeySkipReason } from '@/lib/poster/logo-key';
import { BODY_FONT_OPTIONS, HEADING_FONT_OPTIONS } from '@/lib/poster/theme';
import { findPlateHoles } from '@/lib/poster/plate-regions';
import { prepareTemplateImage, templateFileName } from '@/lib/template-image';
import { parsePlateDraft, parsePlateSpec } from '@/lib/types/plate-spec';
import {
  dedupeTemplateLabel,
  normalizeTemplateLabel,
  templateLabelSchema,
} from '@/lib/template-label';
import {
  MAX_TEMPLATE_BYTES,
  MAX_TEMPLATES_PER_CATEGORY,
  TEMPLATE_MIME_TYPES,
} from '@/lib/template-limits';
import { isImageSizePresetId } from '@/lib/image-sizes';
import {
  clientProvisionSchema,
  normalizeWhatsappNumber,
  provisionClient,
  repairClientDriveFolder,
} from '@/lib/onboarding';
import { mapWithConcurrency } from '@/lib/cron-worker';
import { intEnv, MissingEnvError } from '@/lib/env';
import {
  APP_SETTING_ID,
  FAL_KEY_PATTERN,
  FAL_KEY_PURPOSE,
  loadFalKeyStatus,
  normalizeFalKey,
  resolveFalCredentials,
  type FalKeyStatus,
} from '@/lib/fal-credentials';
import { prisma } from '@/lib/prisma';
import {
  encryptSecret,
  isSecretEncryptionConfigured,
  secretLast4,
  SecretDecryptionError,
} from '@/lib/secret-box';
import { nextSendDelay } from '@/lib/send-jitter';
import { recordImageUsage } from '@/lib/usage';
import {
  describeDeliveryDays,
  formatDisplayDate,
  getAppTimeZone,
  HH_MM_PATTERN,
  normalizeDeliveryDays,
  nthDeliveryDate,
  toTimeString,
  zonedDayRange,
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

/** Drive deletions issued at once when a vertical's whole library goes. */
const TRASH_CHUNK = 8;

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
    //
    // Chunked rather than sequential, because the cap is a hundred templates per
    // vertical and a hundred serial Drive round-trips would run past the action's
    // ceiling — and this runs *after* the cascade, so a timeout here orphans files
    // with nothing left recording which they were.
    //
    // `Promise.all` is safe here only because `trashDriveFile` never throws; a
    // rejecting worker would abandon the rest of its chunk.
    for (let offset = 0; offset < templates.length; offset += TRASH_CHUNK) {
      await Promise.all(
        templates
          .slice(offset, offset + TRASH_CHUNK)
          .map((template) => trashDriveFile(template.gDriveFileId)),
      );
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
 * `category.name` only feeds the LLM system prefix (`Industry: …`) for *future*
 * generation, and days already seeded keep the copy written for the old
 * vertical — reseeding them is the operator's call.
 *
 * **The layout pins are not safe to leave, though.** A day pinned to a template
 * belongs to a vertical, and no foreign key can express "the same vertical the
 * client is in" without denormalising `categoryId` onto every calendar row. So
 * moving a client strands every pin it carries, pointing at templates the new
 * vertical does not own. `resolveDayLayout` catches that as `pinned-foreign` and
 * fails the render rather than drawing the wrong layout — correct, but a silent
 * trap: the operator changing a dropdown here has no idea they have just armed a
 * compose failure on every pinned day.
 *
 * Cleared, and only on rows that can still be rebuilt. A PENDING or FAILED day
 * falls back to the new vertical's rotation, which is what an unpinned day gets
 * anyway. GENERATED and DELIVERED rows keep their pin: it is now a record of
 * what was actually rendered and sent, and rewriting history to tidy a foreign
 * key would be worse than leaving it.
 *
 * The count comes back so the console can say what happened.
 */
export async function updateClientCategory(
  clientId: string,
  categoryId: string,
): Promise<ActionResult<{ unpinnedDays: number }>> {
  try {
    const id = z.string().uuid().parse(clientId);
    const nextId = z.string().uuid('A valid vertical must be selected').parse(categoryId);

    const client = await prisma.client.findUnique({
      where: { id },
      select: { categoryId: true },
    });
    if (!client) return failure('That client no longer exists.');

    const category = await prisma.category.findUnique({
      where: { id: nextId },
      select: { id: true },
    });
    if (!category) return failure('That vertical no longer exists.');

    if (client.categoryId === nextId) return success({ unpinnedDays: 0 });

    const [, cleared] = await prisma.$transaction([
      prisma.client.update({ where: { id }, data: { categoryId: nextId } }),
      prisma.contentCalendar.updateMany({
        where: {
          clientId: id,
          posterTemplateId: { not: null },
          deliveryStatus: { in: [DeliveryStatus.PENDING, DeliveryStatus.FAILED] },
        },
        data: { posterTemplateId: null },
      }),
    ]);

    revalidateAdmin();
    return success({ unpinnedDays: cleared.count });
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
 *
 * The only caller that sets `ignoreApproval`. An operator pressing "Send now" on
 * a poster they are looking at has approved it in every sense that matters, and
 * refusing here would leave them approving a row purely to satisfy a check —
 * which teaches the habit of approving without looking.
 */
export async function forceResendCreative(
  calendarId: string,
): Promise<ActionResult<{ status: string; reusedAsset: boolean }>> {
  try {
    const id = z.string().uuid().parse(calendarId);

    const outcome = await runCreativePipeline(id, {
      reuseExistingAsset: true,
      allowRedelivery: true,
      ignoreApproval: true,
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

// ---------------------------------------------------------------------------
// Pre-generation and approval
// ---------------------------------------------------------------------------

/**
 * Marks a client's remaining campaign for pre-generation.
 *
 * Returns as soon as the rows are marked. It does not render anything, and that
 * is the point: a 30-day campaign is roughly ten minutes of fal.ai and satori
 * work, and a server action has nowhere near that long before the platform cuts
 * it off. The sweep's backlog phase drains the mark a few rows a minute, so the
 * work survives a restart, a deploy, or the operator closing the tab.
 *
 * The Drive folder is checked up front because its absence fails every single
 * render at the upload stage — thirty identical failures an hour after the click,
 * rather than one refusal at the moment of it.
 */
export async function queueCampaignGeneration(
  clientId: string,
): Promise<ActionResult<{ queued: number; alreadyQueued: number }>> {
  try {
    const id = z.string().uuid().parse(clientId);

    const client = await prisma.client.findUnique({
      where: { id },
      select: { companyName: true, gDriveFolderId: true },
    });
    if (!client) return failure('That client no longer exists.');
    if (!client.gDriveFolderId) {
      return failure(
        `${client.companyName} has no Drive vault yet. Repair the Drive folder first — without it every render fails at upload.`,
      );
    }

    const pending = { clientId: id, deliveryStatus: DeliveryStatus.PENDING };

    const alreadyQueued = await prisma.contentCalendar.count({
      where: { ...pending, generationQueuedAt: { not: null } },
    });

    const queued = await prisma.contentCalendar.updateMany({
      where: { ...pending, generationQueuedAt: null },
      data: { generationQueuedAt: new Date() },
    });

    if (queued.count === 0 && alreadyQueued === 0) {
      return failure(
        `Nothing to generate for ${client.companyName} — seed the calendar first, or every day already has a poster.`,
      );
    }

    revalidateAdmin();
    return success({ queued: queued.count, alreadyQueued });
  } catch (error) {
    return toFailure(error, 'Queueing campaign generation');
  }
}

/**
 * Whether a poster's delivery window has already gone by.
 *
 * The sweep releases approved posters only during the minute matching their
 * client's `cronTime`, on their scheduled day. A poster approved after that
 * minute has no second chance today, and one approved for a day already past has
 * none at all — so both need their send booked here or they wait forever.
 */
function hasMissedItsWindow(
  scheduledDate: Date,
  cronTime: string,
  now: Date,
  timeZone: string,
): boolean {
  const { start, end } = zonedDayRange(now, timeZone);
  if (scheduledDate < start) return true;
  if (scheduledDate >= end) return false;
  // Both sides are zero-padded "HH:MM", so a lexicographic compare is a
  // chronological one.
  return toTimeString(now, timeZone) >= cronTime;
}

/**
 * Books a send for an approved poster the sweep will not pick up on its own.
 *
 * Conditional on `sendAfter: null` for the same reason the sweep's own release is:
 * if a sweep booked this row between the read and the write, overwriting its
 * timestamp would move the delivery for no reason and lose the jitter spread.
 */
async function bookSendNow(calendarId: string): Promise<boolean> {
  const claimed = await prisma.contentCalendar.updateMany({
    where: {
      id: calendarId,
      deliveryStatus: DeliveryStatus.GENERATED,
      approvedAt: { not: null },
      sendAfter: null,
    },
    data: { sendAfter: nextSendDelay().sendAfter },
  });

  return claimed.count === 1;
}

/**
 * Approves one poster for delivery.
 *
 * Approval alone does not send anything. On a future day the row simply becomes
 * eligible, and the sweep releases it at the client's delivery minute — which is
 * what keeps `cronTime` meaning the time a client hears from us, rather than the
 * time an operator happened to finish reviewing.
 *
 * The exception is a poster whose window has already passed, which nothing would
 * ever pick up. That one is booked immediately, and the caller is told so it can
 * say which of the two happened.
 */
export async function approveCreative(
  calendarId: string,
): Promise<ActionResult<{ sendsNow: boolean }>> {
  try {
    const id = z.string().uuid().parse(calendarId);

    const entry = await prisma.contentCalendar.findUnique({
      where: { id },
      select: {
        deliveryStatus: true,
        scheduledDate: true,
        approvedAt: true,
        client: { select: { cronTime: true } },
      },
    });

    if (!entry) return failure('That calendar entry no longer exists.');
    if (entry.approvedAt) return failure('That poster is already approved.');
    if (entry.deliveryStatus !== DeliveryStatus.GENERATED) {
      return failure(
        entry.deliveryStatus === DeliveryStatus.PENDING
          ? 'That poster has not been generated yet — there is nothing to look at.'
          : `A ${entry.deliveryStatus.toLowerCase()} poster cannot be approved.`,
      );
    }

    // Conditional on the status re-read, so a row generated-then-delivered by a
    // sweep in the intervening milliseconds is not retroactively approved.
    const approved = await prisma.contentCalendar.updateMany({
      where: { id, deliveryStatus: DeliveryStatus.GENERATED, approvedAt: null },
      data: { approvedAt: new Date() },
    });
    if (approved.count === 0) {
      return failure('That poster changed while you were looking at it. Refresh and retry.');
    }

    const now = new Date();
    const sendsNow =
      hasMissedItsWindow(
        entry.scheduledDate,
        entry.client.cronTime,
        now,
        getAppTimeZone(),
      ) && (await bookSendNow(id));

    revalidateAdmin();
    return success({ sendsNow });
  } catch (error) {
    return toFailure(error, 'Approving poster');
  }
}

/**
 * Approves every reviewed-and-waiting poster for one client.
 *
 * Deliberately does *not* book the overdue ones the way `approveCreative` does.
 * Approving a campaign whose first days have already gone by would otherwise put
 * a queue of back-dated posters on the wire at once — several messages to one
 * number in a few minutes, which is what the send jitter exists to avoid and what
 * a recipient reads as a malfunction. Those rows are counted and handed back, so
 * the operator releases them one at a time with "Send now" if that is what they
 * actually want.
 */
export async function approveAllCreatives(
  clientId: string,
): Promise<ActionResult<{ approved: number; overdue: number }>> {
  try {
    const id = z.string().uuid().parse(clientId);

    const rows = await prisma.contentCalendar.findMany({
      where: {
        clientId: id,
        deliveryStatus: DeliveryStatus.GENERATED,
        approvedAt: null,
      },
      select: {
        scheduledDate: true,
        client: { select: { cronTime: true } },
      },
    });

    if (rows.length === 0) return failure('Nothing is waiting for approval.');

    const now = new Date();
    const timeZone = getAppTimeZone();
    const overdue = rows.filter((row) =>
      hasMissedItsWindow(row.scheduledDate, row.client.cronTime, now, timeZone),
    ).length;

    const approved = await prisma.contentCalendar.updateMany({
      where: {
        clientId: id,
        deliveryStatus: DeliveryStatus.GENERATED,
        approvedAt: null,
      },
      data: { approvedAt: now },
    });

    revalidateAdmin();
    return success({ approved: approved.count, overdue });
  } catch (error) {
    return toFailure(error, 'Approving posters');
  }
}

/**
 * Withdraws approval from a poster that has not gone out yet.
 *
 * Refused once a send is booked rather than racing it: `sendAfter` is non-null
 * from the moment a sweep may claim the row, and clearing approval after that
 * point would leave the operator believing they had stopped a delivery that was
 * already on its way to WhatsApp.
 */
export async function unapproveCreative(calendarId: string): Promise<ActionResult> {
  try {
    const id = z.string().uuid().parse(calendarId);

    const cleared = await prisma.contentCalendar.updateMany({
      where: { id, deliveryStatus: DeliveryStatus.GENERATED, sendAfter: null },
      data: { approvedAt: null },
    });

    if (cleared.count === 0) {
      return failure('Too late to withdraw — that poster is already booked to send or has gone out.');
    }

    revalidateAdmin();
    return success();
  } catch (error) {
    return toFailure(error, 'Withdrawing approval');
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
        // Approved at creation, because on this surface the two are one act: an
        // operator typed this copy and pressed send while a prospect watched.
        // Without it the pipeline would hold the row for a review that has, in
        // every meaningful sense, already happened — and the demo would render a
        // poster and quietly send nothing.
        //
        // Stamped rather than passing `ignoreApproval`, so the row does not read
        // as delivered-but-never-approved in the ledger afterwards.
        approvedAt: new Date(),
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

/** Mirrors `brandColorSchema.hex`; restated so the failure names a format. */
const HEX_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * Layout directives ride in every calendar and poster-copy prompt, so an
 * unbounded list is recurring spend rather than a one-off.
 */
const MAX_LAYOUT_DIRECTIVES = 8;

const manualBrandSchema = z.object({
  colors: z
    .array(
      z.object({
        role: z.enum(BRAND_COLOR_ROLES),
        hex: z.string().trim().regex(HEX_PATTERN, 'Use a hex value like #1F6FEB'),
      }),
    )
    .min(1, 'Pick at least one colour')
    .max(BRAND_COLOR_ROLES.length)
    .refine(
      (colors) => new Set(colors.map((color) => color.role)).size === colors.length,
      'Each role may only be set once',
    ),
  // Rejected rather than coerced. `resolveFace` substitutes the default for a
  // family it has no bytes for and reports nothing, so accepting an arbitrary
  // name here would store a choice the renderer silently ignores — the operator
  // would see their font on the brand canvas and never on a poster.
  headingFont: z
    .string()
    .refine((value) => HEADING_FONT_OPTIONS.includes(value), 'Unsupported heading font'),
  bodyFont: z
    .string()
    .refine((value) => BODY_FONT_OPTIONS.includes(value), 'Unsupported body font'),
  vibeClassification: z
    .string()
    .trim()
    .max(48, 'Keep the vibe to a few words')
    .optional()
    .transform((value) => value || undefined),
  layoutDirectives: z
    .array(z.string().trim().min(1).max(200))
    .max(MAX_LAYOUT_DIRECTIVES, `At most ${MAX_LAYOUT_DIRECTIVES} directives`)
    .default([]),
});

export type ManualBrandInput = z.input<typeof manualBrandSchema>;

/**
 * Writes an operator-chosen palette and typography to `Client.brandGuideline`.
 *
 * This is the route for a client with no website: `extractWebsiteColors` has no
 * stylesheet to read, and the tokenizer can only infer hexes from prose. A
 * tokenizer guess is stored with no `source`, which `resolvePosterTheme` treats
 * as untrusted — it re-ranks the palette by measurement and commonly discards the
 * role labels, which is how a client whose brand is green receives an amber
 * poster.
 *
 * So stamping `source: 'manual'` is not bookkeeping. It is what flips the
 * `measured` branch in the theme engine: the operator's `primary` is then taken
 * as the accent, and the dark ground stays neutral instead of inheriting house
 * navy. A near-black or near-white pick still falls through to ranking, because
 * `pickMeasuredAccent` holds a minimum accent score — the panel warns about that
 * before saving rather than letting it surprise anyone.
 *
 * Colours, typography and directives are replaced together: they are one decision
 * made in one form, and a partial write would leave a half-manual palette whose
 * provenance no longer describes it. `assets` is carried through untouched.
 */
export async function applyManualBrandTokens(
  clientId: string,
  input: ManualBrandInput,
): Promise<ActionResult<{ colors: number }>> {
  try {
    const id = z.string().uuid().parse(clientId);
    const data = manualBrandSchema.parse(input);

    const client = await prisma.client.findUnique({
      where: { id },
      select: { brandGuideline: true },
    });
    if (!client) return failure('That client no longer exists.');

    const guideline: BrandGuideline = {
      ...parseBrandGuideline(client.brandGuideline),
      colors: data.colors.map((color) => ({
        hex: color.hex.toLowerCase(),
        role: color.role,
        source: 'manual' as const,
        // The operator looked at the brand and chose this. Nothing downstream
        // holds better evidence to weigh it against.
        confidence: 1,
      })),
      typography: {
        headingFont: data.headingFont,
        bodyFont: data.bodyFont,
        ...(data.vibeClassification
          ? { vibeClassification: data.vibeClassification }
          : {}),
      },
      layoutDirectives: data.layoutDirectives,
    };

    await prisma.client.update({
      where: { id },
      // Cast: Prisma types Json input as InputJsonValue, which a structural
      // interface does not satisfy without a widening step.
      data: { brandGuideline: guideline as unknown as object },
    });

    revalidateAdmin();
    return success({ colors: guideline.colors.length });
  } catch (error) {
    return toFailure(error, 'Saving brand tokens');
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

/**
 * Re-runs generation from scratch, ignoring any previously uploaded asset.
 *
 * This is the reject button. Withdrawing approval before the render — rather than
 * after, or not at all — is what makes it one: the pipeline reads `approvedAt`
 * when deciding whether to broadcast, so a row cleared here produces a
 * replacement poster and holds it for another look. Left approved, a reject would
 * WhatsApp the client the very poster the operator had just turned down.
 *
 * `allowRedelivery` still passes, and now does only one job: lifting the
 * already-delivered short-circuit so a delivered day can be re-rendered at all.
 * Withholding the send is the approval guard's responsibility, not its.
 *
 * **The layout pin is left alone**, unlike its predecessor. `posterArchetype`
 * was written by the pipeline itself on first compose, so clearing it here was
 * the only way an operator could ever move a rendered day off whichever
 * composition the rotation first handed it. `posterTemplateId` is the opposite:
 * nothing but an imported sheet ever sets one, so it is an instruction rather
 * than a derivation, and discarding it because someone disliked a photograph
 * would silently undo a deliberate choice.
 *
 * A day with no pin re-resolves through the vertical's rotation on every render
 * anyway, so a newly approved template reaches it without help. A day that named
 * its template is changed by re-importing the sheet.
 */
export async function regenerateCreative(
  calendarId: string,
): Promise<ActionResult<{ status: string }>> {
  try {
    const id = z.string().uuid().parse(calendarId);

    const cleared = await prisma.contentCalendar.updateMany({
      where: { id },
      data: { approvedAt: null, sendAfter: null },
    });
    if (cleared.count === 0) return failure('That calendar entry no longer exists.');

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
 * Stores one reference poster against a vertical and reads its layout.
 *
 * `archetype` is still left null: which of the fifteen built-in compositions a
 * reference most resembles is a judgement an operator makes looking at it, and
 * guessing from a filename would put layouts into a client's rotation that
 * nobody chose.
 *
 * The layout *spec* is different, because it is measured rather than judged —
 * the geometry is in the image, and extracting it is what makes the upload
 * worth more than storage. It runs here, inline, so an operator who uploads a
 * template can review it immediately instead of hunting for a second button.
 *
 * **Extraction is best-effort and never fails the upload.** The file is already
 * in Drive by this point; refusing the row because a vision call timed out would
 * lose the operator's work to a fault that `extractTemplateLayout` can retry in
 * one click. A null spec simply means the template falls back to its archetype,
 * which is exactly the behaviour that existed before specs.
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
      select: {
        name: true,
        _count: { select: { templates: true } },
        // At most 100 rows, served by @@index([categoryId, createdAt]). Needed to
        // suffix a colliding name rather than let the unique constraint reject an
        // upload whose bytes are already in Drive.
        templates: { select: { label: true } },
      },
    });
    if (!category) return failure('That vertical no longer exists.');
    if (category._count.templates >= MAX_TEMPLATES_PER_CATEGORY) {
      return failure(
        `${category.name} already has ${MAX_TEMPLATES_PER_CATEGORY} templates. Delete one before adding another.`,
      );
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    // Dimensions come back measured from whatever is actually stored, so the
    // gallery's size badge describes the file in Drive rather than the upload.
    const stored = await prepareTemplateImage(bytes, file.type);

    const folderId = await ensureVerticalTemplateFolder(category.name);
    const uploaded = await uploadClientAsset({
      folderId,
      fileName: templateFileName(file.name, stored.mimeType),
      body: stored.body,
      mimeType: stored.mimeType,
      // Unpublished. A poster has to be link-readable because Evolution API
      // fetches it with no Google credentials; a reference template never
      // leaves the console, so publishing it would only mean that anyone who
      // ever saw its Drive id could read the client's library.
      // `/api/templates/[templateId]/thumbnail` serves it instead.
      publish: false,
    });

    const base = file.name.replace(/\.[^.]+$/, '').trim() || 'Untitled';
    const label = dedupeTemplateLabel(
      base,
      new Set(category.templates.map((existing) => normalizeTemplateLabel(existing.label))),
      uploaded.fileId.slice(0, 8),
    );
    const draft = await readLayoutQuietly(stored.body, stored.mimeType, label, stored);

    const created = await prisma.categoryTemplate.create({
      data: {
        categoryId: id,
        label,
        gDriveFileId: uploaded.fileId,
        gDriveViewUrl: uploaded.viewUrl,
        mimeType: stored.mimeType,
        width: stored.width,
        height: stored.height,
        layoutSpec: draft.spec ?? Prisma.DbNull,
        layoutReading: draft.reading,
        // Never set here. Approval means a human looked at the extraction
        // rendered as a poster, and nobody has at this point.
        layoutApprovedAt: null,
      },
      select: { id: true, label: true },
    });

    revalidateAdmin();
    return success(created);
  } catch (error) {
    return toFailure(error, 'Uploading template');
  }
}

interface LayoutDraft {
  spec: Prisma.InputJsonValue | null;
  /** Operator-facing: the model's reading, or why there isn't one. */
  reading: string;
  problems: string[];
}

/**
 * Runs extraction and swallows every failure into a readable note.
 *
 * Separate from `extractLayoutSpec` because that function is right to throw —
 * a caller asking for a spec should hear about a missing API key. This is the
 * wrapper for the two callers who must not: an upload that has already written
 * to Drive, and a re-extract whose job is to report what happened rather than
 * to crash the console.
 */
async function readLayoutQuietly(
  bytes: Buffer,
  mimeType: string,
  label: string,
  /**
   * The stored file's measured dimensions, which become the spec's `aspect` and
   * therefore the shape of every poster drawn from this template.
   *
   * Passed in rather than re-measured here so the number that reaches the spec
   * is the same one stored on `CategoryTemplate.width/height` — a spec claiming
   * a different ratio from the row beside it would be impossible to debug from
   * the console, which shows both.
   */
  dimensions: { width: number | null; height: number | null },
): Promise<LayoutDraft> {
  try {
    const result = await extractLayoutSpec({
      bytes,
      mimeType,
      label,
      width: dimensions.width,
      height: dimensions.height,
    });
    const problems = result.problems.map(
      (problem) => `${problem.path} ${problem.message}`,
    );

    return {
      // A structurally invalid draft is still stored. It is far more useful to
      // an operator as something to correct than as a blank grid, and
      // `parseLayoutSpec` refuses it at render time regardless, so a bad spec
      // cannot reach a client even if somebody approves it by mistake.
      spec: result.spec as unknown as Prisma.InputJsonValue,
      reading: result.reading,
      problems,
    };
  } catch (error) {
    const message = describeError(error);
    console.warn(`[ace:layout] extraction failed for "${label}": ${message}`);
    return {
      spec: null,
      reading: `Layout could not be read automatically: ${message}`,
      problems: [message],
    };
  }
}

/**
 * Re-reads a stored template's layout, replacing any existing draft.
 *
 * **Clears `layoutApprovedAt`.** An approval refers to the spec that was on
 * screen when it was given; carrying it across to a freshly extracted one would
 * publish geometry no human has seen, which is the single thing the approval
 * gate exists to prevent.
 */
export async function extractTemplateLayout(
  templateId: string,
): Promise<ActionResult<{ approved: false; problems: string[] }>> {
  try {
    const id = z.string().uuid().parse(templateId);

    const template = await prisma.categoryTemplate.findUnique({
      where: { id },
      select: {
        gDriveFileId: true,
        mimeType: true,
        label: true,
        width: true,
        height: true,
      },
    });
    if (!template) return failure('That template no longer exists.');

    // Read back from Drive rather than kept in memory: this action is reached
    // from a template row that may have been uploaded weeks ago.
    let bytes: Buffer;
    try {
      bytes = await downloadDriveFile(template.gDriveFileId);
    } catch (error) {
      return failure(
        'That template could not be read back from Drive — ' +
          `${describeError(error)}. Check the service account still has access ` +
          'to the vertical template folder.',
      );
    }

    /*
     * Re-measured from the bytes just read back, falling back to the stored
     * columns.
     *
     * The row's dimensions were written at upload and are almost always right,
     * but a template uploaded before those columns were populated carries nulls
     * — and a null there would leave the re-read spec with no aspect, which is
     * exactly the state re-reading is meant to fix.
     */
    const measured = readImageDimensions(bytes);
    const draft = await readLayoutQuietly(bytes, template.mimeType, template.label, {
      width: measured?.width ?? template.width,
      height: measured?.height ?? template.height,
    });
    if (!draft.spec) {
      await prisma.categoryTemplate.update({
        where: { id },
        data: { layoutReading: draft.reading, layoutApprovedAt: null },
      });
      revalidateAdmin();
      return failure(draft.reading);
    }

    await prisma.categoryTemplate.update({
      where: { id },
      data: {
        layoutSpec: draft.spec,
        layoutReading: draft.reading,
        layoutApprovedAt: null,
      },
    });

    revalidateAdmin();
    return success({ approved: false as const, problems: draft.problems });
  } catch (error) {
    return toFailure(error, 'Reading template layout');
  }
}

/**
 * Attaches a clean plate to a template.
 *
 * The plate is the template's artwork with its own words and photography erased
 * and the photo areas made transparent. Once one is approved the poster stops
 * being rebuilt from the grid and starts being *composited* — the artwork is the
 * background, the generated frame shows through the holes, and the type is drawn
 * on top. Every treatment the grid cannot express survives as pixels.
 *
 * **Stored as uploaded, not through `prepareTemplateImage`.** That helper
 * re-encodes to WebP, and while WebP does carry alpha, the resize-and-recompress
 * it performs is exactly wrong here: a plate's value is its edges, and the
 * anti-aliased rim of a mask is what makes a composited photograph look cut
 * rather than pasted. The size cap still applies.
 *
 * Photo regions are measured from the file rather than asked of a model — see
 * `findPlateHoles`. Text regions are left empty for the operator or a later
 * extraction pass to fill, which is why this returns the hole count: an operator
 * who cut three holes and sees "1 region" knows the export flattened them.
 */
export async function uploadTemplatePlate(
  templateId: string,
  formData: FormData,
): Promise<ActionResult<{ regions: number; found: number }>> {
  try {
    const id = z.string().uuid().parse(templateId);

    const file = formData.get('plate');
    if (!(file instanceof File) || file.size === 0) {
      return failure('Choose a plate image to upload.');
    }
    if (file.type !== 'image/png') {
      return failure(
        `"${file.type || 'unknown'}" cannot carry transparency. Export the plate as a PNG ` +
          'with the photo areas erased.',
      );
    }
    if (file.size > MAX_TEMPLATE_BYTES) {
      return failure(
        `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${
          MAX_TEMPLATE_BYTES / 1024 / 1024
        } MB.`,
      );
    }

    const template = await prisma.categoryTemplate.findUnique({
      where: { id },
      select: {
        label: true,
        plateDriveFileId: true,
        plateSpec: true,
        category: { select: { name: true } },
      },
    });
    if (!template) return failure('That template no longer exists.');

    const bytes = Buffer.from(await file.arrayBuffer());

    const holes = await findPlateHoles(bytes);
    if (!holes) {
      return failure('That file could not be decoded as an image.');
    }

    const folderId = await ensureVerticalTemplateFolder(template.category.name);
    const uploaded = await uploadClientAsset({
      folderId,
      fileName: `${template.label} — plate.png`,
      body: bytes,
      mimeType: 'image/png',
      // Unpublished, exactly like the reference: a plate never leaves the
      // console, and publishing it would let anyone holding the Drive id read
      // the client's template library.
      publish: false,
    });

    /*
     * An existing draft's text regions survive a re-upload; only the geometry
     * measured from the file is replaced. Re-exporting a plate to nudge one mask
     * is common, and making the operator re-place every text box afterwards
     * would make that a punishing edit.
     */
    const previous = parsePlateDraft(template.plateSpec).spec;

    const spec = {
      version: 1 as const,
      name: previous?.name ?? template.label,
      aspect: holes.width / holes.height,
      photos: holes.regions,
      text: previous?.text ?? [],
      featureCount: previous?.featureCount ?? 3,
      featureStyle: previous?.featureStyle ?? ('labelAndBody' as const),
      ctaShape: previous?.ctaShape ?? ('pill' as const),
      headlineEmphasis: previous?.headlineEmphasis ?? [],
      headlineCase: previous?.headlineCase ?? ('upper' as const),
    };

    await prisma.categoryTemplate.update({
      where: { id },
      data: {
        plateDriveFileId: uploaded.fileId,
        plateViewUrl: uploaded.viewUrl,
        plateWidth: holes.width,
        plateHeight: holes.height,
        plateSpec: spec as unknown as Prisma.InputJsonValue,
        // Never set here. Approval means a human saw the plate composited, and
        // nobody has at this point — the same rule as `layoutApprovedAt`.
        plateApprovedAt: null,
      },
    });

    // Trashed after the row points at the replacement, so a failure above leaves
    // the operator with the plate they had rather than none.
    if (template.plateDriveFileId) {
      await trashDriveFile(template.plateDriveFileId).catch((error: unknown) => {
        console.warn(`[ace:plate] could not trash the previous plate: ${describeError(error)}`);
      });
    }

    revalidateAdmin();
    return success({ regions: holes.regions.length, found: holes.found });
  } catch (error) {
    return toFailure(error, 'Uploading clean plate');
  }
}

/**
 * Publishes or withdraws a template's clean plate.
 *
 * Separate from `setTemplateLayoutApproval` because the two describe different
 * artefacts: a template can have a sound grid and a plate whose headline box
 * sits across somebody's face, and withdrawing one must not withdraw the other.
 * Withdrawing a plate drops the template back to the grid path, which is the fix
 * an operator reaches for when a composited poster comes out wrong.
 */
export async function setTemplatePlateApproval(
  templateId: string,
  approved: boolean,
): Promise<ActionResult<{ approved: boolean }>> {
  try {
    const id = z.string().uuid().parse(templateId);

    const template = await prisma.categoryTemplate.findUnique({
      where: { id },
      select: { plateSpec: true, plateDriveFileId: true },
    });
    if (!template) return failure('That template no longer exists.');

    if (approved) {
      if (!template.plateDriveFileId) {
        return failure('Upload a clean plate before approving one.');
      }
      const spec = parsePlateSpec(template.plateSpec);
      if (!spec) {
        return failure(
          'This plate has no usable region map yet. Every plate needs at least a headline ' +
            'region before it can be composited.',
        );
      }
    }

    await prisma.categoryTemplate.update({
      where: { id },
      data: { plateApprovedAt: approved ? new Date() : null },
    });

    revalidateAdmin();
    return success({ approved });
  } catch (error) {
    return toFailure(error, 'Approving clean plate');
  }
}

/** Chooses whether a template's posters take the reference's colours or the client's. */
export async function setTemplatePaletteSource(
  templateId: string,
  source: 'template' | 'client',
): Promise<ActionResult<{ source: string }>> {
  try {
    const id = z.string().uuid().parse(templateId);
    const value = z.enum(['template', 'client']).parse(source);

    await prisma.categoryTemplate.update({
      where: { id },
      data: { paletteSource: value },
    });

    revalidateAdmin();
    return success({ source: value });
  } catch (error) {
    return toFailure(error, 'Setting palette source');
  }
}

/**
 * Publishes or withdraws a template's extracted layout.
 *
 * Approving is what puts the template's own geometry into its vertical's
 * rotation — until then the row is inert and the vertical falls back to
 * archetypes. Withdrawing takes it straight back out, which is the fix an
 * operator reaches for when a client's posters come out wrong.
 *
 * Refuses to approve a spec that `validateLayoutSpec` rejects. That check is
 * duplicated at render time, deliberately: this one gives the operator a
 * sentence explaining what to fix, and that one guarantees a bad spec never
 * draws a poster whatever route it took into the column.
 */
export async function setTemplateLayoutApproval(
  templateId: string,
  approved: boolean,
): Promise<ActionResult<{ approved: boolean }>> {
  try {
    const id = z.string().uuid().parse(templateId);

    const template = await prisma.categoryTemplate.findUnique({
      where: { id },
      select: { layoutSpec: true },
    });
    if (!template) return failure('That template no longer exists.');

    if (approved) {
      const spec = parseLayoutSpec(template.layoutSpec);
      if (!spec) {
        return failure(
          'This template has no usable layout yet. Re-read the layout, and if it ' +
            'still reports problems, correct them before approving.',
        );
      }
    }

    await prisma.categoryTemplate.update({
      where: { id },
      data: { layoutApprovedAt: approved ? new Date() : null },
    });

    revalidateAdmin();
    return success({ approved });
  } catch (error) {
    return toFailure(error, 'Approving template layout');
  }
}

/**
 * Replaces a template's layout spec with an operator's corrected version.
 *
 * The console's editor posts the whole spec rather than a patch: a layout is a
 * tree, and a field-level patch protocol over a tree is a great deal of surface
 * for something an operator edits a handful of times per template.
 *
 * Validated here and not merely parsed, because this is the one path where a
 * human can write geometry directly — the extractor's output at least came from
 * a schema-constrained model.
 */
export async function setTemplateLayoutSpec(
  templateId: string,
  specJson: string,
): Promise<ActionResult<{ problems: string[] }>> {
  try {
    const id = z.string().uuid().parse(templateId);

    let raw: unknown;
    try {
      raw = JSON.parse(specJson);
    } catch {
      return failure('That is not valid JSON.');
    }

    const parsed = posterLayoutSpecSchema.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return failure(
        first
          ? `${first.path.join('.') || 'spec'}: ${first.message}`
          : 'That is not a readable layout spec.',
      );
    }

    const spec = normalizeLayoutSpec(parsed.data);
    const problems = validateLayoutSpec(spec);
    if (problems.length > 0) {
      return failure(problems.map((p) => `${p.path} ${p.message}`).join(' · '));
    }

    await prisma.categoryTemplate.update({
      where: { id },
      data: {
        layoutSpec: spec as unknown as Prisma.InputJsonValue,
        // Same reasoning as `extractTemplateLayout`: the approval on file refers
        // to the spec that was replaced.
        layoutApprovedAt: null,
      },
    });

    revalidateAdmin();
    return success({ problems: [] });
  } catch (error) {
    return toFailure(error, 'Saving template layout');
  }
}

/**
 * Renames a reference template.
 *
 * The name matters now in a way it did not when it was a caption: a calendar
 * sheet chooses a layout by typing it, so it has to be unique within the vertical
 * and worth typing. Uploads derive it from a filename, which almost never is.
 *
 * **Renaming invalidates saved sheets.** Any spreadsheet still naming the old
 * label is rejected on its next import — the unavoidable cost of a pin keyed on
 * an id and a sheet keyed on a name, and the panel says so where the rename
 * happens.
 */
export async function renameVerticalTemplate(
  templateId: string,
  label: string,
): Promise<ActionResult<{ label: string }>> {
  try {
    const id = z.string().uuid().parse(templateId);
    const next = templateLabelSchema.parse(label);

    const current = await prisma.categoryTemplate.findUnique({
      where: { id },
      select: { categoryId: true, label: true },
    });
    if (!current) return failure('That template no longer exists.');
    // Short-circuit before the collision check, which would otherwise find this
    // row itself when only the case has changed.
    if (current.label === next) return success({ label: next });

    /*
     * Case-insensitive, unlike the database constraint.
     *
     * `@@unique([categoryId, label])` is case-sensitive — Prisma cannot express a
     * functional index, and a shadow one it did not know about would trap the next
     * person to run `migrate diff`. So the application carries the other half:
     * "Grand Opening" and "grand opening" are the same name to anyone typing one
     * into a sheet, and allowing both would make an import ambiguous.
     *
     * `mode: 'insensitive'` emits ILIKE, which the unique index cannot serve —
     * but with the categoryId predicate and at most 100 rows the planner filters
     * off `CategoryTemplate_categoryId_createdAt_idx`. Do not "optimise" it.
     */
    const clash = await prisma.categoryTemplate.findFirst({
      where: {
        categoryId: current.categoryId,
        id: { not: id },
        label: { equals: next, mode: 'insensitive' },
      },
      select: { label: true },
    });
    if (clash) {
      return failure(
        `"${clash.label}" is already the name of another template in this vertical. ` +
          'Names have to be unique because a calendar sheet picks a layout by typing one.',
      );
    }

    try {
      await prisma.categoryTemplate.update({ where: { id }, data: { label: next } });
    } catch (error) {
      // The check above is racy; the constraint is the authority.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return failure(
          `"${next}" is already the name of another template in this vertical.`,
        );
      }
      throw error;
    }

    revalidateAdmin();
    return success({ label: next });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return failure(error.issues[0]?.message ?? 'That is not a usable template name.');
    }
    return toFailure(error, 'Renaming template');
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
  /*
   * Whether the uploaded logo already reads as the company name.
   *
   * Defaults rather than being required so an older caller that omits it keeps
   * the printed name, which is the safe direction: an absent company name is
   * invisible until somebody notices it missing, a doubled one is obvious.
   */
  logoIncludesName: z.boolean().default(false),
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

// ---------------------------------------------------------------------------
// Image generation key (operator-supplied fal.ai credential)
// ---------------------------------------------------------------------------

/**
 * Copy for a deployment that cannot encrypt.
 *
 * Refusing outright is the whole point. An operator who pasted a key and saw
 * "Saved" would reasonably assume it was protected, and a plaintext credential in a
 * table that lands in every nightly dump is worse than not shipping the panel.
 */
const ENCRYPTION_UNAVAILABLE =
  'Cannot save: SETTINGS_ENCRYPTION_KEY is not set on this deployment, and this panel will ' +
  'not store a key in plain text. Generate one with `node scripts/hash-password.mjs ' +
  '--settings-key`, add it to .env, then run `docker compose up -d app` — a plain restart ' +
  'does not re-read .env. Nothing was saved.';

/**
 * Validates a pasted key.
 *
 * No message below may echo the value: `toFailure` writes `describeError(error)`
 * straight to the container log, so a validator that quoted its input would put the
 * key on disk in the one case where the operator most expects it not to be.
 */
const falApiKeySchema = z.object({
  key: z
    .string()
    .trim()
    .min(1, 'Paste your fal.ai key first.')
    .transform(normalizeFalKey)
    .refine(
      (value) => FAL_KEY_PATTERN.test(value),
      'That does not look like a fal.ai key. It is two parts joined by a colon — ' +
        '"<key id>:<key secret>" — copied whole from fal.ai → Settings → API Keys.',
    ),
  label: z
    .string()
    .trim()
    .max(80, 'Label must be 80 characters or fewer')
    .optional()
    .transform((value) => value?.trim() || null),
});

export type FalApiKeyInput = z.input<typeof falApiKeySchema>;

/**
 * Stores the operator's own fal.ai key, encrypted.
 *
 * Takes effect on the next render — there is no process restart and no redeploy,
 * because the pipeline resolves the credential per call rather than at boot.
 */
export async function saveFalApiKey(
  input: FalApiKeyInput,
): Promise<ActionResult<FalKeyStatus>> {
  try {
    const data = falApiKeySchema.parse(input);

    // Checked before the database is touched, so a deployment that cannot encrypt
    // never half-writes a row.
    if (!isSecretEncryptionConfigured()) {
      return failure(ENCRYPTION_UNAVAILABLE);
    }

    const cipher = encryptSecret(data.key, FAL_KEY_PURPOSE);

    await prisma.appSetting.upsert({
      where: { id: APP_SETTING_ID },
      create: {
        id: APP_SETTING_ID,
        falKeyCipher: cipher,
        falKeyLast4: secretLast4(data.key),
        falKeyLabel: data.label,
        falKeyUpdatedAt: new Date(),
      },
      update: {
        falKeyCipher: cipher,
        falKeyLast4: secretLast4(data.key),
        falKeyLabel: data.label,
        falKeyUpdatedAt: new Date(),
      },
    });

    revalidateAdmin();
    return success(await loadFalKeyStatus());
  } catch (error) {
    return toFailure(error, 'Saving the fal.ai key');
  }
}

/*
 * There is deliberately no `clearFalApiKey`.
 *
 * The switch to an operator key is one-way from the console: once saved, a key can
 * be *replaced* by another of the operator's own, but generation never returns to
 * the platform FAL_KEY from here. Hiding a button would not be enough — Next.js
 * publishes Server Action IDs in the client bundle, so an action that existed would
 * be invocable by anyone who loaded the page, whatever the UI showed. The
 * enforcement is the absence of the action, not the absence of the control.
 *
 * Reverting is an operator task with server access, not a console gesture:
 *
 *   docker compose exec db psql -U evokz -d evokz_ace \
 *     -c 'UPDATE "AppSetting" SET "falKeyCipher" = NULL, "falKeyLast4" = NULL,
 *         "falKeyLabel" = NULL, "falKeyUpdatedAt" = NULL;'
 *
 * See DEPLOY_VPS.md §10.
 */

/**
 * Proves a key works by spending one small render on it.
 *
 * With no argument this tests **whatever the pipeline would actually use** — the
 * saved key if there is one, the platform key otherwise — which is more useful than
 * testing only the saved key, and gives an operator a way to check FAL_KEY too.
 */
export async function testFalApiKey(input?: { key?: string }): Promise<
  ActionResult<{
    scope: 'entered' | 'saved' | 'platform';
    endpoint: string;
    renderEndpoint: string;
    elapsedMs: number;
  }>
> {
  const entered = input?.key?.trim() ?? '';

  try {
    const credentials = entered
      ? (() => {
          const key = falApiKeySchema.shape.key.parse(entered);
          return { key, source: UsageKeySource.BYO, last4: secretLast4(key) };
        })()
      : await resolveFalCredentials();

    const probe = await probeFalKey(credentials);

    // Real money on a real account. The ledger's contract is that it is a faithful
    // record of what was spent, so a probe belongs in it — and repeated testing
    // becomes visible rather than invisible. No client, so it lands unattributed.
    await recordImageUsage(probe.endpoint, {}, credentials.source);

    revalidateAdmin();
    return success({
      scope: entered
        ? 'entered'
        : credentials.source === UsageKeySource.BYO
          ? 'saved'
          : 'platform',
      endpoint: probe.endpoint,
      renderEndpoint: getFalEndpoint(),
      elapsedMs: probe.elapsedMs,
    });
  } catch (error) {
    // `probeFalKey` has already redacted. Map the statuses an operator can act on;
    // anything else falls through to the generic handler.
    const message = describeError(error);

    // Both of these already carry operator-legible copy and no key material, so
    // pass them through rather than let `toFailure` flatten them into "check the
    // server logs" — the server log would say exactly what the panel just hid.
    if (error instanceof SecretDecryptionError || error instanceof MissingEnvError) {
      return failure(message);
    }
    if (/responded (401|403)\b/.test(message)) {
      return failure(
        'fal.ai rejected that key. Check you copied both halves — "<key id>:<key secret>" — ' +
          'from fal.ai → Settings → API Keys, and that the key has not been revoked.',
      );
    }
    if (/responded 402\b/.test(message) || /\bbalance\b/i.test(message)) {
      return failure(
        'fal.ai accepted the key but the account has no balance. Top up at fal.ai → Billing.',
      );
    }
    if (/timed out/i.test(message)) {
      return failure(
        'fal.ai did not respond within 30s. The key may still be fine — try again.',
      );
    }
    return toFailure(error, 'Testing the fal.ai key');
  }
}
