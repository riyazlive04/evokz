import { NextResponse, type NextRequest } from 'next/server';

import {
  createSessionToken,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  shouldRenew,
  verifySessionToken,
} from '@/lib/auth';

/**
 * The gate in front of the admin console.
 *
 * This exists because Next.js publishes Server Action IDs inside the public
 * client bundle: without a check that runs *before* the action does, every
 * mutation in `src/app/admin/dashboard/actions.ts` is invocable by anyone who
 * loads the page — including the ones that spend OpenAI/fal.ai credit and send
 * WhatsApp messages to real client numbers. Server actions POST to the route
 * they were rendered from, so covering `/admin/*` here covers them too.
 *
 * This is the *only* lock, in production as well as locally. Caddy used to hold
 * a Basic Auth gateway in front of the whole origin, so an operator answered a
 * browser popup and then this login; that outer lock was removed to leave one
 * credential. Nothing here may therefore be softened into a warning or a
 * redirect-on-failure — there is no longer anything behind it to catch a mistake.
 */

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const secret = process.env.SESSION_SECRET ?? '';
  const passwordHash = process.env.ADMIN_PASSWORD_HASH ?? '';

  // Fail closed, loudly. A missing secret must never degrade to "let everyone
  // in" — that is the exact state this middleware was added to end. 503 rather
  // than a redirect so the cause is legible in a log instead of looking like a
  // login loop.
  if (!secret || !passwordHash) {
    console.error(
      '[ace:auth] SESSION_SECRET and/or ADMIN_PASSWORD_HASH are unset — refusing all requests. ' +
        'Generate them with `node scripts/hash-password.mjs`.',
    );
    return NextResponse.json(
      { error: 'Authentication is not configured on this deployment.' },
      { status: 503 },
    );
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;

  if (await verifySessionToken(token, secret)) {
    if (token && shouldRenew(token)) {
      const response = NextResponse.next();
      applySessionCookie(response, await createSessionToken(secret), request);
      return response;
    }
    return NextResponse.next();
  }

  // A server action or any other non-GET arrives here only when the session
  // died mid-visit. Redirecting it would hand the client an HTML login page in
  // place of the action's expected payload, which surfaces as an unreadable
  // deserialisation error; 401 lets the caller's error channel report the truth.
  if (request.method !== 'GET' || request.headers.has('next-action')) {
    return NextResponse.json({ error: 'Session expired. Sign in again.' }, { status: 401 });
  }

  const loginUrl = new URL('/login', request.url);
  const target = request.nextUrl.pathname + request.nextUrl.search;
  // Path-only, and only when it is worth restoring. Echoing an absolute URL back
  // into a redirect would make this an open redirect.
  if (target !== '/' && !target.startsWith('//')) {
    loginUrl.searchParams.set('next', target);
  }

  return NextResponse.redirect(loginUrl);
}

/** Shared so the login action and the renewal path cannot drift apart. */
export function applySessionCookie(
  response: NextResponse,
  token: string,
  request: { nextUrl: { protocol: string } },
): void {
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    // Keyed off the request rather than NODE_ENV: `next start` over plain HTTP
    // during a VPS smoke test is still production, and a `secure` cookie would
    // silently never be stored.
    secure: request.nextUrl.protocol === 'https:',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

export const config = {
  /*
   * Everything except:
   *   api/webhooks/razorpay — verifies its own HMAC signature over the raw body
   *   api/cron              — verifies its own Bearer token and fails closed
   *   login                 — the unauthenticated entry point itself
   *   _next/static, _next/image, favicon.ico — build output, no data in them
   *
   * Both API exclusions authenticate their callers already, and neither can
   * present a session cookie: Razorpay and the system cron are machines.
   */
  matcher: [
    '/((?!api/webhooks/razorpay|api/cron|login|_next/static|_next/image|favicon.ico).*)',
  ],
};
