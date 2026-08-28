import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';
import satori from 'satori';

import { intEnv, optionalEnv } from '@/lib/env';
import { loadFonts } from '@/lib/poster/fonts';
import { renderLayoutSpec } from '@/lib/poster/layout-render';
import { renderHtmlPoster } from '@/lib/poster/html/render';
import { findHtmlTemplateFor, type HtmlTemplate } from '@/lib/poster/html/template';
import {
  readImageDimensions,
  readSvgDimensions,
  type ImageDimensions,
} from '@/lib/poster/image-info';
import { hexToRgb, relativeLuminance } from '@/lib/poster/color';
import { measureInkLuminance, tintLogoInk } from '@/lib/poster/logo-key';
import { resolveMetrics } from '@/lib/poster/metrics';
import { renderPlateSpec } from '@/lib/poster/plate-render';
import { sampleRegionSurface } from '@/lib/poster/plate-ink';
import { logoReadsOn } from '@/lib/poster/slots';
import { requiredFaces, resolvePosterTheme } from '@/lib/poster/theme';
import type { BrandGuideline } from '@/lib/types/brand';
import { countPhotoSlots, type PosterLayoutSpec } from '@/lib/types/layout-spec';
import type { PosterPlateSpec } from '@/lib/types/plate-spec';
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
  /**
   * The clean plate to composite, when this template has an approved one.
   *
   * Its presence is what selects the render path. With a plate the poster is the
   * template's own artwork with content dropped into it; without one it is
   * rebuilt from `layoutSpec` exactly as before. `layoutSpec` stays required
   * either way — it is what a plate falls back to if its spec stops parsing, and
   * what `describeCopyShape` reads when the copy is written.
   */
  plate?: {
    spec: PosterPlateSpec;
    /** The plate artwork as stored. PNG with alpha, normally. */
    bytes: Buffer;
    mimeType: string;
    /** Whether the reference's sampled colours win over the client's brand. */
    useTemplatePalette: boolean;
  };
  /**
   * The `CategoryTemplate.label` this poster is being drawn from, when the
   * caller knows it.
   *
   * The only thing that selects the HTML renderer. A template migrates by
   * having a file added under `src/lib/poster/templates/` whose manifest claims
   * this label — no database change, no flag, and no effect on the other
   * twenty-three. A caller that does not pass it gets the spec renderer, which
   * is why adding the path routes nothing on its own.
   */
  templateLabel?: string;
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
  /*
   * The migration seam.
   *
   * A template that has been authored as HTML draws in Chromium; everything else
   * still draws through satori. Checked before anything else because the HTML
   * path needs none of what follows — no theme, no metrics, no reference grid —
   * and computing them to throw them away would be misleading to read.
   */
  const template = await findHtmlTemplateFor(input.templateLabel);
  if (template) return renderViaTemplate(input, template);

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
  // A plate's photo count comes from the regions cut into it, not from the grid
  // spec — the two describe the same template but only one of them is drawing.
  const wantedPhotos = input.plate
    ? input.plate.spec.photos.length
    : countPhotoSlots(input.layoutSpec);
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

  const photos = toPosterPhotos(input.photos);

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

  /*
   * What each block of type is about to be set on.
   *
   * Measured here, from the plate itself, because this is the last point that
   * holds the bytes and the first that is allowed to be async — `renderPlateSpec`
   * builds a tree synchronously. Sequential for the reason `extractPlateRegions`
   * gives about its own sampling: seven small crops of one buffer is tens of
   * milliseconds against a render that has already paid for a diffusion call.
   *
   * Per render rather than stored on the spec, deliberately. It could be measured
   * once at plate time and written into `plateSpec`, which would be cheaper — and
   * would reach none of the plates already sitting in Drive without regenerating
   * every one of them. This way the fix applies to the existing library the next
   * time each poster draws.
   */
  const plateSurfaces: Array<string | null> = [];
  if (input.plate) {
    for (const region of input.plate.spec.text) {
      plateSurfaces.push(await sampleRegionSurface(input.plate.bytes, region));
    }
  }

  /*
   * The logo is recoloured when it would not read on the ground it lands on.
   *
   * A keyed-out logo is a silhouette on transparency, so a dark mark on a dark
   * poster is invisible. This used to be answered by painting a pale plate
   * behind it, which is legible and looks like a square of background on artwork
   * that has none — the operator uploaded a transparent logo precisely so there
   * would be no square.
   *
   * Recolouring keeps the silhouette and changes what fills it, which is what a
   * designer does with a one-colour mark. The ink is the client's own
   * `onDark`/`onLight` — contrast-corrected against their palette — rather than
   * flat white, so the lockup still belongs to the brand.
   *
   * **Only when it does not already read.** A mark that is legible as uploaded
   * is left untouched whatever it is made of, because the recolour flattens a
   * multi-coloured logo to a single ink. `logoReadsOn` is the same 3:1 test
   * `LogoLock` used to gate the plate on, and SVG returns a null luminance,
   * which reads as "leave it alone".
   *
   * The canvas ground decides, not the logo cell's own fill: a spec can put its
   * lockup on a band of the opposite colour, and that is rare enough to accept
   * against the cost of measuring a cell whose height flex has not settled yet.
   */
  const logoSurface = input.plate
    ? (plateSurfaces[input.plate.spec.text.findIndex((r) => r.slot === 'logo')] ?? null)
    : null;
  const groundColor =
    logoSurface ??
    (input.layoutSpec.ground === 'dark' ? theme.darkNeutral : theme.lightNeutral);
  const groundIsDark =
    relativeLuminance(hexToRgb(groundColor) ?? { r: 0, g: 0, b: 0 }) < 0.5;

  let logoDataUri = logo?.dataUri ?? null;
  if (logo && !logoReadsOn(logo.inkLuminance, groundColor)) {
    const ink = groundIsDark ? theme.onDark : theme.onLight;
    const tinted = await tintLogoInk(
      Buffer.from(logo.dataUri.split(',')[1] ?? '', 'base64'),
      ink,
    );
    if (tinted) {
      logoDataUri = toDataUri(tinted, 'image/png');
      console.info(
        `[ace:poster] the logo does not read on ${groundColor}; recoloured to ${ink}.`,
      );
    }
  }

  if (logoDataUri !== null) identity.logoDataUri = logoDataUri;

  // Stage 1 — lay out the tree and emit SVG.
  const tree = input.plate
    ? renderPlateSpec({
        spec: input.plate.spec,
        copy: input.copy,
        theme,
        identity,
        plateDataUri: toDataUri(input.plate.bytes, input.plate.mimeType),
        photos,
        metrics,
        logoDimensions: logo?.dimensions ?? null,
        logoInkLuminance: logo?.inkLuminance ?? null,
        useTemplatePalette: input.plate.useTemplatePalette,
        surfaces: plateSurfaces,
      })
    : renderLayoutSpec({
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
  // The plate is what is drawn, so its aspect is the one the canvas must match.
  const spec = input.plate
    ? { name: input.plate.spec.name, aspect: input.plate.spec.aspect }
    : input.layoutSpec;
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

/**
 * The HTML path: hand a template the client's words and pictures, screenshot it.
 *
 * Notice what is *not* here, because it is most of what the spec path does.
 *
 *   - **No theme.** Template colours are hardcoded in its CSS, so
 *     `resolvePosterTheme` and its contrast machinery have nothing to decide.
 *     One client using this template gets this template's colours.
 *   - **No metrics.** There is no reference grid; the template's stylesheet is
 *     its geometry, scaled by `zoom` to whatever canvas was resolved.
 *   - **No `assertRenderableCanvas`.** That guard exists because `@resvg/resvg-js`
 *     is a native addon that panics in Rust on impossible geometry and takes the
 *     whole Node process with it, uncatchable. Chromium is a child process with
 *     no such hazard: a page that cannot lay out produces a bad poster or a
 *     timeout, both of which are ordinary errors on one row.
 *   - **No logo tinting.** `tintLogoInk` flattened a mark to one ink so it would
 *     read on a ground the spec had chosen at runtime. A template knows its own
 *     ground at authoring time, so the light/dark swap is one line of CSS in the
 *     file — `filter: brightness(0) invert(1)` or `filter: brightness(0)` — and
 *     the sharp round-trip goes away with it.
 */
async function renderViaTemplate(
  input: RenderPosterInput,
  template: HtmlTemplate,
): Promise<RenderedPoster> {
  const wanted = template.manifest.photos.length;
  if (wanted > 0 && input.photos.length === 0) {
    throw new Error(
      `The template "${template.manifest.label}" declares ${wanted} photo frame(s) but ` +
        'the poster layer was given no background photo.',
    );
  }
  if (wanted > input.photos.length && input.photos.length > 0) {
    // Same policy and same reason as the spec path: repeating the last frame is
    // right, and doing it silently would ship a two-photo poster carrying one
    // image twice after a diffusion call failed.
    console.warn(
      `[ace:poster] template "${template.manifest.label}" wants ${wanted} photos but ` +
        `${input.photos.length} were supplied — the last frame will be repeated.`,
    );
  }

  const logo = await loadLogo(input.identity.logoUrl);

  const identity: PosterIdentity = {
    companyName: input.identity.companyName,
    /*
     * The client's mark is trimmed for the same reason a cut-out is, and the
     * bug it fixes looked identical: a logo drawn at a fraction of the space
     * reserved for it, on every template at once, with nothing in the render
     * appearing broken.
     *
     * An uploaded logo is almost always a mark floating in a transparent
     * canvas — exported from a design file at the artboard's size, not the
     * artwork's. `.pk-logo img` fits it with `object-fit: contain`, so
     * `contain` fits the *canvas*: a mark occupying a fifth of its file lands
     * at a fifth of `--logo-w`. Measured on a live Constructions poster as a
     * roughly 30px mark inside a 230x66 slot.
     *
     * Trimming is the right place because the fault is in the file rather than
     * in any template's CSS — crop the empty margin away and `contain` fits the
     * mark itself, in whatever box the design gives it.
     */
    logoDataUri: await trimLogoMargin(logo?.dataUri ?? null),
    logoIncludesName: input.identity.logoIncludesName === true,
    brandTagline: normalizeTagline(input.identity.brandTagline),
    phone: formatPhone(input.identity.displayPhone, input.identity.whatsappNumber),
    website: normalizeWebsite(input.identity.websiteUrl),
  };

  /*
   * Cut-outs are trimmed before they are drawn.
   *
   * A background-removed frame comes back the size it was generated at, with
   * the figure somewhere inside it and transparency all around. `object-fit:
   * contain` then fits the *frame*, empty margin included, so a figure occupying
   * half its image lands at half the size the design asked for — measured on a
   * live poster as 223px of clinician inside a 460px box against the reference's
   * 443. Nothing in the render looks broken; the figure is just quietly small,
   * on every subject template at once.
   *
   * Trimming is the right place to fix it because the fault is in the frame, not
   * in any one template's CSS: crop the transparency away and `contain` fits the
   * figure itself.
   */
  const photos = await Promise.all(
    toPosterPhotos(input.photos).map(async (photo, index) =>
      template.manifest.photos[index]?.kind === 'subject'
        ? trimTransparentMargin(photo)
        : photo,
    ),
  );

  const body = await renderHtmlPoster({
    template,
    copy: input.copy,
    identity,
    photos,
    width: input.width,
    height: input.height,
  });

  return {
    body,
    mimeType: 'image/png',
    layoutName: template.manifest.label,
    // There are no canvas modes on this path — the template is drawn at its own
    // proportions and scaled. Reported as the renderer that drew it so the
    // preview route's `X-Poster-Canvas-Mode` header stays a useful thing to read.
    canvasMode: 'template',
  };
}

/**
 * Crops the transparent border off a cut-out, leaving the figure.
 *
 * Only touches frames that actually carry alpha. `sharp.trim()` on an opaque
 * image trims by the *corner colour* instead, which on a photograph means
 * cropping away whatever happens to match the top-left pixel — a pale sky, a
 * white wall — so the guard is load-bearing rather than defensive.
 *
 * Returns the frame untouched on any failure. A slightly small figure is a poor
 * poster; a failed render is no poster, and this is not worth the second.
 */
/**
 * Crops the empty margin from around a client's logo.
 *
 * **Only touches marks that carry alpha**, and the guard is load-bearing rather
 * than defensive — the same one `trimTransparentMargin` needs, for a sharper
 * reason. `sharp.trim()` on an opaque image trims by the *corner colour*, so a
 * logo supplied as a JPEG on a white card would have the card cropped off. That
 * card is part of the artwork as supplied, and a template's `--logo-filter`
 * flattens it to a solid block either way; deciding it is margin is a judgement
 * this function is not entitled to make.
 *
 * SVG is returned untouched. Vector artwork has no pixels to measure, and
 * rasterising it here to find a bounding box would trade the one format that
 * scales cleanly for a guess about its extents.
 *
 * Returns the mark unchanged on every failure. A small logo is a poor poster; a
 * failed render is no poster, and the client's day does not turn on this.
 */
const trimmedLogoCache = new Map<string, Promise<string>>();

async function trimLogoMargin(dataUri: string | null): Promise<string | null> {
  if (!dataUri) return null;
  // `image/svg+xml;base64,...` — the type is in the URI, so no sniffing needed.
  if (dataUri.startsWith('data:image/svg')) return dataUri;

  /*
   * Memoised for the same reason `logoCache` is: a client's mark is identical
   * across all 365 of its posters, and re-decoding and re-cropping it per render
   * is work with a known answer. Keyed on the bytes rather than on the URL so
   * that two clients pointing at the same file share the result and a client who
   * re-uploads gets a fresh one.
   */
  const cached = trimmedLogoCache.get(dataUri);
  if (cached) return cached;

  const work = trimLogoBytes(dataUri);
  trimmedLogoCache.set(dataUri, work);
  return work;
}

async function trimLogoBytes(dataUri: string): Promise<string> {
  try {
    const source = Buffer.from(dataUri.split(',')[1] ?? '', 'base64');
    const metadata = await sharp(source).metadata();
    if (!metadata.hasAlpha) return dataUri;

    const { data, info } = await sharp(source)
      // Above zero so a soft or anti-aliased edge counts as empty rather than
      // as the first pixel of the mark.
      .trim({ threshold: 8 })
      .png()
      .toBuffer({ resolveWithObject: true });

    if (info.width < 1 || info.height < 1) return dataUri;
    return toDataUri(data, 'image/png');
  } catch (error: unknown) {
    console.warn(`[ace:poster] a logo could not be trimmed: ${describe(error)}`);
    return dataUri;
  }
}

async function trimTransparentMargin(photo: PosterPhoto): Promise<PosterPhoto> {
  if (!photo.dataUri) return photo;

  try {
    const source = Buffer.from(photo.dataUri.split(',')[1] ?? '', 'base64');
    const metadata = await sharp(source).metadata();
    if (!metadata.hasAlpha) return photo;

    const { data, info } = await sharp(source)
      // A threshold above zero so the feathered edge birefnet leaves behind is
      // treated as empty rather than as the first pixel of the subject.
      .trim({ threshold: 8 })
      .png()
      .toBuffer({ resolveWithObject: true });

    if (info.width < 1 || info.height < 1) return photo;
    return {
      dataUri: toDataUri(data, 'image/png'),
      width: info.width,
      height: info.height,
    };
  } catch (error: unknown) {
    console.warn(`[ace:poster] a cut-out could not be trimmed: ${describe(error)}`);
    return photo;
  }
}

/**
 * Background frames as data URIs, in slot order.
 *
 * Shared by both renderers because the rule about holes is the same for each
 * and is easy to get subtly wrong in one of them.
 */
function toPosterPhotos(buffers: Buffer[]): PosterPhoto[] {
  return buffers.map((bytes, index) => {
    /*
     * A zero-length frame is a deliberate hole, not a failure.
     *
     * The pipeline pushes one when a `scene` backdrop was asked for and the day
     * carried no `backgroundPrompt`, because dropping the entry instead would
     * shift every later index and swap a subject with its background. Both
     * renderers test `dataUri` and fall back to the painted backdrop.
     */
    if (bytes.length === 0) {
      return { dataUri: '', width: 0, height: 0 };
    }

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
