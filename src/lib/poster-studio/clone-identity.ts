import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';
import sharp, { type OutputInfo, type OverlayOptions } from 'sharp';

import { isCodeDrawnIdentity } from '@/lib/ai/studio-prompts';
import type { ResolvedStudioLogo } from '@/lib/poster-studio/brand-logo';
import { rasterizeLogo, trimLogoPadding } from '@/lib/poster-studio/compose';
import { LOGO_INSET, placeLogoInBox, toPixelBox, type PixelBox } from '@/lib/poster-studio/logo-placement';
import { contrastRatio, relativeLuminance, rgbToHex, type Rgb } from '@/lib/poster/color';
import { loadFonts, type LoadedFont } from '@/lib/poster/fonts';
import type { DayLogoPlacement, ElementBox, ResolvedElement } from '@/lib/types/template-elements';
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
  /**
   * The admin's logo placement, from the day's document. Null or absent leaves
   * the mark where code puts it. A placement given here also turns off both of
   * the compositor's own corrections — the clean-part deflation and the lockup
   * square — so what the admin chose is exactly what is drawn.
   */
  placement?: DayLogoPlacement | null;
}

/** Face identity text is drawn in: a neutral geometric sans that sits well in most templates. */
const IDENTITY_FONT: PosterFontChoice = { family: 'Poppins', weights: [600] };

const DARK_INK = '#0B0B0D';
const LIGHT_INK = '#FFFFFF';

/**
 * The logo geometry, re-exported from the browser-importable module that owns
 * it: every caller still reads it here, beside the compositor that uses it.
 */
export { LOGO_INSET, placeLogoInBox, toPixelBox, type PixelBox };

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
    // The transparent margin many logo files carry is padding, not design: left
    // on, it shrinks the mark inside every box it is fitted to.
    const logo = await trimLogoPadding(input.logo);
    const placement = input.placement ?? null;
    for (const item of input.resolved) {
      if (item.action.type !== 'logo') continue;
      const box = toPixelBox(item.element.box, width, height);
      // Once the admin has placed the mark, code stops correcting the box: the
      // whole element box is theirs to position in, and the browser preview —
      // which knows only that box — shows exactly this.
      const target = placement ? box : await clearPartOfBox(raw, item.action.name ? lockupMarkBox(box, logo) : box, width, height);
      const layer = await logoLayer(logo, target, placement);
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
 * Share of a logo box's **area** a clean part must keep as well.
 *
 * Half the width and half the height each pass `MIN_CLEAR_SHARE` while leaving a
 * quarter of the box — a mark deflated twice over, which is how day 1 of the
 * Sirah campaign ended up with a logo jammed into the corner. The two floors
 * together let one direction give way, but not both at once.
 */
export const MIN_CLEAR_AREA_SHARE = 0.45;

/**
 * Smallest a composited mark may be, as a share of the poster's shorter side. A
 * measured box, a clean part and a lockup square each make the mark smaller; on a
 * 1280×1600 poster this keeps it at 70px or more, which is where a logo stops
 * reading as one.
 */
export const MIN_LOGO_SHARE = 0.055;

/**
 * The part of a logo box the image model actually left empty.
 *
 * The prompt asks for the logo's area to stay clean, but a model rewrapping
 * nearby words sometimes lets a line run into it — measured in the Phase 2
 * end-to-end run, where "healthcare business" started under the composited
 * mark. So the box is measured: a column (then, within the clean columns, a row)
 * is inked when more than `inkShare` (10%) of its pixels differ clearly from the box's
 * median colour, and the logo goes into the longest clean run — provided it
 * keeps at least half the box in that direction, and `minAreaShare` of its area
 * in both together. A box over a photograph or a pattern has no such run and is
 * used whole, as before.
 */
export function clearPartFromPixels(
  pixels: { data: Uint8Array | Buffer; width: number; height: number; channels: number },
  options: { threshold?: number; inkShare?: number; minAreaShare?: number } = {},
): { left: number; top: number; width: number; height: number } {
  const { data, width, height, channels } = pixels;
  const threshold = options.threshold ?? 48;
  const inkShare = options.inkShare ?? 0.1;
  const minAreaShare = options.minAreaShare ?? MIN_CLEAR_AREA_SHARE;
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
  const part = { left: columns[0], top, width: columns[1] - columns[0], height: bottom - top };
  return part.width * part.height >= minAreaShare * width * height ? part : whole;
}

/**
 * `clearPartFromPixels` for a box of a rendered poster, in the poster's pixels —
 * and never below `MIN_LOGO_SHARE` of the poster's shorter side. A clean part too
 * small to hold a legible mark is no use: the whole box, with a word run into a
 * corner of it, still reads better than a mark nobody can make out.
 */
async function clearPartOfBox(raw: Buffer, box: PixelBox, posterWidth: number, posterHeight: number): Promise<PixelBox> {
  if (box.width < 4 || box.height < 4) return box;
  const { data, info } = await sharp(raw).extract(box).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const part = clearPartFromPixels({ data, width: info.width, height: info.height, channels: info.channels });
  const floor = MIN_LOGO_SHARE * Math.min(posterWidth, posterHeight);
  if (Math.max(part.width, part.height) < floor && Math.max(box.width, box.height) >= floor) return box;
  return { left: box.left + part.left, top: box.top + part.top, width: part.width, height: part.height };
}

/**
 * Where the client's mark goes in a wide logo badge whose lettering the image
 * model rewrites (a `logo` action with a `name`): the left end of the badge, as
 * tall as it, as wide as the mark's own shape needs — the area `buildClonePrompt`
 * asks the model to leave empty, which is why `maxShare` and that prompt's "the
 * left third of the badge" must change together.
 *
 * Never narrower than a square, so a tall mark keeps the room it had; never wider
 * than `maxShare` of the badge, so the written name keeps the rest; never wider
 * than the badge itself.
 */
export function lockupMarkBox(box: PixelBox, logo?: { width: number; height: number } | null, maxShare = 1 / 3): PixelBox {
  const aspect = logo && logo.height > 0 && logo.width > 0 ? logo.width / logo.height : 1;
  const share = Math.max(box.height, Math.round(box.width * maxShare));
  const width = Math.min(box.width, Math.max(box.height, Math.min(Math.round(box.height * aspect), share)));
  return { left: box.left, top: box.top, width, height: box.height };
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

async function logoLayer(logo: ResolvedStudioLogo, box: PixelBox, placement: DayLogoPlacement | null): Promise<OverlayOptions | null> {
  const placed = placeLogoInBox(box, logo, placement);
  if (placed.width < 2 || placed.height < 2) return null;

  const png = await rasterizeLogo(logo, placed.width, placed.height);
  // `fit: inside` can land a pixel short of the requested size; keep what came
  // back where `placeLogoInBox` put it, taking up the shortfall at the far edge.
  const actual = await sharp(png).metadata();
  const logoWidth = actual.width ?? placed.width;
  const logoHeight = actual.height ?? placed.height;
  return {
    input: png,
    left: placed.left + Math.round((placed.width - logoWidth) / 2),
    top: placed.top + Math.round((placed.height - logoHeight) / 2),
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
