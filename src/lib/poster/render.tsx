import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';

import { intEnv, optionalEnv } from '@/lib/env';
import { loadFonts } from '@/lib/poster/fonts';
import { renderLayoutSpec } from '@/lib/poster/layout-render';
import {
  readImageDimensions,
  readSvgDimensions,
  type ImageDimensions,
} from '@/lib/poster/image-info';
import { measureInkLuminance } from '@/lib/poster/logo-key';
import { resolveMetrics } from '@/lib/poster/metrics';
import { requiredFaces, resolvePosterTheme } from '@/lib/poster/theme';
import type { BrandGuideline } from '@/lib/types/brand';
import { countPhotoSlots, type PosterLayoutSpec } from '@/lib/types/layout-spec';
import type {
  PosterCopy,
  PosterIdentity,
  PosterPhoto,
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
  /**
   * The geometry to draw. There is no other way to lay out a poster — every one
   * comes from a reference template an operator uploaded and approved, resolved
   * by `resolveDayLayout` before this is called.
   */
  layoutSpec: PosterLayoutSpec;
  copy: PosterCopy;
  guideline: BrandGuideline;
  identity: {
    companyName: string;
    logoUrl: string | null;
    /** Suppresses the printed name for a wordmark logo. Defaults to false. */
    logoIncludesName?: boolean;
    brandTagline: string | null;
    websiteUrl: string | null;
    displayPhone: string | null;
    /** E.164 digits without `+`. Used when `displayPhone` is unset. */
    whatsappNumber: string;
  };
  /**
   * Background photo bytes from the image stage, in slot order.
   *
   * An array because a spec may declare two photo cells — reference templates
   * routinely pair a hero shot with a detail shot. Fewer frames than slots
   * repeats the last one rather than leaving a hole; see the warning below.
   */
  photos: Buffer[];
  /** Output canvas, from the client's `imageSizePreset`. */
  width: number;
  height: number;
}

export interface RenderedPoster {
  body: Buffer;
  mimeType: 'image/png';
  /** The layout's operator-facing name — which template drew this. */
  layoutName: string;
  /**
   * Resolved canvas mode. Anything but `tall` means an off-brand preset
   * compressed the rows, which is worth an operator knowing about.
   */
  canvasMode: string;
}

