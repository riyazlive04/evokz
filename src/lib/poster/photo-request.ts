import {
  FAL_DIMENSION_STEP,
  FAL_MAX_EDGE,
  FAL_MIN_EDGE,
  type ImageSizePreset,
} from '@/lib/image-sizes';
import { ARCHETYPE_PHOTO_SHAPE, type PosterArchetype } from '@/lib/types/poster';

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
 * So the aspect comes from `ARCHETYPE_PHOTO_SHAPE`, never from the output preset.
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
  const shape = ARCHETYPE_PHOTO_SHAPE[archetype];

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

  const canvasAspect = preset.width / preset.height;
  const aspect = clamp(canvasAspect, PORTRAIT_ASPECT_MIN, PORTRAIT_ASPECT_MAX);

  // Long edge follows the canvas height: portrait regions in these archetypes run
  // the full height of the poster.
  const height = clampEdge(Math.min(preset.height, FAL_MAX_EDGE));
  const width = clampEdge(height * aspect);

  return {
    width,
    height,
    reason:
      canvasAspect === aspect
        ? `${archetype} needs a portrait photo matching the ${preset.ratio} canvas`
        : `${archetype} needs a portrait photo; ${preset.ratio} canvas clamped to ${aspect.toFixed(2)}:1`,
  };
}

/** Rounds to a legal Flux dimension and keeps it inside the render limits. */
function clampEdge(value: number): number {
  const stepped = Math.round(value / FAL_DIMENSION_STEP) * FAL_DIMENSION_STEP;
  return Math.max(FAL_MIN_EDGE, Math.min(stepped, FAL_MAX_EDGE));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
