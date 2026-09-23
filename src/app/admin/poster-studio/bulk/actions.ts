'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { CampaignDomainError } from '@/lib/campaign/service';
import { parseBatchSheet } from '@/lib/poster-studio/batch-sheet';
import {
  cancelStudioBatch,
  createStudioBatch,
  customizeBatchItem,
  deleteDraftStudioBatch,
  pauseStudioBatch,
  resumeStudioBatch,
  retryStudioBatch,
  runNextBatchItem,
  startStudioBatch,
  StudioBatchError,
  type BatchItemOutcome,
  type ExcludedRow,
} from '@/lib/poster-studio/batch-service';
import { loadStudioBatchView, type BatchView } from '@/lib/poster-studio/batch-view';
import { STUDIO_FESTIVAL_KEYS, type StudioFestivalKey } from '@/lib/poster-studio/festivals';
import { STUDIO_ASPECT_RATIO_KEYS, STUDIO_QUALITIES, type StudioAspectRatio } from '@/lib/poster-studio/limits';
import { prisma } from '@/lib/prisma';

/**
 * Server Actions for bulk Poster Studio runs (/admin/poster-studio/bulk).
 *
 * Behind the admin session like every `/admin/*` route. Each returns a result
 * rather than throwing: an unhandled rejection reaches the browser as a digest.
 */

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

const uuid = z.string().uuid();
const optionalUuid = z
  .string()
  .trim()
  .transform((value) => value || null)
  .pipe(z.string().uuid().nullable());
const festival = z.union([z.literal(''), z.enum(STUDIO_FESTIVAL_KEYS as [StudioFestivalKey, ...StudioFestivalKey[]])]).transform((value) => value || null);
const quality = z.union([z.literal(''), z.enum(STUDIO_QUALITIES)]).transform((value) => value || null);
const aspectRatio = z.enum(STUDIO_ASPECT_RATIO_KEYS as [StudioAspectRatio, ...StudioAspectRatio[]]);

function failure(error: unknown, context: string): { ok: false; error: string } {
  if (error instanceof StudioBatchError || error instanceof CampaignDomainError) return { ok: false, error: error.message };
  if (error instanceof z.ZodError) return { ok: false, error: error.issues[0]?.message ?? 'The request was not valid.' };
  console.error(`[studio-batch:action] ${context}`, error);
  return { ok: false, error: `${context} failed. The details are in the server log.` };
}

function refresh(batchId?: string) {
  try {
    revalidatePath('/admin/poster-studio/bulk');
    if (batchId) revalidatePath(`/admin/poster-studio/bulk/${batchId}`);
  } catch {
    /* outside a request */
  }
}

const createSchema = z.object({
  name: z.string().trim().max(120),
  target: z.enum(['STUDIO', 'CAMPAIGN']),
  clientId: optionalUuid,
  campaignId: optionalUuid,
  aspectRatio,
  quality,
  festival,
  textFree: z.enum(['0', '1']).transform((value) => value === '1'),
  brandIdentity: z.enum(['0', '1']).transform((value) => value === '1'),
});

export type CreateBatchActionResult = Result<{
  batchId: string;
  created: number;
  excluded: ExcludedRow[];
  /** Rows the sheet itself got wrong; they were left out. */
  sheetProblems: string[];
}>;

