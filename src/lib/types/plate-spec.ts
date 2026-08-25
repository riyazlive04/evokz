import { z } from 'zod';

import {
  layoutAlignSchema,
  layoutCtaShapeSchema,
  layoutEmphasisSchema,
  layoutPhotoKindSchema,
  type LayoutAlign,
} from '@/lib/types/layout-spec';

/**
 * Where things go on a clean plate.
 *
 * The counterpart to `PosterLayoutSpec`, and deliberately a different shape,
 * because the two answer different questions. A layout spec describes a poster
 * so the renderer can *rebuild* one: a flex tree of rows and columns that
 * reflows, because the renderer composes the whole surface and copy length
 * varies. A plate spec describes where content sits on artwork that already
 * exists and cannot reflow — the heart-shaped hole is at a fixed place in the
 * image, and no amount of flexbox will move it.
 *
 * So this is absolute boxes, and that is not a regression to the model the
 * layout spec's own header argues against. That argument is about describing a
 * composition you intend to rebuild at any aspect, where rows that hug their
 * content absorb varying copy. Here the composition is a photograph of itself.
 * The boxes are normalised 0-1 so one plate serves every output resolution, but
 * they do not reflow, and the copy stage is told what will fit instead — the
 * same trade `describeCopyShape` already makes for the grid path.
 *
 * **What the plate carries, this file does not.** Masks, curves, card chrome,
 * gradients, translucent panels: all pixels in the artwork, none of them
 * expressible here and none of them needing to be. That is the whole reason for
 * the plate.
 */

// ---------------------------------------------------------------------------
// Boxes
// ---------------------------------------------------------------------------

/**
 * A rectangle on the plate, normalised 0-1 against its own width and height.
 *
 * Normalised rather than in pixels so the same plate composites at 1080 or at
 * 2160 — the same reasoning that makes `LayoutCell.weight` proportional. A box
 * is allowed to run past the edge (`x + w > 1`): a headline that bleeds off the
 * right edge is a real design, and clamping it here would silently move it.
 */
const boxSchema = z.object({
  x: z.number().min(-1).max(2).finite(),
  y: z.number().min(-1).max(2).finite(),
  w: z.number().positive().max(3).finite(),
  h: z.number().positive().max(3).finite(),
});

export type PlateBox = z.infer<typeof boxSchema>;

/**
 * Which slots a plate can position.
 *
 * `spacer` and `accentRule` are absent, and both for the same reason: they exist
 * in the grid vocabulary to occupy or divide space the renderer is composing.
 * A plate has no space to occupy — its empty regions are already drawn — and its
 * rules are already printed on the artwork.
 */
export const PLATE_SLOTS = [
  'logo',
  'eyebrow',
  'headline',
  'body',
  'features',
  'cta',
  'contact',
] as const;

export type PlateSlot = (typeof PLATE_SLOTS)[number];

export const plateSlotSchema = z.enum(PLATE_SLOTS);

export const plateTextRegionSchema = boxSchema.extend({
  slot: plateSlotSchema,
  align: layoutAlignSchema,
  /**
   * Where the content sits vertically inside its box.
   *
   * Needed because a plate's boxes are fixed while its content is not: a
   * headline written two lines shorter than the reference's leaves slack, and
   * whether that slack falls above, below or around the type is a design
   * decision the box cannot imply.
   */
  valign: layoutAlignSchema,
  /**
   * The colour to set this block in, sampled from the reference.
   *
   * Null resolves from the client's theme, which is what `paletteSource:
   * "client"` wants. A hex here is only honoured under `paletteSource:
   * "template"` — the column decides, not this field, so one plate can be
   * previewed both ways without being rewritten.
   */
  color: z
    .string()
    .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
    .nullable(),
});

export type PlateTextRegion = z.infer<typeof plateTextRegionSchema>;

