import { intEnv, requireEnv } from '@/lib/env';

/**
 * The one Evolution API integration.
 *
 * This is the transport only: it builds the request, classifies the outcome and
 * says whether retrying could help. It has two callers and there is no other
 * code anywhere that talks to Evolution.
 *
 * - `src/lib/ai-pipeline.ts` — the legacy per-client calendar broadcast, which
 *   passes `tolerateUnreadableBody` to keep its long-standing behaviour exactly
 *   as it was.
 * - `src/lib/campaign/delivery-service.ts` — campaign day delivery (Phase 6),
 *   which does not tolerate an unreadable body and records the provider's
 *   message id when it returns one.
 *
 * **Evolution GO, not Node v2.** `POST /send/media` with `{url, type}` and no
 * instance path segment: the instance is selected by the API key, so each
 * instance's own token must be used. The global admin key is rejected with 401
 * on this route.
 *
 * **The API key never appears in a thrown message.** It travels in a header,
 * and every message this module builds is passed through `redactWhatsAppSecrets`
 * before it leaves, because callers persist these strings and the console
 * renders them.
 */

export interface WhatsAppMediaInput {
  /** E.164 without "+", e.g. "919876543210". */
  number: string;
  /** A URL the provider can fetch server-side. It carries no Google credential. */
  mediaUrl: string;
  caption: string;
  fileName: string;
}

export interface WhatsAppSendResult {
  /** The provider's id for the message, when it returns one. Null is normal. */
  providerMessageId: string | null;
}

/**
 * Why a send failed, and — through `retryable` — whether the same call could
 * succeed later.
 */
export type WhatsAppErrorKind =
  | 'config' // A required environment variable is unset
  | 'auth' // 401/403: the API key is wrong for this instance
  | 'recipient' // The provider rejected the destination
  | 'rate-limit' // 429
  | 'provider' // 5xx, 408, 425
  | 'network' // The request never completed
  | 'timeout' // No answer in time — ambiguous, see below
  | 'response'; // 2xx with a body that is not the contract

export class WhatsAppError extends Error {
  constructor(
    public readonly kind: WhatsAppErrorKind,
    message: string,
    public readonly retryable: boolean,
    public readonly status: number | null = null,
    options?: { cause?: unknown },
  ) {
    super(redactWhatsAppSecrets(message), options);
    this.name = 'WhatsAppError';
  }
}

export interface WhatsAppSendOptions {
  /**
   * Treat an empty or non-JSON 2xx body as success.
   *
   * Only the legacy pipeline sets this, because that is how it has always
   * behaved and changing it would alter a working flow. It is a real blind
   * spot — a gateway answering 200 with an HTML error page reads as delivered —
   * so campaign delivery leaves it off and fails loudly instead.
   */
  tolerateUnreadableBody?: boolean;
}

/** Sends one image with a caption. Resolves only when the provider accepted it. */
export async function sendWhatsAppMedia(
  input: WhatsAppMediaInput,
  options: WhatsAppSendOptions = {},
): Promise<WhatsAppSendResult> {
  let baseUrl: string;
  let apiKey: string;
  try {
    baseUrl = requireEnv('EVOLUTION_API_URL').replace(/\/+$/, '');
    apiKey = requireEnv('EVOLUTION_API_KEY');
  } catch (error) {
    // Named, never valued: the point of this branch is a legible config gap.
    throw new WhatsAppError('config', describe(error), false, null, { cause: error });
  }

  const timeoutMs = intEnv('EVOLUTION_TIMEOUT_MS', 60_000);
  const url = `${baseUrl}/send/media`;
  const host = hostOf(url);

  const response = await requestWithTimeout(url, host, timeoutMs, {
    method: 'POST',
    headers: {
      apikey: apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      number: input.number,
      url: input.mediaUrl,
      type: 'image',
      caption: input.caption,
      filename: input.fileName,
    }),
  });

  const rawBody = await readBody(response, host);

  if (!response.ok) {
    // Message format kept identical to the legacy pipeline's, because it is
    // persisted and operators recognise it.
    throw new WhatsAppError(
      classifyStatus(response.status, rawBody),
      `${host} responded ${response.status} ${response.statusText}: ${truncate(rawBody, 500)}`,
      isRetryableStatus(response.status),
      response.status,
    );
  }

  if (!rawBody.trim()) {
    if (options.tolerateUnreadableBody) return { providerMessageId: null };
    throw new WhatsAppError('response', `${host} returned an empty response body`, false, response.status);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    if (options.tolerateUnreadableBody) return { providerMessageId: null };
    throw new WhatsAppError(
      'response',
      `${host} returned non-JSON payload: ${truncate(rawBody, 300)}`,
      false,
      response.status,
    );
  }

  return { providerMessageId: extractMessageId(parsed) };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function classifyStatus(status: number, body: string): WhatsAppErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limit';
  if (status >= 500 || status === 408 || status === 425) return 'provider';
  // A 400/404 mentioning the destination is a bad number, not a bad request we
  // could fix by waiting. Evolution's wording varies, so this is a hint, not a
  // contract — either way the kind is permanent, only the message differs.
  if (/\bnumber\b|\bjid\b|not on whatsapp|recipient|exists/i.test(body)) return 'recipient';
  return 'provider';
}

/** 408, 425, 429 and 5xx are worth another attempt; every other 4xx is not. */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 425 || status === 429;
}

/**
 * Evolution GO's envelope is not stable across versions, so this looks in the
 * places it has been seen and gives up quietly. Nothing depends on the id.
 */
function extractMessageId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;
  const candidates: unknown[] = [
    (root.key as Record<string, unknown> | undefined)?.id,
    ((root.message as Record<string, unknown> | undefined)?.key as Record<string, unknown> | undefined)?.id,
    ((root.data as Record<string, unknown> | undefined)?.key as Record<string, unknown> | undefined)?.id,
    root.messageId,
    root.id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

async function requestWithTimeout(
  url: string,
  host: string,
  timeoutMs: number,
  init: { method: string; headers: Record<string, string>; body: string },
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: 'no-store' });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      /*
       * Not retryable, deliberately. A timeout is ambiguous: the message may
       * already be queued at the provider, so retrying risks sending the same
       * poster to the client twice. The delivery is left failed and permanent
       * for a person to decide about — the same reasoning the legacy pipeline
       * documents for never retrying its broadcast.
       */
      throw new WhatsAppError(
        'timeout',
        `Request to ${host} timed out after ${timeoutMs}ms`,
        false,
        null,
        { cause: error },
      );
    }
    // The request never completed, so nothing was queued: safe to try again.
    throw new WhatsAppError(
      'network',
      `Network failure calling ${host}: ${describe(error)}`,
      true,
      null,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}

async function readBody(response: Response, host: string): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    throw new WhatsAppError('response', `Could not read the response from ${host}: ${describe(error)}`, false, response.status, {
      cause: error,
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Removes credentials from anything about to be persisted or displayed.
 *
 * Exported because campaign delivery writes failure text from stages other than
 * the provider call (Drive reads, database errors) into the same column.
 */
export function redactWhatsAppSecrets(message: string): string {
  const secrets = [process.env.EVOLUTION_API_KEY, process.env.SESSION_SECRET, process.env.CRON_SECRET].filter(
    (value): value is string => typeof value === 'string' && value.length > 6,
  );
  return secrets.reduce((acc, secret) => acc.split(secret).join('«redacted»'), message);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'the Evolution API';
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

function truncate(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}
