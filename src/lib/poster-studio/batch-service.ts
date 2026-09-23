import type {
  PosterGenerationStatus,
  PosterStudioBatch,
  PosterStudioBatchItem,
  PosterStudioBatchStatus,
  PosterStudioBatchTarget,
} from '@prisma/client';

import { SLOT_LOCK_LABELS, slotLockOf } from '@/lib/campaign/board';
import { campaignAllowsChanges } from '@/lib/campaign/model';
import { STALE_GENERATION_MS } from '@/lib/campaign/poster-generation';
import { dayPosterShape, saveStudioPosterToCampaignDay } from '@/lib/campaign/poster-generation-service';
import { CampaignDomainError, type CampaignDb } from '@/lib/campaign/service';
import { intEnv } from '@/lib/env';
import { getRateCard, isOpenAiImagePricingConfigured, priceOpenAiImageCall } from '@/lib/pricing';
import { loadStudioBrandCanvas, summarizeStudioBrandCanvas, type StudioBrandCanvasSummary } from '@/lib/poster-studio/brand-context';
import type { BatchSheetRow } from '@/lib/poster-studio/batch-sheet';
import { findStudioFestival } from '@/lib/poster-studio/festivals';
import { generateStudioPoster, NO_SOURCE, type StudioGenerateResult, type StudioGenerationRequest } from '@/lib/poster-studio/generate';
import type { StudioErrorKind } from '@/lib/poster-studio/errors';
import {
  STUDIO_ASPECT_RATIO_KEYS,
  STUDIO_QUALITIES,
  type StudioAspectRatio,
  type StudioOverlayElement,
  type StudioQuality,
} from '@/lib/poster-studio/limits';
import { getAppTimeZone } from '@/lib/time';

/**
 * Bulk Poster Studio: one spreadsheet of Day + Prompt rows, one image per row.
 *
 * **The queue is the item's `PosterGenerationStatus`**, as it is for campaign
 * days (`src/lib/campaign/generation-queue.ts`): NOT_REQUESTED while the batch
 * is a draft, QUEUED when it is waiting for a worker, GENERATING with
 * `startedAt` as the claim token, then SUCCEEDED or FAILED. Two workers drain
 * it — the open batch page, one item per request, and the cron sweep when the
 * page is closed — and the conditional claim means they never take the same
 * row. A claim older than `STALE_GENERATION_MS` is reclaimable, so a crashed
 * worker's row is picked up again.
 *
 * Each item is made by `generateStudioPoster`, the studio's own pipeline, with
 * no input image: prompt only. A CAMPAIGN batch then saves the image to its day
 * through `saveStudioPosterToCampaignDay`, exactly as Save to Day does, so it
 * lands as a new POSTER_STUDIO version waiting for review.
 *
 * Nothing retries on its own after a billed failure: the studio's rule (a
 * retried image may be billed twice) holds here too. Only a rate limit sends a
 * row back to the queue, and billing or credential failures pause the batch.
 */

export class StudioBatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StudioBatchError';
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface BatchDefaults {
  aspectRatio: StudioAspectRatio;
  quality: StudioQuality | null;
  textFree: boolean;
  festival: string | null;
}

/**
 * One row's overrides. `null` inherits the batch default; for `festival` and
 * `quality`, the empty string is an explicit "none" / "server default" that
 * overrides a batch default — Customize must be able to take Diwali off one day
 * of a Diwali batch.
 */
export interface ItemOverrides {
  aspectRatio: string | null;
  festival: string | null;
  textFree: boolean | null;
  quality: string | null;
}

export interface EffectiveItemSettings {
  aspectRatio: StudioAspectRatio;
  festival: string | null;
  textFree: boolean;
  quality: StudioQuality | null;
}

export function effectiveItemSettings(
  batch: Pick<PosterStudioBatch, 'aspectRatio' | 'festival' | 'textFree' | 'quality'>,
  item: ItemOverrides,
): EffectiveItemSettings {
  const aspect = item.aspectRatio ?? batch.aspectRatio;
  const quality = item.quality === null ? batch.quality : item.quality || null;
  return {
    aspectRatio: (STUDIO_ASPECT_RATIO_KEYS as string[]).includes(aspect) ? (aspect as StudioAspectRatio) : '9:16',
    festival: findStudioFestival(item.festival === null ? batch.festival : item.festival || null)?.key ?? null,
    textFree: item.textFree ?? batch.textFree,
    quality: quality && (STUDIO_QUALITIES as readonly string[]).includes(quality) ? (quality as StudioQuality) : null,
  };
}

