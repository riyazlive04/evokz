import type {
  PosterApprovalStatus,
  PosterGenerationStatus,
  PosterStudioBatchStatus,
  PosterStudioBatchTarget,
} from '@prisma/client';

import type { CampaignDb } from '@/lib/campaign/service';
import { effectiveItemSettings, type EffectiveItemSettings } from '@/lib/poster-studio/batch-service';

/**
 * What the bulk pages show: plain, serialisable data (ISO dates, no Drive ids).
 * Images are fetched by the browser from the studio image route by generation id.
 */

export interface BatchItemView {
  id: string;
  position: number;
  dayLabel: string;
  dayNumber: number | null;
  prompt: string;
  status: PosterGenerationStatus;
  error: string | null;
  attempts: number;
  settings: EffectiveItemSettings;
  /** Which settings differ from the batch defaults because of this row. */
  customized: boolean;
  /** CAMPAIGN rows are fixed to their day's shape. */
  lockedAspect: boolean;
  image: {
    generationId: string;
    aspectRatio: string;
    width: number | null;
    height: number | null;
    hasFinal: boolean;
  } | null;
  /** Images this row has made, redos included. */
  imageCount: number;
  day: {
    calendarDayId: string;
    versionNumber: number | null;
    approvalStatus: PosterApprovalStatus | null;
  } | null;
}

export interface BatchView {
  id: string;
  name: string;
  target: PosterStudioBatchTarget;
  status: PosterStudioBatchStatus;
  pausedReason: string | null;
  clientId: string | null;
  clientName: string | null;
  campaignId: string | null;
  campaignName: string | null;
  defaults: EffectiveItemSettings;
  overlayElements: string[];
  sourceFileName: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  counts: Record<PosterGenerationStatus, number>;
  items: BatchItemView[];
}

export interface BatchListEntry {
  id: string;
  name: string;
  target: PosterStudioBatchTarget;
  status: PosterStudioBatchStatus;
  clientName: string | null;
  campaignName: string | null;
  createdAt: string;
  total: number;
  succeeded: number;
  failed: number;
}

const EMPTY_COUNTS: Record<PosterGenerationStatus, number> = {
  NOT_REQUESTED: 0,
  QUEUED: 0,
  GENERATING: 0,
  SUCCEEDED: 0,
  FAILED: 0,
};

export async function loadStudioBatchView(db: CampaignDb, batchId: string): Promise<BatchView | null> {
  const batch = await db.posterStudioBatch.findUnique({
    where: { id: batchId },
    include: {
      client: { select: { companyName: true } },
      campaign: { select: { name: true } },
      items: {
        orderBy: { position: 'asc' },
        include: {
          generation: { select: { id: true, aspectRatio: true, width: true, height: true, finalImageDriveFileId: true } },
          _count: { select: { images: true } },
        },
      },
    },
  });
  if (!batch) return null;

  const versionIds = batch.items.map((item) => item.posterVersionId).filter((id): id is string => id !== null);
  const versions = versionIds.length
    ? await db.posterVersion.findMany({
        where: { id: { in: versionIds } },
        select: { id: true, versionNumber: true, approvalStatus: true },
      })
    : [];
  const versionById = new Map(versions.map((version) => [version.id, version]));

  const counts = { ...EMPTY_COUNTS };
  const defaults = effectiveItemSettings(batch, { aspectRatio: null, festival: null, textFree: null, quality: null });
  const items: BatchItemView[] = batch.items.map((item) => {
    counts[item.status] += 1;
    const settings = effectiveItemSettings(batch, item);
    const version = item.posterVersionId ? versionById.get(item.posterVersionId) : undefined;
    return {
      id: item.id,
      position: item.position,
      dayLabel: item.dayLabel,
      dayNumber: item.dayNumber,
      prompt: item.prompt,
      status: item.status,
      error: item.error,
      attempts: item.attempts,
      settings,
      customized:
        settings.aspectRatio !== defaults.aspectRatio ||
        settings.festival !== defaults.festival ||
        settings.textFree !== defaults.textFree ||
        settings.quality !== defaults.quality,
      lockedAspect: batch.target === 'CAMPAIGN',
      image: item.generation
        ? {
            generationId: item.generation.id,
            aspectRatio: item.generation.aspectRatio,
            width: item.generation.width,
            height: item.generation.height,
            hasFinal: item.generation.finalImageDriveFileId !== null,
          }
        : null,
      imageCount: item._count.images,
      day: item.calendarDayId
        ? {
            calendarDayId: item.calendarDayId,
            versionNumber: version?.versionNumber ?? null,
            approvalStatus: version?.approvalStatus ?? null,
          }
        : null,
    };
  });

  return {
    id: batch.id,
    name: batch.name,
    target: batch.target,
    status: batch.status,
    pausedReason: batch.pausedReason,
    clientId: batch.clientId,
    clientName: batch.client?.companyName ?? null,
    campaignId: batch.campaignId,
    campaignName: batch.campaign?.name ?? null,
    defaults,
    overlayElements: batch.overlayElements,
    sourceFileName: batch.sourceFileName,
    createdAt: batch.createdAt.toISOString(),
    startedAt: batch.startedAt?.toISOString() ?? null,
    finishedAt: batch.finishedAt?.toISOString() ?? null,
    counts,
    items,
  };
}

export async function listStudioBatches(db: CampaignDb, take = 20): Promise<BatchListEntry[]> {
  const batches = await db.posterStudioBatch.findMany({
    orderBy: { createdAt: 'desc' },
    take,
    select: {
      id: true,
      name: true,
      target: true,
      status: true,
      createdAt: true,
      client: { select: { companyName: true } },
      campaign: { select: { name: true } },
      _count: { select: { items: true } },
    },
  });
  if (batches.length === 0) return [];
  const grouped = await db.posterStudioBatchItem.groupBy({
    by: ['batchId', 'status'],
    where: { batchId: { in: batches.map((batch) => batch.id) }, status: { in: ['SUCCEEDED', 'FAILED'] } },
    _count: { _all: true },
  });
  const countOf = (batchId: string, status: PosterGenerationStatus) =>
    grouped.find((entry) => entry.batchId === batchId && entry.status === status)?._count._all ?? 0;
  return batches.map((batch) => ({
    id: batch.id,
    name: batch.name,
    target: batch.target,
    status: batch.status,
    clientName: batch.client?.companyName ?? null,
    campaignName: batch.campaign?.name ?? null,
    createdAt: batch.createdAt.toISOString(),
    total: batch._count.items,
    succeeded: countOf(batch.id, 'SUCCEEDED'),
    failed: countOf(batch.id, 'FAILED'),
  }));
}
