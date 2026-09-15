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
  createCampaign,
  markCampaignDayContentReviewed,
  updateCampaignDayContent,
  type CampaignDayContentPatch,
  type DayEditResult,
} from '@/lib/campaign/service';
import { prisma } from '@/lib/prisma';

/**
 * Campaign calendar actions (Phase 2: content only).
 *
 * Thin wrappers over `src/lib/campaign`: parse the wire input, call one service,
 * map failures to operator copy. Behind the admin session like every other
 * action (`src/middleware.ts` gates `/admin/*`, which is where these POST).
 *
 * None of these renders a poster, maps a template, touches a poster version or
 * sends anything. The legacy calendar tools refuse campaign clients
 * (src/lib/calendar-scope.ts) — these are the campaign-specific actions that
 * explicitly target campaign days.
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
