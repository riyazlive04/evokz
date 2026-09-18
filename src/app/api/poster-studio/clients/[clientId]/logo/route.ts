import { NextResponse, type NextRequest } from 'next/server';

import { loadStudioBrandCanvas } from '@/lib/poster-studio/brand-context';
import { resolveStudioLogo } from '@/lib/poster-studio/brand-logo';
import { trimLogoPadding } from '@/lib/poster-studio/compose';
import { StudioError } from '@/lib/poster-studio/errors';
import { studioPreview } from '@/lib/poster-studio/images';

/**
 * Previews a client's Brand Canvas logo in the AI Poster Studio, as a given
 * poster would draw it.
 *
 * The browser never learns where the logo lives. The client id is the only input;
 * the Drive file id or logo URL is resolved and read server-side, through the
 * service account for a Drive-backed logo, so this works whatever the file's
 * sharing is and without making anything public for the studio.
 *
 * Read-only: "Remove background" for a logo Brand Canvas has not keyed is keyed
 * in memory for the preview and discarded. Nothing is written to the client.
 *
 * Behind the admin session: `src/middleware.ts` gates every path not in its
 * exclusion list, and this one is not in it.
 *
 * Query parameters:
 *   background  ORIGINAL (default) | REMOVED
 *   w           preview width, 1–1024 (default 240)
 *   trim        1 to cut the transparent padding away first, as a clone's
 *               compositor does — what the template editor's logo-placement
 *               preview draws, so it shows the mark at the proportions the
 *               poster will actually use.
 */

export const runtime = 'nodejs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_WIDTH = 1024;
const DEFAULT_WIDTH = 240;

export async function GET(request: NextRequest, { params }: { params: { clientId: string } }) {
  if (!UUID_PATTERN.test(params.clientId)) return plainText('Not found', 404);

  const search = request.nextUrl.searchParams;
  const background = search.get('background') === 'REMOVED' ? 'REMOVED' : 'ORIGINAL';
  const requested = Number.parseInt(search.get('w') ?? '', 10);
  const width = Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_WIDTH) : DEFAULT_WIDTH;

  try {
    const canvas = await loadStudioBrandCanvas(params.clientId);
    const resolved = await resolveStudioLogo(canvas.logo, background);
    const logo = search.get('trim') === '1' ? await trimLogoPadding(resolved) : resolved;
    const preview = await studioPreview(logo.bytes, logo.mimeType, width);

    return new NextResponse(preview.body as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': preview.mimeType,
        // Short and private: Brand Canvas can replace the logo at any time, and
        // the response is authorised only for the operator who asked.
        'Cache-Control': 'private, max-age=60',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    if (error instanceof StudioError) {
      if (error.kind === 'validation') return plainText('Not found', 404);
      if (error.kind === 'logo-background') return plainText(error.message, 422);
      if (error.kind === 'logo') return plainText(error.message, 404);
    }
    console.error('[ace:studio-logo]', params.clientId, background, error);
    return plainText('Could not load this logo.', 502);
  }
}

function plainText(message: string, status: number): NextResponse {
  return new NextResponse(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
