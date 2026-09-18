import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';
import sharp, { type OverlayOptions } from 'sharp';

import { resolveStudioLogo, type ResolvedStudioLogo } from '@/lib/poster-studio/brand-logo';
import type { StudioBrandCanvas } from '@/lib/poster-studio/brand-context';
import { StudioError } from '@/lib/poster-studio/errors';
import {
  identityBandFraction,
  STUDIO_ASPECT_RATIOS,
  STUDIO_OVERLAY_PRESET,
  type StudioAspectRatio,
  type StudioDrawnElement,
  type StudioFooterBackground,
  type StudioFooterTone,
  type StudioLogoBackground,
  type StudioOverlayElement,
} from '@/lib/poster-studio/limits';
import {
  bestTextOn,
  ensureContrast,
  hexToRgb,
  hslToRgb,
  relativeLuminance,
  rgbToHex,
  rgbToHsl,
  withAlpha,
  type Rgb,
} from '@/lib/poster/color';
import { heaviestWeight, lightestWeight, loadFonts, type LoadedFont } from '@/lib/poster/fonts';
import { containFit } from '@/lib/poster/image-info';
import { logoReadsOn } from '@/lib/poster/slots';
import { requiredFaces, resolvePosterTheme } from '@/lib/poster/theme';
import type { PosterTheme } from '@/lib/types/poster';

/**
 * Deterministic Brand Canvas identity overlay for AI Poster Studio posters.
 *
 * The AI image is the creative artwork. Everything that must be *exact* — the
 * client's logo, company name, tagline, website and phone number — is drawn here
 * from Brand Canvas data, never by the image model: a diffusion model cannot be
 * trusted to spell a phone number or reproduce a logo, which is the same reason
 * the delivery renderer draws its contact bar as real glyphs.
 *
 * Not `renderPoster`. That renderer lays out a whole poster from an approved
 * reference template; an AI poster already has its composition, so this adds a
 * single identity footer on top and touches nothing else.
 *
 * Two stages:
 *   1. Text and the footer itself — satori to SVG, resvg to PNG, in the client's
 *      own typography and theme colours (`resolvePosterTheme`, `loadFonts`).
 *   2. Pixels — sharp composites the footer and the logo onto the raw artwork.
 *
 * **The footer.** A light or dark ground (`StudioFooterBackground`) whose top
 * edge feathers into the artwork rather than cutting across it, faintly tinted
 * with the artwork's own colour so it reads as part of the poster. AUTO picks the
 * tone from the luminance of the artwork the footer meets — a plain pixel
 * measurement, no model call. Hierarchy: company name strongest, tagline
 * secondary beneath it, contact details readable but quieter.
 *
 * **The logo is scaled and nothing else.** No trim, no recolour, no backing plate:
 * "Keep original" means the uploaded file, and "Remove background" means the
 * transparent version `resolveStudioLogo` produced. Whether a transparent logo
 * reads on the ground limits the tone instead (`logoReadsOn`), so the logo is
 * never altered to fit the footer.
 *
 * `prepareStudioOverlay` does everything that can fail deterministically — the
 * logo, the fonts, the footer tone, a full dry-run composite — and runs before
 * any image is paid for.
 */

export interface StudioOverlaySelection {
  elements: StudioOverlayElement[];
  logoBackground: StudioLogoBackground;
  footerBackground: StudioFooterBackground;
}

export interface StudioOverlayPlan {
  preset: typeof STUDIO_OVERLAY_PRESET;
  aspectRatio: StudioAspectRatio;
  theme: PosterTheme;
  fonts: LoadedFont[];
  logo: ResolvedStudioLogo | null;
  /** Measured once from the logo's pixels; decides which footer grounds it reads on. */
  logoInk: LogoInk | null;
  name: string | null;
  tagline: string | null;
  website: string | null;
  phone: string | null;
  footerBackground: StudioFooterBackground;
  drawn: StudioDrawnElement[];
}

export interface ComposedPoster {
  bytes: Buffer;
  mimeType: 'image/png';
  drawn: StudioDrawnElement[];
  /** The tone actually drawn — what AUTO resolved to, or the explicit choice. */
  footerTone: StudioFooterTone;
}

