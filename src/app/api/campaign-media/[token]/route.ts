import { NextResponse, type NextRequest } from 'next/server';

import { verifyMediaToken } from '@/lib/campaign/delivery-media';
import { downloadDriveFile } from '@/lib/google-drive';
import { prisma } from '@/lib/prisma';

/**
 * Serves one campaign poster to the WhatsApp provider, for a few minutes.
 *
 * Evolution downloads media server-side and holds no Google credential, so it
 * needs an anonymous URL. Campaign posters live in Drive **unpublished**, and
 * this phase does not publish them: this route is the alternative. The caller
 * presents a signed, expiring token naming exactly one poster version; the
 * bytes are then fetched with the service account and streamed back.
 *
 * What a token can do is deliberately tiny: one poster image, for
 * `MEDIA_TOKEN_TTL_SECONDS`, and only for a version that actually has a
 * delivery record. It cannot be edited (HMAC), cannot be guessed, names no
 * Drive id, and grants nothing else.
 *
 * **Unauthenticated by design, like `/api/cron` and the Razorpay webhook.** It
 * is excluded from the session middleware because the provider is a machine
 * with no cookie, and it authenticates its own caller instead. Every failure is
 * a bare 404 with no detail — an expired token, a forged one and an unknown
 * poster are indistinguishable from outside.
 */

// Buffers and the Drive SDK: Node, not edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: { token: string } }) {
  const secret = process.env.SESSION_SECRET ?? '';
  const verified = await verifyMediaToken(params.token, secret);

  if (!verified.ok) {
    // One shape for every rejection, including an unset secret.
    if (verified.reason === 'unconfigured') {
      console.error('[ace:campaign-media] SESSION_SECRET is unset — refusing to serve poster media.');
    }
    return notFound();
  }

  let version;
  try {
    version = await prisma.posterVersion.findUnique({
      where: { id: verified.posterVersionId },
      select: {
        imageDriveFileId: true,
        imageMimeType: true,
        // A poster is reachable only while it is something we are delivering.
        deliveries: { select: { id: true }, take: 1 },
      },
    });
  } catch (error) {
    console.error('[ace:campaign-media] database lookup failed', error instanceof Error ? error.message : error);
    return new NextResponse('Unavailable', { status: 503 });
  }

  if (!version || version.deliveries.length === 0) return notFound();

  try {
    const bytes = await downloadDriveFile(version.imageDriveFileId);
    return new NextResponse(bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': version.imageMimeType,
        /*
         * Never cached anywhere. The URL is short-lived on purpose, and a proxy
         * holding a copy would outlive the token that authorised it.
         */
        'Cache-Control': 'private, no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'inline',
      },
    });
  } catch (error) {
    // The message only: a Drive client error object carries the request it made.
    console.error('[ace:campaign-media] Drive read failed', error instanceof Error ? error.message : error);
    return new NextResponse('Unavailable', { status: 502 });
  }
}

function notFound(): NextResponse {
  return new NextResponse('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
