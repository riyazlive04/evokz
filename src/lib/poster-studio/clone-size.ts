/**
 * The output size of a cloned template poster.
 *
 * A clone comes out in its template's own shape (a 4:5 template stays 4:5), so
 * the size is chosen per template rather than from the client's output preset
 * or the studio's fixed formats (`STUDIO_ASPECT_RATIOS`).
 *
 * gpt-image-2 takes any `WIDTHxHEIGHT` whose sides are both multiples of 16 and
 * whose ratio is within 1:3–3:1. Output cost and time grow with the pixel count,
 * and a clone renders at `high` quality, so the size is kept to about 1.5–2.1
 * megapixels — enough for small type to stay crisp. Two sizes are fixed because
 * the Phase 0 spike measured them (2026-09-17): 4:5 → 1280x1600, 2:3 → 1024x1536.
 * Every other shape takes the size in that band whose ratio is closest, the
 * larger one on a tie.
 *
 * Pure and dependency-free: the studio's client components import it.
 */

export interface CloneSize {
  /** Exact `WIDTHxHEIGHT` sent to the image model. */
  size: string;
  width: number;
  height: number;
  /** "4:5", "2:3", or "0.70:1" for a shape with no common name. */
  aspectLabel: string;
  /** "vertical 4:5", for the prompt. */
  orientation: string;
}

/** Shapes a template is snapped to when it is within 2% of one (735×919 is 4:5). */
const NAMED_SHAPES: ReadonlyArray<readonly [string, number]> = [
  ['1:3', 1 / 3],
  ['9:16', 9 / 16],
  ['1:2', 1 / 2],
  ['2:3', 2 / 3],
  ['3:4', 3 / 4],
  ['4:5', 4 / 5],
  ['1:1', 1],
  ['5:4', 5 / 4],
  ['4:3', 4 / 3],
  ['3:2', 3 / 2],
  ['1.91:1', 1.91],
  ['16:9', 16 / 9],
  ['2:1', 2],
  ['3:1', 3],
];

const SHAPE_TOLERANCE = 0.02;

/** Sizes measured in the Phase 0 spike, used as they are. */
const FIXED_SIZES: Readonly<Record<string, readonly [number, number]>> = {
  '4:5': [1280, 1600],
  '2:3': [1024, 1536],
};

export const MIN_CLONE_PIXELS = 1_500_000;
export const MAX_CLONE_PIXELS = 2_100_000;
/** gpt-image-2's ratio limit, either way round. */
export const MAX_CLONE_RATIO = 3;
const STEP = 16;

/**
 * The clone size for a template of `width` × `height` pixels, or null when the
 * template is unmeasured or its shape is outside 1:3–3:1 — a shape the image
 * model cannot produce.
 */
export function cloneSizeFor(width: number | null | undefined, height: number | null | undefined): CloneSize | null {
  if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const measured = width / height;
  if (measured > MAX_CLONE_RATIO * (1 + 1e-9) || measured < (1 / MAX_CLONE_RATIO) * (1 - 1e-9)) return null;

  const named = NAMED_SHAPES.find(([, ratio]) => Math.abs(measured / ratio - 1) <= SHAPE_TOLERANCE);
  const target = named ? named[1] : measured;
  const aspectLabel = named ? named[0] : `${measured.toFixed(2)}:1`;

  const fixed = named ? FIXED_SIZES[named[0]] : undefined;
  const [outWidth, outHeight] = fixed ?? nearestSize(target);
  return {
    size: `${outWidth}x${outHeight}`,
    width: outWidth,
    height: outHeight,
    aspectLabel,
    orientation: `${target < 0.98 ? 'vertical' : target > 1.02 ? 'horizontal' : 'square'} ${aspectLabel}`,
  };
}

/** The size in the pixel band whose ratio is closest to `ratio`; the larger on a tie. */
function nearestSize(ratio: number): [number, number] {
  let best: { width: number; height: number; error: number; pixels: number } | null = null;
  const minSide = STEP;
  const maxSide = Math.ceil(Math.sqrt(MAX_CLONE_PIXELS * MAX_CLONE_RATIO) / STEP) * STEP;
  for (let width = minSide; width <= maxSide; width += STEP) {
    // Only the heights near the target ratio can win; the band bounds the rest.
    const ideal = width / ratio;
    for (const height of [Math.floor(ideal / STEP) * STEP, Math.ceil(ideal / STEP) * STEP]) {
      if (height < STEP) continue;
      const pixels = width * height;
      if (pixels < MIN_CLONE_PIXELS || pixels > MAX_CLONE_PIXELS) continue;
      const shape = width / height;
      if (shape > MAX_CLONE_RATIO || shape < 1 / MAX_CLONE_RATIO) continue;
      const error = Math.abs(Math.log(shape) - Math.log(ratio));
      if (!best || error < best.error - 1e-12 || (Math.abs(error - best.error) <= 1e-12 && pixels > best.pixels)) {
        best = { width, height, error, pixels };
      }
    }
  }
  // The band always holds a size for a ratio within 1:3–3:1.
  return best ? [best.width, best.height] : [1024, 1024];
}
