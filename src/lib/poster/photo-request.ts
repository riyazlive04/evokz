import {
  FAL_DIMENSION_STEP,
  FAL_MAX_EDGE,
  FAL_MIN_EDGE,
} from '@/lib/image-sizes';
import type { LayoutPhotoKind, PosterLayoutSpec } from '@/lib/types/layout-spec';

/**
 * What size to ask fal.ai for — the *background photo*, not the delivered canvas.
 *
 * Two different things. The delivered file is the composite at the resolved
 * canvas size; the photograph only has to cover whatever cell the layout puts it
 * in.
 *
 * Getting this wrong is a visible defect rather than an inefficiency. A layout
 * placing its photo in a wide horizontal band, fed a 9:16 portrait render, means
 * cover-fitting a tall image into a short wide box — which throws away roughly
 * two thirds of the frame and usually decapitates the subject. So the aspect
 * comes from the layout's own geometry, measured against the canvas that layout
 * is actually being drawn onto.
 */

export interface PhotoRequest {
  width: number;
  height: number;
  /**
   * What this frame has to be.
   *
   * `subject` frames are prompted for an isolated figure and then passed through
   * background removal before they reach the renderer, so the kind has to travel
   * with the request rather than being re-derived from the spec downstream.
   */
  kind: LayoutPhotoKind;
  /** Reported so the pipeline can log what it asked for and why. */
  reason: string;
}

/**
 * The frame this module sizes against.
 *
 * Deliberately not an `ImageSizePreset`: since the template's own aspect decides
 * the poster's shape, the preset is no longer what the layout is drawn onto.
 * Estimating a cell's proportions against the preset would ask fal for a 9:16
 * frame to fill a cell in a square poster.
 */
export interface PhotoCanvas {
  width: number;
  height: number;
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
 * excuse. `renderLayoutSpec` fills a `scene` cell with `object-fit: cover`, so a
 * frame whose aspect is a little off is cropped, never stretched or letterboxed.
 * What the estimate actually buys is not correctness but economy — asking fal
 * for a 2:3 frame that lands in a 3:2 cell means paying to render pixels that
 * are then cropped away.
 *
 * A `subject` cell is `object-fit: contain`, so there the estimate matters even
 * less: a cut-out figure is letterboxed into whatever room it has rather than
 * cropped. It is still worth getting close, because a portrait figure asked for
 * at 2:1 comes back as a wide frame with a small person in the middle of it.
 *
 * Row heights are apportioned rather than guessed per row:
 *   fixed — its declared fraction, which is exact.
 *   hug   — HUG_SHARE of the canvas each, since a hug row is as tall as the copy
 *           in it and a copy block runs about a fifth of a portrait poster.
 *   flex  — whatever those two leave, split between them. That is the definition
 *           of a flex row, and it is the only estimate here that can be derived
 *           rather than assumed.
 *
 * Apportioning matters most where the old per-row constants were worst: a
 * one-row banner. `flex` used to be a flat third of the canvas whatever else was
 * on the poster, so a full-height cut-out column in a single-row spec was sized
 * as though it were a third of the height — asking fal for a landscape frame to
 * fill a portrait column, and letterboxing the figure into the middle of it with
 * a band of empty ground above and below.
 */
export function resolveSpecPhotoRequests(
  spec: PosterLayoutSpec,
  canvas: PhotoCanvas,
): PhotoRequest[] {
  const requests: PhotoRequest[] = [];

  /*
   * What the non-flex rows claim, and what is therefore left to share.
   *
   * Floored rather than allowed to go negative: a spec whose fixed rows already
   * claim most of the canvas leaves its flex row very little, and a negative
   * share would invert the aspect and ask fal for a frame taller than it is wide
   * when the truth is the opposite.
   */
  const claimed = spec.rows.reduce(
    (sum, row) =>
      sum +
      (row.sizingMode === 'fixed'
        ? row.heightFraction
        : row.sizingMode === 'hug'
          ? HUG_SHARE
          : 0),
    0,
  );

  const flexRows = spec.rows.filter((row) => row.sizingMode === 'flex').length;
  const flexShare =
    flexRows > 0 ? Math.max(MIN_FLEX_SHARE, (1 - claimed) / flexRows) : MIN_FLEX_SHARE;

  spec.rows.forEach((row, rowIndex) => {
    const totalWeight = row.cells.reduce((sum, cell) => sum + cell.weight, 0);
    const rowHeight =
      canvas.height *
      (row.sizingMode === 'fixed'
        ? row.heightFraction
        : row.sizingMode === 'flex'
          ? flexShare
          : HUG_SHARE);

    for (const cell of row.cells) {
      for (const slot of cell.slots) {
        if (slot !== 'photo') continue;

        const cellWidth = (canvas.width * cell.weight) / totalWeight;

        /*
         * A cut-out subject is allowed a taller frame than a scene.
         *
         * `SPEC_ASPECT_MIN` exists to stop a misread spec asking fal for an
         * absurd sliver, and 0.4 is the right floor for a photographic region —
         * past that a `cover` fit is discarding most of the frame. A subject is
         * `contain`-fitted, so nothing is discarded, and the shape it wants is
         * whatever its column is: a figure standing the full height of a poster
         * beside the type is a genuinely narrow, genuinely tall frame. Held at
         * 0.4 it came back landscape and was letterboxed into the middle of its
         * column with empty ground above and below.
         */
        const floor = cell.photoKind === 'subject' ? SUBJECT_ASPECT_MIN : SPEC_ASPECT_MIN;
        const aspect = clamp(
          rowHeight > 0 ? cellWidth / rowHeight : 1,
          floor,
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
          kind: cell.photoKind,
          reason:
            `spec "${spec.name}" row ${rowIndex + 1} ${cell.photoKind} cell is about ` +
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

/**
 * Assumed height of a `hug` row, as a share of the canvas.
 *
 * A hug row is as tall as the type in it, which is not knowable here — but the
 * copy blocks these posters carry (a headline stack, a feature strip, a body
 * paragraph) run about a fifth of a portrait canvas each across the reference
 * set.
 */
/**
 * Narrowest frame a cut-out subject may be asked for.
 *
 * Lower than `SPEC_ASPECT_MIN` because a `contain` fit wastes nothing, and a
 * standing figure beside a full-height column of type really is about 1:4. Still
 * bounded: below this the request is a misread spec rather than a tall figure,
 * and fal's own minimum edge would clamp it into a different shape anyway.
 */
const SUBJECT_ASPECT_MIN = 0.25;

const HUG_SHARE = 0.2;

/**
 * Floor on a flex row's share, for a spec whose other rows have already claimed
 * the canvas. Matches the renderer's own 12% minimum on a flex row, so the
 * estimate cannot describe a band smaller than one that will actually be drawn.
 */
const MIN_FLEX_SHARE = 0.12;

/** Rounds to a legal Flux dimension and keeps it inside the render limits. */
function clampEdge(value: number): number {
  const stepped = Math.round(value / FAL_DIMENSION_STEP) * FAL_DIMENSION_STEP;
  return Math.max(FAL_MIN_EDGE, Math.min(stepped, FAL_MAX_EDGE));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