function checkDefaults(defaults: BatchDefaults): void {
  if (!(STUDIO_ASPECT_RATIO_KEYS as string[]).includes(defaults.aspectRatio)) throw new StudioBatchError('Choose an aspect ratio.');
  if (defaults.quality !== null && !(STUDIO_QUALITIES as readonly string[]).includes(defaults.quality)) {
    throw new StudioBatchError('Choose Low, Medium or High quality.');
  }
  if (defaults.festival !== null && !findStudioFestival(defaults.festival)) throw new StudioBatchError('Unknown festival.');
}

/** Which Brand Canvas elements a batch draws: everything the client's Brand Canvas has. */
export function batchIdentityFromSummary(summary: StudioBrandCanvasSummary): {
  overlayElements: StudioOverlayElement[];
  logoBackground: 'ORIGINAL' | 'REMOVED';
} {
  const overlayElements: StudioOverlayElement[] = [];
  if (summary.logo.available && !summary.logo.loadError) overlayElements.push('logo');
  if (summary.tagline) overlayElements.push('tagline');
  if (summary.website) overlayElements.push('website');
  if (summary.phone) overlayElements.push('phone');
  return {
    overlayElements,
    logoBackground: summary.logo.removal.possible ? summary.logo.defaultBackground : 'ORIGINAL',
  };
}

// ---------------------------------------------------------------------------
// Dependencies (replaceable in tests)
// ---------------------------------------------------------------------------

export interface BatchDeps {
  now(): Date;
  generate(
    request: StudioGenerationRequest,
    options: { batchItemId: string },
  ): Promise<StudioGenerateResult>;
  saveToDay(db: CampaignDb, dayId: string, generationId: string): Promise<{ versionId: string }>;
  brandSummary(clientId: string): Promise<StudioBrandCanvasSummary>;
}

export const defaultBatchDeps: BatchDeps = {
  now: () => new Date(),
  generate: (request, options) => generateStudioPoster(request, NO_SOURCE, { batchItemId: options.batchItemId }),
  saveToDay: (db, dayId, generationId) => saveStudioPosterToCampaignDay(db, dayId, generationId),
  brandSummary: async (clientId) => summarizeStudioBrandCanvas(await loadStudioBrandCanvas(clientId)),
};

// ---------------------------------------------------------------------------
// Creating a draft
// ---------------------------------------------------------------------------

export interface CreateBatchInput {
  name: string;
  target: PosterStudioBatchTarget;
  /** STUDIO only; a CAMPAIGN batch takes the campaign's client. */
  clientId: string | null;
  campaignId: string | null;
  defaults: BatchDefaults;
  /** Composite the client's Brand Canvas identity (logo, tagline, website, phone). */
  brandIdentity: boolean;
  fileName: string | null;
  rows: BatchSheetRow[];
}

export interface ExcludedRow {
  sheetRow: number;
  dayLabel: string;
  reason: string;
}

export interface CreateBatchResult {
  batchId: string;
  created: number;
  excluded: ExcludedRow[];
}

/**
 * Writes a DRAFT batch from parsed rows. Spends nothing.
 *
 * A CAMPAIGN batch resolves each row's day now, so the review shows exactly
 * which days will be filled: a row whose day is missing, repeated, sent,
 * sending or past, or whose template shape the studio cannot make, is left out
 * with its reason. Each kept row is fixed to its day's shape.
 */
