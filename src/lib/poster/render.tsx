import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';

import { intEnv } from '@/lib/env';
import { renderArchetype } from '@/lib/poster/archetypes';
import { loadFonts } from '@/lib/poster/fonts';
import {
  readImageDimensions,
  readSvgDimensions,
  type ImageDimensions,
} from '@/lib/poster/image-info';
import { droppedSlots, resolveMetrics } from '@/lib/poster/metrics';
import { requiredFaces, resolvePosterTheme } from '@/lib/poster/theme';
import type { BrandGuideline } from '@/lib/types/brand';
import {
  archetypeForDay,
  posterArchetypeSchema,
  type PosterArchetype,
  type PosterCopy,
  type PosterIdentity,
  type PosterPhoto,
  type PosterSpec,
} from '@/lib/types/poster';

/**
 * Composites a finished poster: background photo plus the vector text layer.
 *
 * This is the stage that makes the creatives match the reference set. The photo
 * carries no text at all — that rule in the calendar generator was always correct,
 * because diffusion models cannot spell a phone number. Everything readable on the
 * poster is drawn here, from data, as real glyphs.
 *
 * Rendering is satori rather than a headless browser: it needs no Chromium binary,
 * runs inside a Vercel function, and is deterministic — the same spec produces
 * byte-identical output, which is what makes a retry after a WhatsApp failure safe
 * to compare against the original.
 *
 * **Why satori + resvg directly rather than `next/og`'s `ImageResponse`.**
 * `ImageResponse` wraps exactly these two libraries, so it looks like the obvious
 * choice, but its Node-runtime build cannot load on Windows. It resolves its own
 * wasm and fallback-font assets with
 * `fileURLToPath(path.join(import.meta.url, '../yoga.wasm'))`, and on Windows
 * `path.join` rewrites `file:///D:/…` into `file:\D:\…`, which is not a parseable
 * URL — the module throws `TypeError: Invalid URL` at import time, before any
 * poster tree is evaluated. It works on Vercel's Linux, so the failure is
 * local-development-only, which is worse: the composition could not be previewed or
 * iterated on the machine it is authored on. Importing the two libraries directly
 * sidesteps the asset resolution entirely.
 */

export interface RenderPosterInput {
  /** Explicit choice, or null to derive deterministically from `dayNumber`. */
  archetype: string | null;
  dayNumber: number;
  copy: PosterCopy;
  guideline: BrandGuideline;
  identity: {
    companyName: string;
    logoUrl: string | null;
    brandTagline: string | null;
    websiteUrl: string | null;
    displayPhone: string | null;
    /** E.164 digits without `+`. Used when `displayPhone` is unset. */
    whatsappNumber: string;
  };
  /** Background photo bytes from the image stage. */
  photo: Buffer;
  /** Output canvas, from the client's `imageSizePreset`. */
  width: number;
  height: number;
}

export interface RenderedPoster {
  body: Buffer;
  mimeType: 'image/png';
  archetype: PosterArchetype;
  /** Slots the canvas mode could not carry. Empty for portrait presets. */
  dropped: string[];
}

export async function renderPoster(
  input: RenderPosterInput,
): Promise<RenderedPoster> {
  const archetype = resolveArchetype(input.archetype, input.dayNumber);
  const theme = resolvePosterTheme(input.guideline);
  const metrics = resolveMetrics(input.width, input.height);

  const photoDimensions = readImageDimensions(input.photo);
  if (!photoDimensions) {
    throw new Error(
      'Background photo is not a recognisable PNG, JPEG, WebP or GIF — the poster ' +
        'layer cannot lay out an image of unknown size.',
    );
  }

  const photo: PosterPhoto = {
    dataUri: toDataUri(input.photo, photoDimensions.mimeType),
    width: photoDimensions.width,
    height: photoDimensions.height,
  };

  const logo = await loadLogo(input.identity.logoUrl);

  const identity: PosterIdentity = {
    companyName: input.identity.companyName,
    logoDataUri: logo?.dataUri ?? null,
    brandTagline: normalizeTagline(input.identity.brandTagline),
    phone: formatPhone(input.identity.displayPhone, input.identity.whatsappNumber),
    website: normalizeWebsite(input.identity.websiteUrl),
  };

  const spec: PosterSpec = {
    archetype,
    copy: input.copy,
    theme,
    identity,
    photo,
    width: input.width,
    height: input.height,
  };

  const fonts = await loadFonts(requiredFaces(theme));

  // Stage 1 — lay out the tree and emit SVG.
  const svg = await satori(
    renderArchetype({ spec, metrics, logoDimensions: logo?.dimensions ?? null }),
    {
      width: input.width,
      height: input.height,
      fonts: fonts.map((font) => ({
        name: font.name,
        data: font.data,
        weight: font.weight,
        style: font.style,
      })),
    },
  );

  // Stage 2 — rasterise. `fitTo` is pinned to the intended width rather than left
  // at resvg's default: satori writes the SVG's own width/height, and any
  // disagreement between the two would silently rescale the whole poster.
  const raster = new Resvg(svg, {
    fitTo: { mode: 'width', value: input.width },
    // Satori has already resolved every image to a data URI, so the rasteriser
    // needs no network — but resvg would otherwise try to load remote hrefs, and a
    // hung fetch inside the render path is worth ruling out.
    background: 'rgba(0, 0, 0, 0)',
  });

  const body = Buffer.from(raster.render().asPng());
  if (body.byteLength === 0) {
    throw new Error('The poster renderer produced an empty image');
  }

  const dropped = droppedSlots(metrics.mode);
  if (dropped.length > 0) {
    console.warn(
      `[ace:poster] ${input.width}×${input.height} is a "${metrics.mode}" canvas — ` +
        `dropped: ${dropped.join(', ')}. Pick a portrait preset to carry the full layout.`,
    );
  }

  return { body, mimeType: 'image/png', archetype, dropped };
}

