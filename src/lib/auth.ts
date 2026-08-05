/**
 * Session and password primitives for the admin console.
 *
 * **Everything here uses Web Crypto, never `node:crypto`.** `middleware.ts` runs
 * on the edge runtime, where the Node builtins are absent — a `node:crypto`
 * import there fails the build rather than at request time, but the constraint
 * is easy to forget when editing this file from the server side. Web Crypto is
 * present in both runtimes, so one module serves both.
 *
 * Threat model: a single shared operator credential, not a user directory. The
 * session is a stateless signed token — there is no session table to revoke
 * against, so rotating `SESSION_SECRET` is what invalidates every live session.
 */

export const SESSION_COOKIE = 'evokz_session';

/** Twelve hours, renewed on use — see `shouldRenew`. */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

/** PBKDF2 rounds. OWASP's 2023 floor for PBKDF2-HMAC-SHA256. */
const PBKDF2_ITERATIONS = 210_000;

const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Session tokens
// ---------------------------------------------------------------------------

/**
 * Mints `<expiryEpochSeconds>.<hmac>`.
 *
 * The expiry is inside the signed payload rather than relied upon through the
 * cookie's own `Max-Age`: cookie attributes are client-side hints that a caller
 * can simply not honour, so a token whose deadline lived only there would stay
 * valid forever to anyone who kept a copy.
 */
export async function createSessionToken(
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const expiry = nowSeconds + SESSION_TTL_SECONDS;
  const signature = await sign(String(expiry), secret);
  return `${expiry}.${signature}`;
}

/** True when `token` carries an intact signature and has not expired. */
export async function verifySessionToken(
  token: string | undefined,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!token || !secret) return false;

  const separator = token.lastIndexOf('.');
  if (separator <= 0) return false;

  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);

  const expiry = Number.parseInt(payload, 10);
  if (!Number.isFinite(expiry)) return false;

  // Signature first, expiry second. Checking the cheap numeric field first
  // would answer "was this ever a real token?" to an attacker probing with
  // forged payloads.
  const expected = await sign(payload, secret);
  if (!timingSafeEqual(signature, expected)) return false;

  return expiry > nowSeconds;
}

/**
 * True once a token is past the halfway mark of its lifetime.
 *
 * Renewing on every request would rewrite `Set-Cookie` on every asset fetch;
 * renewing only at the halfway point keeps an active operator logged in
 * indefinitely while still expiring an idle session on schedule.
 */
export function shouldRenew(
  token: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  const expiry = Number.parseInt(token.slice(0, token.lastIndexOf('.')), 10);
  if (!Number.isFinite(expiry)) return false;
  return expiry - nowSeconds < SESSION_TTL_SECONDS / 2;
}

async function sign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return toHex(new Uint8Array(signature));
}

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

/**
 * Derives a verifier string: `pbkdf2-sha256:<iterations>:<saltHex>:<hashHex>`.
 *
 * Self-describing so the iteration count can be raised later without
 * invalidating hashes already in use — `verifyPassword` reads the cost from the
 * stored value rather than assuming the current constant.
 *
 * **Colon-delimited, not the conventional `$`.** This value lives in `.env`, and
 * Next.js pipes that file through `dotenv-expand`: a `$210000` segment reads as
 * a reference to an undefined variable and expands to nothing, so the stored
 * hash silently loses its cost field and every login fails with no clue why.
 * Docker Compose's `env_file` does no expansion, so the same file would behave
 * differently in the container than under `next dev` — a colon sidesteps the
 * divergence entirely. Hex has no colons, so the split stays unambiguous.
 */
export async function hashPassword(
  password: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await derive(password, salt, iterations);
  return `pbkdf2-sha256:${iterations}:${toHex(salt)}:${toHex(derived)}`;
}

/** Constant-time check of `password` against a stored verifier. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, cost, saltHex, expectedHex] = stored.split(':');
  if (scheme !== 'pbkdf2-sha256' || !cost || !saltHex || !expectedHex) return false;

  const iterations = Number.parseInt(cost, 10);
  const salt = fromHex(saltHex);
  if (!Number.isFinite(iterations) || iterations <= 0 || salt === null) return false;

  const derived = await derive(password, salt, iterations);
  return timingSafeEqual(toHex(derived), expectedHex);
}

async function derive(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return new Uint8Array(bits);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Length-independent, content-constant-time comparison of two hex strings.
 *
 * `===` on strings short-circuits at the first differing byte, which leaks the
 * length of a correct prefix to anyone able to time enough attempts. There is no
 * `timingSafeEqual` on the edge runtime, so this is done by hand.
 */
function timingSafeEqual(a: string, b: string): boolean {
  // Comparing over the longer of the two keeps the loop count independent of
  // which argument is short, so an early length mismatch is not itself a signal.
  const length = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;

  for (let index = 0; index < length; index += 1) {
    mismatch |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }

  return mismatch === 0;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;

  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
