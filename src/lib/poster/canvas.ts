import type { ImageSizePreset } from '@/lib/image-sizes';
import type { PosterLayoutSpec } from '@/lib/types/layout-spec';

/**
 * What size to actually draw, given a template and a client's output preset.
 *
 * **The template's shape wins; the preset supplies resolution.** A square
 * reference produces a square poster even for a client whose preset is WhatsApp
 * Status, because the shape is part of the composition rather than a delivery
 * setting: a 1:1 banner drawn onto 9:16 does not become a taller version of
 * itself, it becomes the same artwork with half a canvas of invented emptiness
 * above and below it. That was the single largest reason a generated poster
 * stopped resembling the template it was read from.
 *
 * The preset is not ignored — it still decides how many pixels the client gets,
 * which is what varies between a WhatsApp status and a 4K wallpaper. Only its
 * *aspect* is overridden, and only when the spec knows its own.
 *
 * Consequences worth stating plainly, because they surprise people:
 *
 *   - A client on "Feed landscape" whose vertical holds 9:16 templates receives
 *     9:16 posters. The preset's name stops describing the output shape, so the
 *     console labels it as an output *resolution* and prints the resolved canvas
 *     beside each template.
 *   - Two templates in one vertical may deliver at two different shapes. That is
 *     correct — they are two different compositions — and it is why this is
 *     resolved per day rather than once per client.
 *
 * Kept in its own module, like `layout-library.ts`, so the pipeline and the
 * preview route cannot drift: a preview rendered at a different shape from the
 * poster it is previewing is worse than no preview.
 */

export interface PosterCanvas {
  width: number;
  height: number;
  /** Why these numbers, for the pipeline's log line and the console's badge. */
  reason: string;
}

/**
 * Guards mirroring `assertRenderableCanvas` in render.tsx.
 *
 * Duplicated deliberately rather than imported: that one is the renderer's last
 * line of defence and throws, which is right when something has already gone
 * wrong. This one is a *constructor* and must not produce a canvas that trips
 * it, so it clamps quietly. A spec whose stored aspect is beyond these bounds is
 * a misread template, and clamping renders it slightly wrong rather than failing
 * the client's day over it.
 */
const MIN_EDGE = 240;
const MAX_EDGE = 4096;
const MAX_ASPECT = 4;
const MIN_ASPECT = 1 / 4;

export function resolvePosterCanvas(
  spec: Pick<PosterLayoutSpec, 'aspect' | 'name'>,
  preset: Pick<ImageSizePreset, 'width' | 'height'>,
): PosterCanvas {
  /*
   * Zero is "not measured", which is what every spec written before the aspect
   * field carries. Those fall through to the preset unchanged — that is the
   * whole reason the field defaults to 0 rather than to 9/16, and it is what
   * lets this ship without re-reading a single live template.
   */
  if (!Number.isFinite(spec.aspect) || spec.aspect <= 0) {
    return {
      width: preset.width,
      height: preset.height,
      reason:
        `layout "${spec.name}" carries no measured aspect, so the ` +
        `${preset.width}×${preset.height} output preset sets the shape`,
    };
  }

  const aspect = clamp(spec.aspect, MIN_ASPECT, MAX_ASPECT);

  /*
   * Width from the preset, height derived.
   *
   * Not "fit inside the preset box": that would shrink a square template to
   * 1080×1080 on one preset and 566×566 on another, so the same template would
   * deliver at wildly different resolutions depending on a setting that is
   * supposed to be about resolution. Every preset in the catalogue is between
   * 1080 and 1640 wide, so anchoring on width gives a predictable long edge.
   */
  const width = clampEven(preset.width, MIN_EDGE, MAX_EDGE);
  const height = clampEven(Math.round(width / aspect), MIN_EDGE, MAX_EDGE);

  const matchesPreset =
    Math.abs(width / height - preset.width / preset.height) < 0.01;

  return {
    width,
    height,
    reason: matchesPreset
      ? `layout "${spec.name}" is ${aspect.toFixed(2)}:1, which the output preset already matches`
      : `layout "${spec.name}" is ${aspect.toFixed(2)}:1, so ${width}×${height} is drawn ` +
        `instead of the preset's ${preset.width}×${preset.height}`,
  };
}

/**
 * The aspect a stored template file implies, or 0 when it cannot be known.
 *
 * `CategoryTemplate.width/height` are null when the uploaded file's header could
 * not be parsed, and a spec is better off falling back to the client's preset
 * than carrying an invented ratio.
 */
export function measuredAspect(
  width: number | null | undefined,
  height: number | null | undefined,
): number {
  if (!width || !height || width <= 0 || height <= 0) return 0;
  return width / height;
}

/** Even, because an odd edge puts a half-pixel seam down a centred split. */
function clampEven(value: number, min: number, max: number): number {
  const bounded = Math.round(clamp(value, min, max));
  return bounded % 2 === 0 ? bounded : bounded + 1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
