import sharp from 'sharp';

import type { PlateBox } from '@/lib/types/plate-spec';

/**
 * Reads the colour a block of type is actually set in, from the reference the
 * plate was cut out of.
 *
 * **Measured, for the same reason `findPlateHoles` measures the holes.** A
 * region's ink colour is a property of the pixels — the extractor is asked about
 * geometry it has to judge, and a hex value is not that. Asked for one anyway, a
 * vision model reports plausible neighbours: `#0E7C86` for a teal that is
 * `#0F766E`, which lands close enough to look deliberate and wrong enough that
 * the composited headline is visibly a different colour from the one printed two
 * centimetres above it on the same artwork.
 *
 * It matters only under `paletteSource: "template"`, which is what a plate
 * normally wants — the type is being set on finished artwork in its designer's
 * colours, and `PlateTextRegion.color` is the only channel that carries them.
 *
 * Sampled from the **reference**, never the plate: the plate is the artwork with
 * its words erased, so by the time it exists the ink this function looks for is
 * gone.
 */

/** Guards the decode against a decompression bomb, matching `plate-regions.ts`. */
const MAX_PIXELS = 32_000_000;

/**
 * Longest edge the crop is reduced to before counting.
 *
 * Ink colour is a modal statistic, not a detail: 96px of a headline holds tens
 * of thousands of samples of the same two colours, and the reduction is what
 * keeps a whole-poster pass over seven regions in the tens of milliseconds.
 * Small enough to be cheap, large enough that a thin rule or a light weight is
 * still represented after the resize's own averaging.
 */
const SAMPLE_EDGE = 96;

/**
 * How far from the region's background a pixel must sit to count as ink.
 *
 * Euclidean in RGB, which is crude and sufficient here: the question is not
 * "which of two similar colours is this" but "is this the type or the surface
 * behind it", and those are separated by a wide margin in every readable design
 * — type that sits 70 units from its own background is type nobody can read.
 * Below this the region is a flat area of artwork with no type in it at all —
 * which happens on a box an operator drew slightly off — and that is reported as
 * null rather than as the background colour, since setting a headline in its own
 * background is worse than falling back to the theme.
 */
const INK_DISTANCE = 70;

/**
 * Share of the crop that must be ink before the reading is trusted.
 *
 * Anti-aliasing alone puts a few percent of any crop between the two colours, so
 * a threshold under this reports the ramp rather than the type.
 */
const MIN_INK_SHARE = 0.015;

/**
 * Share of a region that must be opaque plate before its surface is trusted.
 *
 * A text region positioned over a photographic hole is transparent on the plate,
 * and the colour the type will land on belongs to the generated photograph
 * rather than to the artwork. Reporting the rim in that case would be worse than
 * reporting nothing: the caller's fallback is the client's theme, which is at
 * least a deliberate pairing.
 */
const MIN_OPAQUE_SHARE = 0.6;

/** 4 bits per channel: 4,096 buckets, coarse enough to survive JPEG mottling. */
function bucketOf(r: number, g: number, b: number): number {
  return ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

interface Accumulator {
  count: number;
  r: number;
  g: number;
  b: number;
}

function meanOf(bucket: Accumulator): { r: number; g: number; b: number } {
  return {
    r: bucket.r / bucket.count,
    g: bucket.g / bucket.count,
    b: bucket.b / bucket.count,
  };
}

/**
 * Colour-bucketed pixels of one normalised box.
 *
 * Shared by the two samplers below because they ask two questions of the same
 * histogram: which cluster is the type, and which cluster is the surface it sits
 * on. Running the crop twice to answer them separately would double the sharp
 * work for nothing.
 */
interface RegionSample {
  buckets: Map<number, Accumulator>;
  /** Pixels that were opaque enough to carry a colour. */
  opaque: number;
  /** Every pixel in the crop, opaque or not. */
  total: number;
}

async function bucketRegion(bytes: Buffer, box: PlateBox): Promise<RegionSample | null> {
  const image = sharp(bytes, { limitInputPixels: MAX_PIXELS });
  const meta = await image.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width <= 0 || height <= 0) return null;

  /*
   * Clamped rather than refused. A region is allowed to run past the edge —
   * see the note on `boxSchema` — and a headline bleeding off the right is a
   * real design whose visible part is still the part worth sampling.
   */
  const left = Math.min(Math.max(Math.round(box.x * width), 0), width - 1);
  const top = Math.min(Math.max(Math.round(box.y * height), 0), height - 1);
  const cropWidth = Math.min(Math.max(Math.round(box.w * width), 1), width - left);
  const cropHeight = Math.min(Math.max(Math.round(box.h * height), 1), height - top);

  const { data } = await image
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .resize({ width: SAMPLE_EDGE, height: SAMPLE_EDGE, fit: 'inside', withoutEnlargement: true })
    // Normalises the stride to 4 whatever the source was, exactly as
    // `findPlateHoles` does.
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const buckets = new Map<number, Accumulator>();
  let opaque = 0;
  let total = 0;

  for (let i = 0; i < data.length; i += 4) {
    total += 1;

    // A transparent pixel is a hole in the artwork, not a colour. Counting it
    // as black would make every region over a cut-out read as dark ink.
    if ((data[i + 3] ?? 255) < 128) continue;

    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    opaque += 1;

    const key = bucketOf(r, g, b);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.count += 1;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
    } else {
      buckets.set(key, { count: 1, r, g, b });
    }
  }

  return { buckets, opaque, total };
}

