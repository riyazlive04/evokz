import { NextResponse, type NextRequest } from 'next/server';

import { downloadDriveFile } from '@/lib/google-drive';
import { prisma } from '@/lib/prisma';
import { templateThumbnail } from '@/lib/template-image';

/**
 * Serves one reference template's image to the vertical gallery.
 *
 * Reference posters are uploaded unpublished — see `DriveUploadInput.publish` —
 * so no Google host will hand them to a browser. This route is how they are
 * seen: it fetches the bytes with the service account's own credentials and
 * returns them to an operator who is already through the admin session.
 *
 * The session check is the middleware's, not this file's. `src/middleware.ts`
 * matches everything bar three named exceptions, and this is not one of them —
 * an unauthenticated GET is redirected to `/login` before the handler runs. Do
 * not add this path to that matcher's exclusion list.
 *
 * Query parameters:
 *   w     thumbnail width, 1–1600 (default 640)
 *   full  serve the stored file untouched, for a proper look at a reference
 *   plate serve the template's clean plate instead of the reference
 *
 * The plate is served through the same route rather than its own because it is
 * the same thing under the same rule: an unpublished Drive object belonging to
 * one template, readable only by an operator with a session. `templateThumbnail`
 * re-encodes to WebP, which carries the alpha the plate path depends on — the
 * region editor draws its boxes over the holes, so a thumbnail that flattened
 * them onto white would hide exactly what an operator is placing type around.
 */

// Buffers, sharp and the Drive SDK: Node, not edge.
export const runtime = 'nodejs';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Above the stored long edge there is nothing left to serve. */
const MAX_WIDTH = 1600;
const DEFAULT_WIDTH = 640;

export async function GET(
  request: NextRequest,
  { params }: { params: { templateId: string } },
) {
  if (!UUID_PATTERN.test(params.templateId)) {
    return new NextResponse('Not found', { status: 404 });
  }

  const template = await prisma.categoryTemplate.findUnique({
    where: { id: params.templateId },
    select: { gDriveFileId: true, mimeType: true, plateDriveFileId: true },
  });

  if (!template) return new NextResponse('Not found', { status: 404 });

  const wantsPlate = request.nextUrl.searchParams.get('plate') === '1';
  // 404 rather than falling back to the reference. A silent substitution would
  // show the region editor the poster's own words where it promised the erased
  // artwork, which is the one image an operator must not confuse for the other.
  if (wantsPlate && !template.plateDriveFileId) {
    return new NextResponse('Not found', { status: 404 });
  }

  const fileId = wantsPlate ? (template.plateDriveFileId as string) : template.gDriveFileId;
  // Plates are always stored as uploaded, and `uploadTemplatePlate` accepts
  // nothing but PNG.
  const storedMimeType = wantsPlate ? 'image/png' : template.mimeType;

  const requested = Number.parseInt(request.nextUrl.searchParams.get('w') ?? '', 10);
  const width =
    Number.isFinite(requested) && requested > 0
      ? Math.min(requested, MAX_WIDTH)
      : DEFAULT_WIDTH;
  const full = request.nextUrl.searchParams.get('full') === '1';

  try {
    const stored = await downloadDriveFile(fileId);
    const image = full
      ? { body: stored, mimeType: storedMimeType }
      : await templateThumbnail(stored, storedMimeType, width);

    return new NextResponse(image.body as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': image.mimeType,
        /*
         * Immutable, because a *reference* is: its bytes never change after
         * upload — replacing one means deleting the row and uploading a new
         * one, which mints a new id and therefore a new URL. Without this every
         * scroll back to page one is twenty-four Drive round-trips.
         *
         * **A plate is the exception, and must never be cached that way.**
         * "Replace plate" writes a new Drive file onto the same template id, so
         * the URL outlives the bytes — and re-exporting a plate to nudge one
         * mask is the commonest edit there is. Cached immutably, the operator
         * would nudge a mask, re-upload, and see the plate they had, with the
         * region editor drawing boxes over holes that had moved.
         *
         * Private in both cases, because the response is only authorised for the
         * operator who requested it. A shared cache holding these would hand a
         * non-member the exact bytes the unpublished upload exists to withhold.
         */
        'Cache-Control': wantsPlate
          ? 'private, no-cache'
          : 'private, max-age=86400, immutable',
      },
    });
  } catch (error) {
    console.error('[ace:template-thumbnail]', params.templateId, error);
    // Plain text: this is consumed by an <img>, where a JSON body is noise and
    // the status code is what the browser acts on.
    return new NextResponse('Could not load this template image.', {
      status: 502,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}
