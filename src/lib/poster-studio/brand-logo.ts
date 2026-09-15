import { createHash } from 'node:crypto';

import { fetchLogoUrl, LogoFetchError, MAX_BRAND_LOGO_BYTES, sniffLogo } from '@/lib/brand/logo-fetch';
import { downloadDriveFile } from '@/lib/google-drive';
import { StudioError } from '@/lib/poster-studio/errors';
import type { StudioLogoBackground } from '@/lib/poster-studio/limits';
import {
  describeLogoKeySkip,
  keyLogoBackground,
  measureInkLuminance,
} from '@/lib/poster/logo-key';

/**
 * Reads a client's Brand Canvas logo for an AI Poster Studio poster.
 *
 * **Read-only with respect to Brand Canvas.** Nothing here writes to `Client`,
 * uploads, moves or trashes a logo file, or calls the Brand Canvas logo actions
 * (`uploadClientLogo`, `removeClientLogoBackground`, `revertClientLogoBackground`,
 * `setClientLogoUrl`). A per-poster "Remove background" that Brand Canvas has not
 * already done is keyed in memory and lives only in that poster's composite.
 *
 * Which column holds the exact uploaded file, per the invariant documented on
 * `Client` in schema.prisma:
 *
 *   logoBackgroundRemoved = true   logoUrl / logoDriveFileId is Brand Canvas's keyed
 *                                  PNG; logoOriginal* is the file as uploaded
 *   logoBackgroundRemoved = false  logoUrl / logoDriveFileId is the file as uploaded
 *
 * Bytes are fetched server-side and never reach the browser as a Drive id or URL:
 * a Drive-backed logo through the service account (`downloadDriveFile`), so the
 * studio does not depend on the file's public link; an externally hosted logo
 * through the shared guarded fetcher.
 */

export interface BrandCanvasLogoFields {
  logoUrl: string | null;
  logoDriveFileId: string | null;
  logoOriginalUrl: string | null;
  logoOriginalDriveFileId: string | null;
  logoBackgroundRemoved: boolean;
}

/** How the bytes a poster draws were arrived at. Recorded nowhere; surfaced for the UI. */
export type StudioLogoProcessing =
  /** "Keep original": the exact uploaded file. */
  | 'as-uploaded'
  /** "Remove background": the transparent version Brand Canvas already made. */
  | 'brand-canvas-removed'
  /** "Remove background": keyed in memory for this poster only. */
  | 'keyed-for-poster'
  /** "Remove background": the upload already carries transparency. */
  | 'already-transparent'
  /** "Remove background": SVG, which has no raster background. */
  | 'vector';

export interface ResolvedStudioLogo {
  background: StudioLogoBackground;
  processing: StudioLogoProcessing;
  bytes: Buffer;
  /** What the bytes actually are, sniffed rather than trusted. */
  mimeType: string;
  isSvg: boolean;
  width: number;
  height: number;
  /** Mean luminance of opaque pixels, 0–1; null for SVG or when unmeasurable. */
  inkLuminance: number | null;
}

interface LogoRef {
  driveFileId: string | null;
  url: string | null;
}

export function hasBrandCanvasLogo(fields: BrandCanvasLogoFields): boolean {
  return originalRef(fields) !== null;
}

/** The exact uploaded logo. */
function originalRef(fields: BrandCanvasLogoFields): LogoRef | null {
  const ref = fields.logoBackgroundRemoved
    ? { driveFileId: fields.logoOriginalDriveFileId, url: fields.logoOriginalUrl }
    : { driveFileId: fields.logoDriveFileId, url: fields.logoUrl };
  return ref.driveFileId || ref.url ? ref : null;
}

/** Brand Canvas's own transparent version, when it has made one. */
function brandCanvasRemovedRef(fields: BrandCanvasLogoFields): LogoRef | null {
  if (!fields.logoBackgroundRemoved) return null;
  const ref = { driveFileId: fields.logoDriveFileId, url: fields.logoUrl };
  return ref.driveFileId || ref.url ? ref : null;
}