export async function renderPoster(
  input: RenderPosterInput,
): Promise<RenderedPoster> {
  const theme = resolvePosterTheme(input.guideline);
  /*
   * The spec's measured aspect is passed so the design can be re-proportioned to
   * the template's own shape rather than fitted to a 9:16 frame it was never
   * drawn at. `resolveMetrics` ignores it unless the canvas actually matches —
   * see the note there for why that gate is load-bearing rather than defensive.
   */
  const metrics = resolveMetrics(input.width, input.height, input.layoutSpec.aspect);
  assertRenderableCanvas(metrics, input.width, input.height);

  /*
   * A spec with no photo cell is legal — `validateLayoutSpec` does not demand
   * one — so the guard is conditional on the spec actually wanting a photograph
   * rather than on the array being empty. Under the archetypes this could not
   * happen: every one of them had a photo region.
   */
  const wantedPhotos = countPhotoSlots(input.layoutSpec);
  if (wantedPhotos > 0 && input.photos.length === 0) {
    throw new Error(
      `The layout "${input.layoutSpec.name}" declares ${wantedPhotos} photo cell(s) but ` +
        'the poster layer was given no background photo.',
    );
  }
  if (wantedPhotos > input.photos.length && input.photos.length > 0) {
    // The renderer repeats the last frame rather than leaving a hole, which is
    // the right policy and a bad thing to do silently — a two-photo poster whose
    // second diffusion call failed would otherwise ship the same image twice.
    console.warn(
      `[ace:poster] layout "${input.layoutSpec.name}" wants ${wantedPhotos} photos but ` +
        `${input.photos.length} were supplied — the last frame will be repeated.`,
    );
  }

  const photos: PosterPhoto[] = input.photos.map((bytes, index) => {
    const dimensions = readImageDimensions(bytes);
    if (!dimensions) {
      throw new Error(
        `Background photo ${index + 1} is not a recognisable PNG, JPEG, WebP or GIF — ` +
          'the poster layer cannot lay out an image of unknown size.',
      );
    }
    return {
      dataUri: toDataUri(bytes, dimensions.mimeType),
      width: dimensions.width,
      height: dimensions.height,
    };
  });

  const logo = await loadLogo(input.identity.logoUrl);

  const identity: PosterIdentity = {
    companyName: input.identity.companyName,
    logoDataUri: logo?.dataUri ?? null,
    logoIncludesName: input.identity.logoIncludesName === true,
    brandTagline: normalizeTagline(input.identity.brandTagline),
    phone: formatPhone(input.identity.displayPhone, input.identity.whatsappNumber),
    website: normalizeWebsite(input.identity.websiteUrl),
  };

  const fonts = await loadFonts(requiredFaces(theme));

  // Stage 1 — lay out the tree and emit SVG.
  const tree = renderLayoutSpec({
    spec: input.layoutSpec,
    copy: input.copy,
    theme,
    identity,
    photos,
    metrics,
    logoDimensions: logo?.dimensions ?? null,
    logoInkLuminance: logo?.inkLuminance ?? null,
  });

  const svg = await satori(tree, {
    width: input.width,
    height: input.height,
    fonts: fonts.map((font) => ({
      name: font.name,
      data: font.data,
      weight: font.weight,
      style: font.style,
    })),
  });

  // Diagnostic escape hatch. resvg is a native addon: impossible geometry makes
  // it panic in Rust and abort the entire process, so there is no post-mortem to
  // read and no exception to catch. The SVG therefore has to be captured
  // *before* it is handed over. Set POSTER_DEBUG_SVG_DIR to keep a copy.
  const debugDir = optionalEnv('POSTER_DEBUG_SVG_DIR', '');
  if (debugDir) {
    const name = `poster-${input.width}x${input.height}-${slugify(input.layoutSpec.name)}.svg`;
    await writeFile(join(debugDir, name), svg, 'utf8').catch((error: unknown) => {
      console.warn(`[ace:poster] could not write debug SVG: ${describe(error)}`);
    });
    console.info(`[ace:poster] debug SVG written: ${name}`);
  }

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

  /*
   * Warn only when the canvas disagrees with the template it is drawing.
   *
   * This used to fire on any canvas that was not `tall`, which was the best it
   * could do while a spec carried no record of the shape it was read from — and
   * which is now both wrong and noisy, since a square template drawn at 1:1 is
   * the correct outcome rather than a degraded one.
   *
   * A spec now stores its measured `aspect`, so the real question is answerable:
   * is this poster being drawn at the proportions its reference had? It is not
   * only when the spec predates the field (aspect 0, so `resolvePosterCanvas`
   * fell back to the client's preset) — which is exactly the case an operator
   * should be told about, because the fix is to re-read the template.
   */
  const spec = input.layoutSpec;
  const canvasAspect = input.width / input.height;

  if (spec.aspect > 0) {
    if (Math.abs(canvasAspect - spec.aspect) > ASPECT_TOLERANCE) {
      console.warn(
        `[ace:poster] layout "${spec.name}" was read from a ${spec.aspect.toFixed(2)}:1 ` +
          `reference but is being drawn at ${input.width}×${input.height} ` +
          `(${canvasAspect.toFixed(2)}:1); rows will compress. This should not happen — ` +
          'the canvas is meant to be resolved by `resolvePosterCanvas`.',
      );
    }
  } else if (metrics.mode !== 'tall') {
    console.warn(
      `[ace:poster] ${input.width}×${input.height} is a "${metrics.mode}" canvas and ` +
        `layout "${spec.name}" carries no measured aspect, so it is being drawn at the ` +
        'output preset\'s shape. Re-read the template so its own proportions are stored.',
    );
  }

  return {
    body,
    mimeType: 'image/png',
    layoutName: input.layoutSpec.name,
    canvasMode: metrics.mode,
  };
}

/** Filesystem-safe form of a layout name, for the debug SVG filename. */
function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'layout';
}

// ---------------------------------------------------------------------------
// Pre-render sanity
// ---------------------------------------------------------------------------

