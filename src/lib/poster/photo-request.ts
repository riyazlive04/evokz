import {
  FAL_DIMENSION_STEP,
  FAL_MAX_EDGE,
  FAL_MIN_EDGE,
  type ImageSizePreset,
} from '@/lib/image-sizes';
import type { PosterLayoutSpec } from '@/lib/types/layout-spec';
import { describeArchetype, type PosterArchetype } from '@/lib/types/poster';

/**
 * What size to ask fal.ai for — the *background photo*, not the delivered canvas.
 *
 * Before the poster layer existed these were the same thing, so the preset drove
 * the diffusion request directly. They are now different: the delivered file is the
 * composite at the preset's exact size, while the photo only has to cover whatever
 * region its archetype puts it in.
 *
 * Getting this wrong is a visible defect rather than an inefficiency. Archetype C
 * ("stacked bands") places the photo in a wide horizontal band; feeding it a 9:16
 * portrait render means cover-fitting a tall image into a short wide box, which
 * throws away roughly two thirds of the frame and usually decapitates the subject.
 * So the aspect comes from the archetype's catalogue entry, never from the output
 * preset.
 */

export interface PhotoRequest {
  width: number;
  height: number;
  /** Reported so the pipeline can log what it asked for and why. */
  reason: string;
}

/** Aspect used for landscape regions — the bands and curve archetypes. */
const LANDSCAPE_ASPECT = 1.5;

/**
 * Portrait aspect is taken from the canvas, clamped: a photo much narrower than
 * its region crops badly at the sides, and one much wider wastes render budget on
 * pixels that get cropped away. 0.5–0.8 covers every portrait preset in the
 * catalogue from 4:5 through 9:20.
 */
const PORTRAIT_ASPECT_MIN = 0.5;
const PORTRAIT_ASPECT_MAX = 0.8;

export function resolvePhotoRequest(
  archetype: PosterArchetype,
  preset: ImageSizePreset,
): PhotoRequest {
  const shape = describeArchetype(archetype).photoShape;

  if (shape === 'landscape') {
    // Long edge follows the canvas width, since the band spans it.
    const width = clampEdge(Math.min(preset.width, FAL_MAX_EDGE));
    const height = clampEdge(width / LANDSCAPE_ASPECT);
    return {
      width,
      height,
      reason: `${archetype} needs a landscape band photo (${LANDSCAPE_ASPECT}:1)`,
    };
  }

  return portraitRequest(archetype, preset);
}

/**
 * Portrait request, with the aspect preserved through the minimum-edge floor.
 *
 * The naive form clamped each edge independently, so on a short canvas both
 * landed on `FAL_MIN_EDGE` and the request silently became 1:1 — while still
 * *reporting* the intended ratio. A square photo cover-fitted into a wide region
 * then blew up to many times the canvas height, which is what drove the resvg
 * panic. Scaling the partner edge keeps the requested shape intact.
 */
function portraitRequest(
  archetype: PosterArchetype,
  preset: ImageSizePreset,
): PhotoRequest {

  const canvasAspect = preset.width / preset.height;
  const aspect = clamp(canvasAspect, PORTRAIT_ASPECT_MIN, PORTRAIT_ASPECT_MAX);

  // Long edge follows the canvas height: portrait regions in these archetypes run
  // the full height of the poster.
  let height = clampEdge(Math.min(preset.height, FAL_MAX_EDGE));
  let width = clampEdge(height * aspect);

  // If the width hit the floor, the aspect was lost — grow the height back so the
  // requested shape survives instead of collapsing to a square.
  if (width <= FAL_MIN_EDGE && height * aspect < FAL_MIN_EDGE) {
    width = FAL_MIN_EDGE;
    height = clampEdge(width / aspect);
  }

  return {
    width,
    height,
    reason:
      canvasAspect === aspect
        ? `${archetype} needs a portrait photo matching the ${preset.ratio} canvas`
        : `${archetype} needs a portrait photo; ${preset.ratio} canvas clamped to ${aspect.toFixed(2)}:1`,
  };
}

/**
 * One request per photo slot in a layout spec, in render order.
 *
 * The archetype path asks its catalogue entry for a `photoShape` because its
 * photo regions are fixed geometry known at authoring time. A spec's regions are
 * not: a photo cell's width comes from its column weight, and its height is
 * whatever the row settles at after the copy above it has been laid out. So the
 * aspect is estimated from the spec rather than declared.
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
 * Wider than the portrait clamp above because a spec can legitimately ask for a
 * letterbox hero band or a tall side inset, neither of which the archetypes
 * have. Beyond these the estimate is more likely to be a misread spec than a
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