export const platePhotoRegionSchema = boxSchema.extend({
  kind: layoutPhotoKindSchema,
  /**
   * `cover` crops to fill the region; `contain` fits the whole frame inside it.
   *
   * Defaults to cover, which is right for a photographic hole in the artwork.
   * A cut-out subject standing in an open area of the plate wants contain, for
   * the reason given on the renderer's own subject branch: cropping a figure to
   * fill a box removes their head.
   */
  fit: z.enum(['cover', 'contain']).default('cover'),
});

export type PlatePhotoRegion = z.infer<typeof platePhotoRegionSchema>;

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

export const posterPlateSpecSchema = z.object({
  version: z.literal(1),
  /** Operator-facing, shown beside the plate in the console. */
  name: z.string().min(1).max(80),
  /**
   * The plate's own width divided by height, measured from the file.
   *
   * Wins over the reference's `layoutSpec.aspect` when compositing, because the
   * plate is what is actually drawn. Zero is unknown and falls back to the
   * client's preset, exactly as the layout spec's aspect does.
   */
  aspect: z.number().min(0).finite().default(0),
  /**
   * Photographic regions, in the order the generated frames fill them.
   *
   * Usually derived from the plate's transparency rather than authored — see
   * `src/lib/poster/plate-regions.ts`. A plate with no photo region is legal:
   * plenty of templates are pure artwork and type.
   */
  photos: z.array(platePhotoRegionSchema).max(2).default([]),
  text: z.array(plateTextRegionSchema).default([]),

  // Content shaping, carried across from the grid vocabulary unchanged so a
  // day's copy fits a plate the same way it fits a spec.
  featureCount: z.number().int().min(2).max(4).default(3),
  featureStyle: z.enum(['labelAndBody', 'labelOnly']).default('labelAndBody'),
  ctaShape: layoutCtaShapeSchema.default('pill'),
  headlineEmphasis: z.array(layoutEmphasisSchema).max(4).default([]),
  headlineCase: z.enum(['upper', 'sentence']).default('upper'),
});

export type PosterPlateSpec = z.infer<typeof posterPlateSpecSchema>;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface PlateSpecProblem {
  path: string;
  message: string;
}

/**
 * Structural checks Zod cannot express.
 *
 * Same split as `validateLayoutSpec`: this reports what an operator must fix and
 * blocks the render; `normalizePlateSpec` silently repairs what nobody needs to
 * see.
 */