export async function createStudioBatch(
  db: CampaignDb,
  input: CreateBatchInput,
  deps: Pick<BatchDeps, 'now' | 'brandSummary'> = defaultBatchDeps,
): Promise<CreateBatchResult> {
  checkDefaults(input.defaults);
  if (input.rows.length === 0) throw new StudioBatchError('The sheet has no rows to make.');
  const now = deps.now();
  const excluded: ExcludedRow[] = [];
  let clientId = input.clientId;
  type Kept = { row: BatchSheetRow; calendarDayId: string | null; aspectRatio: string | null };
  let kept: Kept[] = [];

  if (input.target === 'CAMPAIGN') {
    if (!input.campaignId) throw new StudioBatchError('Choose the campaign whose days the sheet fills.');
    const campaign = await db.campaign.findUnique({
      where: { id: input.campaignId },
      select: {
        id: true,
        status: true,
        durationDays: true,
        deliveryTime: true,
        templateMappingMode: true,
        clientId: true,
        client: { select: { imageSizePreset: true } },
      },
    });
    if (!campaign) throw new StudioBatchError('That campaign no longer exists.');
    if (!campaignAllowsChanges(campaign.status)) {
      throw new StudioBatchError(`The campaign is ${campaign.status.toLowerCase()}, so its posters can no longer change.`);
    }
    clientId = campaign.clientId;

    const numbers = [...new Set(input.rows.map((row) => row.dayNumber).filter((value): value is number => value !== null))];
    const days = await db.contentCalendar.findMany({
      where: { campaignId: campaign.id, dayNumber: { in: numbers } },
      select: {
        id: true,
        dayNumber: true,
        scheduledDate: true,
        posterTemplateId: true,
        suggestedTemplateId: true,
        delivery: { select: { status: true, scheduledFor: true } },
      },
    });
    const byNumber = new Map(days.map((day) => [day.dayNumber, day]));
    const seen = new Set<number>();
    const timeZone = getAppTimeZone();

    for (const row of input.rows) {
      const exclude = (reason: string) => excluded.push({ sheetRow: row.sheetRow, dayLabel: row.dayLabel, reason });
      if (row.dayNumber === null) {
        exclude('For a campaign, Day must be a day number, such as 12 or "Day 12".');
        continue;
      }
      if (seen.has(row.dayNumber)) {
        exclude(`Day ${row.dayNumber} appears earlier in the sheet; only the first row is used.`);
        continue;
      }
      seen.add(row.dayNumber);
      const day = byNumber.get(row.dayNumber);
      if (!day) {
        exclude(`Day ${row.dayNumber} is not in this campaign (days 1–${campaign.durationDays}).`);
        continue;
      }
      const lock = slotLockOf(day, now, timeZone, campaign.deliveryTime);
      if (lock) {
        exclude(`Day ${row.dayNumber}: ${SLOT_LOCK_LABELS[lock]}`);
        continue;
      }
      const shape = await dayPosterShape(db, day, campaign.templateMappingMode, campaign.client.imageSizePreset);
      if (!shape.aspect || !(STUDIO_ASPECT_RATIO_KEYS as string[]).includes(shape.aspect)) {
        exclude(`Day ${row.dayNumber}'s posters are ${shape.aspect ?? shape.describe}, a shape the studio cannot make.`);
        continue;
      }
      // A sheet's own Aspect ratio is not an error here: the day's shape wins,
      // because Save to Day refuses any other, and the review shows it.
      kept.push({ row, calendarDayId: day.id, aspectRatio: shape.aspect });
    }
  } else {
    if (clientId) {
      const client = await db.client.findUnique({ where: { id: clientId }, select: { id: true } });
      if (!client) throw new StudioBatchError('That client no longer exists.');
    }
    kept = input.rows.map((row) => ({ row, calendarDayId: null, aspectRatio: row.aspectRatio }));
  }

  if (kept.length === 0) {
    throw new StudioBatchError(
      `None of the ${input.rows.length} row${input.rows.length === 1 ? '' : 's'} can be made. ${excluded
        .slice(0, 3)
        .map((entry) => entry.reason)
        .join(' ')}`,
    );
  }

  let identity: { overlayElements: StudioOverlayElement[]; logoBackground: 'ORIGINAL' | 'REMOVED' } = {
    overlayElements: [],
    logoBackground: 'ORIGINAL',
  };
  if (input.brandIdentity && clientId) {
    let summary: StudioBrandCanvasSummary;
    try {
      summary = await deps.brandSummary(clientId);
    } catch (error) {
      throw new StudioBatchError(
        `The client's Brand Canvas could not be loaded, so the posters cannot be branded. ${error instanceof Error ? error.message : ''}`.trim(),
      );
    }
    identity = batchIdentityFromSummary(summary);
  }

  const name = input.name.trim() || `${(input.fileName ?? 'Bulk posters').replace(/\.(xlsx|csv)$/i, '')}`;
  const batch = await db.posterStudioBatch.create({
    data: {
      name: name.slice(0, 120),
      target: input.target,
      clientId,
      campaignId: input.target === 'CAMPAIGN' ? input.campaignId : null,
      aspectRatio: input.defaults.aspectRatio,
      quality: input.defaults.quality,
      textFree: input.defaults.textFree,
      festival: input.defaults.festival,
      overlayElements: identity.overlayElements,
      logoBackground: identity.logoBackground,
      footerBackground: 'AUTO',
      sourceFileName: input.fileName,
      items: {
        create: kept.map((entry, index) => ({
          position: index + 1,
          dayLabel: entry.row.dayLabel,
          dayNumber: entry.row.dayNumber,
          prompt: entry.row.prompt,
          aspectRatio: entry.aspectRatio,
          festival: entry.row.festival,
          textFree: entry.row.textFree,
          quality: entry.row.quality,
          calendarDayId: entry.calendarDayId,
        })),
      },
    },
    select: { id: true },
  });
  return { batchId: batch.id, created: kept.length, excluded };
}