/** Reads the uploaded sheet and writes a DRAFT batch. Spends nothing. */
export async function createStudioBatchAction(formData: FormData): Promise<CreateBatchActionResult> {
  try {
    const field = (name: string) => {
      const value = formData.get(name);
      return typeof value === 'string' ? value : '';
    };
    const input = createSchema.parse({
      name: field('name'),
      target: field('target'),
      clientId: field('clientId'),
      campaignId: field('campaignId'),
      aspectRatio: field('aspectRatio'),
      quality: field('quality'),
      festival: field('festival'),
      textFree: field('textFree') || '0',
      brandIdentity: field('brandIdentity') || '0',
    });
    const file = formData.get('file');
    if (!(file instanceof File) || file.size === 0) return { ok: false, error: 'Choose the Excel (.xlsx) or .csv file to upload.' };

    const sheet = await parseBatchSheet(Buffer.from(await file.arrayBuffer()), file.name);
    const sheetProblems = sheet.problems.map((problem) => problem.message);
    if (sheet.rows.length === 0) return { ok: false, error: sheetProblems.join(' ') || 'The sheet has no rows.' };

    const created = await createStudioBatch(prisma, {
      name: input.name,
      target: input.target,
      clientId: input.target === 'STUDIO' ? input.clientId : null,
      campaignId: input.target === 'CAMPAIGN' ? input.campaignId : null,
      defaults: { aspectRatio: input.aspectRatio, quality: input.quality, festival: input.festival, textFree: input.textFree },
      brandIdentity: input.brandIdentity,
      fileName: file.name.slice(0, 200),
      rows: sheet.rows,
    });
    refresh();
    return { ok: true, ...created, sheetProblems };
  } catch (error) {
    return failure(error, 'Creating the batch');
  }
}

async function withView<T extends object>(batchId: string, run: () => Promise<T>, context: string): Promise<Result<T & { view: BatchView | null }>> {
  try {
    const id = uuid.parse(batchId);
    const result = await run();
    refresh(id);
    return { ok: true, ...result, view: await loadStudioBatchView(prisma, id) };
  } catch (error) {
    return failure(error, context);
  }
}

export async function startStudioBatchAction(batchId: string) {
  return withView(batchId, () => startStudioBatch(prisma, batchId), 'Starting the batch');
}

export async function pauseStudioBatchAction(batchId: string) {
  return withView(batchId, async () => (await pauseStudioBatch(prisma, batchId), {}), 'Pausing the batch');
}

export async function resumeStudioBatchAction(batchId: string) {
  return withView(batchId, async () => (await resumeStudioBatch(prisma, batchId), {}), 'Resuming the batch');
}

export async function cancelStudioBatchAction(batchId: string) {
  return withView(batchId, () => cancelStudioBatch(prisma, batchId), 'Cancelling the batch');
}

export async function retryStudioBatchAction(batchId: string) {
  return withView(batchId, () => retryStudioBatch(prisma, batchId), 'Retrying failed rows');
}

export async function loadStudioBatchViewAction(batchId: string) {
  return withView(batchId, async () => ({}), 'Loading the batch');
}

export async function deleteDraftStudioBatchAction(batchId: string): Promise<Result<object>> {
  try {
    await deleteDraftStudioBatch(prisma, uuid.parse(batchId));
    refresh();
    return { ok: true };
  } catch (error) {
    return failure(error, 'Discarding the draft');
  }
}

const itemSettingsSchema = z.object({
  prompt: z.string().trim().min(3, 'The prompt needs at least 3 characters.').max(4000),
  aspectRatio,
  festival: z.enum(STUDIO_FESTIVAL_KEYS as [StudioFestivalKey, ...StudioFestivalKey[]]).nullable(),
  textFree: z.boolean(),
  quality: z.enum(STUDIO_QUALITIES).nullable(),
});

/** Customize one row: free in a draft; after the start it queues the row to be made again. */
export async function customizeBatchItemAction(batchId: string, itemId: string, settings: unknown) {
  return withView(
    batchId,
    async () => {
      const item = await prisma.posterStudioBatchItem.findUnique({ where: { id: uuid.parse(itemId) }, select: { batchId: true } });
      if (!item || item.batchId !== batchId) throw new StudioBatchError('That row is not part of this batch.');
      return customizeBatchItem(prisma, itemId, itemSettingsSchema.parse(settings));
    },
    'Customizing the row',
  );
}

/**
 * The open page's worker: makes the next row of this batch (about a minute) and
 * returns what happened with the refreshed batch. Null outcome: nothing is left
 * to claim.
 */
export async function runNextBatchItemAction(batchId: string): Promise<Result<{ outcome: BatchItemOutcome | null; view: BatchView | null }>> {
  try {
    const id = uuid.parse(batchId);
    const outcome = await runNextBatchItem(prisma, id);
    return { ok: true, outcome, view: await loadStudioBatchView(prisma, id) };
  } catch (error) {
    return failure(error, 'Generating the next row');
  }
}
