import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { intEnv, optionalEnv } from '@/lib/env';
import type { PosterFontChoice } from '@/lib/types/poster';

/**
 * Font byte loading for the poster renderer.
 *
 * Satori rasterises text itself and has no access to system fonts, so every face
 * must be handed to it as a buffer. Two sources, in order:
 *
 *   1. A local directory (`POSTER_FONT_DIR`), if the file is present. Preferred
 *      in production — no network dependency inside the render path.
 *   2. Google Fonts, fetched once per process and cached in memory.
 *
 * **The legacy User-Agent is load-bearing.** `fonts.googleapis.com/css2` performs
 * UA sniffing and serves `woff2` to any modern browser string. Satori's font parser
 * reads TTF, OTF and WOFF but *not* WOFF2 — the Brotli table compression is a
 * different container entirely. Sending an old UA makes Google downgrade to a
 * format we can parse (in practice `format('woff')`; some families still offer
 * truetype). Remove the header and every render fails with an opaque
 * "Unsupported OpenType signature wOF2".
 */

const GOOGLE_CSS_ENDPOINT = 'https://fonts.googleapis.com/css2';

/**
 * IE-era UA string. Anything Google recognises as pre-WOFF2 works; this one is
 * stable and unambiguous.
 */
const LEGACY_USER_AGENT =
  'Mozilla/5.0 (Windows NT 6.1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/28.0.1500.95 Safari/537.36';

export interface LoadedFont {
  name: string;
  data: ArrayBuffer;
  weight: 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;
  style: 'normal' | 'italic';
}

/**
 * Process-lifetime cache, keyed `Family:weight`.
 *
 * Holds the in-flight promise rather than the resolved buffer so that a burst of
 * concurrent renders — the dispatch sweep firing several clients in the same
 * minute — collapses onto one fetch per face instead of one per render.
 */
const fontCache = new Map<string, Promise<ArrayBuffer>>();

function cacheKey(family: string, weight: number): string {
  return `${family}:${weight}`;
}

/** Loads every weight of every face a theme needs, in parallel. */
export async function loadFonts(faces: PosterFontChoice[]): Promise<LoadedFont[]> {
  const requests: Array<Promise<LoadedFont | null>> = [];

  for (const face of faces) {
    for (const weight of face.weights) {
      requests.push(
        loadFace(face.family, weight)
          .then((data) => ({
            name: face.family,
            data,
            weight: normalizeWeight(weight),
            style: 'normal' as const,
          }))
          .catch((error: unknown) => {
            // One missing weight must not fail the render: satori synthesises
            // from the nearest available weight, which is visibly worse but
            // still delivers a poster. A face with *no* weights loaded is caught
            // by the caller.
            console.warn(
              `[ace:poster] could not load ${face.family} ${weight}: ${describe(error)}`,
            );
            return null;
          }),
      );
    }
  }

  const settled = await Promise.all(requests);
  const loaded = settled.filter((font): font is LoadedFont => font !== null);

  if (loaded.length === 0) {
    throw new Error(
      `No font could be loaded for [${faces
        .map((face) => face.family)
        .join(', ')}]. Satori cannot render text without at least one face — ` +
        'set POSTER_FONT_DIR to a directory of TTFs if this environment has no outbound network access.',
    );
  }

  return loaded;
}

async function loadFace(family: string, weight: number): Promise<ArrayBuffer> {
  const key = cacheKey(family, weight);
  const cached = fontCache.get(key);
  if (cached) return cached;

  const request = readLocalFace(family, weight).then(
    (local) => local ?? fetchGoogleFace(family, weight),
  );

  fontCache.set(key, request);

  // A transient fetch failure must not poison the cache for the process's
  // lifetime — every later render would inherit the rejection.
  request.catch(() => {
    fontCache.delete(key);
  });

  return request;
}

// ---------------------------------------------------------------------------
// Local directory source
// ---------------------------------------------------------------------------

/**
 * Looks for `<dir>/<Family>-<weight>.ttf`, e.g. `Inter-400.ttf`, plus a couple
 * of common alternate spellings. Returns null when the directory is unset or the
 * file is absent, which is the normal case rather than an error.
 */
