'use server';

import { Prisma } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import type { ActionResult } from '@/app/admin/dashboard/actions';
import { LlmError } from '@/lib/ai/openai';
import {
  loadCampaignDayCloneEditor,
  rewriteCampaignDayElements,
  rewriteDraftDays,
  updateCampaignDayElements,
  type CampaignDayCloneEditor,
  type ElementsSaveResult,
  type RewriteDraftsResult,
  type RewriteResult,
} from '@/lib/campaign/clone-editor';
import { loadTemplateEditorScreen, type TemplateEditorLoad } from '@/lib/campaign/clone-editor-screen';
import { editCampaignDayPoster, fixCampaignDayPosterText, MAX_POSTER_CHANGE_LENGTH, type PosterRevisionResult } from '@/lib/campaign/clone-fix';
import { cloneTemplatesIntoCampaign, type CloneIntoQueueResult } from '@/lib/campaign/clone-queue';
import {
  changeCampaignDayTemplate,
  listCampaignDayTemplateChoices,
  type TemplateChangeResult,
  type TemplateChoice,
} from '@/lib/campaign/clone-template-change';
import { queueCampaignPosters, runQueuedCampaignGenerations, type QueueOutcome } from '@/lib/campaign/generation-queue';
import { MAX_CAMPAIGN_DAYS } from '@/lib/campaign/model';
import { CampaignDomainError } from '@/lib/campaign/service';
import { MissingEnvError } from '@/lib/env';
import { prisma } from '@/lib/prisma';
import { MAX_ELEMENT_TEXT } from '@/lib/types/template-elements';

/**
 * Clone-mode campaign actions: filling days with cloned templates, editing and
 * rewriting a day's template elements, and the board's own bulk generation run.
 *
 * Same conventions as `./actions.ts`: parse the wire input, call one service,
 * map failures to operator copy; behind the admin session (`src/middleware.ts`).
 * Only `runNextQueuedPosterAction` generates (one queued poster per call, through
 * the unchanged generation gate); the rewrite actions make one cheap text call
 * per day; nothing here sends anything.
 */

const uuid = z.string().uuid();

function revalidateAdmin(): void {
  revalidatePath('/admin', 'layout');
}

function toFailure(error: unknown, context: string): ActionResult<never> {
  if (error instanceof CampaignDomainError) return { ok: false, error: error.message };
  if (error instanceof LlmError) return { ok: false, error: error.message };
  if (error instanceof MissingEnvError) return { ok: false, error: `The server is missing required configuration (${error.key}).` };
  if (error instanceof z.ZodError) return { ok: false, error: error.issues[0]?.message ?? 'The request was not valid.' };
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
    return { ok: false, error: 'That record no longer exists.' };
  }
  console.error(`[campaign:clone-action] ${context} failed:`, error);
  return { ok: false, error: `${context} failed. Check the server logs for details.` };
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

/** The editor view with dates as ISO strings, for the browser. */
export type CampaignDayCloneEditorView = Omit<CampaignDayCloneEditor, 'day' | 'generation'> & {
  day: Omit<CampaignDayCloneEditor['day'], 'scheduledDate'> & { scheduledDate: string };
  generation: Omit<CampaignDayCloneEditor['generation'], 'startedAt'> & { startedAt: string | null };
};

export async function loadCampaignDayCloneEditorAction(dayId: string): Promise<ActionResult<CampaignDayCloneEditorView>> {
  try {
    const editor = await loadCampaignDayCloneEditor(prisma, uuid.parse(dayId));
    return {
      ok: true,
      data: {
        ...editor,
        day: { ...editor.day, scheduledDate: editor.day.scheduledDate.toISOString() },
        generation: { ...editor.generation, startedAt: editor.generation.startedAt?.toISOString() ?? null },
      },
    };
  } catch (error) {
    return toFailure(error, 'Loading the poster');
  }
}

const elementsInputSchema = z.object({
  values: z
    .array(
      z.object({
        id: z.string().regex(/^e\d{1,3}$/, 'Unknown element.'),
        // The service trims and caps; this only bounds the payload.
        text: z.string().max(MAX_ELEMENT_TEXT * 4).nullable().optional(),
        removed: z.boolean().optional(),
      }),
    )
    .max(80)
    .optional(),
  imagePrompt: z.string().max(16_000).optional(),
});