// ---------------------------------------------------------------------------
// Operator actions
// ---------------------------------------------------------------------------

export interface ItemSettingsInput {
  prompt: string;
  aspectRatio: StudioAspectRatio;
  festival: string | null;
  textFree: boolean;
  quality: StudioQuality | null;
}

/**
 * Customize one row. In a draft it only changes what will be made (free).
 * After the run has started it also queues the row again, so its image is
 * remade with the new settings — the earlier image stays on the row's history.
 */
export async function customizeBatchItem(
  db: CampaignDb,
  itemId: string,
  settings: ItemSettingsInput,
  deps: Pick<BatchDeps, 'now'> = defaultBatchDeps,
): Promise<{ requeued: boolean }> {
  const now = deps.now();
  const item = await db.posterStudioBatchItem.findUnique({
    where: { id: itemId },
    select: { id: true, status: true, startedAt: true, aspectRatio: true, calendarDayId: true, batch: { select: { id: true, status: true, target: true } } },
  });
  if (!item) throw new StudioBatchError('That row no longer exists.');
  const prompt = settings.prompt.trim();
  if (prompt.length < 3) throw new StudioBatchError('The prompt needs at least 3 characters.');
  if (!(STUDIO_ASPECT_RATIO_KEYS as string[]).includes(settings.aspectRatio)) throw new StudioBatchError('Choose an aspect ratio.');
  if (settings.festival !== null && !findStudioFestival(settings.festival)) throw new StudioBatchError('Unknown festival.');
  if (settings.quality !== null && !(STUDIO_QUALITIES as readonly string[]).includes(settings.quality)) throw new StudioBatchError('Unknown quality.');
  if (item.batch.target === 'CAMPAIGN' && item.aspectRatio && settings.aspectRatio !== item.aspectRatio) {
    throw new StudioBatchError(`This day's posters are ${item.aspectRatio}; the format cannot change.`);
  }
  if (isClaimLive(item.status, item.startedAt, now)) throw new StudioBatchError('This row is being generated right now. Try again when it finishes.');

  const draft = item.batch.status === 'DRAFT';
  await db.posterStudioBatchItem.update({
    where: { id: item.id },
    data: {
      prompt,
      aspectRatio: settings.aspectRatio,
      // Explicit, so a batch default never comes back: '' is "none".
      festival: settings.festival ?? '',
      textFree: settings.textFree,
      quality: settings.quality ?? '',
      ...(draft ? {} : { status: 'QUEUED', error: null, startedAt: null }),
    },
  });
  if (!draft && item.batch.status !== 'PAUSED') {
    await db.posterStudioBatch.update({ where: { id: item.batch.id }, data: { status: 'RUNNING', finishedAt: null } });
  }
  return { requeued: !draft };
}

async function requireBatch(db: CampaignDb, batchId: string) {
  const batch = await db.posterStudioBatch.findUnique({ where: { id: batchId }, select: { id: true, status: true } });
  if (!batch) throw new StudioBatchError('That batch no longer exists.');
  return batch;
}

