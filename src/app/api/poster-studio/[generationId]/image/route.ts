import { NextResponse, type NextRequest } from 'next/server';

import { downloadDriveFile } from '@/lib/google-drive';
import { studioPreview } from '@/lib/poster-studio/images';
import { prisma } from '@/lib/prisma';

/**
 * Serves one AI Poster Studio image — a generation's output, or the input image
 * sent with it — to the studio workspace.
 *
 * Studio images are uploaded to Drive unpublished (see
 * `src/lib/poster-studio/storage.ts`), so no Google host will hand them to a
 * browser. This route fetches the bytes with the service account and returns
 * them to an operator already through the admin session — the same arrangement
 * as `/api/templates/[templateId]/thumbnail`.
 *
 * The session check is the middleware's, not this file's: `src/middleware.ts`
 * matches everything except its named exclusions, and this path is not one of
 * them. Do not add it to that list.
 *
 * Query parameters:
 *   variant   omitted: the final composited poster, or the raw artwork when no
 *             identity overlay was drawn
 *             "raw": exactly what the image model returned — what Edit and
 *             Variation send back to it
 *             "reference": the input image sent with the request (Mix: the base)
 *             "element-reference": Mix only — the image elements were taken from
 *   w         preview width, 1–2048 (default 640), re-encoded as WebP
 *   full      serve the stored file untouched
 *   download  with full, send it as an attachment
 */

// Buffers, sharp and the Drive SDK: Node, not edge.
export const runtime = 'nodejs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The largest output edge. Above it there is nothing left to serve. */
const MAX_WIDTH = 2048;
const DEFAULT_WIDTH = 640;

export async function GET(
  request: NextRequest,
  { params }: { params: { generationId: string } },
) {
  if (!UUID_PATTERN.test(params.generationId)) {
    return new NextResponse('Not found', { status: 404 });
  }

  const search = request.nextUrl.searchParams;
  const requestedVariant = search.get('variant');
  const variant =
    requestedVariant === 'reference' || requestedVariant === 'raw' || requestedVariant === 'element-reference'
      ? requestedVariant
      : 'final';

  let row;
  try {
    row = await prisma.posterStudioGeneration.findUnique({
      where: { id: params.generationId },
      select: {
        imageDriveFileId: true,
        imageMimeType: true,
        finalImageDriveFileId: true,
        finalImageMimeType: true,
        referenceDriveFileId: true,
        referenceMimeType: true,
        elementReferenceDriveFileId: true,
        elementReferenceMimeType: true,
      },
    });
  } catch (error) {
    console.error('[ace:studio-image] database lookup failed', params.generationId, error);
    return plainText('Could not look up this image.', 503);
  }

  if (!row) return new NextResponse('Not found', { status: 404 });

  const useFinal = variant === 'final' && row.finalImageDriveFileId !== null;
  const [fileId, storedMimeType] =
    variant === 'reference'
      ? [row.referenceDriveFileId, row.referenceMimeType]
      : variant === 'element-reference'
        ? [row.elementReferenceDriveFileId, row.elementReferenceMimeType]
        : useFinal
          ? [row.finalImageDriveFileId, row.finalImageMimeType]
          : [row.imageDriveFileId, row.imageMimeType];
  if (!fileId || !storedMimeType) return new NextResponse('Not found', { status: 404 });

  const full = search.get('full') === '1';
  const download = full && search.get('download') === '1';
  const requested = Number.parseInt(search.get('w') ?? '', 10);
  const width =
    Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_WIDTH) : DEFAULT_WIDTH;

  try {
    const stored = await downloadDriveFile(fileId);
    const image = full
      ? { body: stored, mimeType: storedMimeType }
      : await studioPreview(stored, storedMimeType, width);

    const headers: Record<string, string> = {
      'Content-Type': image.mimeType,
      /*
       * Immutable, because a studio row is: an edit or a variation is a new row
       * with a new id, never a rewrite of the file behind an existing URL.
       * Private, because the response is authorised only for the operator who
       * asked — a shared cache holding it would defeat the unpublished upload.
       */
      'Cache-Control': 'private, max-age=86400, immutable',
      'X-Content-Type-Options': 'nosniff',
    };

    if (download) {
      const extension = storedMimeType === 'image/webp' ? 'webp' : storedMimeType === 'image/jpeg' ? 'jpg' : 'png';
      const suffix =
        variant === 'reference' ? '-input' : variant === 'element-reference' ? '-element' : variant === 'raw' ? '-raw' : '';
      const name = `poster-studio-${params.generationId.slice(0, 8)}${suffix}.${extension}`;
      headers['Content-Disposition'] = `attachment; filename="${name}"`;
    }

    return new NextResponse(image.body as unknown as BodyInit, { status: 200, headers });
  } catch (error) {
    // The message only: a Drive client error object carries the request it made.
    console.error('[ace:studio-image]', params.generationId, variant, error instanceof Error ? error.message : error);
    return plainText('Could not load this image from Google Drive.', 502);
  }
}

function plainText(message: string, status: number): NextResponse {
  return new NextResponse(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