export async function updateCampaignDayElementsAction(
  dayId: string,
  input: z.input<typeof elementsInputSchema>,
  expectedRevision: number,
): Promise<ActionResult<Omit<ElementsSaveResult, 'elements'>>> {
  try {
    const result = await updateCampaignDayElements(prisma, uuid.parse(dayId), elementsInputSchema.parse(input), {
      expectedRevision: z.number().int().min(1).parse(expectedRevision),
    });
    // No revalidation: this is the editor's autosave, and revalidating would re-render the whole editor route inside
    // every save's response. The editor keeps its own state from this result and refreshes the router when left.
    return { ok: true, data: { changed: result.changed, revisionBumped: result.revisionBumped, contentRevision: result.contentRevision } };
  } catch (error) {
    return toFailure(error, 'Saving the poster');
  }
}

export async function rewriteCampaignDayElementsAction(
  dayId: string,
): Promise<ActionResult<Pick<RewriteResult, 'rewritten' | 'kept' | 'contentRevision' | 'revisionBumped'>>> {
  try {
    const result = await rewriteCampaignDayElements(prisma, uuid.parse(dayId));
    revalidateAdmin();
    return { ok: true, data: { rewritten: result.rewritten, kept: result.kept, contentRevision: result.contentRevision, revisionBumped: result.revisionBumped } };
  } catch (error) {
    return toFailure(error, 'Rewriting the poster');
  }
}

export async function rewriteDraftDaysAction(campaignId: string, dayIds: string[]): Promise<ActionResult<RewriteDraftsResult>> {
  try {
    const ids = z.array(uuid).min(1, 'Select at least one day.').max(MAX_CAMPAIGN_DAYS).parse(dayIds);
    const result = await rewriteDraftDays(prisma, uuid.parse(campaignId), ids);
    revalidateAdmin();
    return { ok: true, data: result };
  } catch (error) {
    return toFailure(error, 'Rewriting the drafts');
  }
}

// ---------------------------------------------------------------------------
// Filling days
// ---------------------------------------------------------------------------

/** "Fill empty days": clone the vertical's read templates into days with no poster. No AI call. */
export async function cloneTemplatesIntoCampaignAction(campaignId: string): Promise<ActionResult<CloneIntoQueueResult>> {
  try {
    const result = await cloneTemplatesIntoCampaign(prisma, uuid.parse(campaignId));
    revalidateAdmin();
    return { ok: true, data: result };
  } catch (error) {
    return toFailure(error, 'Filling the empty days');
  }
}

// ---------------------------------------------------------------------------
// Bulk generation through the queue
// ---------------------------------------------------------------------------

/**
 * Queues the listed days (the posts in view) for generation and returns at
 * once. Spends nothing: the board then drives the queue with
 * `runNextQueuedPosterAction`, and the cron sweep drains whatever is left.
 */
export async function queueCampaignDayPostersAction(campaignId: string, dayIds: string[]): Promise<ActionResult<QueueOutcome>> {
  try {
    const ids = z.array(uuid).min(1, 'Select at least one day.').max(MAX_CAMPAIGN_DAYS).parse(dayIds);
    const outcome = await queueCampaignPosters(prisma, uuid.parse(campaignId), { mode: 'missing', dayIds: ids });
    revalidateAdmin();
    return { ok: true, data: outcome };
  } catch (error) {
    return toFailure(error, 'Queueing the posters');
  }
}

export interface NextQueuedPosterResult {
  /** `idle`: nothing of this campaign was waiting. */
  outcome: 'generated' | 'failed' | 'skipped' | 'idle';
  dayNumber: number | null;
  message: string;
  /** This campaign's days still QUEUED after this call. */
  remaining: number;
  /** A configuration, credential or billing failure: every later poster would fail the same way. */
  stopped: boolean;
}

/**
 * Generates ONE queued poster of this campaign — the oldest slot first — with
 * the queue worker's own claim, gate and pipeline, and says how many are left.
 * The board calls it repeatedly while it is open, so a bulk run shows progress
 * and can be stopped between posters; the cron sweep takes over if the tab
 * closes. Each call can take a few minutes (a high-quality clone).
 */
