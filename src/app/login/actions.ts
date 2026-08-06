'use server';

import { cookies, headers } from 'next/headers';
import { z } from 'zod';

import {
  createSessionToken,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  verifyPassword,
} from '@/lib/auth';
import type { ActionResult } from '@/app/admin/dashboard/actions';

/**
 * Sign-in and sign-out.
 *
 * Follows the console's convention of returning `ActionResult` rather than
 * throwing — see the header of `src/app/admin/dashboard/actions.ts`.
 */

const credentialsSchema = z.object({
  // No max: a passphrase manager entry can be long, and PBKDF2 cost does not
  // scale with input length.
  password: z.string().min(1, 'Enter the console password.'),
});

// ---------------------------------------------------------------------------
// Brute-force throttle
// ---------------------------------------------------------------------------

/**
 * Per-process failure counter, keyed by client IP.
 *
 * Deliberately in-memory: there is one app container, and a restart clearing the
 * counters is an acceptable trade for not putting a write on the hot path of
 * every failed login.
 *
 * **This is now the outermost defence.** It used to sit behind a Caddy Basic
 * Auth gateway, which is what actually stood between the internet and this
 * endpoint; that gateway was removed so the console takes one password instead
 * of two. What remains is a per-IP speed bump that a distributed attempt walks
 * straight past, and that a container restart resets. If this endpoint ever
 * starts drawing real guessing traffic, the fix is a shared store for these
 * counters or putting the gateway back — not a longer window here.
 */
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 8;

const failures = new Map<string, { count: number; firstAt: number }>();

function clientKey(): string {
  const forwarded = headers().get('x-forwarded-for');
  // Caddy appends, so the left-most entry is the original client.
  return forwarded?.split(',')[0]?.trim() || 'unknown';
}

function isThrottled(key: string, now: number): boolean {
  const record = failures.get(key);
  if (!record) return false;

  if (now - record.firstAt > FAILURE_WINDOW_MS) {
    failures.delete(key);
    return false;
  }

  return record.count >= MAX_FAILURES;
}

function recordFailure(key: string, now: number): void {
  const record = failures.get(key);

  if (!record || now - record.firstAt > FAILURE_WINDOW_MS) {
    failures.set(key, { count: 1, firstAt: now });
    return;
  }

  record.count += 1;

  // Unbounded growth would otherwise be a slow memory leak under a scripted
  // attack that rotates source addresses.
  if (failures.size > 1_000) {
    for (const [entryKey, entry] of failures) {
      if (now - entry.firstAt > FAILURE_WINDOW_MS) failures.delete(entryKey);
    }
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export async function login(formData: FormData): Promise<ActionResult<undefined>> {
  const parsed = credentialsSchema.safeParse({ password: formData.get('password') });

  if (!parsed.success) {
    return {
      ok: false,
      error: 'Enter the console password.',
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  const secret = process.env.SESSION_SECRET ?? '';
  const storedHash = process.env.ADMIN_PASSWORD_HASH ?? '';

  if (!secret || !storedHash) {
    console.error('[ace:auth] login attempted with SESSION_SECRET/ADMIN_PASSWORD_HASH unset');
    return { ok: false, error: 'Authentication is not configured on this deployment.' };
  }

  const now = Date.now();
  const key = clientKey();

  if (isThrottled(key, now)) {
    return { ok: false, error: 'Too many failed attempts. Try again in 15 minutes.' };
  }

  if (!(await verifyPassword(parsed.data.password, storedHash))) {
    recordFailure(key, now);
    console.warn(`[ace:auth] failed sign-in from ${key}`);
    return { ok: false, error: 'That password is not correct.' };
  }

  failures.delete(key);

  cookies().set(SESSION_COOKIE, await createSessionToken(secret), {
    httpOnly: true,
    sameSite: 'lax',
    // Mirrors the reasoning in `applySessionCookie`: derive from the actual
    // scheme, because a `secure` cookie over plain HTTP is dropped silently and
    // presents as a login that "succeeds" then bounces straight back.
    secure: headers().get('x-forwarded-proto') === 'https',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });

  return { ok: true, data: undefined };
}

export async function logout(): Promise<ActionResult<undefined>> {
  cookies().delete(SESSION_COOKIE);
  return { ok: true, data: undefined };
}