/**
 * Validates a selection against the client's Brand Canvas and loads everything
 * the overlay needs. Throws `StudioError` before any spend when a prerequisite
 * is missing: an element with no stored value, an unreadable logo, a background
 * removal the keyer declines, a footer tone the logo cannot be read on, fonts
 * that cannot be loaded, or a composite that does not render.
 */
export async function prepareStudioOverlay(
  canvas: StudioBrandCanvas,
  selection: StudioOverlaySelection,
  aspectRatio: StudioAspectRatio,
): Promise<StudioOverlayPlan> {
  const wants = new Set(selection.elements);

  const missing: string[] = [];
  if (wants.has('tagline') && !canvas.tagline) missing.push('tagline');
  if (wants.has('website') && !canvas.website) missing.push('website');
  if (wants.has('phone') && !canvas.phone) missing.push('phone number');
  if (missing.length > 0) {
    throw new StudioError(
      'validation',
      `This client's Brand Canvas has no ${missing.join(', ')}. Add it in Brand Canvas, or untick it for this poster.`,
    );
  }

  const logo = wants.has('logo') ? await resolveStudioLogo(canvas.logo, selection.logoBackground) : null;
  const logoInk = logo ? await sampleLogoInk(logo) : null;

  // The renderer's rule: the company name is printed unless a logo that already
  // spells it is on the poster.
  const name = !logo || !canvas.logoIncludesName ? canvas.companyName : null;

  const theme = resolvePosterTheme(canvas.guideline);

  // An explicit tone the logo cannot be read on is refused here, before spend,
  // rather than silently switched after the operator chose it.
  if (logo && logoInk && selection.footerBackground !== 'AUTO') {
    const tone = selection.footerBackground;
    if (!logoReadsOnGround(logo, logoInk, neutralGround(theme, tone))) {
      const other = tone === 'LIGHT' ? 'Dark' : 'Light';
      throw new StudioError(
        'validation',
        `This logo would not be readable on a ${tone === 'LIGHT' ? 'light' : 'dark'} footer. Choose "${other}" or "Auto" for this poster.`,
      );
    }
  }

  let fonts: LoadedFont[];
  try {
    fonts = await loadFonts(requiredFaces(theme));
  } catch (error) {
    throw new StudioError(
      'composition',
      `The brand fonts (${theme.headingFont.family}, ${theme.bodyFont.family}) could not be loaded, so exact text cannot be drawn. Nothing was generated.`,
      { cause: error },
    );
  }

  const drawn: StudioDrawnElement[] = [];
  if (logo) drawn.push('logo');
  if (name) drawn.push('name');
  if (wants.has('tagline')) drawn.push('tagline');
  if (wants.has('website')) drawn.push('website');
  if (wants.has('phone')) drawn.push('phone');

  const plan: StudioOverlayPlan = {
    preset: STUDIO_OVERLAY_PRESET,
    aspectRatio,
    theme,
    fonts,
    logo,
    logoInk,
    name,
    tagline: wants.has('tagline') ? canvas.tagline : null,
    website: wants.has('website') ? canvas.website : null,
    phone: wants.has('phone') ? canvas.phone : null,
    footerBackground: selection.footerBackground,
    drawn,
  };

  // Dry run on a blank canvas of the real size, so a rendering fault surfaces
  // here rather than after the image has been billed.
  const [width, height] = STUDIO_ASPECT_RATIOS[aspectRatio].size.split('x').map(Number) as [number, number];
  const blank = await sharp({ create: { width, height, channels: 3, background: '#777777' } }).png().toBuffer();
  try {
    await composeStudioPoster(blank, plan);
  } catch (error) {
    throw new StudioError(
      'composition',
      'The brand identity overlay could not be rendered for this client, so nothing was generated. The details are in the server log.',
      { cause: error },
    );
  }

  return plan;
}

/** Draws the plan's identity footer onto raw artwork of any size. */
export async function composeStudioPoster(raw: Buffer, plan: StudioOverlayPlan): Promise<ComposedPoster> {
  const metadata = await sharp(raw).metadata();
  const width = metadata.width;
  const height = metadata.height;
  if (!width || !height) throw new Error('The raw artwork has no readable dimensions');

  const bandHeight = Math.round(height * identityBandFraction(plan.aspectRatio));
  const sample = await sampleFooterArtwork(raw, width, height, bandHeight);
  const palette = resolveFooterPalette(plan, sample);

  const band = layoutBand(width, bandHeight, plan);
  const bandPng = await renderBand(band, plan, palette);

  const top = height - band.height;
  const layers: OverlayOptions[] = [{ input: bandPng, left: 0, top }];

  if (plan.logo && band.logo) {
    layers.push({
      input: await rasterizeLogo(plan.logo, band.logo.width, band.logo.height),
      left: band.logo.left,
      top: top + band.logo.top,
    });
  }

  const bytes = await sharp(raw).composite(layers).png().toBuffer();
  return { bytes, mimeType: 'image/png', drawn: plan.drawn, footerTone: palette.tone };
}