/** DRAFT → RUNNING: every row is queued. Spends nothing itself; the workers do. */
export async function startStudioBatch(db: CampaignDb, batchId: string, deps: Pick<BatchDeps, 'now'> = defaultBatchDeps): Promise<{ queued: number }> {
  const batch = await requireBatch(db, batchId);
  if (batch.status !== 'DRAFT') throw new StudioBatchError('This batch has already been started.');
  const moved = await db.posterStudioBatch.updateMany({
    where: { id: batchId, status: 'DRAFT' },
    data: { status: 'RUNNING', startedAt: deps.now(), pausedReason: null },
  });
  if (moved.count === 0) throw new StudioBatchError('This batch has already been started.');
  const queued = await db.posterStudioBatchItem.updateMany({ where: { batchId, status: 'NOT_REQUESTED' }, data: { status: 'QUEUED' } });
  return { queued: queued.count };
}

export async function pauseStudioBatch(db: CampaignDb, batchId: string): Promise<void> {
  const moved = await db.posterStudioBatch.updateMany({ where: { id: batchId, status: 'RUNNING' }, data: { status: 'PAUSED', pausedReason: null } });
  if (moved.count === 0) throw new StudioBatchError('Only a running batch can be paused.');
}

export async function resumeStudioBatch(db: CampaignDb, batchId: string, deps: Pick<BatchDeps, 'now'> = defaultBatchDeps): Promise<void> {
  const moved = await db.posterStudioBatch.updateMany({ where: { id: batchId, status: 'PAUSED' }, data: { status: 'RUNNING', pausedReason: null } });
  if (moved.count === 0) throw new StudioBatchError('Only a paused batch can be resumed.');
  await settleStudioBatch(db, batchId, deps.now());
}

/** Stops the run: queued rows are released. A row being generated finishes and is kept. */
export async function cancelStudioBatch(db: CampaignDb, batchId: string, deps: Pick<BatchDeps, 'now'> = defaultBatchDeps): Promise<{ released: number }> {
  const moved = await db.posterStudioBatch.updateMany({
    where: { id: batchId, status: { in: ['RUNNING', 'PAUSED'] } },
    data: { status: 'CANCELLED', finishedAt: deps.now() },
  });
  if (moved.count === 0) throw new StudioBatchError('Only a running or paused batch can be cancelled.');
  const released = await db.posterStudioBatchItem.updateMany({ where: { batchId, status: 'QUEUED' }, data: { status: 'NOT_REQUESTED' } });
  return { released: released.count };
}

/** Failed rows (and, for a cancelled batch, rows never made) go back in the queue. */
export async function retryStudioBatch(db: CampaignDb, batchId: string): Promise<{ queued: number }> {
  const batch = await requireBatch(db, batchId);
  if (batch.status === 'DRAFT') throw new StudioBatchError('Start the batch first.');
  const statuses: PosterGenerationStatus[] = batch.status === 'CANCELLED' ? ['FAILED', 'NOT_REQUESTED'] : ['FAILED'];
  const queued = await db.posterStudioBatchItem.updateMany({
    where: { batchId, status: { in: statuses } },
    data: { status: 'QUEUED', error: null, startedAt: null },
  });
  if (queued.count > 0 && batch.status !== 'PAUSED') {
    await db.posterStudioBatch.update({ where: { id: batchId }, data: { status: 'RUNNING', finishedAt: null } });
  }
  return { queued: queued.count };
}

export async function deleteDraftStudioBatch(db: CampaignDb, batchId: string): Promise<void> {
  const removed = await db.posterStudioBatch.deleteMany({ where: { id: batchId, status: 'DRAFT' } });
  if (removed.count === 0) throw new StudioBatchError('Only a draft batch can be discarded.');
}

// ---------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------

function isClaimLive(status: PosterGenerationStatus, startedAt: Date | null, now: Date): boolean {
  return status === 'GENERATING' && startedAt !== null && now.getTime() - startedAt.getTime() < STALE_GENERATION_MS;
}

export interface BatchClaim {
  itemId: string;
  batchId: string;
  token: Date;
}

/**
 * Claims the next row of a RUNNING batch: a QUEUED one, or a GENERATING one
 * whose claim has gone stale. Conditional on the state it was read in, so two
 * workers cannot both take a row. Oldest batch first, then sheet order.
 */
