'use server';

import { DeliveryStatus, Prisma } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { tokenizeClientBrand } from '@/lib/ai/brand-tokenizer';
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
import { countOpenCampaignDaysReferencingTemplate } from '@/lib/campaign/template-mapping-service';
import { describeError } from '@/lib/errors';
import {
  ensureVerticalTemplateFolder,
  trashDriveFile,
  uploadClientAsset,
} from '@/lib/google-drive';
import { fetchLogoUrl } from '@/lib/brand/logo-fetch';
import {
  describeLogoKeySkip,
  keyLogoBackground,
  type LogoKeySkipReason,
} from '@/lib/poster/logo-key';
import { BODY_FONT_OPTIONS, HEADING_FONT_OPTIONS } from '@/lib/poster/theme';
import { prepareTemplateImage, templateFileName } from '@/lib/template-image';
import {
  elementsCreateData,
  readElementsQuietly,
  refreshTemplateElements,
} from '@/lib/templates/elements-reading';
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
 * Sets the client's output-size preset: the poster shape of a campaign day that
 * has no template (a templated day takes its template's own shape).
 *
 * Applies to posters made from now on; an existing poster keeps its size.
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
 * Reassigns the client's vertical: the one a new campaign takes its templates
 * from. An existing campaign keeps the vertical it was created with, so nothing
 * already planned changes.
 */
export async function updateClientCategory(
  clientId: string,
  categoryId: string,
): Promise<ActionResult> {
  try {
    const id = z.string().uuid().parse(clientId);
    const nextId = z.string().uuid('A valid vertical must be selected').parse(categoryId);

    const [client, category] = await Promise.all([
      prisma.client.findUnique({ where: { id }, select: { categoryId: true } }),
      prisma.category.findUnique({ where: { id: nextId }, select: { id: true } }),
    ]);
    if (!client) return failure('That client no longer exists.');
    if (!category) return failure('That vertical no longer exists.');
    if (client.categoryId === nextId) return success();

    await prisma.client.update({ where: { id }, data: { categoryId: nextId } });

    revalidateAdmin();
    return success();
  } catch (error) {
    return toFailure(error, 'Updating vertical');
  }
}

/**
 * Reassigns the client's plan, and moves the client's plan window with it.
 *
 * The plan is the default length of a new campaign; an existing campaign keeps
 * its own duration and dates. `endDate` is derived from the plan duration at
 * provisioning (`lib/onboarding.ts`), so it is recomputed here rather than left
 * describing the old plan.
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

/**
 * Sets the weekdays a client accepts delivery on — the default for a new
 * campaign, which keeps its own weekdays once created — and moves the plan
 * window's end date with them.
 */
export async function updateClientDeliveryDays(
  clientId: string,
  days: number[],
): Promise<ActionResult<{ endsOn: string; label: string }>> {
  try {
    const id = z.string().uuid().parse(clientId);
    const parsed = normalizeDeliveryDays(
      z.array(z.number().int().min(1).max(7)).parse(days),
    );

    // An empty set would mean a client who never receives anything.
    if (parsed.length === 0) {
      return failure('Pick at least one delivery day.');
    }

    const client = await prisma.client.findUnique({
      where: { id },
      select: { startDate: true, plan: { select: { durationDays: true } } },
    });
    if (!client) return failure('That client no longer exists.');

    const timeZone = getAppTimeZone();
    const stored = parsed.length === 7 ? [] : parsed;
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

    revalidateAdmin();
    return success({
      endsOn: formatDisplayDate(endDate, timeZone),
      label: describeDeliveryDays(stored),
    });
  } catch (error) {
    return toFailure(error, 'Updating delivery days');
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
 *  - Campaigns and calendar days cascade at the database level (schema.prisma).
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

export interface ClearLegacyCalendarOutcome {
  /** Unsent calendar rows from before campaigns that were deleted. */
  deleted: number;
  /** Their Drive files moved to the bin. */
  filesBinned: number;
  /** Their Drive files that could not be binned (the rows went anyway). */
  filesNotBinned: number;
  /** Older rows left in place: generated or delivered, so history. */
  kept: number;
}

/**
 * Deletes a client's unsent calendar days from before campaigns.
 *
 * Such a row still holds its day number, and `createCampaign` refuses a campaign
 * whose day numbers are taken, so these rows block every new campaign.
 *
 * Narrow on purpose: only rows with no campaign that are PENDING or FAILED — so
 * never a campaign day, and never anything the client received (DELIVERED) or a
 * poster that was made (GENERATED).
 *
 * Drive files are binned before the rows go, because once a row is gone nothing
 * records its file; a retry after a timeout re-bins harmlessly. A file that
 * cannot be binned does not stop the delete — it is counted and reported. A file
 * another remaining row or poster version still points at is left alone.
 */
export async function clearUnsentLegacyCalendarAction(
  clientId: string,
): Promise<ActionResult<ClearLegacyCalendarOutcome>> {
  try {
    const id = z.string().uuid().parse(clientId);

    const client = await prisma.client.findUnique({ where: { id }, select: { id: true } });
    if (!client) return failure('That client no longer exists.');

    const unsentLegacy = {
      clientId: id,
      campaignId: null,
      deliveryStatus: { in: [DeliveryStatus.PENDING, DeliveryStatus.FAILED] },
    } satisfies Prisma.ContentCalendarWhereInput;

    const rows = await prisma.contentCalendar.findMany({
      where: unsentLegacy,
      select: { id: true, gDriveFileId: true },
    });
    const rowIds = rows.map((row) => row.id);
    const fileIds = [
      ...new Set(rows.map((row) => row.gDriveFileId).filter((fileId): fileId is string => Boolean(fileId))),
    ];

    let filesToBin = fileIds;
    if (fileIds.length > 0) {
      const [sharedByDays, sharedByVersions] = await Promise.all([
        prisma.contentCalendar.findMany({
          where: { gDriveFileId: { in: fileIds }, id: { notIn: rowIds } },
          select: { gDriveFileId: true },
        }),
        prisma.posterVersion.findMany({
          where: { imageDriveFileId: { in: fileIds } },
          select: { imageDriveFileId: true },
        }),
      ]);
      const stillUsed = new Set<string | null>([
        ...sharedByDays.map((row) => row.gDriveFileId),
        ...sharedByVersions.map((version) => version.imageDriveFileId),
      ]);
      filesToBin = fileIds.filter((fileId) => !stillUsed.has(fileId));
    }

    // `trashDriveFile` never throws, so `Promise.all` cannot abandon a chunk.
    let filesNotBinned = 0;
    for (let offset = 0; offset < filesToBin.length; offset += TRASH_CHUNK) {
      const binned = await Promise.all(
        filesToBin.slice(offset, offset + TRASH_CHUNK).map((fileId) => trashDriveFile(fileId)),
      );
      filesNotBinned += binned.filter((ok) => !ok).length;
    }

    // The status filter is repeated so a row that changed since it was read stays.
    const { count: deleted } = await prisma.contentCalendar.deleteMany({
      where: { ...unsentLegacy, id: { in: rowIds } },
    });
    const kept = await prisma.contentCalendar.count({ where: { clientId: id, campaignId: null } });

    revalidateAdmin();
    return success({
      deleted,
      filesBinned: filesToBin.length - filesNotBinned,
      filesNotBinned,
      kept,
    });
  } catch (error) {
    return toFailure(error, 'Clearing older calendar days');
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
 * Layout directives ride in every Poster Studio prompt, so an unbounded list is
 * recurring spend rather than a one-off.
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
 * Stores one reference poster against a vertical and reads its elements.
 *
 * **Elements, not a layout.** A campaign poster is a clone of its template with
 * only the words, the photo and the business identity changed, so what an upload
 * needs is the list of those elements — `readTemplateElements`, run here on the
 * stored (downscaled) file at its measured size, so the boxes describe the file
 * that is actually served. The legacy layout reading that used to run here fed
 * only the old code-drawn poster maker, which is retired: its columns
 * (`layoutSpec`, `layoutReading`, `layoutApprovedAt`) are no longer written for a
 * new template.
 *
 * **The read never fails the upload.** The file is already in Drive by this
 * point; refusing the row because a vision call timed out would lose the
 * operator's work to a fault "Try again" on the card fixes in one click. A failed
 * read stores no elements and a short reason in `elementsError`.
 *
 * This makes an upload take ten seconds to a minute longer. The panel sends one
 * file per call and says so while it waits; the vertical page raises its
 * `maxDuration` for the same reason.
 *
 * **No human approval.** An uploaded template is usable as it is.
 */
export async function uploadVerticalTemplate(
  categoryId: string,
  formData: FormData,
): Promise<
  ActionResult<{
    id: string;
    label: string;
    /** "headline · 3 features · logo", or null when the read failed. */
    elementsSummary: string | null;
    elementsError: string | null;
  }>
> {
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

    // Read before the row exists, so the template never appears half-read.
    // Never throws: a failure comes back as a reason to store.
    const reading = await readElementsQuietly({
      bytes: stored.body,
      mimeType: stored.mimeType,
      label,
      width: stored.width,
      height: stored.height,
    });

    const created = await prisma.categoryTemplate.create({
      data: {
        categoryId: id,
        label,
        gDriveFileId: uploaded.fileId,
        gDriveViewUrl: uploaded.viewUrl,
        mimeType: stored.mimeType,
        width: stored.width,
        height: stored.height,
        ...elementsCreateData(reading),
      },
      select: { id: true, label: true },
    });

    revalidateAdmin();

    return success({
      ...created,
      elementsSummary: reading.ok ? reading.summary : null,
      elementsError: reading.ok ? null : reading.error,
    });
  } catch (error) {
    return toFailure(error, 'Uploading template');
  }
}

/**
 * Reads a stored template's elements again, from its file in Drive.
 *
 * Reached from the template card: "Read now" on a template uploaded before
 * elements existed, "Try again" after a failed read, and "Re-read" in the
 * elements dialog, which asks first because a reading is non-deterministic and a
 * new one can differ slightly from the one it replaces.
 *
 * **A failed re-read keeps the reading on file** and records only why — see
 * `elementsUpdateData`. The failure is returned as well, so the card can show it
 * before its refresh lands.
 */
export async function readTemplateElementsAction(
  templateId: string,
): Promise<ActionResult<{ summary: string; count: number }>> {
  try {
    const id = z.string().uuid().parse(templateId);

    const outcome = await refreshTemplateElements(id);
    if (!outcome) return failure('That template no longer exists.');

    revalidateAdmin();

    const { reading } = outcome;
    if (!reading.ok) return failure(reading.error);
    return success({ summary: reading.summary, count: reading.doc.elements.length });
  } catch (error) {
    return toFailure(error, 'Reading template elements');
  }
}

/**
 * Renames a reference template.
 *
 * Uploads derive the name from a filename, which is rarely one worth reading on
 * a campaign board. It stays unique within the vertical so two templates can
 * always be told apart.
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
     * "Grand Opening" and "grand opening" are the same name to anyone reading one.
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
          'Template names are unique within a vertical.',
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

    // The delete would SetNull every campaign day mapped to it, silently
    // discarding those mappings. Deactivating keeps them and flags the days.
    const campaignDays = await countOpenCampaignDaysReferencingTemplate(prisma, id);
    if (campaignDays > 0) {
      return failure(
        `Cannot delete: ${campaignDays} campaign day${campaignDays === 1 ? '' : 's'} ` +
          'still map to this template. Deactivate it instead — those days keep it and ' +
          'are flagged for a replacement — or remap them first.',
      );
    }

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
const describeSkip = describeLogoKeySkip;

/**
 * Downloads a logo we already published, for reprocessing.
 *
 * Deliberately narrow — this is not a general fetcher. The timeout, `image/*`
 * content type and size cap are the shared `fetchLogoUrl` checks, because the
 * same failure modes apply: a Drive link that has lost its sharing grant answers
 * with an HTML interstitial and a 200. Stricter than the renderer in one respect:
 * a response with no content type at all is refused, since the keyer needs it.
 */
async function fetchLogoBytes(
  url: string,
): Promise<{ bytes: Buffer; mimeType: string } | null> {
  try {
    const { bytes, declaredType } = await fetchLogoUrl(url);
    if (!declaredType) return null;
    return { bytes, mimeType: declaredType };
  } catch {
    return null;
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
