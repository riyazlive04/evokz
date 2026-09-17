import { NextResponse } from 'next/server';

/**
 * What the container's health check reads (see the Dockerfile's HEALTHCHECK).
 *
 * A liveness answer: the Next server is up and serving route handlers. It used
 * to also report the retired HTML poster renderer's recent render outcomes;
 * nothing renders through that renderer any more, so there is nothing further
 * to report here.
 *
 * **Unauthenticated, and carrying nothing.** `src/middleware.ts` names this
 * route as an exception so the check can reach it without a session, which puts
 * it in the same company as the Razorpay webhook and the cron endpoint. Those
 * two authenticate their own callers; this one has nothing worth authenticating
 * for — it returns no data at all.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    { ok: true },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  );
}
