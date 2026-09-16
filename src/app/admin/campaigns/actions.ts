'use server';

import { Prisma } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import type { ActionResult } from '@/app/admin/dashboard/actions';
import { LlmError } from '@/lib/ai/openai';
import {
  generateCampaignContent,
  regenerateCampaignDayContent,
  type ContentChunkReport,
  type GenerateCampaignContentResult,
} from '@/lib/campaign/content-generation';
import { parseContentStrategyText } from '@/lib/campaign/content-strategy';
import {
  CampaignDomainError,
  changeCampaignStatus,
  createCampaign,
  markCampaignDayContentReviewed,
  updateCampaignDayContent,
  type CampaignDayContentPatch,
  type DayEditResult,
} from '@/lib/campaign/service';
import {
  approveCampaignDayPoster,
  generateCampaignDayPoster,
  loadPosterOverview,
  planPosterBatch,
  saveStudioPosterToCampaignDay,
  type GenerateDayPosterResult,
  type PosterBatchPlan,
} from '@/lib/campaign/poster-generation-service';
import { MAX_REJECTION_DETAIL } from '@/lib/campaign/review';
import {
  approveCampaignDayPosters,
  loadCampaignDayReview,
  rejectCampaignDayPoster,
  type BulkApprovalResult,
} from '@/lib/campaign/review-service';
import type { AutoMapOutcome, MappingSource } from '@/lib/campaign/template-mapping';
import {
  applyAutoMap,
  assignManualTemplates,
  changeTemplateMappingMode,
  previewAutoMap,
  setTemplateActive,
  setTemplateContentTypes,
  type ManualMappingResult,
} from '@/lib/campaign/template-mapping-service';
import { prisma } from '@/lib/prisma';

/**
 * Campaign calendar actions (Phase 2 content, Phase 3 template mapping, Phase 4
 * rolling poster generation, Phase 5 review and approval).
 *
 * Thin wrappers over `src/lib/campaign`: parse the wire input, call one service,
 * map failures to operator copy. Behind the admin session like every other
 * action (`src/middleware.ts` gates `/admin/*`, which is where these POST).
 *
 * Only the Phase 4 poster actions render posters or write poster versions, and
 * none of these sends anything. The legacy calendar tools refuse campaign
 * clients (src/lib/calendar-scope.ts) — these are the campaign-specific actions
 * that explicitly target campaign days.
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
  templateMappingMode: z.enum(['AUTO', 'MANUAL']),
});

export async function createCampaignAction(
  clientId: string,
  input: z.input<typeof createInputSchema>,
): Promise<ActionResult<{ campaignId: string; dayCount: number }>> {
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
    revalidateAdmin();
    return { ok: true, data: { campaignId: result.campaignId, dayCount: result.dayCount } };
  } catch (error) {
    return toFailure(error, 'Creating the campaign');
  }
}

const generateInputSchema = z.object({
  fromDay: z.number().int().min(1),
  toDay: z.number().int().min(1),
  mode: z.enum(['missing', 'overwrite']),
});

/**
 * Generates content for at most ONE chunk (30 days) of the range and returns
 * where to continue. The calendar calls it repeatedly, so a long campaign is a
 * series of short requests: each shows progress, each is saved as it lands, and
 * a failure costs one chunk.
 */
export async function generateCampaignContentAction(
  campaignId: string,
  input: z.input<typeof generateInputSchema>,
): Promise<ActionResult<GenerateCampaignContentResult>> {
  try {
    const data = generateInputSchema.parse(input);
    const result = await generateCampaignContent(prisma, uuid.parse(campaignId), { ...data, maxChunks: 1 });
    revalidateAdmin();
    return { ok: true, data: result };
  } catch (error) {
    return toFailure(error, 'Generating content');
  }
}

export async function regenerateCampaignDayAction(dayId: string): Promise<ActionResult<ContentChunkReport>> {
  try {
    const report = await regenerateCampaignDayContent(prisma, uuid.parse(dayId));
    revalidateAdmin();
    if (report.error) return failure(report.error);
    if (report.written.length === 0) {
      return failure(
        report.changedMeanwhile.length > 0
          ? 'The day was edited while its content was being written, so the edit was kept.'
          : 'The model returned no usable content for this day. Try again.',
      );
    }
    return { ok: true, data: report };
  } catch (error) {
    return toFailure(error, 'Regenerating the day');
  }
}

export async function updateCampaignDayAction(
  dayId: string,
  patch: CampaignDayContentPatch,
  expectedRevision: number,
): Promise<ActionResult<DayEditResult>> {
  try {
    const result = await updateCampaignDayContent(prisma, uuid.parse(dayId), patch, {
      expectedRevision: z.number().int().min(1).parse(expectedRevision),
    });
    revalidateAdmin();
    return { ok: true, data: result };
  } catch (error) {
    return toFailure(error, 'Saving the day');
  }
}