async function readLocalFace(
  family: string,
  weight: number,
): Promise<ArrayBuffer | null> {
  const dir = optionalEnv('POSTER_FONT_DIR', '');
  if (!dir) return null;

  const compact = family.replace(/\s+/g, '');
  const candidates = [
    `${compact}-${weight}.ttf`,
    `${compact}-${weight}.otf`,
    `${family}-${weight}.ttf`,
    `${compact}.ttf`,
  ];

  for (const name of candidates) {
    try {
      const buffer = await readFile(path.join(dir, name));
      return toArrayBuffer(buffer);
    } catch {
      // Try the next spelling.
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Google Fonts source
// ---------------------------------------------------------------------------

async function fetchGoogleFace(family: string, weight: number): Promise<ArrayBuffer> {
  const timeoutMs = intEnv('POSTER_FONT_TIMEOUT_MS', 15_000);
  const url = `${GOOGLE_CSS_ENDPOINT}?family=${encodeURIComponent(family)}:wght@${weight}&display=swap`;

  const cssResponse = await fetchWithTimeout(
    url,
    { 'User-Agent': LEGACY_USER_AGENT },
    timeoutMs,
  );

  if (!cssResponse.ok) {
    throw new Error(
      `Google Fonts returned ${cssResponse.status} for "${family}" weight ${weight}` +
        (cssResponse.status === 400
          ? ' — the family probably does not publish that weight'
          : ''),
    );
  }

  const css = await cssResponse.text();
  const fileUrl = extractUsableFontUrl(css);
  if (!fileUrl) {
    throw new Error(
      `No parseable font source in the Google Fonts CSS for "${family}" weight ${weight} — ` +
        'only woff2 was offered, which means the legacy User-Agent header was dropped.',
    );
  }

  const fileResponse = await fetchWithTimeout(fileUrl, {}, timeoutMs);
  if (!fileResponse.ok) {
    throw new Error(`Font file download failed with ${fileResponse.status}`);
  }

  const bytes = await fileResponse.arrayBuffer();
  if (bytes.byteLength === 0) {
    throw new Error(`Font file for "${family}" weight ${weight} was empty`);
  }

  return bytes;
}

/**
 * Pulls a parseable font URL out of the CSS.
 *
 * Order of preference is truetype, then woff, then a bare `.ttf`/`.otf` URL. WOFF2
 * is never accepted — satori's parser cannot decompress it, and picking one yields
 * "Unsupported OpenType signature wOF2" at render time rather than here.
 *
 * The explicit ordering matters because Google returns several `@font-face` blocks
 * for different unicode subsets. Taking the first `url(...)` blindly can land on a
 * woff2 block even when a usable one exists further down.
 */
function extractUsableFontUrl(css: string): string | null {
  for (const format of ['truetype', 'woff'] as const) {
    const tagged = new RegExp(
      `url\\((https://[^)]+)\\)\\s*format\\(['"]${format}['"]\\)`,
    ).exec(css);
    if (tagged?.[1]) return tagged[1];
  }

  const byExtension = /url\((https:\/\/[^)]+\.(?:ttf|otf|woff))\)/.exec(css);
  if (byExtension?.[1]) return byExtension[1];

  return null;
}

async function fetchWithTimeout(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { headers, signal: controller.signal, cache: 'no-store' });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Font request to ${new URL(url).host} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The heaviest weight a face actually publishes.
 *
 * Slot components ask for this instead of hard-coding 900: Anton and Archivo
 * Black ship a single 400 face that is *already* black, so requesting 900 makes
 * satori synthesise a faux-bold on top of an ultra-heavy design and the counters
 * fill in.
 */
export function heaviestWeight(face: PosterFontChoice): number {
  return face.weights.reduce((max, weight) => Math.max(max, weight), 400);
}

/** The lightest published weight, used for body copy. */
export function lightestWeight(face: PosterFontChoice): number {
  return face.weights.reduce((min, weight) => Math.min(min, weight), 900);
}

function normalizeWeight(weight: number): LoadedFont['weight'] {
  const buckets: LoadedFont['weight'][] = [
    100, 200, 300, 400, 500, 600, 700, 800, 900,
  ];
  return buckets.reduce((closest, bucket) =>
    Math.abs(bucket - weight) < Math.abs(closest - weight) ? bucket : closest,
  );
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  // `buffer.buffer` may be a pooled allocation shared with unrelated data, so
  // the region must be copied out rather than handed over directly.
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