/**
 * Widest canvas the poster layer will attempt.
 *
 * `desktop-ultrawide` (3440×1440) is 2.39:1 and composes correctly; the retired
 * `linkedin-banner` was 5.9:1 and panicked resvg. 4:1 sits between them with
 * room for a future preset, while still refusing anything genuinely extreme.
 */
const MAX_RENDERABLE_ASPECT = 4;

/**
 * How far a canvas may drift from its spec's measured aspect before it is worth
 * a line in the log. Wide enough to absorb `clampEven`'s rounding on a small
 * canvas, narrow enough that a genuine mismatch always reports.
 */
const ASPECT_TOLERANCE = 0.02;

/** Below this the slot skeleton has no room on either axis. */
const MIN_RENDERABLE_EDGE = 240;

/**
 * Refuses a canvas whose resolved metrics cannot produce positive geometry.
 *
 * This exists because a bad layout does not fail gracefully downstream.
 * `@resvg/resvg-js` is a native addon: impossible geometry makes it panic in
 * Rust (`called Option::unwrap() on a None value`), which **terminates the Node
 * process outright**. It cannot be caught by the pipeline's try/catch, so a
 * single mis-sized preset would kill an entire cron sweep mid-flight and leave
 * every row in it PENDING with no error message to debug from.
 *
 * Throwing a normal Error here keeps the failure inside the pipeline's error
 * handling, where it lands in `ContentCalendar.errorMessage` as a readable
 * `[compose]` failure and only that one row is affected.
 */
function assertRenderableCanvas(
  metrics: { margin: number; copyWidth: number; mode: string },
  width: number,
  height: number,
): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new Error(
      `Poster canvas ${width}×${height} is not a renderable size.`,
    );
  }

  if (metrics.margin * 2 >= height || metrics.margin * 2 >= width) {
    throw new Error(
      `Poster canvas ${width}×${height} is too small for its own margins ` +
        `(${metrics.margin.toFixed(1)}px each side in "${metrics.mode}" mode). ` +
        'Choose a preset with more room.',
    );
  }

  if (metrics.copyWidth < 1) {
    throw new Error(
      `Poster canvas ${width}×${height} leaves no width for the copy column ` +
        `in "${metrics.mode}" mode.`,
    );
  }

  // The one that actually bites. Beyond roughly 4:1 the photo layer cover-fits
  // its source into a strip a fraction of the image's own height, and satori's
  // nested overflow masks over that make resvg panic in Rust — which aborts the
  // process rather than throwing. Refusing here keeps the failure inside the
  // pipeline, where it becomes a readable `[compose]` error on one row instead
  // of taking down a whole dispatch sweep.
  const aspect = width / height;
  if (aspect > MAX_RENDERABLE_ASPECT) {
    throw new Error(
      `Poster canvas ${width}×${height} is ${aspect.toFixed(1)}:1, beyond the ` +
        `${MAX_RENDERABLE_ASPECT}:1 the poster layer can compose. Choose a less ` +
        'extreme output size.',
    );
  }

  if (height < MIN_RENDERABLE_EDGE || width < MIN_RENDERABLE_EDGE) {
    throw new Error(
      `Poster canvas ${width}×${height} is below the ${MIN_RENDERABLE_EDGE}px ` +
        'minimum edge the poster layer can compose.',
    );
  }
}

// ---------------------------------------------------------------------------
// Logo loading
// ---------------------------------------------------------------------------

interface LoadedLogo {
  dataUri: string;
  dimensions: ImageDimensions;
  /**
   * Mean luminance of the logo's opaque pixels, 0–1, or null when it could not be
   * measured. Drives the backing plate in `LogoLock`: a logo whose background has
   * been keyed out has nothing behind it, so dark ink on a dark archetype would
   * otherwise be invisible.
   */
  inkLuminance: number | null;
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
    // Measured here rather than read from a column because this is the one place
    // that holds the bytes for *every* logo — uploaded, externally linked, keyed
    // or not — and the answer is then cached with the data URI for the process
    // lifetime. SVG returns null: rasterising vector artwork to average it would
    // cost more than the plate it might justify.
    inkLuminance: isSvg ? null : await measureInkLuminance(bytes, dimensions.mimeType),
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