export async function resolveStudioLogo(
  fields: BrandCanvasLogoFields,
  background: StudioLogoBackground,
): Promise<ResolvedStudioLogo> {
  const original = originalRef(fields);
  if (!original) {
    throw new StudioError(
      'logo',
      fields.logoBackgroundRemoved
        ? "This client's original uploaded logo is not on record in Brand Canvas. Re-upload the logo in Brand Canvas."
        : 'This client has no logo in Brand Canvas. Add one there, or turn off the logo for this poster.',
    );
  }

  if (background === 'ORIGINAL') {
    const loaded = await loadLogo(original);
    return toResolved(loaded, 'ORIGINAL', 'as-uploaded', loaded.bytes);
  }

  const existing = brandCanvasRemovedRef(fields);
  if (existing) {
    const loaded = await loadLogo(existing);
    return toResolved(loaded, 'REMOVED', 'brand-canvas-removed', loaded.bytes);
  }

  const loaded = await loadLogo(original);
  if (loaded.isSvg) return toResolved(loaded, 'REMOVED', 'vector', loaded.bytes);

  const keyed = await keyedForPoster(loaded);
  if (keyed.keyed) {
    return {
      background: 'REMOVED',
      processing: 'keyed-for-poster',
      bytes: keyed.png,
      mimeType: 'image/png',
      isSvg: false,
      width: keyed.width,
      height: keyed.height,
      inkLuminance: keyed.inkLuminance,
    };
  }

  switch (keyed.reason) {
    case 'already-transparent':
      return toResolved(loaded, 'REMOVED', 'already-transparent', loaded.bytes);
    case 'vector':
      return toResolved(loaded, 'REMOVED', 'vector', loaded.bytes);
    default:
      // Never a silent fallback to the original: the operator asked for a
      // transparent logo, and a white rectangle on the poster is not that.
      throw new StudioError(
        'logo-background',
        `${describeLogoKeySkip(keyed.reason)} Choose "Keep original" for this poster, or fix the logo in Brand Canvas.`,
      );
  }
}

// ---------------------------------------------------------------------------
// Loading and caching
// ---------------------------------------------------------------------------

interface LoadedLogo {
  bytes: Buffer;
  mimeType: string;
  isSvg: boolean;
  width: number;
  height: number;
}

/**
 * Process-lifetime caches, bounded.
 *
 * Brand Canvas never rewrites a logo file in place — a re-upload, a removal and a
 * revert each point the client at a different Drive file or URL — so bytes keyed
 * by file id or URL cannot go stale for a Drive-backed logo. Promises are cached
 * so concurrent requests share one download; failures are evicted.
 */
const MAX_CACHED = 32;
const loadCache = new Map<string, Promise<LoadedLogo>>();
const keyCache = new Map<string, ReturnType<typeof keyLogoBackground>>();

function remember<T>(cache: Map<string, Promise<T>>, key: string, work: () => Promise<T>): Promise<T> {
  const cached = cache.get(key);
  if (cached) return cached;
  if (cache.size >= MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  const pending = work();
  cache.set(key, pending);
  pending.catch(() => cache.delete(key));
  return pending;
}

function loadLogo(ref: LogoRef): Promise<LoadedLogo> {
  const key = ref.driveFileId ? `drive:${ref.driveFileId}` : `url:${ref.url}`;
  return remember(loadCache, key, () => fetchLogoBytes(ref));
}

function keyedForPoster(logo: LoadedLogo): ReturnType<typeof keyLogoBackground> {
  // Keyed on a digest of the bytes: keying is deterministic, so the same file
  // always yields the same transparent version and there is no reason to redo it.
  const key = createHash('sha256').update(logo.bytes).digest('hex');
  return remember(keyCache, key, () => keyLogoBackground(logo.bytes, logo.mimeType));
}

async function fetchLogoBytes(ref: LogoRef): Promise<LoadedLogo> {
  let bytes: Buffer;
  let declaredType = '';

  if (ref.driveFileId) {
    try {
      bytes = await downloadDriveFile(ref.driveFileId);
    } catch (error) {
      console.error(
        '[studio:logo] Brand Canvas logo download from Drive failed:',
        error instanceof Error ? error.message : error,
      );
      throw new StudioError(
        'logo',
        "The client's logo could not be read from Google Drive. Check the logo in Brand Canvas and try again.",
        { cause: error },
      );
    }
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_BRAND_LOGO_BYTES) {
      throw new StudioError('logo', "The client's logo file is empty or larger than 4 MB. Replace it in Brand Canvas.");
    }
  } else {
    try {
      ({ bytes, declaredType } = await fetchLogoUrl(ref.url ?? ''));
    } catch (error) {
      const reason = error instanceof LogoFetchError ? error.message : 'could not be downloaded';
      throw new StudioError('logo', `The client's logo link ${reason}. Fix the logo in Brand Canvas.`, {
        cause: error,
      });
    }
  }

  const sniffed = sniffLogo(bytes, declaredType);
  if (!sniffed) {
    throw new StudioError('logo', "The client's logo could not be read as an image. Replace it in Brand Canvas.");
  }

  return {
    bytes,
    mimeType: sniffed.dimensions.mimeType,
    isSvg: sniffed.isSvg,
    width: sniffed.dimensions.width,
    height: sniffed.dimensions.height,
  };
}

async function toResolved(
  loaded: LoadedLogo,
  background: StudioLogoBackground,
  processing: StudioLogoProcessing,
  bytes: Buffer,
): Promise<ResolvedStudioLogo> {
  return {
    background,
    processing,
    bytes,
    mimeType: loaded.mimeType,
    isSvg: loaded.isSvg,
    width: loaded.width,
    height: loaded.height,
    inkLuminance: loaded.isSvg ? null : await measureInkLuminance(bytes, loaded.mimeType),
  };
}