export async function markCampaignDayReviewedAction(dayId: string): Promise<ActionResult> {
  try {
    await markCampaignDayContentReviewed(prisma, uuid.parse(dayId));
    revalidateAdmin();
    return { ok: true, data: undefined };
  } catch (error) {
    return toFailure(error, 'Marking the day reviewed');
  }
}

/** Saves a vertical's content strategy from the editor's text. Empty text restores the default. */
export async function saveVerticalContentStrategyAction(
  categoryId: string,
  text: string,
): Promise<ActionResult<{ pillars: number; usesDefault: boolean }>> {
  try {
    const id = uuid.parse(categoryId);
    const trimmed = z.string().max(20_000).parse(text).trim();

    if (!trimmed) {
      await prisma.category.update({ where: { id }, data: { contentStrategy: Prisma.DbNull } });
      revalidateAdmin();
      return { ok: true, data: { pillars: 0, usesDefault: true } };
    }

    const parsed = parseContentStrategyText(trimmed);
    if (!parsed.strategy) return failure(parsed.errors.slice(0, 3).join(' '));

    await prisma.category.update({
      where: { id },
      data: { contentStrategy: parsed.strategy as unknown as Prisma.InputJsonValue },
    });
    revalidateAdmin();
    return { ok: true, data: { pillars: parsed.strategy.pillars.length, usesDefault: false } };
  } catch (error) {
    return toFailure(error, 'Saving the content strategy');
  }
}

// ---------------------------------------------------------------------------
// Template mapping (Phase 3). Maps templates to days; never generates a poster.
// ---------------------------------------------------------------------------

const scopeSchema = z.enum(['fill', 'rebalance']);

export interface AutoMapPreviewEntry {
  dayNumber: number;
  outcome: AutoMapOutcome;
  currentTemplateId: string | null;
  currentSource: MappingSource | null;
  templateId: string | null;
  conflict: { title: string; detail: string } | null;
  replacementTemplateId: string | null;
  unmappedReason: string | null;
  repeatsPreviousDay: boolean;
}

export interface AutoMapPreview {
  scope: 'fill' | 'rebalance';
  switchesMode: boolean;
  fingerprint: string;
  counts: Record<AutoMapOutcome, number> & { conflicts: number; changes: number };
  entries: AutoMapPreviewEntry[];
}

/** What Auto Map would do. Writes nothing. */
export async function previewAutoMapAction(
  campaignId: string,
  scope: 'fill' | 'rebalance',
): Promise<ActionResult<AutoMapPreview>> {
  try {
    const { plan } = await previewAutoMap(prisma, uuid.parse(campaignId), { scope: scopeSchema.parse(scope) });
    return {
      ok: true,
      data: {
        scope: plan.scope,
        switchesMode: plan.switchesMode,
        fingerprint: plan.fingerprint,
        counts: plan.counts,
        entries: plan.entries.map((entry) => ({
          dayNumber: entry.dayNumber,
          outcome: entry.outcome,
          currentTemplateId: entry.currentTemplateId,
          currentSource: entry.currentSource,
          templateId: entry.templateId,
          conflict: entry.conflict ? { title: entry.conflict.title, detail: entry.conflict.detail } : null,
          replacementTemplateId: entry.replacementTemplateId,
          unmappedReason: entry.unmappedReason?.detail ?? null,
          repeatsPreviousDay: entry.repeatsPreviousDay,
        })),
      },
    };
  } catch (error) {
    return toFailure(error, 'Previewing Auto Map');
  }
}

/** Applies the previewed plan, refused if the campaign changed since the preview. */
export async function applyAutoMapAction(
  campaignId: string,
  input: { scope: 'fill' | 'rebalance'; fingerprint: string },
): Promise<ActionResult<{ daysWritten: number; revisionsBumped: number; switchedToAuto: boolean }>> {
  try {
    const result = await applyAutoMap(prisma, uuid.parse(campaignId), {
      scope: scopeSchema.parse(input.scope),
      fingerprint: z.string().min(1).max(64).parse(input.fingerprint),
    });
    revalidateAdmin();
    return {
      ok: true,
      data: { daysWritten: result.daysWritten, revisionsBumped: result.revisionsBumped, switchedToAuto: result.switchedToAuto },
    };
  } catch (error) {
    return toFailure(error, 'Applying Auto Map');
  }
}

const dayNumberSchema = z.number().int().min(1).max(730);
const templateIdSchema = uuid.nullable();

const assignmentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('days'), dayNumbers: z.array(dayNumberSchema).min(1).max(730), templateId: templateIdSchema }),
  z.object({ kind: z.literal('range'), fromDay: dayNumberSchema, toDay: dayNumberSchema, templateId: templateIdSchema }),
  z.object({ kind: z.literal('pattern'), fromDay: dayNumberSchema, toDay: dayNumberSchema, templateIds: z.array(uuid).min(1).max(50) }),
]);

