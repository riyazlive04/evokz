import {
  FAL_DIMENSION_STEP,
  FAL_MAX_EDGE,
  FAL_MIN_EDGE,
  type ImageSizePreset,
} from '@/lib/image-sizes';
import type { PosterLayoutSpec } from '@/lib/types/layout-spec';

/**
 * What size to ask fal.ai for — the *background photo*, not the delivered canvas.
 *
 * Two different things. The delivered file is the composite at the preset's exact
 * size; the photograph only has to cover whatever cell the layout puts it in.
 *
 * Getting this wrong is a visible defect rather than an inefficiency. A layout
 * placing its photo in a wide horizontal band, fed a 9:16 portrait render, means
 * cover-fitting a tall image into a short wide box — which throws away roughly
 * two thirds of the frame and usually decapitates the subject. So the aspect
 * comes from the layout's own geometry, never from the output preset.
 */

export interface PhotoRequest {
  width: number;
  height: number;
  /** Reported so the pipeline can log what it asked for and why. */
  reason: string;
}

/**
 * One request per photo slot in a layout spec, in render order.
 *
 * A spec's photo regions are not fixed geometry: a cell's width comes from its
 * column weight, and its height is whatever the row settles at after the copy
 * above it has been laid out. So the aspect is estimated from the spec rather
 * than declared anywhere.
 *
 * An estimate is enough, and that is a property of the renderer rather than an
 * excuse. `renderLayoutSpec` fills a photo cell with `object-fit: cover`, so a
 * frame whose aspect is a little off is cropped, never stretched or letterboxed.
 * What the estimate actually buys is not correctness but economy — asking fal
 * for a 2:3 frame that lands in a 3:2 cell means paying to render pixels that
 * are then cropped away.
 *
 * Row heights are approximated by mode:
 *   fixed — its declared fraction, which is exact.
 *   flex  — a third of the canvas. Flex rows take what the hug rows leave, and
 *           across the reference set that lands near a third.
 *   hug   — a quarter. A hug row holding a photo is sized by the copy beside it,
 *           which is typically a headline block.
 */
export function resolveSpecPhotoRequests(
  spec: PosterLayoutSpec,
  preset: ImageSizePreset,
): PhotoRequest[] {
  const requests: PhotoRequest[] = [];

  spec.rows.forEach((row, rowIndex) => {
    const totalWeight = row.cells.reduce((sum, cell) => sum + cell.weight, 0);
    const rowHeight =
      preset.height *
      (row.sizingMode === 'fixed' ? row.heightFraction : row.sizingMode === 'flex' ? 0.33 : 0.25);

    for (const cell of row.cells) {
      for (const slot of cell.slots) {
        if (slot !== 'photo') continue;

        const cellWidth = (preset.width * cell.weight) / totalWeight;
        const aspect = clamp(
          rowHeight > 0 ? cellWidth / rowHeight : 1,
          SPEC_ASPECT_MIN,
          SPEC_ASPECT_MAX,
        );

        // Fit the request inside fal's ceiling on whichever edge is longer, so a
        // wide band and a tall inset both come back at usable resolution.
        const long = Math.min(FAL_MAX_EDGE, Math.max(cellWidth, rowHeight, FAL_MIN_EDGE));
        const width = clampEdge(aspect >= 1 ? long : long * aspect);
        const height = clampEdge(aspect >= 1 ? long / aspect : long);

        requests.push({
          width,
          height,
          reason:
            `spec "${spec.name}" row ${rowIndex + 1} photo cell is about ` +
            `${aspect.toFixed(2)}:1`,
        });
      }
    }
  });

  return requests;
}

/**
 * Bounds on an estimated cell aspect.
 *
 * A spec can legitimately ask for a letterbox hero band or a tall side inset.
 * Beyond these bounds the estimate is more likely to be a misread spec than a
 * real intention, and an extreme request wastes fal budget on pixels that
 * `object-fit: cover` immediately crops.
 */
const SPEC_ASPECT_MIN = 0.4;
const SPEC_ASPECT_MAX = 2.5;

/** Rounds to a legal Flux dimension and keeps it inside the render limits. */
function clampEdge(value: number): number {
  const stepped = Math.round(value / FAL_DIMENSION_STEP) * FAL_DIMENSION_STEP;
  return Math.max(FAL_MIN_EDGE, Math.min(stepped, FAL_MAX_EDGE));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
