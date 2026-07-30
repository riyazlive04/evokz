import crypto from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { describeError } from '@/lib/ai-pipeline';
import { optionalEnv } from '@/lib/env';
import { provisionClient } from '@/lib/onboarding';

/**
 * Razorpay event controller.
 *
 * Signature verification runs against the *raw* request body — any
 * parse-then-restringify round trip changes byte order and breaks the HMAC.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SIGNATURE_HEADER = 'x-razorpay-signature';

/**
 * Razorpay `notes` are free-form strings supplied at order creation. Keys are
 * accepted in both the snake_case documented for the checkout integration and
 * the camelCase some SDK wrappers emit.
 */
const notesSchema = z
  .record(z.string(), z.unknown())
  .transform((notes) => ({
    companyName: firstString(notes, ['company_name', 'companyName']),
    whatsappNumber: firstString(notes, [
      'whatsapp_phone',
      'whatsappPhone',
      'phone_number',
      'phoneNumber',
      'whatsapp_number',
    ]),
    planId: firstString(notes, ['plan_id', 'planId']),
    categoryId: firstString(notes, ['category_id', 'categoryId']),
    cronTime: firstString(notes, ['preferred_cron_time', 'cron_time', 'cronTime']),
    // Optional. Absent — the common case, since most checkouts do not collect it
    // — provisions on the fleet default.
    imageSizePreset: firstString(notes, [
      'image_size',
      'imageSize',
      'image_size_preset',
      'imageSizePreset',
    ]),
  }));

const webhookSchema = z.object({
  event: z.string(),
  payload: z
    .object({
      order: z
        .object({ entity: z.object({ id: z.string().optional(), notes: z.unknown().optional() }) })
        .optional(),
      payment: z
        .object({ entity: z.object({ id: z.string().optional(), notes: z.unknown().optional() }) })
        .optional(),
    })
    .default({}),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const secret = optionalEnv('RAZORPAY_WEBHOOK_SECRET', '');
  if (!secret) {
    // Misconfiguration, not a caller error — never accept unverified payloads.
    console.error('[ace:razorpay] RAZORPAY_WEBHOOK_SECRET is not configured');
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get(SIGNATURE_HEADER);

  if (!signature || !verifySignature(rawBody, signature, secret)) {
    // Deliberately opaque: an unauthenticated caller learns nothing about why.
    console.warn(
      `[ace:razorpay] rejected webhook — ${signature ? 'signature mismatch' : 'missing signature header'}`,
    );
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  let parsedEvent: z.infer<typeof webhookSchema>;
  try {
    parsedEvent = webhookSchema.parse(JSON.parse(rawBody));
  } catch (error) {
    console.warn(`[ace:razorpay] malformed payload: ${describeError(error)}`);
    return NextResponse.json({ error: 'Malformed payload' }, { status: 400 });
  }

  if (parsedEvent.event !== 'order.paid') {
    // 200 so Razorpay stops redelivering events this endpoint does not handle.
    return NextResponse.json({ ok: true, ignored: parsedEvent.event });
  }

  // `notes` set at order creation surface on the payment entity too; the
  // payment copy is preferred, with the order entity as fallback.
  const rawNotes =
    parsedEvent.payload.payment?.entity.notes ?? parsedEvent.payload.order?.entity.notes;
  const notesResult = notesSchema.safeParse(rawNotes ?? {});

  if (!notesResult.success) {
    console.error('[ace:razorpay] order.paid notes were not an object');
    return NextResponse.json({ error: 'Unusable order notes' }, { status: 422 });
  }

  const notes = notesResult.data;
  const orderId = parsedEvent.payload.order?.entity.id ?? 'unknown-order';

  const missing = (
    [
      ['company_name', notes.companyName],
      ['whatsapp_phone', notes.whatsappNumber],
      ['plan_id', notes.planId],
      ['category_id', notes.categoryId],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    // 422, not 400: the signature was valid, so this is a checkout-integration
    // bug worth surfacing in the Razorpay dashboard rather than a retry loop.
    console.error(
      `[ace:razorpay] order ${orderId} is missing required notes: ${missing.join(', ')}`,
    );
    return NextResponse.json(
      { error: 'Missing required order notes', missing },
      { status: 422 },
    );
  }

  try {
    const result = await provisionClient({
      companyName: notes.companyName as string,
      whatsappNumber: notes.whatsappNumber as string,
      planId: notes.planId as string,
      categoryId: notes.categoryId as string,
      cronTime: notes.cronTime ?? '09:00',
    });

    console.info(
      `[ace:razorpay] order ${orderId} -> client ${result.clientId} (${result.created ? 'created' : 'already provisioned'})`,
    );

    return NextResponse.json({
      ok: true,
      created: result.created,
      clientId: result.clientId,
      startDate: result.startDate.toISOString(),
      endDate: result.endDate.toISOString(),
      gDriveFolderId: result.gDriveFolderId,
      ...(result.driveWarning ? { driveWarning: result.driveWarning } : {}),
    });
  } catch (error) {
    const message = describeError(error);
    console.error(`[ace:razorpay] provisioning failed for order ${orderId}: ${message}`);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid order notes', issues: error.flatten().fieldErrors },
        { status: 422 },
      );
    }

    // 500 lets Razorpay retry a transient database fault; provisioning is
    // idempotent, so a retry cannot double-onboard the customer.
    return NextResponse.json({ error: 'Provisioning failed' }, { status: 500 });
  }
}

/** Constant-time HMAC SHA256 hex comparison. */
function verifySignature(rawBody: string, signature: string, secret: string): boolean {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('hex');

  const received = signature.trim();

  // timingSafeEqual throws on length mismatch, so guard before comparing.
  if (received.length !== expected.length) return false;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'utf8'),
      Buffer.from(received, 'utf8'),
    );
  } catch {
    return false;
  }
}

/** First non-empty string among `keys` in an untrusted record. */
function firstString(
  source: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}
