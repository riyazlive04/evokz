import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';
import sharp, { type OutputInfo, type OverlayOptions } from 'sharp';

import { isCodeDrawnIdentity } from '@/lib/ai/studio-prompts';
import type { ResolvedStudioLogo } from '@/lib/poster-studio/brand-logo';
import { rasterizeLogo } from '@/lib/poster-studio/compose';
import { contrastRatio, relativeLuminance, rgbToHex, type Rgb } from '@/lib/poster/color';
import { loadFonts, type LoadedFont } from '@/lib/poster/fonts';
import { containFit } from '@/lib/poster/image-info';
import type { ElementBox, ResolvedElement } from '@/lib/types/template-elements';
import type { PosterFontChoice } from '@/lib/types/poster';

/**
 * Exact identity for a cloned template poster, drawn by code after generation.
 *
 * The clone counterpart of `composeStudioPoster`. There is no footer band: a
 * clone keeps the template's own design, so identity goes back where the
 * template had it —
 *
 *   - **The logo**, always. The image model clears every `logo` element and the
 *     client's exact logo is scaled into that box here, fit inside and centred.
 *     No model can reproduce a logo, and a near-miss is worse than none. In a
 *     wide badge whose lettering the model rewrites with the company name, the
 *     logo goes into the square at the badge's left end (`lockupMarkBox`).
 *   - **Identity text**, when `drawIdentityText` is set: the business name,
 *     tagline, phone and website, drawn as real glyphs into the boxes the model
 *     was told to leave empty (`buildClonePrompt` with `identity: 'code'`). One
 *     line, sized to the box, dark or light ink chosen by measuring what the
 *     model left behind in that box.
 *
 * Boxes are the template's own, normalised, so they scale to whatever size the
 * image model returned. Nothing here calls a model or touches storage.
 */

export interface CloneIdentityInput {
  resolved: readonly ResolvedElement[];
  /** The client's logo, or null to place none. */
  logo: ResolvedStudioLogo | null;
  /** Draw brand-bound identity text (name, tagline, phone, website) into its boxes. */
  drawIdentityText: boolean;
  /** Forces the ink of drawn text; measured per box when omitted. */
  textColorHint?: 'dark' | 'light';
}

/** Face identity text is drawn in: a neutral geometric sans that sits well in most templates. */
const IDENTITY_FONT: PosterFontChoice = { family: 'Poppins', weights: [600] };

const DARK_INK = '#0B0B0D';
const LIGHT_INK = '#FFFFFF';

/** Share of a logo box left clear on each side, so the mark does not touch its surroundings. */
const LOGO_INSET = 0.06;

/**
 * Share of a text box's height the drawn ink may fill. Template text boxes are
 * measured tight around the old words' ink; this leaves room for descenders and
 * the measurement's own grid.
 */
const TEXT_INK_HEIGHT = 0.78;

/** Share of a text box's width the drawn ink may fill. */
const TEXT_INK_WIDTH = 0.98;

export async function composeCloneIdentity(raw: Buffer, input: CloneIdentityInput): Promise<Buffer> {
  const meta = await sharp(raw).metadata();
  const width = meta.width;
  const height = meta.height;
  if (!width || !height) throw new Error('The cloned artwork has no readable dimensions');

  const layers: OverlayOptions[] = [];

  if (input.logo) {
    for (const item of input.resolved) {
      if (item.action.type !== 'logo') continue;
      const box = toPixelBox(item.element.box, width, height);
      const target = item.action.name ? lockupMarkBox(box) : box;
      const layer = await logoLayer(input.logo, await clearPartOfBox(raw, target));
      if (layer) layers.push(layer);
    }
  }

  if (input.drawIdentityText) {
    const texts = input.resolved.filter(
      (item): item is ResolvedElement & { action: { type: 'replace'; text: string } } =>
        item.action.type === 'replace' && isCodeDrawnIdentity(item.element.kind),
    );
    if (texts.length > 0) {
      const fonts = await loadFonts([IDENTITY_FONT]);
      for (const item of texts) {
        const box = toPixelBox(item.element.box, width, height);
        if (box.width < 4 || box.height < 4) continue;
        const background = await sampleBackground(raw, box);
        const ink = inkFor(background, input.textColorHint);
        const layer = await textLayer(item.action.text, box, ink, identityTextAlign(item.element.box), fonts);
        if (layer) layers.push(layer);
      }
    }
  }

  const image = sharp(raw);
  return (layers.length > 0 ? image.composite(layers) : image).png().toBuffer();
}