/** Manual mapping: one day, a selection, a range or a repeating pattern. Clears with a null template. */
export async function assignCampaignTemplatesAction(
  campaignId: string,
  assignment: z.input<typeof assignmentSchema>,
  options: { skipManual?: boolean } = {},
): Promise<ActionResult<ManualMappingResult>> {
  try {
    const result = await assignManualTemplates(prisma, uuid.parse(campaignId), assignmentSchema.parse(assignment), {
      skipManual: z.boolean().optional().parse(options.skipManual),
    });
    revalidateAdmin();
    return { ok: true, data: result };
  } catch (error) {
    return toFailure(error, 'Mapping templates');
  }
}

export async function changeTemplateMappingModeAction(
  campaignId: string,
  mode: 'AUTO' | 'MANUAL',
): Promise<ActionResult<{ changed: boolean; daysAffected: number }>> {
  try {
    const result = await changeTemplateMappingMode(prisma, uuid.parse(campaignId), z.enum(['AUTO', 'MANUAL']).parse(mode));
    revalidateAdmin();
    return { ok: true, data: result };
  } catch (error) {
    return toFailure(error, 'Changing the mapping mode');
  }
}

/** Retires or restores a template for campaign mapping. Mapped days keep it and are flagged. */
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

export async function setTemplateContentTypesAction(
  templateId: string,
  contentTypes: string[],
): Promise<ActionResult<{ contentTypes: string[] }>> {
  try {
    const result = await setTemplateContentTypes(prisma, uuid.parse(templateId), z.array(z.string().max(40)).max(20).parse(contentTypes));
    revalidateAdmin();
    return { ok: true, data: result };
  } catch (error) {
    return toFailure(error, 'Saving the template content types');
  }
}

// ---------------------------------------------------------------------------
// Rolling poster generation (Phase 4). Generates posters; never sends anything.
// ---------------------------------------------------------------------------

const posterModeSchema = z.enum(['missing', 'upcoming', 'regenerate']);
const batchRequestSchema = z.object({
  mode: posterModeSchema,
  fromDay: z.number().int().min(1).max(730).optional(),
  toDay: z.number().int().min(1).max(730).optional(),
});

/**
 * What a batch would generate, and why every other day in scope would not.
 * Writes nothing and calls no provider — it is the confirmation's data.
 */
export async function planPosterBatchAction(
  campaignId: string,
  request: z.input<typeof batchRequestSchema>,
): Promise<ActionResult<PosterBatchPlan>> {
  try {
    const overview = await loadPosterOverview(prisma, uuid.parse(campaignId));
    return { ok: true, data: planPosterBatch(overview, batchRequestSchema.parse(request)) };
  } catch (error) {
    return toFailure(error, 'Planning poster generation');
  }
}

/**
 * Generates ONE day's poster if it is eligible now. The calendar calls it once
 * per day in sequence, so a batch shows progress, can be stopped between days,
 * and keeps every poster already made if the tab closes.
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

export async function approveCampaignDayPosterAction(dayId: string, versionId: string): Promise<ActionResult> {
  try {
    await approveCampaignDayPoster(prisma, uuid.parse(dayId), uuid.parse(versionId));
    revalidateAdmin();
    return { ok: true, data: undefined };
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

/** Activate, pause or resume a campaign. Activating sends nothing — delivery is not wired to campaigns. */
export async function changeCampaignStatusAction(
  campaignId: string,
  status: 'ACTIVE' | 'PAUSED',
): Promise<ActionResult<{ from: string; to: string }>> {
  try {
    const result = await changeCampaignStatus(prisma, uuid.parse(campaignId), z.enum(['ACTIVE', 'PAUSED']).parse(status));
    revalidateAdmin();
    return { ok: true, data: result };
  } catch (error) {
    return toFailure(error, 'Changing the campaign status');
  }
}

// ---------------------------------------------------------------------------
// Review and approval (Phase 5). Reviews posters; never sends or deletes anything.
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
): Promise<ActionResult<BulkApprovalResult>> {
  try {
    const ids = z.array(uuid).min(1, 'Select at least one day.').max(730).parse(dayIds);
    const result = await approveCampaignDayPosters(prisma, uuid.parse(campaignId), ids);
    revalidateAdmin();
    return { ok: true, data: result };
  } catch (error) {
    return toFailure(error, 'Approving the selected posters');
  }
}

/** One day's content, template, poster and version history — the review detail. */
export async function loadCampaignDayReviewAction(dayId: string) {
  try {
    const detail = await loadCampaignDayReview(prisma, uuid.parse(dayId));
    return {
      ok: true as const,
      data: {
        ...detail,
        scheduledDate: detail.scheduledDate.toISOString(),
        versions: detail.versions.map((version) => ({
          ...version,
          createdAt: version.createdAt.toISOString(),
          reviewedAt: version.reviewedAt?.toISOString() ?? null,
        })),
      },
    };
  } catch (error) {
    return toFailure(error, 'Loading the day');
  }
}