/** The cluster a region is mostly made of — its surface, not its type. */
function modalBucket(buckets: Map<number, Accumulator>): Accumulator | null {
  let winner: Accumulator | null = null;
  for (const bucket of buckets.values()) {
    if (!winner || bucket.count > winner.count) winner = bucket;
  }
  return winner;
}

/**
 * The colour of the artwork *behind* a region, measured from the plate.
 *
 * The counterpart to `sampleRegionInk`, and deliberately read from a different
 * image. Ink is sampled from the reference, because that is the only place the
 * type still exists. The surface has to be sampled from the **plate**, because
 * that is what the type is about to be composited onto — and the two are not the
 * same picture. A headline that sat on the reference's own photograph now sits on
 * whatever the eraser reconstructed there.
 *
 * **This is what makes a plate's colours answerable rather than assumed.** Every
 * colour on the plate path used to resolve from the client's theme against an
 * imagined light ground, so a plate whose artwork is dark got dark type on it —
 * see `groundForRegion`. With the surface measured, the ground can be built from
 * what is actually there.
 *
 * `null` when the region is mostly transparent: a hole shows the generated
 * photograph, whose colour is not a property of the plate and is not knowable
 * here. The caller keeps its existing fallback for those.
 */
export async function sampleRegionSurface(
  bytes: Buffer,
  box: PlateBox,
): Promise<string | null> {
  try {
    const sample = await bucketRegion(bytes, box);
    if (!sample) return null;

    /*
     * A region has to be mostly artwork before its surface means anything.
     *
     * Below this it is a box over a photographic hole, and the modal opaque
     * bucket would report the few plate pixels around the rim rather than what
     * the type will actually sit on.
     */
    if (sample.total === 0 || sample.opaque / sample.total < MIN_OPAQUE_SHARE) return null;

    const surface = modalBucket(sample.buckets);
    if (!surface) return null;

    const mean = meanOf(surface);
    return toHex(mean.r, mean.g, mean.b);
  } catch (error) {
    console.warn(
      '[ace:plate-ink] could not sample a region surface, keeping the theme ground:',
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * The dominant ink colour inside one normalised box, or null.
 *
 * Null on every doubt — an undecodable file, a box off the edge of the image, a
 * crop with no type in it — because the caller's fallback is the client's theme,
 * which is a defensible poster. A guessed hex is not.
 */
export async function sampleRegionInk(
  bytes: Buffer,
  box: PlateBox,
): Promise<string | null> {
  try {
    const sample = await bucketRegion(bytes, box);
    if (!sample) return null;

    const { buckets, opaque } = sample;
    if (opaque === 0 || buckets.size === 0) return null;

    // The background is whatever the region is mostly made of. True for every
    // block of type there is: the surface always outweighs the letterforms.
    const background = modalBucket(buckets);
    if (!background) return null;
    const ground = meanOf(background);

    /*
     * The ink is the bucket that stands out most, scored by area *and* contrast.
     *
     * Area alone picks the wrong colour, and does it on the commonest case there
     * is. A headline box an operator dragged a little low catches the top of the
     * photograph below it, and a pale grey circle covering a third of the box
     * outnumbers the letterforms several times over — so "the largest non-
     * background cluster" reports the photograph and sets the headline in pale
     * grey. Seen on the first real extraction this was run against.
     *
     * Squaring the distance is what fixes it: type is *far* from its background
     * because it has to be legible, while an adjacent element is merely
     * different. A colour three times further out wins against nine times the
     * area, which is the trade that matches how posters are actually built.
     */
    let ink: Accumulator | null = null;
    let bestScore = 0;
    let inkPixels = 0;

    for (const bucket of buckets.values()) {
      const mean = meanOf(bucket);
      const distance = Math.sqrt(
        (mean.r - ground.r) ** 2 + (mean.g - ground.g) ** 2 + (mean.b - ground.b) ** 2,
      );
      if (distance < INK_DISTANCE) continue;

      inkPixels += bucket.count;

      const score = bucket.count * distance * distance;
      if (score > bestScore) {
        bestScore = score;
        ink = bucket;
      }
    }

    if (!ink || inkPixels / opaque < MIN_INK_SHARE) return null;

    const mean = meanOf(ink);
    return toHex(mean.r, mean.g, mean.b);
  } catch (error) {
    console.warn(
      '[ace:plate-ink] could not sample a region, falling back to the theme:',
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
