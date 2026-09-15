import { MissingEnvError } from '@/lib/env';
import {
  downloadDriveFile,
  ensurePosterStudioFolder,
  trashDriveFile,
  uploadClientAsset,
} from '@/lib/google-drive';
import { StudioError } from '@/lib/poster-studio/errors';
import { prisma } from '@/lib/prisma';

/**
 * Google Drive storage for AI Poster Studio images.
 *
 * Thin wrappers over `src/lib/google-drive.ts` — the same service account, vault
 * and unpublished-upload pattern as vertical reference templates — that turn
 * Drive faults into operator copy.
 *
 * **Every file is uploaded unpublished.** A studio draft never leaves the
 * console, so nothing outside needs to fetch it; publishing would make it
 * readable to anyone who ever saw its Drive id. The browser reaches the bytes
 * through `/api/poster-studio/[generationId]/image`, behind the admin session.
 */

/**
 * Resolves (creating if needed) the Drive folder for a request.
 *
 * Called *before* the image model is, so a server that cannot store an image
 * fails without spending anything on one.
 */
export async function resolveStudioFolder(companyName: string | null): Promise<string> {
  try {
    return await ensurePosterStudioFolder(companyName ?? 'Generic');
  } catch (error) {
    if (error instanceof MissingEnvError) {
      throw new StudioError(
        'config',
        `Google Drive storage is not configured on the server (${error.key} is not set), so studio images cannot be saved. Nothing was generated.`,
        { cause: error },
      );
    }
    console.error('[studio:storage] could not resolve the Poster Studio folder:', describe(error));
    throw new StudioError(
      'storage',
      'Could not reach the Poster Studio folder in Google Drive, so nothing was generated. Check the Drive service account and try again.',
      { cause: error },
    );
  }
}

export async function storeStudioFile(input: {
  folderId: string;
  fileName: string;
  body: Buffer;
  mimeType: string;
}): Promise<string> {
  try {
    const uploaded = await uploadClientAsset({ ...input, publish: false });
    return uploaded.fileId;
  } catch (error) {
    console.error(`[studio:storage] upload of ${input.fileName} failed:`, describe(error));
    throw new StudioError('storage', 'Google Drive did not accept the upload.', { cause: error });
  }
}

export async function readStudioFile(fileId: string): Promise<Buffer> {
  try {
    return await downloadDriveFile(fileId);
  } catch (error) {
    console.error(`[studio:storage] download of ${fileId} failed:`, describe(error));
    throw new StudioError(
      'storage',
      'Could not load the selected image from Google Drive, so nothing was generated. It may have been removed from Drive.',
      { cause: error },
    );
  }
}

/** Bins files written by a request that then failed. Never throws. */
export async function trashStudioFiles(fileIds: readonly string[]): Promise<void> {
  await Promise.all(fileIds.map((fileId) => trashDriveFile(fileId)));
}

/**
 * Bins each file no remaining studio row references. Never throws.
 *
 * A file can belong to more than one row: an edit made from a history item
 * records the parent's output as its own input, without copying it. Deleting
 * the parent must leave that file in place for the child.
 *
 * Trashed rather than deleted, as elsewhere in the vault, so a mistaken delete is
 * recoverable from Drive's bin.
 */
export async function trashUnreferencedStudioFiles(
  fileIds: ReadonlyArray<string | null>,
): Promise<void> {
  const unique = [...new Set(fileIds.filter((id): id is string => Boolean(id)))];

  for (const fileId of unique) {
    try {
      const stillUsed = await prisma.posterStudioGeneration.count({
        where: { OR: [{ imageDriveFileId: fileId }, { referenceDriveFileId: fileId }] },
      });
      if (stillUsed === 0) await trashDriveFile(fileId);
    } catch (error) {
      console.warn(`[studio:storage] could not tidy Drive file ${fileId}:`, describe(error));
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