export async function claimBatchItem(
  db: CampaignDb,
  now: Date,
  options: { batchId?: string } = {},
): Promise<BatchClaim | null> {
  const stale = new Date(now.getTime() - STALE_GENERATION_MS);
  const candidates = await db.posterStudioBatchItem.findMany({
    where: {
      ...(options.batchId ? { batchId: options.batchId } : {}),
      batch: { status: 'RUNNING' },
      OR: [{ status: 'QUEUED' }, { status: 'GENERATING', startedAt: { lt: stale } }],
    },
    orderBy: [{ batch: { createdAt: 'asc' } }, { position: 'asc' }],
    take: 5,
    select: { id: true, batchId: true, status: true, startedAt: true },
  });
  for (const candidate of candidates) {
    // A fresh token even when the clock has not moved: it identifies this attempt.
    const token = new Date(Math.max(now.getTime(), (candidate.startedAt?.getTime() ?? 0) + 1));
    const claimed = await db.posterStudioBatchItem.updateMany({
      where: { id: candidate.id, status: candidate.status, startedAt: candidate.startedAt },
      data: { status: 'GENERATING', startedAt: token, attempts: { increment: 1 } },
    });
    if (claimed.count === 1) return { itemId: candidate.id, batchId: candidate.batchId, token };
  }
  return null;
}

/** Provider failures no retry can fix: the batch waits for the operator instead of failing every row. */
const PAUSING_KINDS: ReadonlySet<StudioErrorKind> = new Set(['config', 'auth', 'access', 'quota', 'model']);

export type BatchItemOutcome =
  | { kind: 'succeeded'; itemId: string; generationId: string; savedToDay: boolean }
  | { kind: 'failed'; itemId: string; message: string }
  | { kind: 'requeued'; itemId: string; message: string }
  | { kind: 'paused'; itemId: string; message: string }
  /** The claim was lost (reclaimed as stale, or the batch changed); nothing recorded. */
  | { kind: 'lost'; itemId: string };