// ---------------------------------------------------------------------------
// Geometry and colour — pure
// ---------------------------------------------------------------------------

export interface PixelBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A normalised box in whole pixels of an image, kept inside it. */
export function toPixelBox(box: ElementBox, width: number, height: number): PixelBox {
  const left = Math.min(Math.max(Math.round(box.x * width), 0), Math.max(width - 1, 0));
  const top = Math.min(Math.max(Math.round(box.y * height), 0), Math.max(height - 1, 0));
  const right = Math.min(Math.max(Math.round((box.x + box.w) * width), left + 1), width);
  const bottom = Math.min(Math.max(Math.round((box.y + box.h) * height), top + 1), height);
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * The longest run of `true` in a list, as [start, end) — the first on a tie —
 * or null when there is none.
 */
export function longestRun(flags: readonly boolean[]): [number, number] | null {
  let best: [number, number] | null = null;
  let start = -1;
  for (let index = 0; index <= flags.length; index += 1) {
    if (index < flags.length && flags[index]) {
      if (start < 0) start = index;
    } else if (start >= 0) {
      if (!best || index - start > best[1] - best[0]) best = [start, index];
      start = -1;
    }
  }
  return best;
}

/** Share of a logo box's width (or height) a clean part must keep to be used instead of the whole box. */
export const MIN_CLEAR_SHARE = 0.5;

/**
 * The part of a logo box the image model actually left empty.
 *
 * The prompt asks for the logo's area to stay clean, but a model rewrapping
 * nearby words sometimes lets a line run into it — measured in the Phase 2
 * end-to-end run, where "healthcare business" started under the composited
 * mark. So the box is measured: a column (then, within the clean columns, a row)
 * is inked when more than `inkShare` (10%) of its pixels differ clearly from the box's
 * median colour, and the logo goes into the longest clean run — provided it
 * keeps at least half the box in that direction. A box over a photograph or a
 * pattern has no such run and is used whole, as before.
 */
export function clearPartFromPixels(
  pixels: { data: Uint8Array | Buffer; width: number; height: number; channels: number },
  options: { threshold?: number; inkShare?: number } = {},
): { left: number; top: number; width: number; height: number } {
  const { data, width, height, channels } = pixels;
  const threshold = options.threshold ?? 48;
  const inkShare = options.inkShare ?? 0.1;
  const whole = { left: 0, top: 0, width, height };
  if (width < 4 || height < 4) return whole;

  const at = (x: number, y: number): Rgb => {
    const index = (y * width + x) * channels;
    return { r: data[index]!, g: data[index + 1]!, b: data[index + 2]! };
  };
  const all: Array<{ rgb: Rgb; luminance: number }> = [];
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) all.push({ rgb: at(x, y), luminance: relativeLuminance(at(x, y)) });
  all.sort((a, b) => a.luminance - b.luminance);
  const ground = all[Math.floor(all.length / 2)]!.rgb;
  const inked = (x: number, y: number) => {
    const pixel = at(x, y);
    return Math.max(Math.abs(pixel.r - ground.r), Math.abs(pixel.g - ground.g), Math.abs(pixel.b - ground.b)) > threshold;
  };

  const cleanColumns = Array.from({ length: width }, (_, x) => {
    let count = 0;
    for (let y = 0; y < height; y += 1) if (inked(x, y)) count += 1;
    return count <= inkShare * height;
  });
  const columns = longestRun(cleanColumns);
  if (!columns || columns[1] - columns[0] < MIN_CLEAR_SHARE * width) return whole;

  const cleanRows = Array.from({ length: height }, (_, y) => {
    let count = 0;
    for (let x = columns[0]; x < columns[1]; x += 1) if (inked(x, y)) count += 1;
    return count <= inkShare * (columns[1] - columns[0]);
  });
  const rows = longestRun(cleanRows);
  const [top, bottom] = rows && rows[1] - rows[0] >= MIN_CLEAR_SHARE * height ? rows : [0, height];
  return { left: columns[0], top, width: columns[1] - columns[0], height: bottom - top };
}

