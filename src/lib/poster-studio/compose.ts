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
  type StudioLogoBackground,
  type StudioOverlayElement,
} from '@/lib/poster-studio/limits';
import { heaviestWeight, loadFonts, type LoadedFont } from '@/lib/poster/fonts';
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
 * single identity band on top and touches nothing else.
 *
 * Two stages:
 *   1. Text and the band itself — satori to SVG, resvg to PNG, in the client's
 *      own typography and theme colours (`resolvePosterTheme`, `loadFonts`).
 *   2. Pixels — sharp composites the band and the logo onto the raw artwork.
 *
 * **The logo is scaled and nothing else.** No trim, no recolour, no backing plate:
 * "Keep original" means the uploaded file, and "Remove background" means the
 * transparent version `resolveStudioLogo` produced. Whether the logo reads on the
 * band decides the band's colour instead (`logoReadsOn`), so the artwork is never
 * altered to fit the band.
 *
 * `prepareStudioOverlay` does everything that can fail deterministically — the
 * logo, the fonts, a full dry-run composite — and runs before any image is paid
 * for.
 */

export interface StudioOverlaySelection {
  elements: StudioOverlayElement[];
  logoBackground: StudioLogoBackground;
}

export interface StudioOverlayPlan {
  preset: typeof STUDIO_OVERLAY_PRESET;
  aspectRatio: StudioAspectRatio;
  theme: PosterTheme;
  fonts: LoadedFont[];
  logo: ResolvedStudioLogo | null;
  name: string | null;
  tagline: string | null;
  website: string | null;
  phone: string | null;
  drawn: StudioDrawnElement[];
}

export interface ComposedPoster {
  bytes: Buffer;
  mimeType: 'image/png';
  drawn: StudioDrawnElement[];
}

