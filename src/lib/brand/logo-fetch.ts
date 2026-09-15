import { intEnv } from '@/lib/env';
import {
  readImageDimensions,
  readSvgDimensions,
  type ImageDimensions,
} from '@/lib/poster/image-info';

/**
 * Guarded server-side access to a client's Brand Canvas logo bytes.
 *
 * One implementation for every caller that reads `Client.logoUrl` over HTTP.
 * The poster renderer and the Brand Canvas "remove background" action each used
 * to carry their own copy of these checks, and the AI Poster Studio needs the
 * same ones — three copies of a security boundary drift.
 *
 * The checks exist because of real failure modes, not caution in general:
 *   - a timeout, because a hung logo host must not hang a render;
 *   - a size cap, because a multi-megabyte "logo" is a mistake or an attack;
 *   - an `image/*` content type, because a Drive link whose sharing grant was
 *     never opened answers with an HTML interstitial *and a 200*.
 *
 * Callers keep their own failure policy: the renderer degrades to a wordmark,
 * the Brand Canvas action reports "could not be downloaded", and the studio stops
 * before spending on an image it could not brand.
 */

/** Refuses anything larger than this; a logo this big is a mistake, not a logo. */
export const MAX_BRAND_LOGO_BYTES = 4 * 1024 * 1024;

export class LogoFetchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LogoFetchError';
  }
}

export interface FetchedLogo {
  bytes: Buffer;
  /** Lower-cased `content-type` without parameters, or '' when the host sent none. */
  declaredType: string;
}

/**
 * Downloads a logo URL with the checks above. Throws `LogoFetchError` whose
 * message names a reason and never the URL, so it is safe to log or show.
 */
export async function fetchLogoUrl(url: string): Promise<FetchedLogo> {
  const timeoutMs = intEnv('POSTER_LOGO_TIMEOUT_MS', 15_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new LogoFetchError(`timed out after ${timeoutMs}ms`, { cause: error });
      }
      throw new LogoFetchError(
        `could not be reached (${error instanceof Error ? error.message : String(error)})`,
        { cause: error },
      );
    }

    if (!response.ok) {
      throw new LogoFetchError(`responded ${response.status} ${response.statusText}`);
    }

    const declaredType =
      response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (declaredType && !declaredType.startsWith('image/')) {
      throw new LogoFetchError(
        `served "${declaredType}" rather than an image — if this is a Google Drive ` +
          'link, the file is probably not shared link-readable',
      );
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength === 0) throw new LogoFetchError('the file was empty');
    if (bytes.byteLength > MAX_BRAND_LOGO_BYTES) {
      throw new LogoFetchError(
        `the file is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB, over the ${
          MAX_BRAND_LOGO_BYTES / 1024 / 1024
        } MB cap`,
      );
    }

    return { bytes, declaredType };
  } finally {
    clearTimeout(timer);
  }
}

export interface SniffedLogo {
  isSvg: boolean;
  /** Dimensions and the MIME type the bytes actually are. */
  dimensions: ImageDimensions;
}

/**
 * Works out what a logo's bytes are, trusting the bytes over any declared type.
 * Null when neither a raster header nor SVG size attributes can be read.
 */
export function sniffLogo(bytes: Buffer, declaredType = ''): SniffedLogo | null {
  const head = bytes.toString('utf8', 0, 300);
  const isSvg =
    declaredType === 'image/svg+xml' || head.trimStart().startsWith('<svg') || head.includes('<?xml');

  const dimensions = isSvg ? readSvgDimensions(bytes.toString('utf8')) : readImageDimensions(bytes);
  return dimensions ? { isSvg, dimensions } : null;
}