/** `clearPartFromPixels` for a box of a rendered poster, in the poster's pixels. */
async function clearPartOfBox(raw: Buffer, box: PixelBox): Promise<PixelBox> {
  if (box.width < 4 || box.height < 4) return box;
  const { data, info } = await sharp(raw).extract(box).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const part = clearPartFromPixels({ data, width: info.width, height: info.height, channels: info.channels });
  return { left: box.left + part.left, top: box.top + part.top, width: part.width, height: part.height };
}

/**
 * Where the client's mark goes in a wide logo badge whose lettering the image
 * model rewrites (a `logo` action with a `name`): the square at the badge's left
 * end, as tall as the badge — the area `buildClonePrompt` asks the model to leave
 * empty. Never wider than the badge.
 */
export function lockupMarkBox(box: PixelBox): PixelBox {
  return { left: box.left, top: box.top, width: Math.min(box.height, box.width), height: box.height };
}

/**
 * How drawn text sits in its box, from where the box is on the poster: a box
 * hugging the left edge was set flush left, one hugging the right flush right,
 * anything else centred. The measured box is the old words' extent, so the new
 * words keep the edge the designer aligned them to.
 */
export function identityTextAlign(box: ElementBox): 'start' | 'center' | 'end' {
  const centre = box.x + box.w / 2;
  if (centre < 0.4) return 'start';
  if (centre > 0.6 && box.x + box.w > 0.85) return 'end';
  return 'center';
}

/** Dark or light ink for a background colour, unless the caller forces one. */
export function inkFor(background: Rgb, hint?: 'dark' | 'light'): string {
  if (hint === 'dark') return DARK_INK;
  if (hint === 'light') return LIGHT_INK;
  const hex = rgbToHex(background);
  return contrastRatio(DARK_INK, hex) >= contrastRatio(LIGHT_INK, hex) ? DARK_INK : LIGHT_INK;
}

// ---------------------------------------------------------------------------
// Pixels
// ---------------------------------------------------------------------------

async function logoLayer(logo: ResolvedStudioLogo, box: PixelBox): Promise<OverlayOptions | null> {
  const inset = Math.round(Math.min(box.width, box.height) * LOGO_INSET);
  const bounds = { width: box.width - inset * 2, height: box.height - inset * 2 };
  if (bounds.width < 2 || bounds.height < 2) return null;

  const fitted = containFit({ width: logo.width, height: logo.height }, bounds);
  const png = await rasterizeLogo(logo, Math.max(1, fitted.width), Math.max(1, fitted.height));
  // `fit: inside` can land a pixel short of the requested size; centre what came back.
  const actual = await sharp(png).metadata();
  const logoWidth = actual.width ?? fitted.width;
  const logoHeight = actual.height ?? fitted.height;
  return {
    input: png,
    left: box.left + Math.round((box.width - logoWidth) / 2),
    top: box.top + Math.round((box.height - logoHeight) / 2),
  };
}

/**
 * The background a text box holds: the colour of its median-luminance pixel.
 *
 * The median rather than the mean, because the model sometimes leaves a trace of
 * the old words in the box, and ink pulls a mean towards itself while barely
 * moving a median.
 */