/**
 * Validates a selection against the client's Brand Canvas and loads everything
 * the overlay needs. Throws `StudioError` before any spend when a prerequisite
 * is missing: an element with no stored value, an unreadable logo, a background
 * removal the keyer declines, fonts that cannot be loaded, or a composite that
 * does not render.
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

  // The renderer's rule: the company name is printed unless a logo that already
  // spells it is on the poster.
  const name = !logo || !canvas.logoIncludesName ? canvas.companyName : null;

  const theme = resolvePosterTheme(canvas.guideline);
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
    name,
    tagline: wants.has('tagline') ? canvas.tagline : null,
    website: wants.has('website') ? canvas.website : null,
    phone: wants.has('phone') ? canvas.phone : null,
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

/** Draws the plan's identity band onto raw artwork of any size. */
export async function composeStudioPoster(raw: Buffer, plan: StudioOverlayPlan): Promise<ComposedPoster> {
  const metadata = await sharp(raw).metadata();
  const width = metadata.width;
  const height = metadata.height;
  if (!width || !height) throw new Error('The raw artwork has no readable dimensions');

  const band = layoutBand(width, height, plan);
  const bandPng = await renderBand(band, plan);

  const layers: OverlayOptions[] = [{ input: bandPng, left: 0, top: height - band.height }];

  if (plan.logo && band.logo) {
    layers.push({
      input: await rasterizeLogo(plan.logo, band.logo.width, band.logo.height),
      left: band.logo.left,
      top: height - band.height + band.logo.top,
    });
  }

  const bytes = await sharp(raw).composite(layers).png().toBuffer();
  return { bytes, mimeType: 'image/png', drawn: plan.drawn };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

interface BandLayout {
  width: number;
  height: number;
  padding: number;
  gap: number;
  rule: number;
  ground: string;
  textColor: string;
  accentText: string;
  logo: { left: number; top: number; width: number; height: number } | null;
}

function layoutBand(width: number, height: number, plan: StudioOverlayPlan): BandLayout {
  const bandHeight = Math.round(height * identityBandFraction(plan.aspectRatio));
  const rule = Math.max(3, Math.round(bandHeight * 0.025));
  const padding = Math.round(bandHeight * 0.17);
  const gap = Math.round(bandHeight * 0.14);

  // Dark band by default; light only when a logo would not read on dark. The
  // band adapts to the logo, never the other way round.
  const dark = !plan.logo || logoReadsOn(plan.logo.inkLuminance, plan.theme.darkNeutral);
  const ground = dark ? plan.theme.darkNeutral : plan.theme.lightNeutral;

  let logo: BandLayout['logo'] = null;
  if (plan.logo) {
    const box = {
      width: Math.round(width * 0.3),
      height: bandHeight - rule - padding * 2,
    };
    const fitted = containFit({ width: plan.logo.width, height: plan.logo.height }, box);
    logo = {
      left: padding,
      top: rule + padding + Math.round((box.height - fitted.height) / 2),
      width: Math.max(1, fitted.width),
      height: Math.max(1, fitted.height),
    };
  }

  return {
    width,
    height: bandHeight,
    padding,
    gap,
    rule,
    ground,
    textColor: dark ? plan.theme.onDark : plan.theme.onLight,
    accentText: dark ? plan.theme.accentOnDark : plan.theme.accentOnLight,
    logo,
  };
}

// ---------------------------------------------------------------------------
// Stage 1 — band and text (satori + resvg)
// ---------------------------------------------------------------------------

/** Satori's element shape, built without JSX so this stays a plain .ts module. */
type Node = { type: string; props: { style?: Record<string, unknown>; children?: Node | string | Array<Node | string> } };

function el(type: string, style: Record<string, unknown>, children?: Node['props']['children']): Node {
  return { type, props: { style, ...(children === undefined ? {} : { children }) } };
}

/**
 * A single line's font size: as large as its share of the band allows, shrunk
 * until an average-width estimate fits the column. Text is never truncated —
 * exact contact details that are cut off are worse than smaller ones.
 */
function fitFontSize(text: string, columnWidth: number, lineHeight: number, widthPerEm: number): number {
  const byHeight = lineHeight * 0.7;
  const byWidth = columnWidth / Math.max(1, text.length * widthPerEm);
  return Math.max(10, Math.floor(Math.min(byHeight, byWidth)));
}

async function renderBand(band: BandLayout, plan: StudioOverlayPlan): Promise<Buffer> {
  const heading = plan.theme.headingFont;
  const body = plan.theme.bodyFont;
  const inner = band.height - band.rule - band.padding * 2;

  const leftWidth = band.logo ? band.logo.width : 0;
  const nameWidth = plan.name ? Math.round(band.width * (band.logo ? 0.28 : 0.42)) : 0;
  const rightWidth =
    band.width - band.padding * 2 - leftWidth - nameWidth - band.gap * ((band.logo ? 1 : 0) + (plan.name ? 1 : 0));

  const lines: Array<{ text: string; family: string; weight: number; color: string; widthPerEm: number }> = [];
  if (plan.tagline) {
    lines.push({ text: plan.tagline, family: heading.family, weight: heaviestWeight(heading), color: band.accentText, widthPerEm: 0.62 });
  }
  if (plan.website) {
    lines.push({ text: plan.website, family: body.family, weight: heaviestWeight(body), color: band.textColor, widthPerEm: 0.56 });
  }
  if (plan.phone) {
    lines.push({ text: plan.phone, family: body.family, weight: heaviestWeight(body), color: band.textColor, widthPerEm: 0.56 });
  }

  const lineHeight = inner / Math.max(2, lines.length);

  const children: Node[] = [];

  // Space the logo will be composited into by sharp.
  if (band.logo) {
    children.push(el('div', { display: 'flex', width: band.logo.width, height: inner, flexShrink: 0 }));
  }

  if (plan.name) {
    // One line or two, whichever lets the exact name be set larger. Satori wraps
    // at word boundaries inside the fixed-width column.
    const oneLine = fitFontSize(plan.name, nameWidth, inner * 0.6, 0.62);
    const twoLines = plan.name.includes(' ')
      ? fitFontSize(plan.name.slice(0, Math.ceil(plan.name.length / 2) + 2), nameWidth, inner * 0.46, 0.62)
      : 0;
    const size = Math.max(oneLine, twoLines);
    children.push(
      el(
        'div',
        {
          display: 'flex',
          alignItems: 'center',
          width: nameWidth,
          height: inner,
          marginLeft: band.logo ? band.gap : 0,
          flexShrink: 0,
          fontFamily: heading.family,
          fontWeight: heaviestWeight(heading),
          fontSize: size,
          color: band.textColor,
          lineHeight: 1.1,
        },
        plan.name,
      ),
    );
  }

  if (lines.length > 0) {
    children.push(
      el(
        'div',
        {
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'flex-end',
          marginLeft: 'auto',
          width: Math.max(1, rightWidth),
          height: inner,
        },
        lines.map((line) =>
          el(
            'div',
            {
              display: 'flex',
              fontFamily: line.family,
              fontWeight: line.weight,
              fontSize: fitFontSize(line.text, rightWidth, lineHeight, line.widthPerEm),
              color: line.color,
              lineHeight: 1.15,
              whiteSpace: 'nowrap',
            },
            line.text,
          ),
        ),
      ),
    );
  }

  const tree = el(
    'div',
    {
      display: 'flex',
      flexDirection: 'column',
      width: band.width,
      height: band.height,
      backgroundColor: band.ground,
    },
    [
      el('div', { display: 'flex', width: band.width, height: band.rule, backgroundColor: plan.theme.accent }),
      el(
        'div',
        {
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          width: band.width,
          height: band.height - band.rule,
          paddingLeft: band.padding,
          paddingRight: band.padding,
        },
        children,
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
 * rather than resampling a small raster up.
 */
async function rasterizeLogo(logo: ResolvedStudioLogo, width: number, height: number): Promise<Buffer> {
  if (logo.isSvg) {
    const intrinsic = Math.max(logo.width, logo.height) || 1;
    const density = Math.min(2400, Math.max(72, Math.ceil((Math.max(width, height) / intrinsic) * 72 * 2)));
    return sharp(logo.bytes, { density }).resize({ width, height, fit: 'inside' }).png().toBuffer();
  }
  return sharp(logo.bytes).resize({ width, height, fit: 'inside' }).png().toBuffer();
}