// ---------------------------------------------------------------------------
// Tone and colour
// ---------------------------------------------------------------------------

/**
 * AUTO's threshold on mean relative luminance. 0.32 is roughly L* 63: a pale,
 * airy image sits well above it, a dark or saturated one below. Measured per
 * pixel in linear light, so a few bright highlights on a dark scene do not tip it.
 */
const LIGHT_ARTWORK_LUMINANCE = 0.32;

/** How much of the artwork's hue the ground takes on. Enough to belong, not enough to tint the text. */
const MAX_TINT_SATURATION = { LIGHT: 0.32, DARK: 0.45 } as const;

/**
 * A transparent logo reads on a ground when at least this share of its ink
 * clears 3:1 against it. A share rather than the mean: a teal disc carrying a
 * white glyph averages out mid-light and fails a mean test on white, yet the
 * disc — most of the ink — plainly reads there.
 */
const LEGIBLE_INK_SHARE = 0.6;

interface LogoInk {
  /** No transparent pixels: the logo carries its own background and reads on any ground. */
  opaque: boolean;
  /** Relative luminance of each opaque pixel of a downsampled copy; null when unmeasurable (SVG). */
  luminances: number[] | null;
}

interface ArtworkSample {
  /** Mean relative luminance, 0–1. */
  luminance: number;
  /** Mean colour, sRGB. */
  color: Rgb;
}

interface FooterPalette {
  tone: StudioFooterTone;
  ground: string;
  name: string;
  tagline: string;
  contact: string;
}

/**
 * The artwork the footer meets: the strip just above it, which stays visible,
 * and the top of the band, which shows through the feathered edge. Downsampled
 * first — this is an average, not an inspection.
 */
