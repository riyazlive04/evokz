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

  /*
   * Two slots cannot occupy the same pixels.
   *
   * A plate cannot reflow, so overlapping regions are not a tight fit that
   * resolves at render — they are two blocks of type printed over each other,
   * every day, on every poster that template draws. Nothing checked for this
   * until now, and it shipped: Med-SM-1 carried a features region running from
   * the eyebrow to the bottom edge, with the body and the contact bar inside it.
   *
   * Judged by the share of the *smaller* region that is covered, not by absolute
   * area — a headline clipping the corner of a full-width contact bar matters
   * more to the contact bar than the raw overlap suggests. The threshold leaves
   * room for the incidental touching that measured boxes produce at the edges of
   * their ink.
   */
  for (let i = 0; i < spec.text.length; i += 1) {
    for (let j = i + 1; j < spec.text.length; j += 1) {
      const a = spec.text[i]!;
      const b = spec.text[j]!;

      const wide = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const tall = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (wide <= 0 || tall <= 0) continue;

      const shared = wide * tall;
      const smaller = Math.min(a.w * a.h, b.w * b.h);
      if (smaller <= 0) continue;

      const share = shared / smaller;
      if (share < MAX_REGION_OVERLAP) continue;

      problems.push({
        path: 'text',
        message:
          `positions "${a.slot}" and "${b.slot}" over each other — ` +
          `${(share * 100).toFixed(0)}% of the smaller one is covered. A plate cannot ` +
          'reflow, so both blocks would be printed in the same place.',
      });
    }
  }

  return problems;
}

/**
 * Share of the smaller region that may be covered before it counts as a clash.
 *
 * Measured boxes hug their ink and still touch at the edges — a descender, a
 * letterspaced capital — so a small overlap is normal rather than a fault. A
 * quarter is well past incidental contact and well short of the wholesale
 * containment that this exists to catch.
 */
const MAX_REGION_OVERLAP = 0.25;

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Narrowest a region may be before it is treated as a misread.
 *
 * A block of type occupies a column. Below about a twelfth of the poster there
 * is no column — 8% of a 900px reference is 72px, which holds a word at caption
 * size and nothing a slot is made of. Regions this narrow are what a detector
 * produces from a stray mark that a labeller then named, and drawing one sets a
 * phone number one character per line.
 */
const MIN_REGION_WIDTH = 0.08;

/**
 * Shortest a region may be.
 *
 * **Far lower than it was, because the regions changed under it.** At 2% this
 * was calibrated for boxes a vision model estimated, which never came back
 * smaller than a twentieth of the poster; measured against pixels, one line of
 * small type genuinely is 1.5% of a 1600px poster and an eyebrow is nothing but
 * one line. Seven of thirteen templates were refused outright on their eyebrow
 * or their body — regions whose only fault was being measured accurately.
 *
 * 0.8% is a 13px line on that same poster, below which there is no type.
 */
const MIN_REGION_HEIGHT = 0.008;

/**
 * Repairs the faults not worth an operator's attention.
 *
 * An undersized region is repaired here rather than reported by
 * `validatePlateSpec`, and the distinction is the difference between a template
 * that draws and one that does not: a reported problem refuses the whole spec,
 * so a single stray box named `contact` would drop an otherwise perfect plate
 * back to the grid. Dropping the box costs that one slot and keeps the poster.
 *
 * If what gets dropped is the headline, `validatePlateSpec` still refuses the
 * spec on its headline count — which is right, because a plate with nowhere to
 * put the thing it is about cannot be drawn.
 */
export function normalizePlateSpec(spec: PosterPlateSpec): PosterPlateSpec {
  return {
    ...spec,
    text: spec.text
      .filter((region) => {
        const usable =
          region.w >= MIN_REGION_WIDTH && region.h >= MIN_REGION_HEIGHT;
        if (!usable) {
          console.warn(
            `[ace:plate] dropping the "${region.slot}" region: ` +
              `${(region.w * 100).toFixed(0)}% by ${(region.h * 100).toFixed(1)}% of the ` +
              'plate is too small to set a slot in.',
          );
        }
        return usable;
      })
      // Deduped by slot, keeping the first. A second box for the same slot is the
      // extractor having described one block twice; drawing both stacks identical
      // type at two places on the poster, which reads as a rendering fault.
      .filter(
        (region, index, kept) =>
          kept.findIndex((other) => other.slot === region.slot) === index,
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
