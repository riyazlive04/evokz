import { NextResponse } from 'next/server';

import { rendererHealth } from '@/lib/poster/html/browser';

/**
 * What the container's health check reads.
 *
 * **Why this exists.** The check used to be `curl /login`, which asks whether
 * the web server is up. It is a fair question and not the interesting one: the
 * platform's job is drawing posters, and a renderer that cannot draw one leaves
 * the login page serving perfectly. A dead Chromium therefore reported
 * `healthy` indefinitely, and the first person to know was a client who did not
 * get their poster.
 *
 * **What it does not do.** It does not render a probe poster. A synthetic render
 * on a timer costs a browser context every interval and, because this route is
 * unauthenticated, hands anyone who finds the URL a lever to spend the box's
 * memory. It reports the outcome of the renders the platform was doing anyway —
 * see `recordRenderOutcome`. The cost of that is honest and worth stating: a
 * process that has rendered nothing reports healthy, because it has nothing to
 * prove yet.
 *
 * **Unauthenticated, and carrying nothing.** `src/middleware.ts` names this
 * route as an exception so the check can reach it without a session, which puts
 * it in the same company as the Razorpay webhook and the cron endpoint. Those
 * two authenticate their own callers; this one instead has nothing worth
 * authenticating for. It returns counts, timestamps and a one-word browser
 * state — no error text, because a render failure's message can hold a Drive
 * URL, a client's name or a filesystem path. The reason lives in the logs,
 * behind the session.
 *
 * 503 rather than 200-with-a-flag, so `curl -fsS` fails without needing to
 * parse the body.
 */

// `rendererHealth` reads process-local state, so this must not be cached or
// statically evaluated at build time.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const renderer = rendererHealth();
  const body = { ok: renderer.ok, renderer };

  return NextResponse.json(body, {
    status: renderer.ok ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}
