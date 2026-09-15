import { Prisma } from '@prisma/client';

import { StudioError } from '@/lib/poster-studio/errors';
import type { StudioMode } from '@/lib/poster-studio/limits';
import { prisma } from '@/lib/prisma';

/**
 * AI Poster Studio history, as the workspace receives it.
 *
 * Metadata only. Each item is a few hundred bytes plus its prompts; the images
 * are fetched lazily by the browser from the proxy route. The first version
 * selected every column, image data URIs included, into the server-rendered
 * payload — twenty-four multi-megabyte strings on every page load.
 */

export const STUDIO_HISTORY_LIMIT = 24;

export interface StudioHistoryItem {
  id: string;
  mode: StudioMode;
  prompt: string;
  sentPrompt: string;
  aspectRatio: string;
  size: string;
  model: string;
  quality: string;
  textFree: boolean;
  width: number | null;
  height: number | null;
  /** An input image was sent with the request and is stored on this row. */
  hasReference: boolean;
  /** A composited final poster exists. When false, the raw artwork is the poster. */
  hasFinal: boolean;
  /** Exact Brand Canvas elements the overlay drew — names only. */
  overlayElements: string[];
  logoBackground: 'ORIGINAL' | 'REMOVED' | null;
  /** Footer choice, and the tone it was drawn in. Null when no overlay was drawn. */
  footerBackground: 'AUTO' | 'LIGHT' | 'DARK' | null;
  footerTone: 'AUTO' | 'LIGHT' | 'DARK' | null;
  parentGenerationId: string | null;
  clientId: string | null;
  clientName: string | null;
  /** ISO timestamp — a Date does not survive the server/client boundary unchanged. */
  createdAt: string;
}

export const studioHistorySelect = {
  id: true,
  mode: true,
  prompt: true,
  sentPrompt: true,
  aspectRatio: true,
  size: true,
  model: true,
  quality: true,
  textFree: true,
  width: true,
  height: true,
  referenceDriveFileId: true,
  finalImageDriveFileId: true,
  overlayElements: true,
  logoBackground: true,
  footerBackground: true,
  footerTone: true,
  parentGenerationId: true,
  clientId: true,
  createdAt: true,
  client: { select: { companyName: true } },
} satisfies Prisma.PosterStudioGenerationSelect;

type HistoryRow = Prisma.PosterStudioGenerationGetPayload<{ select: typeof studioHistorySelect }>;

export function toStudioHistoryItem(row: HistoryRow): StudioHistoryItem {
  return {
    id: row.id,
    mode: row.mode,
    prompt: row.prompt,
    sentPrompt: row.sentPrompt,
    aspectRatio: row.aspectRatio,
    size: row.size,
    model: row.model,
    quality: row.quality,
    textFree: row.textFree,
    width: row.width,
    height: row.height,
    hasReference: row.referenceDriveFileId !== null,
    hasFinal: row.finalImageDriveFileId !== null,
    overlayElements: row.overlayElements,
    logoBackground: row.logoBackground,
    footerBackground: row.footerBackground,
    footerTone: row.footerTone,
    parentGenerationId: row.parentGenerationId,
    clientId: row.clientId,
    clientName: row.client?.companyName ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function loadStudioHistory(): Promise<StudioHistoryItem[]> {
  const rows = await prisma.posterStudioGeneration.findMany({
    orderBy: { createdAt: 'desc' },
    take: STUDIO_HISTORY_LIMIT,
    select: studioHistorySelect,
  });
  return rows.map(toStudioHistoryItem);
}

/**
 * Maps a database fault to operator copy.
 *
 * P2021 gets its own message because it is the likeliest one on a fresh
 * environment: the code is deployed and the migration is not.
 */
export function toStudioDatabaseError(error: unknown, context: string): StudioError {
  if (error instanceof StudioError) return error;

  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2021') {
    return new StudioError(
      'database',
      `${context}: the Poster Studio table does not exist in this database. Apply migrations with "npx prisma migrate deploy".`,
      { cause: error },
    );
  }

  if (error instanceof Prisma.PrismaClientInitializationError) {
    return new StudioError(
      'database',
      `${context}: the database is unreachable. Check DATABASE_URL and that the database server is running.`,
      { cause: error },
    );
  }

  return new StudioError(
    'database',
    `${context}: the database request failed. The details are in the server log.`,
    { cause: error },
  );
}