export async function runNextQueuedPosterAction(campaignId: string): Promise<ActionResult<NextQueuedPosterResult>> {
  try {
    const id = uuid.parse(campaignId);
    const sweep = await runQueuedCampaignGenerations(prisma, { campaignId: id, limit: 1, concurrency: 1 });
    const remaining = await prisma.contentCalendar.count({ where: { campaignId: id, generationStatus: 'QUEUED' } });
    if (sweep.generated.length + sweep.failed.length + sweep.skipped.length > 0) revalidateAdmin();

    const generated = sweep.generated[0];
    const failed = sweep.failed[0];
    const skipped = sweep.skipped[0];
    const data: NextQueuedPosterResult = generated
      ? { outcome: 'generated', dayNumber: generated.dayNumber, message: `Day ${generated.dayNumber} generated.`, remaining, stopped: false }
      : failed
        ? { outcome: 'failed', dayNumber: failed.dayNumber, message: failed.message, remaining, stopped: sweep.stopped }
        : skipped
          ? { outcome: 'skipped', dayNumber: skipped.dayNumber, message: skipped.message, remaining, stopped: false }
          : { outcome: 'idle', dayNumber: null, message: 'Nothing is waiting to be generated.', remaining, stopped: false };
    return { ok: true, data };
  } catch (error) {
    return toFailure(error, 'Generating the next poster');
  }
}

// ---------------------------------------------------------------------------
// Template poster editor (Poster Studio)
// ---------------------------------------------------------------------------

/**
 * The template poster editor's whole view of one day, for its reloads: after a
 * save conflict, after an action, and every few seconds while a poster is being
 * made. Read-only.
 */
export async function loadTemplateEditorScreenAction(dayId: string): Promise<ActionResult<TemplateEditorLoad>> {
  try {
    return { ok: true, data: await loadTemplateEditorScreen(prisma, uuid.parse(dayId)) };
  } catch (error) {
    return toFailure(error, 'Loading the poster');
  }
}

/** The vertical's active, read templates this day may switch to. Read-only. */
export async function listCampaignDayTemplateChoicesAction(dayId: string): Promise<ActionResult<TemplateChoice[]>> {
  try {
    return { ok: true, data: await listCampaignDayTemplateChoices(prisma, uuid.parse(dayId)) };
  } catch (error) {
    return toFailure(error, 'Loading the templates');
  }
}

/**
 * Re-clones the day from another template: its words are replaced by the new
 * template's, and an existing poster becomes outdated. No AI call.
 */
export async function changeCampaignDayTemplateAction(
  dayId: string,
  templateId: string,
  expectedRevision: number,
): Promise<ActionResult<TemplateChangeResult>> {
  try {
    const result = await changeCampaignDayTemplate(prisma, uuid.parse(dayId), uuid.parse(templateId), {
      expectedRevision: z.number().int().min(1).parse(expectedRevision),
    });
    if (result.changed) revalidateAdmin();
    return { ok: true, data: result };
  } catch (error) {
    return toFailure(error, 'Changing the template');
  }
}

/**
 * "Fix text": one high-quality image edit of the active poster that corrects
 * only what its text check found wrong, saved as a new version. Takes about as
 * long as a generation.
 */
export async function fixCampaignDayPosterTextAction(dayId: string): Promise<ActionResult<PosterRevisionResult>> {
  try {
    const result = await fixCampaignDayPosterText(prisma, uuid.parse(dayId));
    revalidateAdmin();
    return { ok: true, data: result };
  } catch (error) {
    return toFailure(error, 'Fixing the text');
  }
}

/** "Small change": one admin instruction applied to the active poster, saved as a new version. */
export async function editCampaignDayPosterAction(dayId: string, instruction: string): Promise<ActionResult<PosterRevisionResult>> {
  try {
    const text = z.string().max(MAX_POSTER_CHANGE_LENGTH * 4, 'Describe one change at a time.').parse(instruction);
    const result = await editCampaignDayPoster(prisma, uuid.parse(dayId), text);
    revalidateAdmin();
    return { ok: true, data: result };
  } catch (error) {
    return toFailure(error, 'Changing the poster');
  }
}
