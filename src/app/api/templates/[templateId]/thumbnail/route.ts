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
    select: { gDriveFileId: true, mimeType: true },
  });

  if (!template) return new NextResponse('Not found', { status: 404 });

  const requested = Number.parseInt(request.nextUrl.searchParams.get('w') ?? '', 10);
  const width =
    Number.isFinite(requested) && requested > 0
      ? Math.min(requested, MAX_WIDTH)
      : DEFAULT_WIDTH;
  const full = request.nextUrl.searchParams.get('full') === '1';

  try {
    const stored = await downloadDriveFile(template.gDriveFileId);
    const image = full
      ? { body: stored, mimeType: template.mimeType }
      : await templateThumbnail(stored, template.mimeType, width);

    return new NextResponse(image.body as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': image.mimeType,
        /*
         * Immutable, because it is: a template's bytes never change after
         * upload — replacing a reference means deleting the row and uploading
         * a new one, which mints a new id and therefore a new URL. Without
         * this every scroll back to page one is twenty-four Drive round-trips.
         *
         * Private, because the response is only authorised for the operator
         * who requested it. A shared cache holding these would hand a
         * non-member the exact bytes the unpublished upload exists to withhold.
         */
        'Cache-Control': 'private, max-age=86400, immutable',
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