/** Makes one claimed row and settles it. Never throws for a provider failure. */
export async function processBatchItem(db: CampaignDb, claim: BatchClaim, deps: BatchDeps = defaultBatchDeps): Promise<BatchItemOutcome> {
  const item = await db.posterStudioBatchItem.findUnique({
    where: { id: claim.itemId },
    include: { batch: true },
  });
  if (!item || item.status !== 'GENERATING' || item.startedAt?.getTime() !== claim.token.getTime()) {
    return { kind: 'lost', itemId: claim.itemId };
  }
  const settings = effectiveItemSettings(item.batch, item);
  const request: StudioGenerationRequest = {
    mode: 'GENERATE',
    prompt: item.prompt,
    aspectRatio: settings.aspectRatio,
    clientId: item.batch.clientId,
    textFree: settings.textFree,
    overlayElements: item.batch.clientId ? (item.batch.overlayElements as StudioOverlayElement[]) : [],
    logoBackground: item.batch.logoBackground,
    footerBackground: item.batch.footerBackground,
    festival: settings.festival,
    quality: settings.quality,
  };

  let result: StudioGenerateResult;
  try {
    result = await deps.generate(request, { batchItemId: item.id });
  } catch (error) {
    result = { ok: false, kind: 'provider', error: error instanceof Error ? error.message : 'Generation failed.' };
  }

  const settle = async (data: Parameters<CampaignDb['posterStudioBatchItem']['updateMany']>[0]['data']) => {
    const settled = await db.posterStudioBatchItem.updateMany({
      where: { id: item.id, status: 'GENERATING', startedAt: claim.token },
      data,
    });
    await settleStudioBatch(db, item.batchId, deps.now());
    return settled.count === 1;
  };

  if (!result.ok) {
    if (PAUSING_KINDS.has(result.kind)) {
      await db.posterStudioBatch.updateMany({ where: { id: item.batchId, status: 'RUNNING' }, data: { status: 'PAUSED', pausedReason: result.error } });
      await settle({ status: 'QUEUED', startedAt: null, attempts: { decrement: 1 } });
      logBatch('paused', item, result.kind);
      return { kind: 'paused', itemId: item.id, message: result.error };
    }
    if (result.kind === 'rate-limit') {
      await settle({ status: 'QUEUED', startedAt: null });
      logBatch('requeued', item, result.kind);
      return { kind: 'requeued', itemId: item.id, message: result.error };
    }
    const unsavedNote = 'unsaved' in result && result.unsaved ? ' The image was billed but could not be kept.' : '';
    await settle({ status: 'FAILED', error: `${result.error}${unsavedNote}`.slice(0, 1000) });
    logBatch('failed', item, result.kind);
    return { kind: 'failed', itemId: item.id, message: result.error };
  }

  const generationId = result.generation.id;
  let posterVersionId: string | null = null;
  let saveError: string | null = null;
  if (item.batch.target === 'CAMPAIGN' && item.calendarDayId) {
    const day = await db.contentCalendar.findUnique({
      where: { id: item.calendarDayId },
      select: {
        id: true,
        dayNumber: true,
        scheduledDate: true,
        delivery: { select: { status: true, scheduledFor: true } },
        campaign: { select: { deliveryTime: true } },
      },
    });
    const lock = day ? slotLockOf(day, deps.now(), getAppTimeZone(), day.campaign?.deliveryTime) : null;
    if (!day) saveError = 'The campaign day no longer exists.';
    else if (lock) saveError = SLOT_LOCK_LABELS[lock];
    else {
      try {
        posterVersionId = (await deps.saveToDay(db, day.id, generationId)).versionId;
      } catch (error) {
        saveError = error instanceof CampaignDomainError || error instanceof Error ? error.message : 'Saving to the day failed.';
      }
    }
  }

  if (saveError) {
    const message = `The image was made but not saved to day ${item.dayNumber ?? item.dayLabel}: ${saveError}`;
    const kept = await settle({ status: 'FAILED', generationId, error: message.slice(0, 1000) });
    if (!kept) return { kind: 'lost', itemId: item.id };
    logBatch('failed', item, 'save-to-day');
    return { kind: 'failed', itemId: item.id, message };
  }
  const kept = await settle({ status: 'SUCCEEDED', generationId, posterVersionId, error: null });
  if (!kept) return { kind: 'lost', itemId: item.id };
  logBatch('generated', item);
  return { kind: 'succeeded', itemId: item.id, generationId, savedToDay: posterVersionId !== null };
}

/** RUNNING → DONE once nothing is queued or being generated. */
export async function settleStudioBatch(db: CampaignDb, batchId: string, now: Date): Promise<PosterStudioBatchStatus | null> {
  const open = await db.posterStudioBatchItem.count({ where: { batchId, status: { in: ['QUEUED', 'GENERATING'] } } });
  if (open === 0) {
    await db.posterStudioBatch.updateMany({ where: { id: batchId, status: 'RUNNING' }, data: { status: 'DONE', finishedAt: now } });
  }
  const batch = await db.posterStudioBatch.findUnique({ where: { id: batchId }, select: { status: true } });
  return batch?.status ?? null;
}

/** The open batch page's worker: one row of this batch per call. */
export async function runNextBatchItem(db: CampaignDb, batchId: string, deps: BatchDeps = defaultBatchDeps): Promise<BatchItemOutcome | null> {
  const claim = await claimBatchItem(db, deps.now(), { batchId });
  if (!claim) {
    await settleStudioBatch(db, batchId, deps.now());
    return null;
  }
  return processBatchItem(db, claim, deps);
}

/** Rows made at once by the page, and by each cron sweep. Default 2, at most 4. */
export function studioBatchConcurrency(): number {
  return Math.max(1, Math.min(intEnv('POSTER_STUDIO_BATCH_CONCURRENCY', 2), 4));
}

/** Rows one cron sweep will start at most. */
export function studioBatchCronLimit(): number {
  return Math.max(1, intEnv('POSTER_STUDIO_BATCH_CRON_LIMIT', 8));
}

export interface StudioBatchSweep {
  generated: number;
  failed: number;
  /** Another sweep held the lock, so this one did nothing. */
  lockHeld: boolean;
}

const TRY_BATCH_LOCK = `SELECT pg_try_advisory_xact_lock(hashtext('evokz:studio-batch-sweep')) AS locked`;
const BATCH_LOCK_TRANSACTION_MS = 15 * 60_000;

