import sharp from 'sharp';

import type { PlatePhotoRegion } from '@/lib/types/plate-spec';

/**
 * Finds the transparent holes in a clean plate — the regions a generated
 * photograph shows through.
 *
 * **Measured, never modelled.** The same argument that keeps `aspect` out of the
 * extractor's schema applies with more force here: a hole's position is a
 * property of the pixels, exact and free to compute, and asking a vision model
 * to estimate it would turn a certainty into a draft that needs reviewing. The
 * operator draws the hole in their image editor; this reads back what they drew.
 *
 * The plate is composited *over* the photograph, so a hole is simply where the
 * plate stops covering it. That is why the heart mask, the rounded card corners
 * and the curved footer survive intact without a single line of layout
 * vocabulary describing them — this function does not need to know the hole is
 * heart-shaped, only where its bounding box is.
 *
 * Connected regions are found with a flood fill rather than one global bounding
 * box, because a plate with two separate holes is a two-photo poster and a
 * single box spanning both would stretch one frame across the gap between them.
 */

/**
 * Alpha at or below which a pixel counts as a hole.
 *
 * Not zero. Exporting a PNG with a soft-edged eraser, or any anti-aliased mask,
 * leaves a rim of low-but-nonzero alpha; treating only a hard 0 as a hole finds
 * a region a few pixels smaller than the designer drew and leaves a hairline of
 * plate colour around the photograph.
 */
const HOLE_ALPHA = 24;

/**
 * Smallest share of the plate a hole must cover to count.
 *
 * Below this it is almost always an artefact — a stray erased pixel, a soft
 * shadow that dipped under the alpha threshold, the anti-aliased edge of a
 * shape. Emitting it as a photo region would bill a diffusion render for
 * something a few pixels across.
 */
const MIN_HOLE_FRACTION = 0.004;

/** Guards the fill against a decompression bomb, matching `logo-key.ts`. */
const MAX_PIXELS = 32_000_000;

export interface PlateHoles {
  width: number;
  height: number;
  /** Normalised 0-1, largest first, capped at the two the pipeline can pay for. */
  regions: PlatePhotoRegion[];
  /** Every hole found before the cap, for the console to report honestly. */
  found: number;
}

/**
 * Reads a plate's transparent regions.
 *
 * Returns no regions rather than throwing when the file has no alpha channel at
 * all: a fully opaque plate is a legal design — pure artwork and type — and it
 * is `validatePlateSpec`'s job to complain if a spec then claims photos.
 */
export async function findPlateHoles(bytes: Buffer): Promise<PlateHoles | null> {
  let width: number;
  let height: number;
  let pixels: Buffer;

  try {
    const decoded = await sharp(bytes, { limitInputPixels: MAX_PIXELS })
      // Normalises every input to RGBA so the stride below is always 4. A plate
      // saved as JPEG has no alpha at all and yields a fully opaque buffer,
      // which correctly finds no holes.
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    pixels = decoded.data;
    width = decoded.info.width;
    height = decoded.info.height;
  } catch {
    return null;
  }

  if (width < 2 || height < 2) return null;

  const total = width * height;
  const visited = new Uint8Array(total);
  const boxes: Array<{ x0: number; y0: number; x1: number; y1: number; area: number }> = [];

  const isHole = (index: number): boolean => pixels[index * 4 + 3]! <= HOLE_ALPHA;

  /*
   * Iterative flood fill with an explicit stack.
   *
   * Recursion would blow the call stack on any real plate — a half-canvas hole
   * on a 1600px image is upwards of a million pixels deep in the worst case.
   */
  const stack: number[] = [];

  for (let seed = 0; seed < total; seed += 1) {
    if (visited[seed] || !isHole(seed)) continue;

    let x0 = width;
    let y0 = height;
    let x1 = -1;
    let y1 = -1;
    let area = 0;

    stack.push(seed);
    visited[seed] = 1;

    while (stack.length > 0) {
      const index = stack.pop()!;
      const x = index % width;
      const y = (index - x) / width;

      area += 1;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;

      // Four-connected, not eight: a diagonal touch is two regions meeting at a
      // corner, and merging them across it would join a photo hole to an
      // unrelated erased area.
      if (x > 0) push(index - 1);
      if (x < width - 1) push(index + 1);
      if (y > 0) push(index - width);
      if (y < height - 1) push(index + width);
    }

    if (area / total >= MIN_HOLE_FRACTION) {
      boxes.push({ x0, y0, x1, y1, area });
    }
  }

  function push(index: number): void {
    if (visited[index] || !isHole(index)) return;
    visited[index] = 1;
    stack.push(index);
  }

  boxes.sort((a, b) => b.area - a.area);

  const regions: PlatePhotoRegion[] = boxes.slice(0, 2).map((box) => ({
    x: box.x0 / width,
    y: box.y0 / height,
    w: (box.x1 - box.x0 + 1) / width,
    h: (box.y1 - box.y0 + 1) / height,
    /*
     * Every measured hole is a `scene`.
     *
     * A hole in the artwork is a window onto a photograph, and the plate's own
     * edge does the shaping — so the frame should fill it and be cropped, which
     * is what `cover` and `scene` mean. `subject` is for a cut-out figure
     * standing in open plate area, which by definition is *not* a hole and has
     * to be positioned by hand.
     */
    kind: 'scene',
    fit: 'cover',
  }));

  return { width, height, regions, found: boxes.length };
}
