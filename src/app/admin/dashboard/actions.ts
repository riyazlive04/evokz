'use server';

import { Prisma } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { describeError, runCreativePipeline } from '@/lib/ai-pipeline';
import { tokenizeClientBrand } from '@/lib/ai/brand-tokenizer';
import { generateContentCalendar } from '@/lib/ai/calendar-generator';
import { applyCalendarImport, type CalendarImportResult } from '@/lib/calendar-import';
import type { CalendarImportInput } from '@/lib/calendar-parse';
import { trashDriveFile, uploadClientAsset } from '@/lib/google-drive';
import { isImageSizePresetId } from '@/lib/image-sizes';
import {
  clientProvisionSchema,
  provisionClient,
  repairClientDriveFolder,
} from '@/lib/onboarding';
import { prisma } from '@/lib/prisma';
import { HH_MM_PATTERN } from '@/lib/time';

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

    await prisma.category.delete({ where: { id: categoryId } });
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
): Promise<ActionResult<{ logoUrl: string }>> {
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
      select: { gDriveFolderId: true, logoDriveFileId: true },
    });
    if (!client) return failure('That client no longer exists.');
    if (!client.gDriveFolderId) {
      return failure(
        'This client has no Drive folder yet. Repair the Drive folder first, then upload the logo.',
      );
    }

    const uploaded = await uploadClientAsset({
      folderId: client.gDriveFolderId,
      fileName: `Brand_Logo${logoExtension(file.type)}`,
      body: Buffer.from(await file.arrayBuffer()),
      mimeType: file.type,
    });

    await prisma.client.update({
      where: { id },
      data: { logoUrl: uploaded.viewUrl, logoDriveFileId: uploaded.fileId },
    });

    // After the row is updated, so a failure here cannot leave the client
    // pointing at a file that has just been binned.
    if (client.logoDriveFileId && client.logoDriveFileId !== uploaded.fileId) {
      await trashDriveFile(client.logoDriveFileId);
    }

    revalidateAdmin();
    return success({ logoUrl: uploaded.viewUrl });
  } catch (error) {
    return toFailure(error, 'Uploading logo');
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
      select: { logoDriveFileId: true },
    });
    if (!client) return failure('That client no longer exists.');

    await prisma.client.update({
      where: { id },
      // The Drive file id is dropped too: it no longer describes where the logo
      // lives, and keeping it would make a later re-upload trash an unrelated file.
      data: { logoUrl: parsed, logoDriveFileId: null },
    });

    if (client.logoDriveFileId) {
      await trashDriveFile(client.logoDriveFileId);
    }

    revalidateAdmin();
    return success();
  } catch (error) {
    return toFailure(error, 'Updating logo');
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