async function sampleBackground(raw: Buffer, box: PixelBox): Promise<Rgb> {
  const { data, info } = await sharp(raw)
    .extract(box)
    .removeAlpha()
    .resize({ width: 32, height: 12, fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels: Array<{ rgb: Rgb; luminance: number }> = [];
  for (let index = 0; index + 2 < data.length; index += info.channels) {
    const rgb = { r: data[index]!, g: data[index + 1]!, b: data[index + 2]! };
    pixels.push({ rgb, luminance: relativeLuminance(rgb) });
  }
  pixels.sort((a, b) => a.luminance - b.luminance);
  return pixels[Math.floor(pixels.length / 2)]?.rgb ?? { r: 128, g: 128, b: 128 };
}

/** Satori's element shape, built without JSX, as in `compose.ts`. */
type Node = { type: string; props: { style?: Record<string, unknown>; children?: string | Node | Node[] } };

/**
 * One line of text fitted to a box.
 *
 * Measured rather than estimated: the line is rendered once, larger than it will
 * be drawn, trimmed to its ink, and that ink scaled down to fit the box. An
 * advance-width estimate would be wrong in one direction or the other for every
 * face and every mix of capitals and digits, and exact contact details that
 * overflow their bar are the failure this exists to prevent.
 */
async function textLayer(
  text: string,
  box: PixelBox,
  ink: string,
  align: 'start' | 'center' | 'end',
  fonts: LoadedFont[],
): Promise<OverlayOptions | null> {
  const line = text.replace(/\s+/g, ' ').trim();
  if (!line) return null;

  // Rendered at twice the box height so the fitted line is always a downscale.
  const size = Math.max(24, Math.ceil(box.height * 2));
  const canvasWidth = Math.ceil(line.length * size * 0.9) + size * 2;
  const canvasHeight = Math.ceil(size * 1.8);

  const tree: Node = {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        alignItems: 'center',
        width: canvasWidth,
        height: canvasHeight,
        paddingLeft: size,
      },
      children: {
        type: 'div',
        props: {
          style: {
            display: 'flex',
            fontFamily: IDENTITY_FONT.family,
            fontWeight: IDENTITY_FONT.weights[0],
            fontSize: size,
            lineHeight: 1.2,
            whiteSpace: 'nowrap',
            color: ink,
          },
          children: line,
        },
      },
    },
  };

  const svg = await satori(tree as unknown as Parameters<typeof satori>[0], {
    width: canvasWidth,
    height: canvasHeight,
    fonts: fonts.map((font) => ({ name: font.name, data: font.data, weight: font.weight, style: font.style })),
  });
  const rendered = Buffer.from(
    new Resvg(svg, { fitTo: { mode: 'width', value: canvasWidth }, background: 'rgba(0, 0, 0, 0)' }).render().asPng(),
  );

  let trimmed: { data: Buffer; info: OutputInfo };
  try {
    trimmed = await sharp(rendered).trim().png().toBuffer({ resolveWithObject: true });
  } catch {
    // Nothing to trim to: the font drew no ink for this line.
    return null;
  }
  const inkWidth = trimmed.info.width;
  const inkHeight = trimmed.info.height;
  if (inkWidth < 1 || inkHeight < 1) return null;

  const scale = Math.min((box.width * TEXT_INK_WIDTH) / inkWidth, (box.height * TEXT_INK_HEIGHT) / inkHeight);
  const drawnWidth = Math.max(1, Math.floor(inkWidth * scale));
  const drawnHeight = Math.max(1, Math.floor(inkHeight * scale));
  const png = await sharp(trimmed.data).resize({ width: drawnWidth, height: drawnHeight, fit: 'fill' }).png().toBuffer();

  const left =
    align === 'start'
      ? box.left
      : align === 'end'
        ? box.left + box.width - drawnWidth
        : box.left + Math.round((box.width - drawnWidth) / 2);
  return { input: png, left, top: box.top + Math.round((box.height - drawnHeight) / 2) };
}