export function validatePlateSpec(spec: PosterPlateSpec): PlateSpecProblem[] {
  const problems: PlateSpecProblem[] = [];

  const seen = new Map<PlateSlot, number>();
  for (const region of spec.text) {
    seen.set(region.slot, (seen.get(region.slot) ?? 0) + 1);
  }

  for (const [slot, count] of seen) {
    if (count > 1) {
      problems.push({
        path: 'text',
        message: `positions the "${slot}" slot ${count} times; each slot appears at most once.`,
      });
    }
  }

  const headlines = seen.get('headline') ?? 0;
  if (headlines !== 1) {
    problems.push({
      path: 'text',
      message:
        `must position exactly one headline, found ${headlines}. A poster with no ` +
        'headline region has nowhere to put the thing it is about.',
    });
  }

  /*
   * A region too small to set anything in is almost always a misplaced decimal —
   * 0.05 where 0.5 was meant — and it renders as type crushed into a corner
   * rather than as an error.
   */
  spec.text.forEach((region, index) => {
    if (region.w < 0.08 || region.h < 0.02) {
      problems.push({
        path: `text[${index}]`,
        message:
          `is ${(region.w * 100).toFixed(0)}% by ${(region.h * 100).toFixed(0)}% of the ` +
          'plate, too small to set the slot in. Check for a misplaced decimal point.',
      });
    }
  });

  spec.photos.forEach((region, index) => {
    if (region.w < 0.05 || region.h < 0.05) {
      problems.push({
        path: `photos[${index}]`,
        message:
          `is ${(region.w * 100).toFixed(0)}% by ${(region.h * 100).toFixed(0)}% of the ` +
          'plate, too small to be a photographic region.',
      });
    }
  });

  return problems;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** Repairs the faults not worth an operator's attention. */
export function normalizePlateSpec(spec: PosterPlateSpec): PosterPlateSpec {
  return {
    ...spec,
    // Deduped by slot, keeping the first. A second box for the same slot is the
    // extractor having described one block twice; drawing both stacks identical
    // type at two places on the poster, which reads as a rendering fault.
    text: spec.text.filter(
      (region, index) =>
        spec.text.findIndex((other) => other.slot === region.slot) === index,
    ),
  };
}

/**
 * Parses a stored `CategoryTemplate.plateSpec`, or null if it is absent or no
 * longer readable.
 *
 * Null rather than throwing, for the reason `parseLayoutSpec` gives: a spec
 * written by a build whose shape has moved on must take one template off the
 * plate path — where it falls back to its layout grid — rather than fail every
 * render in the vertical.
 */
export function parsePlateSpec(value: unknown): PosterPlateSpec | null {
  if (value === null || value === undefined) return null;

  const parsed = posterPlateSpecSchema.safeParse(value);
  if (!parsed.success) {
    console.warn(
      `[ace:plate] stored plate spec is not readable by this build (${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}) — this template falls back to its layout grid.`,
    );
    return null;
  }

  const normalized = normalizePlateSpec(parsed.data);
  const problems = validatePlateSpec(normalized);
  if (problems.length > 0) {
    console.warn(
      `[ace:plate] stored plate spec "${normalized.name}" is structurally invalid ` +
        `(${problems.map((p) => `${p.path} ${p.message}`).join('; ')}) — ` +
        'this template falls back to its layout grid.',
    );
    return null;
  }

  return normalized;
}

export interface PlateDraft {
  spec: PosterPlateSpec | null;
  problems: PlateSpecProblem[];
}

/** The editing counterpart of `parsePlateSpec`, mirroring `parseLayoutDraft`. */
export function parsePlateDraft(value: unknown): PlateDraft {
  if (value === null || value === undefined) return { spec: null, problems: [] };

  const parsed = posterPlateSpecSchema.safeParse(value);
  if (!parsed.success) {
    return {
      spec: null,
      problems: parsed.error.issues.slice(0, 4).map((issue) => ({
        path: issue.path.join('.') || 'spec',
        message: issue.message,
      })),
    };
  }

  const spec = normalizePlateSpec(parsed.data);
  return { spec, problems: validatePlateSpec(spec) };
}

/** What a plate wants from the copy stage. Mirrors `describeCopyShape`. */
export interface PlateCopyShape {
  hasEyebrow: boolean;
  hasBody: boolean;
  hasFeatures: boolean;
  hasCta: boolean;
  featureCount: number;
  featureBodies: boolean;
  headlineWidthShare: number;
  featureWidthShare: number;
  headlineLineCount: number;
}

export function describePlateCopyShape(spec: PosterPlateSpec): PlateCopyShape {
  const slots = new Set(spec.text.map((region) => region.slot));
  const widthOf = (slot: PlateSlot): number =>
    spec.text.find((region) => region.slot === slot)?.w ?? 1;

  return {
    hasEyebrow: slots.has('eyebrow'),
    hasBody: slots.has('body'),
    hasFeatures: slots.has('features'),
    hasCta: slots.has('cta'),
    featureCount: spec.featureCount,
    featureBodies: spec.featureStyle === 'labelAndBody',
    headlineWidthShare: widthOf('headline'),
    featureWidthShare: widthOf('features'),
    headlineLineCount: spec.headlineEmphasis.length,
  };
}

/** Flexbox equivalent of a plate region's alignment. */
export const PLATE_FLEX: Record<LayoutAlign, 'flex-start' | 'center' | 'flex-end'> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
};