async function sampleFooterArtwork(
  raw: Buffer,
  width: number,
  height: number,
  bandHeight: number,
): Promise<ArtworkSample> {
  const above = Math.round(bandHeight * 0.75);
  const into = Math.round(bandHeight * 0.35);
  const top = Math.max(0, height - bandHeight - above);
  const regionHeight = Math.min(height - top, above + into);

  const { data, info } = await sharp(raw)
    .extract({ left: 0, top, width, height: regionHeight })
    .removeAlpha()
    .resize({ width: 96, height: 12, fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  let luminance = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  const pixels = info.width * info.height;
  for (let index = 0; index < data.length; index += info.channels) {
    const rgb = { r: data[index]!, g: data[index + 1]!, b: data[index + 2]! };
    luminance += relativeLuminance(rgb);
    r += rgb.r;
    g += rgb.g;
    b += rgb.b;
  }

  return { luminance: luminance / pixels, color: { r: r / pixels, g: g / pixels, b: b / pixels } };
}

function resolveFooterPalette(plan: StudioOverlayPlan, sample: ArtworkSample): FooterPalette {
  const preferred: StudioFooterTone =
    plan.footerBackground === 'AUTO'
      ? sample.luminance >= LIGHT_ARTWORK_LUMINANCE
        ? 'LIGHT'
        : 'DARK'
      : plan.footerBackground;

  const tone = plan.footerBackground === 'AUTO' ? autoTone(plan, preferred) : preferred;

  // The tinted ground, unless it would cost a transparent logo its legibility —
  // then the brand's plain neutral for the same tone, which the pre-flight (for
  // an explicit tone) or `autoTone` has already confirmed the logo reads on.
  let ground = tintedGround(plan.theme, tone, sample.color);
  if (plan.logo && plan.logoInk && !logoReadsOnGround(plan.logo, plan.logoInk, ground)) {
    ground = neutralGround(plan.theme, tone);
  }

  const name = ensureContrast(bestTextOn(ground), ground, 7);
  return {
    tone,
    ground,
    name,
    tagline: ensureContrast(plan.theme.accent, ground, 4.5),
    // Quieter than the name, still comfortably readable.
    contact: ensureContrast(mixHex(name, ground, 0.22), ground, 4.5),
  };
}

/** AUTO follows the artwork unless a transparent logo would not read on that tone. */
function autoTone(plan: StudioOverlayPlan, preferred: StudioFooterTone): StudioFooterTone {
  if (!plan.logo || !plan.logoInk) return preferred;
  if (logoReadsOnGround(plan.logo, plan.logoInk, neutralGround(plan.theme, preferred))) return preferred;
  const other: StudioFooterTone = preferred === 'LIGHT' ? 'DARK' : 'LIGHT';
  if (logoReadsOnGround(plan.logo, plan.logoInk, neutralGround(plan.theme, other))) return other;
  // Reads on neither: the renderer's historical default.
  return 'DARK';
}

function neutralGround(theme: PosterTheme, tone: StudioFooterTone): string {
  return tone === 'LIGHT' ? theme.lightNeutral : theme.darkNeutral;
}

/**
 * The brand neutral, carrying the artwork's hue at low saturation. A grey or
 * near-neutral artwork leaves the brand neutral as it is.
 */
function tintedGround(theme: PosterTheme, tone: StudioFooterTone, artwork: Rgb): string {
  const neutral = neutralGround(theme, tone);
  const hue = rgbToHsl(artwork);
  if (hue.s < 0.08) return neutral;

  const base = rgbToHsl(hexToRgb(neutral) ?? { r: 128, g: 128, b: 128 });
  // Light: at least near-white. Dark: a deep tone with enough lightness for the
  // hue to show, never lighter than a dark ground should be.
  const lightness = tone === 'LIGHT' ? Math.max(base.l, 0.955) : Math.min(Math.max(base.l, 0.09), 0.13);
  const saturation = Math.min(hue.s * (tone === 'LIGHT' ? 0.5 : 0.6), MAX_TINT_SATURATION[tone]);
  return rgbToHex(hslToRgb({ h: hue.h, s: saturation, l: lightness }));
}

function logoReadsOnGround(logo: ResolvedStudioLogo, ink: LogoInk, ground: string): boolean {
  if (ink.opaque) return true;
  const rgb = hexToRgb(ground);
  if (!ink.luminances || ink.luminances.length === 0 || !rgb) return logoReadsOn(logo.inkLuminance, ground);

  const groundLuminance = relativeLuminance(rgb);
  let legible = 0;
  for (const luminance of ink.luminances) {
    const lighter = Math.max(luminance, groundLuminance);
    const darker = Math.min(luminance, groundLuminance);
    if ((lighter + 0.05) / (darker + 0.05) >= 3) legible += 1;
  }
  return legible / ink.luminances.length >= LEGIBLE_INK_SHARE;
}

async function sampleLogoInk(logo: ResolvedStudioLogo): Promise<LogoInk> {
  if (logo.isSvg) return { opaque: false, luminances: null };
  try {
    const { data, info } = await sharp(logo.bytes)
      .resize({ width: 64, height: 64, fit: 'inside' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let opaque = true;
    const luminances: number[] = [];
    for (let index = 0; index < data.length; index += info.channels) {
      const alpha = data[index + 3]!;
      if (alpha < 250) opaque = false;
      if (alpha >= 128) {
        luminances.push(relativeLuminance({ r: data[index]!, g: data[index + 1]!, b: data[index + 2]! }));
      }
    }
    return { opaque, luminances };
  } catch {
    return { opaque: false, luminances: null };
  }
}

function mixHex(from: string, to: string, amount: number): string {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  if (!a || !b) return from;
  return rgbToHex({
    r: a.r + (b.r - a.r) * amount,
    g: a.g + (b.g - a.g) * amount,
    b: a.b + (b.b - a.b) * amount,
  });
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * Average advance width per em, deliberately generous. Text is sized to fit
 * rather than truncated — exact contact details that are cut off are worse than
 * smaller ones — so an estimate that runs wide only costs a few pixels of size.
 */
const EM = { heading: 0.66, bodyBold: 0.58, body: 0.55 } as const;

/** One block of text, already broken into the lines it is drawn on. */
interface TextBlock {
  lines: string[];
  size: number;
}

interface BandLayout {
  width: number;
  height: number;
  /** Height of the feathered top edge; the solid footer is below it. */
  fade: number;
  paddingX: number;
  paddingY: number;
  inner: number;
  gap: number;
  logo: { left: number; top: number; width: number; height: number } | null;
  identityWidth: number;
  name: TextBlock | null;
  tagline: TextBlock | null;
  taglineGap: number;
  contact: TextBlock | null;
}

/**
 * Sizes and places everything in the footer.
 *
 * Order of precedence: the logo takes its box; the tagline and the contact
 * details share one secondary size, solved together so neither crowds the other
 * out of the row; the company name takes what the identity column then allows,
 * always larger than the tagline. A name or tagline that would otherwise be set
 * very small goes onto two balanced lines — split explicitly, not left to
 * satori's greedy wrapping, which can run to a third line.
 */
function layoutBand(width: number, bandHeight: number, plan: StudioOverlayPlan): BandLayout {
  const fade = Math.round(bandHeight * 0.16);
  const solid = bandHeight - fade;
  const paddingY = Math.round(solid * 0.12);
  const paddingX = Math.round(Math.max(solid * 0.3, width * 0.04));
  const inner = solid - paddingY * 2;
  const gap = Math.round(solid * 0.14);
  const available = width - paddingX * 2;

  let logo: BandLayout['logo'] = null;
  if (plan.logo) {
    const box = { width: Math.round(width * (plan.name ? 0.22 : 0.3)), height: inner };
    const fitted = containFit({ width: plan.logo.width, height: plan.logo.height }, box);
    logo = {
      left: paddingX,
      top: fade + paddingY + Math.round((inner - fitted.height) / 2),
      width: Math.max(1, fitted.width),
      height: Math.max(1, fitted.height),
    };
  }

  const contactTexts = [plan.website, plan.phone].filter((text): text is string => Boolean(text));
  const contactChars = Math.max(0, ...contactTexts.map((text) => text.length));
  const hasIdentityText = Boolean(plan.name || plan.tagline);
  const room =
    available - (logo ? logo.width + gap : 0) - (contactTexts.length > 0 && hasIdentityText ? gap * 2 : 0);

  const nameTarget = inner * (plan.tagline ? 0.38 : 0.46);
  const taglineTarget = inner * (plan.name ? 0.2 : 0.25);
  const contactTarget = Math.min(
    inner * (contactTexts.length > 1 ? 0.21 : 0.24),
    inner / Math.max(1, contactTexts.length) / 1.3,
  );
  const taglineGap = Math.round(inner * 0.07);

  // ---- Secondary size: tagline and contact, solved together ----------------
  const secondaryFor = (taglineChars: number) => {
    const perPixel = taglineChars * EM.bodyBold + contactChars * EM.body;
    let size = Math.min(plan.tagline ? taglineTarget : Infinity, contactTexts.length > 0 ? contactTarget : Infinity);
    if (perPixel > 0) size = Math.min(size, room / perPixel);
    // With a tagline beside it the contact column cannot claim the whole row.
    if (contactChars > 0 && hasIdentityText) size = Math.min(size, (available * 0.44) / (contactChars * EM.body));
    return size;
  };

  const taglineSplit = plan.tagline ? balancedSplit(plan.tagline) : null;
  let taglineLines = plan.tagline ? [plan.tagline] : [];
  let secondary = secondaryFor(plan.tagline?.length ?? 0);
  if (plan.tagline && taglineSplit && secondary < taglineTarget * 0.62) {
    const twoLine = secondaryFor(longest(taglineSplit));
    if (twoLine > secondary * 1.2) {
      secondary = twoLine;
      taglineLines = taglineSplit;
    }
  }
  if (!Number.isFinite(secondary)) secondary = 0;

  const contactWidth = contactChars > 0 ? Math.ceil(contactChars * secondary * EM.body) : 0;
  const identityWidth = Math.max(1, Math.floor(room - contactWidth));

  // ---- Company name: the strongest element ----------------------------------
  let name: BandLayout['name'] = null;
  if (plan.name) {
    const oneLine = Math.min(nameTarget, identityWidth / (plan.name.length * EM.heading));
    name = { lines: [plan.name], size: oneLine };
    const split = balancedSplit(plan.name);
    if (split && oneLine < nameTarget * 0.7) {
      const heightLeft = inner - (plan.tagline ? taglineGap + taglineLines.length * 1.2 * secondary : 0);
      const twoLine = Math.min(nameTarget * 0.8, identityWidth / (longest(split) * EM.heading), heightLeft / 2.16);
      if (twoLine > oneLine * 1.15) name = { lines: split, size: twoLine };
    }
  }

  let taglineSize = secondary;
  // Secondary to the name, always.
  if (name) taglineSize = Math.min(taglineSize, name.size * 0.62);

  // The identity block must fit the footer's height.
  const blockHeight =
    (name ? name.size * 1.08 * name.lines.length : 0) +
    (name && plan.tagline ? taglineGap : 0) +
    (plan.tagline ? taglineSize * 1.2 * taglineLines.length : 0);
  if (blockHeight > inner) {
    const scale = inner / blockHeight;
    if (name) name.size *= scale;
    taglineSize *= scale;
  }

  // Contact details stay readable but never outrank the tagline.
  const contactSize = plan.tagline ? Math.min(secondary, Math.max(taglineSize, inner * 0.15)) : secondary;

  return {
    width,
    height: bandHeight,
    fade,
    paddingX,
    paddingY,
    inner,
    gap,
    logo,
    identityWidth,
    name: name ? { lines: name.lines, size: floorSize(name.size) } : null,
    tagline: plan.tagline ? { lines: taglineLines, size: floorSize(taglineSize) } : null,
    taglineGap,
    contact: contactTexts.length > 0 ? { lines: contactTexts, size: floorSize(contactSize) } : null,
  };
}

function floorSize(size: number): number {
  return Math.max(10, Math.floor(size));
}

function longest(lines: readonly string[]): number {
  return Math.max(...lines.map((line) => line.length));
}

/** `text` split into two lines at the space nearest its middle; null for a single word. */
function balancedSplit(text: string): [string, string] | null {
  const middle = text.length / 2;
  let best = -1;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === ' ' && (best < 0 || Math.abs(index - middle) < Math.abs(best - middle))) best = index;
  }
  if (best < 0) return null;
  return [text.slice(0, best), text.slice(best + 1)];
}

// ---------------------------------------------------------------------------
// Stage 1 — footer and text (satori + resvg)
// ---------------------------------------------------------------------------

/** Satori's element shape, built without JSX so this stays a plain .ts module. */
type Node = { type: string; props: { style?: Record<string, unknown>; children?: Node | string | Array<Node | string> } };

function el(type: string, style: Record<string, unknown>, children?: Node['props']['children']): Node {
  return { type, props: { style, ...(children === undefined ? {} : { children }) } };
}

async function renderBand(band: BandLayout, plan: StudioOverlayPlan, palette: FooterPalette): Promise<Buffer> {
  const heading = plan.theme.headingFont;
  const body = plan.theme.bodyFont;

  const row: Node[] = [];

  // Space the logo will be composited into by sharp.
  if (band.logo) {
    row.push(el('div', { display: 'flex', width: band.logo.width, height: band.inner, flexShrink: 0 }));
  }

  const textLines = (block: TextBlock, style: Record<string, unknown>, lineHeight: number) =>
    block.lines.map((line) =>
      el('div', { display: 'flex', fontSize: block.size, lineHeight, whiteSpace: 'nowrap', ...style }, line),
    );

  if (band.name || band.tagline) {
    const stack: Node[] = [];
    if (band.name) {
      stack.push(
        ...textLines(
          band.name,
          { fontFamily: heading.family, fontWeight: heaviestWeight(heading), color: palette.name },
          1.08,
        ),
      );
    }
    if (band.tagline) {
      stack.push(
        el(
          'div',
          { display: 'flex', flexDirection: 'column', marginTop: band.name ? band.taglineGap : 0 },
          textLines(
            band.tagline,
            { fontFamily: body.family, fontWeight: heaviestWeight(body), color: palette.tagline },
            1.2,
          ),
        ),
      );
    }
    row.push(
      el(
        'div',
        {
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          width: band.identityWidth,
          height: band.inner,
          marginLeft: band.logo ? band.gap : 0,
          flexShrink: 1,
        },
        stack,
      ),
    );
  }

  if (band.contact) {
    row.push(
      el(
        'div',
        {
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'flex-end',
          marginLeft: 'auto',
          paddingLeft: band.gap,
          height: band.inner,
          flexShrink: 0,
        },
        textLines(
          band.contact,
          { fontFamily: body.family, fontWeight: lightestWeight(body), color: palette.contact },
          1.3,
        ),
      ),
    );
  }

  const tree = el(
    'div',
    { display: 'flex', flexDirection: 'column', width: band.width, height: band.height },
    [
      // Feathered top edge: eased so the artwork fades into the footer without a seam.
      el('div', {
        display: 'flex',
        width: band.width,
        height: band.fade,
        backgroundImage: `linear-gradient(to bottom, ${withAlpha(palette.ground, 0)} 0%, ${withAlpha(palette.ground, 0.35)} 40%, ${withAlpha(palette.ground, 0.82)} 75%, ${withAlpha(palette.ground, 1)} 100%)`,
      }),
      el(
        'div',
        {
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          width: band.width,
          height: band.height - band.fade,
          paddingLeft: band.paddingX,
          paddingRight: band.paddingX,
          backgroundColor: palette.ground,
        },
        row,
      ),
    ],
  );

  // Satori's types expect a React element; this plain object is the same shape.
  const svg = await satori(tree as unknown as Parameters<typeof satori>[0], {
    width: band.width,
    height: band.height,
    fonts: plan.fonts.map((font) => ({ name: font.name, data: font.data, weight: font.weight, style: font.style })),
  });

  return Buffer.from(
    new Resvg(svg, { fitTo: { mode: 'width', value: band.width }, background: 'rgba(0, 0, 0, 0)' }).render().asPng(),
  );
}

// ---------------------------------------------------------------------------
// Stage 2 — logo pixels (sharp)
// ---------------------------------------------------------------------------

/**
 * Scales the logo into its box. Scaling only: no trim, no recolour. A vector
 * logo is rasterised at a density that renders it at the target size directly,
 * rather than resampling a small raster up. Shared with `composeCloneIdentity`,
 * which places the same logo into a template's own logo box.
 */
export async function rasterizeLogo(logo: ResolvedStudioLogo, width: number, height: number): Promise<Buffer> {
  if (logo.isSvg) {
    const intrinsic = Math.max(logo.width, logo.height) || 1;
    const density = Math.min(2400, Math.max(72, Math.ceil((Math.max(width, height) / intrinsic) * 72 * 2)));
    return sharp(logo.bytes, { density }).resize({ width, height, fit: 'inside' }).png().toBuffer();
  }
  return sharp(logo.bytes).resize({ width, height, fit: 'inside' }).png().toBuffer();
}

/**
 * The same logo with its transparent margin cut away, as a **new** object — the
 * caller's logo is left exactly as it was, so the studio's footer band, whose
 * layout is measured against the uploaded file, is untouched.
 *
 * Most uploaded marks carry a wide transparent border. Fitted into a template's
 * own logo box that border is drawn as empty space, and the mark itself ends up a
 * fraction of the room the design left for it.
 *
 * Two guards, both learned the hard way:
 *
 *   - **Raster only.** A vector logo is rasterised at the size it is drawn at, so
 *     its margin costs nothing, and trimming would change its intrinsic box.
 *   - **A corner must be transparent.** `trim` works from the top-left pixel's
 *     colour, so a logo whose white box *is* the design would have that box cut
 *     off. No transparent corner, no trim.
 *
 * Anything unreadable, or a trim that leaves nothing, returns the logo unchanged:
 * this is a tidy-up, never a reason for a poster to fail.
 */
export async function trimLogoPadding(logo: ResolvedStudioLogo): Promise<ResolvedStudioLogo> {
  if (logo.isSvg) return logo;
  try {
    const { data, info } = await sharp(logo.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (info.width < 2 || info.height < 2) return logo;
    const alphaAt = (x: number, y: number) => data[(y * info.width + x) * info.channels + 3] ?? 255;
    const corners = [alphaAt(0, 0), alphaAt(info.width - 1, 0), alphaAt(0, info.height - 1), alphaAt(info.width - 1, info.height - 1)];
    if (corners.every((alpha) => alpha >= 250)) return logo;

    const trimmed = await sharp(logo.bytes).trim({ threshold: 1 }).png().toBuffer({ resolveWithObject: true });
    if (trimmed.info.width < 1 || trimmed.info.height < 1) return logo;
    return { ...logo, bytes: trimmed.data, mimeType: 'image/png', width: trimmed.info.width, height: trimmed.info.height };
  } catch {
    return logo;
  }
}