// ---------------------------------------------------------------------------
// Archetype selection
// ---------------------------------------------------------------------------

function resolveArchetype(stored: string | null, dayNumber: number): PosterArchetype {
  const parsed = posterArchetypeSchema.safeParse(stored);
  if (parsed.success) return parsed.data;
  // Covers both null and a value written by an older build whose archetype has
  // since been renamed. Deriving from the day keeps a campaign varied.
  return archetypeForDay(dayNumber);
}

// ---------------------------------------------------------------------------
// Logo loading
// ---------------------------------------------------------------------------

interface LoadedLogo {
  dataUri: string;
  dimensions: ImageDimensions;
}

/**
 * Process-lifetime logo cache.
 *
 * A client's logo is identical across all 365 of its posters, so refetching it per
 * render would be pure waste. Keyed by URL so a re-upload — which changes the URL —
 * misses the cache and picks up the new file.
 */
const logoCache = new Map<string, Promise<LoadedLogo | null>>();

/** Refuses anything larger than this; a logo this big is a mistake, not a logo. */
const MAX_LOGO_BYTES = 4 * 1024 * 1024;

/**
 * Fetches and measures the logo.
 *
 * Returns null on every failure rather than throwing: a missing or broken logo must
 * degrade to the generated wordmark lockup, not fail the day's delivery. The
 * warning is logged so an operator can see that the upload is bad.
 */
async function loadLogo(url: string | null): Promise<LoadedLogo | null> {
  const trimmed = url?.trim();
  if (!trimmed) return null;

  const cached = logoCache.get(trimmed);
  if (cached) return cached;

  const request = fetchLogo(trimmed).catch((error: unknown) => {
    console.warn(
      `[ace:poster] logo at ${trimmed} could not be used (${describe(error)}) — ` +
        'falling back to the wordmark lockup.',
    );
    return null;
  });

  logoCache.set(trimmed, request);
  return request;
}

async function fetchLogo(url: string): Promise<LoadedLogo | null> {
  const timeoutMs = intEnv('POSTER_LOGO_TIMEOUT_MS', 15_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`responded ${response.status} ${response.statusText}`);
  }

  const declaredType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
  // A Drive link whose sharing was never opened returns an HTML interstitial with
  // a 200, so the content type has to be checked rather than assumed.
  if (declaredType && !declaredType.startsWith('image/')) {
    throw new Error(
      `served "${declaredType}" rather than an image — if this is a Google Drive ` +
        'link, the file is probably not shared link-readable',
    );
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error('the file was empty');
  if (bytes.byteLength > MAX_LOGO_BYTES) {
    throw new Error(
      `the file is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB, over the ${
        MAX_LOGO_BYTES / 1024 / 1024
      } MB cap`,
    );
  }

  const isSvg =
    declaredType === 'image/svg+xml' ||
    bytes.toString('utf8', 0, 300).trimStart().startsWith('<svg') ||
    bytes.toString('utf8', 0, 300).includes('<?xml');

  const dimensions = isSvg
    ? readSvgDimensions(bytes.toString('utf8'))
    : readImageDimensions(bytes);

  if (!dimensions) {
    throw new Error('its dimensions could not be read');
  }

  return {
    dataUri: toDataUri(bytes, dimensions.mimeType),
    dimensions,
  };
}

// ---------------------------------------------------------------------------
// Identity formatting
// ---------------------------------------------------------------------------

function toDataUri(bytes: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${bytes.toString('base64')}`;
}

function normalizeTagline(raw: string | null): string | null {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Strips the scheme and any trailing slash, leaving the bare host form the
 * references use (`www.loremipsum.com`, never `https://www.loremipsum.com/`).
 */
function normalizeWebsite(raw: string | null): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '') || null;
}

/**
 * The contact bar's phone value.
 *
 * `displayPhone` is passed through verbatim when set — an operator who typed
 * "+91 98765 43210" chose that spacing and it must not be reformatted. Only the
 * fallback path formats, grouping Indian numbers as `+91 XXXXX XXXXX` to match the
 * reference set; anything else gets a plain `+` prefix rather than a guessed
 * grouping, since applying Indian spacing to a 9-digit European number would
 * render a number that cannot be dialled.
 */
export function formatPhone(displayPhone: string | null, whatsappNumber: string): string {
  const explicit = displayPhone?.trim();
  if (explicit) return explicit;

  const digits = whatsappNumber.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) {
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  }
  return digits ? `+${digits}` : '';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