/**
 * The cron sweep's share: rows of every RUNNING batch until `budgetMs` has
 * passed, `studioBatchCronLimit()` rows have started or a rate limit is hit,
 * `studioBatchConcurrency()` at a time. One sweep at a time (advisory lock, as
 * the campaign queue does); the row in flight finishes.
 */
export async function runQueuedStudioBatchItemsExclusively(
  db: CampaignDb,
  options: { budgetMs: number; limit?: number; concurrency?: number },
  deps: BatchDeps = defaultBatchDeps,
): Promise<StudioBatchSweep> {
  const work = async (): Promise<StudioBatchSweep> => {
    const started = Date.now();
    const limit = options.limit ?? studioBatchCronLimit();
    const width = options.concurrency ?? studioBatchConcurrency();
    const sweep: StudioBatchSweep = { generated: 0, failed: 0, lockHeld: false };
    let taken = 0;
    let stop = false;
    await Promise.all(
      Array.from({ length: width }, async () => {
        while (!stop && taken < limit && Date.now() - started < options.budgetMs) {
          taken += 1;
          const claim = await claimBatchItem(db, deps.now());
          if (!claim) {
            taken -= 1;
            return;
          }
          const outcome = await processBatchItem(db, claim, deps);
          if (outcome.kind === 'succeeded') sweep.generated += 1;
          else if (outcome.kind === 'failed') sweep.failed += 1;
          else if (outcome.kind === 'requeued') stop = true;
        }
      }),
    );
    return sweep;
  };

  if (!('$transaction' in db)) {
    const locked = await db.$queryRawUnsafe<Array<{ locked: boolean }>>(TRY_BATCH_LOCK);
    if (!locked[0]?.locked) return { generated: 0, failed: 0, lockHeld: true };
    return work();
  }
  return db.$transaction(
    async (tx) => {
      const locked = await tx.$queryRawUnsafe<Array<{ locked: boolean }>>(TRY_BATCH_LOCK);
      if (!locked[0]?.locked) return { generated: 0, failed: 0, lockHeld: true };
      return work();
    },
    { timeout: BATCH_LOCK_TRANSACTION_MS, maxWait: 10_000 },
  );
}

function logBatch(event: 'generated' | 'failed' | 'requeued' | 'paused', item: PosterStudioBatchItem, detail?: string): void {
  console.info(`[ace:studio-batch] ${event} batch=${item.batchId} item=${item.id} position=${item.position}${detail ? ` kind=${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

export interface BatchCostEstimate {
  images: number;
  /** Studio calls the averages come from; 0 means nothing to go on yet. */
  sampleSize: number;
  averageOutputTokens: number | null;
  pricingConfigured: boolean;
  /** USD micros; null when pricing is not configured or there is no sample. */
  perImageMicros: number | null;
  totalMicros: number | null;
}

/**
 * What `images` more studio images are likely to cost: the average tokens of
 * the last studio calls, priced with the configured rate card. An estimate —
 * size and quality move the output tokens — and said to be one on the page.
 */
export async function estimateStudioBatchCost(db: CampaignDb, images: number): Promise<BatchCostEstimate> {
  const recent = await db.usageEvent.findMany({
    where: { operation: 'studio-image', backfilled: false },
    orderBy: { createdAt: 'desc' },
    take: 40,
    select: { inputTokens: true, outputTokens: true },
  });
  const rates = getRateCard();
  const pricingConfigured = isOpenAiImagePricingConfigured(rates);
  if (recent.length === 0) {
    return { images, sampleSize: 0, averageOutputTokens: null, pricingConfigured, perImageMicros: null, totalMicros: null };
  }
  const average = (pick: (row: (typeof recent)[number]) => number) => recent.reduce((sum, row) => sum + pick(row), 0) / recent.length;
  const outputTokens = average((row) => row.outputTokens);
  const perImageMicros = priceOpenAiImageCall(
    { textInputTokens: average((row) => row.inputTokens), imageInputTokens: 0, outputTokens },
    rates,
  );
  return {
    images,
    sampleSize: recent.length,
    averageOutputTokens: Math.round(outputTokens),
    pricingConfigured,
    perImageMicros,
    totalMicros: perImageMicros === null ? null : perImageMicros * images,
  };
}
