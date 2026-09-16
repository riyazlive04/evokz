import { optionalEnv } from '@/lib/env';

/**
 * Temporary, signed links to a campaign poster — the media URL Evolution fetches.
 *
 * **Why this exists.** Evolution GO downloads media server-side and carries no
 * Google credentials, so it needs a URL it can fetch anonymously. Campaign and
 * Poster Studio images are uploaded to Drive **unpublished** on purpose
 * (`src/lib/poster-studio/storage.ts`), and publishing them so WhatsApp could
 * read them would make every poster world-readable forever, through a URL that
 * outlives the campaign. The legacy pipeline does publish its assets; this phase
 * does not extend that.
 *
 * Instead a link is minted per send: it names one poster version, expires in
 * minutes, and is signed so it cannot be guessed or edited. The route behind it
 * streams the bytes through the service account, exactly as the admin-session
 * image route does, and the Drive file stays private.
 *
 * **Not a permanent public URL architecture.** Nothing stores these tokens,
 * nothing lists them, and an expired one is refused. The only thing that can be
 * reached with a valid token is one poster image.
 *
 * Signed with `SESSION_SECRET` under its own domain prefix, so a media token can
 * never be presented as a session cookie and rotating the secret invalidates
 * outstanding links along with sessions.
 */

/** Long enough for a provider fetch and a retry, short enough to be worthless. */
export const MEDIA_TOKEN_TTL_SECONDS = 30 * 60;

const DOMAIN = 'campaign-media:v1';
const encoder = new TextEncoder();

export class MediaUrlNotConfiguredError extends Error {
  constructor() {
    super(
      'PUBLIC_BASE_URL is not set, so there is no address WhatsApp could fetch the poster from. ' +
        'Set it to this deployment\'s public origin, e.g. https://console.example.com.',
    );
    this.name = 'MediaUrlNotConfiguredError';
  }
}

/** True when a media link can be built at all. Checked before any send. */
export function isMediaDeliveryConfigured(): boolean {
  return normalizedBaseUrl() !== null;
}

/**
 * The absolute URL to hand the provider for one poster version.
 *
 * @throws MediaUrlNotConfiguredError when `PUBLIC_BASE_URL` is unset — never a
 * guessed origin, because a wrong one silently delivers nothing.
 */
export async function buildDeliveryMediaUrl(
  posterVersionId: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const base = normalizedBaseUrl();
  if (!base) throw new MediaUrlNotConfiguredError();
  const token = await mintMediaToken(posterVersionId, secret, nowSeconds);
  return `${base}/api/campaign-media/${token}`;
}

/** `<posterVersionId>~<expiryEpochSeconds>~<hmac>` */
export async function mintMediaToken(
  posterVersionId: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const expiry = nowSeconds + MEDIA_TOKEN_TTL_SECONDS;
  const payload = `${posterVersionId}~${expiry}`;
  return `${payload}~${await sign(payload, secret)}`;
}

export type MediaTokenResult =
  | { ok: true; posterVersionId: string }
  | { ok: false; reason: 'malformed' | 'expired' | 'bad-signature' | 'unconfigured' };

/**
 * Checks a token and returns the poster version it names.
 *
 * Signature before expiry, so a forged token cannot be distinguished from an
 * expired real one by timing. Fails closed on an unset secret.
 */
export async function verifyMediaToken(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<MediaTokenResult> {
  if (!secret) return { ok: false, reason: 'unconfigured' };

  const parts = token.split('~');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };

  const [posterVersionId, expiryRaw, signature] = parts as [string, string, string];
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(posterVersionId)) {
    return { ok: false, reason: 'malformed' };
  }

  const expiry = Number.parseInt(expiryRaw, 10);
  if (!Number.isFinite(expiry)) return { ok: false, reason: 'malformed' };

  const expected = await sign(`${posterVersionId}~${expiry}`, secret);
  if (!timingSafeEqual(signature, expected)) return { ok: false, reason: 'bad-signature' };
  if (expiry <= nowSeconds) return { ok: false, reason: 'expired' };

  return { ok: true, posterVersionId };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function normalizedBaseUrl(): string | null {
  const raw = optionalEnv('PUBLIC_BASE_URL', '');
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

async function sign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  // Domain-separated: the same secret signs session tokens, and a value valid
  // for one must never be valid for the other.
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${DOMAIN}:${payload}`));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Content-constant-time hex comparison — `===` would leak a correct prefix. */
function timingSafeEqual(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}
