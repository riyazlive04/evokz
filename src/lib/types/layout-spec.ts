import { z } from 'zod';

/**
 * A poster layout described as data rather than as a React component.
 *
 * This is what makes an uploaded reference template actually reach the renderer.
 * Before it, `CategoryTemplate.archetype` was the only channel: an operator
 * looked at a template and named which of the fifteen hand-written compositions
 * it most resembled, and the poster came out in *that* composition — see the
 * note at the top of src/lib/poster/archetype-library.ts. A layout spec carries
 * the template's own geometry instead.
 *
 * **A spec is a flexbox tree, deliberately, and not a list of rectangles.**
 * Absolute 0–1 boxes are the obvious first model and they break on the two
 * things that always happen in production:
 *
 *   1. Copy length varies. A headline that ran three lines in the reference runs
 *      four for another client, and a box measured for three either clips it or
 *      leaves a hole. Rows that hug their content absorb this; a rectangle
 *      cannot.
 *   2. Canvases vary. `IMAGE_SIZE_PRESETS` spans 4:5 to 9:20, and a template
 *      authored at 9:16 has to survive all of them. Row order and column
 *      proportions carry across aspects; absolute vertical offsets do not.
 *
 * So a spec is a stack of rows, each row split into one or more columns, each
 * column holding an ordered run of slots. That is exactly what satori consumes,
 * which keeps the renderer a thin interpreter rather than a layout engine.
 *
 * **Every field is required and every union is a flat string enum.** The
 * extractor reaches this shape through OpenAI Structured Outputs, whose `strict`
 * mode supports neither optional properties nor discriminated unions — so
 * `sizingMode` and `heightFraction` are two fields rather than one tagged union,
 * and `heightFraction` is simply ignored unless `sizingMode` is `fixed`. Keeping
 * the wire shape and the internal shape identical means there is no translation
 * layer to drift.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * What a cell can contain.
 *
 * Deliberately the slot skeleton of docs/creative-style-spec.md §2 and nothing
 * else. A spec chooses *where* the eight slots go and, through `featureCount`
 * and `featureStyle`, how densely one of them is drawn; it can neither invent a
 * ninth slot nor restyle one, which is what keeps every poster in a campaign
 * recognisably the same system however many templates a vertical accumulates.
 *
 * A cell holding a photo *and* text is the one layering the model allows: the
 * photograph becomes that cell's background and the copy is drawn over it. Every
 * other combination stacks.
 *
 * `spacer` is the one addition, and it carries no content: it exists so a
 * template with a deliberately empty column — the wide left gutter that a lot of
 * editorial layouts use — can say so, rather than the extractor being forced to
 * put something there.
 */
export const LAYOUT_SLOTS = [
  'logo',
  'eyebrow',
  'headline',
  'accentRule',
  'body',
  'features',
  'photo',
  'contact',
  'spacer',
] as const;

export type LayoutSlot = (typeof LAYOUT_SLOTS)[number];

export const layoutSlotSchema = z.enum(LAYOUT_SLOTS);

/**
 * Which of the theme's three surfaces a row or cell is painted in.
 *
 * Named rather than given as hex so one spec renders correctly for every client:
 * the template's own orange footer becomes `accent`, and a client whose brand is
 * green gets a green footer without the spec being touched. A spec that stored
 * `#E8481F` would make every tenant's poster Borcelle's.
 *
 * `inherit` paints nothing and shows the canvas ground through.
 */
export const LAYOUT_FILLS = ['inherit', 'light', 'dark', 'accent'] as const;

export type LayoutFill = (typeof LAYOUT_FILLS)[number];

export const layoutFillSchema = z.enum(LAYOUT_FILLS);

/**
 * How a row claims vertical space.
 *
 *   hug   — exactly its content's height. Copy rows.
 *   fixed — `heightFraction` of the canvas. Rows whose proportion is the point,
 *           like a full-bleed contact bar.
 *   flex  — whatever is left after the hug and fixed rows have taken theirs.
 *
 * **At least one row must be `flex`**, and `validateLayoutSpec` refuses a spec
 * without one. This is the invariant that makes overflow structurally
 * impossible rather than merely unlikely: type cannot reflow to fit a canvas, so
 * if every row insisted on its content height a long headline would push the
 * contact bar off the bottom edge and `Canvas`'s `overflow: hidden` would eat it
 * silently — a poster that still renders, still looks deliberate, and carries no
 * phone number. That was a real defect in the hand-written `bands` archetype.
 *
 * A photo row is the natural flex row, and normalisation promotes one if the
 * extractor did not mark any: a photograph losing a slice of its frame is the
 * only way this composition can give that is not a defect.
 */
export const LAYOUT_SIZING_MODES = ['hug', 'fixed', 'flex'] as const;

export type LayoutSizingMode = (typeof LAYOUT_SIZING_MODES)[number];

export const layoutSizingModeSchema = z.enum(LAYOUT_SIZING_MODES);

/** Where a cell's content hangs within it. Mirrors `CopyAlign`. */
export const LAYOUT_ALIGNS = ['start', 'center', 'end'] as const;

export type LayoutAlign = (typeof LAYOUT_ALIGNS)[number];

export const layoutAlignSchema = z.enum(LAYOUT_ALIGNS);

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export const layoutCellSchema = z.object({
  /**
   * Share of the row's width, relative to its siblings. Proportional rather than
   * absolute so a 40/60 split stays 40/60 at every canvas width.
   */
  weight: z.number().positive().finite(),
  fill: layoutFillSchema,
  align: layoutAlignSchema,
  /**
   * Inset by the canvas margin.
   *
   * False is what makes a full-bleed photo full-bleed. A cell holding copy
   * should essentially always be padded — unpadded type runs into the canvas
   * edge — so normalisation forces it on for any cell with a text slot in it.
   */
  padded: z.boolean(),
  /** Stacked top to bottom, in this order. */
  slots: z.array(layoutSlotSchema),
});

export type LayoutCell = z.infer<typeof layoutCellSchema>;

export const layoutRowSchema = z.object({
  sizingMode: layoutSizingModeSchema,
  /**
   * Share of canvas height, 0–1. Read only when `sizingMode` is `fixed`;
   * the extractor is told to send 0 otherwise.
   */
  heightFraction: z.number().min(0).max(1).finite(),
  fill: layoutFillSchema,
  /** One cell is a full-width row; more than one splits it left to right. */
  cells: z.array(layoutCellSchema).min(1),
});

export type LayoutRow = z.infer<typeof layoutRowSchema>;

export const posterLayoutSpecSchema = z.object({
  /**
   * Bumped when a change to this shape cannot be read by an older build.
   * Stored specs are rows in a live database, so a spec written today has to
   * stay readable — or be refused loudly rather than misrendered.
   */
  version: z.literal(1),
  /** Operator-facing, shown in the console next to the template it came from. */
  name: z.string().min(1).max(80),
  /** The canvas behind every `inherit` row. */
  ground: z.enum(['light', 'dark']),
  /**
   * How many items the template's feature block holds.
   *
   * On the spec rather than the cell because `validateLayoutSpec` already caps a
   * spec at one `features` slot, so there is nowhere else it could apply.
   *
   * **The default is what lets existing templates alone.** Every spec stored
   * before this field existed parses with 3 and renders exactly as it did — the
   * count the copy stage has always produced. Only a newly extracted spec
   * carries a measured value.
   */
  featureCount: z.number().int().min(2).max(4).default(3),
  /**
   * Whether each feature card carries a sentence under its label.
   *
   * Reference posters split about evenly: a wide strip of three labelled
   * paragraphs, or a row of four icon cards with nothing but a one-or-two-word
   * label. Rendering the second as the first is the single most common way a
   * generated poster stops looking like the template it came from.
   *
   * Expressed here and honoured in the renderer rather than by asking the copy
   * stage for empty bodies — `posterFeatureSchema.body` is `.min(1)`, so an empty
   * one fails validation and takes the whole day's copy with it.
   */
  featureStyle: z.enum(['labelAndBody', 'labelOnly']).default('labelAndBody'),
  rows: z.array(layoutRowSchema).min(1),
});

export type PosterLayoutSpec = z.infer<typeof posterLayoutSpecSchema>;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Slots that set type and therefore must never sit in an unpadded cell. */
const TEXT_SLOTS: ReadonlySet<LayoutSlot> = new Set<LayoutSlot>([
  'logo',
  'eyebrow',
  'headline',
  'accentRule',
  'body',
  'features',
  'contact',
]);

export interface LayoutSpecProblem {
  /** `rows[2].cells[0]`, for an operator reading the console. */
  path: string;
  message: string;
}

/**
 * Structural checks Zod cannot express, run after parsing.
 *
 * Kept separate from `normalizeLayoutSpec` because the two answer different
 * questions: this reports what an operator has to fix, that one silently repairs
 * what nobody needs to see. A spec that fails here is not rendered.
 */
export function validateLayoutSpec(spec: PosterLayoutSpec): LayoutSpecProblem[] {
  const problems: LayoutSpecProblem[] = [];

  const counts = new Map<LayoutSlot, number>();
  spec.rows.forEach((row, rowIndex) => {
    row.cells.forEach((cell, cellIndex) => {
      const path = `rows[${rowIndex}].cells[${cellIndex}]`;

      if (cell.slots.length === 0) {
        problems.push({
          path,
          message:
            'has no slots. Use the "spacer" slot for a deliberately empty column.',
        });
      }

      for (const slot of cell.slots) {
        counts.set(slot, (counts.get(slot) ?? 0) + 1);
      }

      /*
       * A cell holding a photo *and* text is an overlay: the photograph becomes
       * the cell's background and the copy is drawn over it under a scrim. That
       * used to be refused outright, because cells stack their slots rather than
       * layering them — but a full-bleed photo with the headline on top is one of
       * the commonest poster shapes there is, and approximating it as two
       * separate bands is visibly not the same poster.
       *
       * Two photos in one cell has no meaning, though: the second would be drawn
       * underneath the first and never seen.
       */
      const photosHere = cell.slots.filter((slot) => slot === 'photo').length;
      if (photosHere > 1 && cell.slots.some((s) => TEXT_SLOTS.has(s))) {
        problems.push({
          path,
          message:
            `overlays text on ${photosHere} photos. An overlay cell backs its copy ` +
            'with exactly one photograph — split the row instead.',
        });
      }
    });
  });

  const headlines = counts.get('headline') ?? 0;
  if (headlines !== 1) {
    problems.push({
      path: 'rows',
      message: `must contain exactly one headline slot, found ${headlines}.`,
    });
  }

  for (const slot of ['contact', 'logo', 'body', 'features'] as const) {
    const seen = counts.get(slot) ?? 0;
    if (seen > 1) {
      problems.push({
        path: 'rows',
        message: `contains ${seen} "${slot}" slots; at most one is allowed.`,
      });
    }
  }

  // Two is the ceiling because two is what the pipeline can pay for — see
  // `resolvePhotoRequests` in src/lib/poster/photo-request.ts. A third would
  // either bill a third diffusion render per poster per day or silently reuse a
  // frame, and both should be a decision rather than a side effect.
  const photos = counts.get('photo') ?? 0;
  if (photos > 2) {
    problems.push({
      path: 'rows',
      message: `contains ${photos} photo slots; at most two are supported.`,
    });
  }

  if (!spec.rows.some((row) => row.sizingMode === 'flex')) {
    problems.push({
      path: 'rows',
      message:
        'has no flexible row, so nothing can absorb copy that runs longer than the ' +
        'reference. Mark the photo row — or the largest row — as "flex".',
    });
  }

  const fixedTotal = spec.rows
    .filter((row) => row.sizingMode === 'fixed')
    .reduce((sum, row) => sum + row.heightFraction, 0);
  if (fixedTotal >= 1) {
    problems.push({
      path: 'rows',
      message: `fixed rows claim ${(fixedTotal * 100).toFixed(0)}% of the canvas, leaving nothing for the rest.`,
    });
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Repairs the faults that are not worth an operator's attention.
 *
 * The extractor is a vision model reading a JPEG, so its output is a draft. Some
 * of what it gets wrong has exactly one sensible correction — an unpadded cell
 * full of type, a spec where nothing was marked flexible — and making a human
 * fix those would bury the mistakes that genuinely need judgement.
 *
 * Anything with more than one sensible correction is left for
 * `validateLayoutSpec` to report instead.
 */
export function normalizeLayoutSpec(spec: PosterLayoutSpec): PosterLayoutSpec {
  const rows = spec.rows.map((row) => ({
    ...row,
    heightFraction: row.sizingMode === 'fixed' ? row.heightFraction : 0,
    cells: row.cells.map((cell) => ({
      ...cell,
      // Type against the canvas edge is never what a template meant, and the
      // extractor reads a full-bleed dark band as unpadded often enough that
      // fixing it by hand every time would be the main cost of using this.
      padded: cell.padded || cell.slots.some((slot) => TEXT_SLOTS.has(slot)),
      slots: cell.slots.length > 0 ? cell.slots : (['spacer'] as LayoutSlot[]),
    })),
  }));

  /*
   * A `hug` row with nothing to hug collapses to nothing.
   *
   * `hug` means "as tall as its type". A row holding only a photograph — or only
   * a spacer — has no type, so it resolves to zero height and the photograph
   * vanishes: the poster renders, looks deliberate, and is simply missing a band.
   * Seen on a real extraction, where the model marked a full-width hero photo
   * `hug` and the top third of the poster came out blank.
   *
   * Promoted to `flex` rather than given an invented `heightFraction`, because
   * flex is what a photo row is for — it is the band that gives when the copy
   * runs long. Several flex rows simply share what is left.
   */
  for (const [index, row] of rows.entries()) {
    if (row.sizingMode !== 'hug') continue;
    const hasType = row.cells.some((cell) => cell.slots.some((slot) => TEXT_SLOTS.has(slot)));
    if (hasType) continue;
    rows[index] = { ...row, sizingMode: 'flex', heightFraction: 0 };
  }

  // Promote a flex row if the extractor marked none. The photo row is the right
  // one for the reason given on LAYOUT_SIZING_MODES; failing that, the row with
  // the largest declared share, since that is the one with room to lose.
  if (!rows.some((row) => row.sizingMode === 'flex')) {
    const photoRow = rows.findIndex((row) =>
      row.cells.some((cell) => cell.slots.includes('photo')),
    );

    const fallback = rows.reduce(
      (best, row, index) =>
        row.heightFraction > (rows[best]?.heightFraction ?? -1) ? index : best,
      0,
    );

    const target = photoRow >= 0 ? photoRow : fallback;
    const row = rows[target];
    if (row) rows[target] = { ...row, sizingMode: 'flex', heightFraction: 0 };
  }

  return { ...spec, rows };
}

/**
 * Parses a stored `CategoryTemplate.layoutSpec`, or null if it is absent or no
 * longer readable.
 *
 * Null rather than throwing, matching `loadCategoryArchetypes`: the column is
 * free-form JSON, and a spec written by a build whose shape has since moved on
 * must degrade to the archetype path for that one template rather than fail
 * every render for the whole vertical.
 */
export function parseLayoutSpec(value: unknown): PosterLayoutSpec | null {
  if (value === null || value === undefined) return null;

  const parsed = posterLayoutSpecSchema.safeParse(value);
  if (!parsed.success) {
    console.warn(
      `[ace:layout] stored spec is not readable by this build (${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}) — falling back to the archetype.`,
    );
    return null;
  }

  const normalized = normalizeLayoutSpec(parsed.data);
  const problems = validateLayoutSpec(normalized);
  if (problems.length > 0) {
    console.warn(
      `[ace:layout] stored spec "${normalized.name}" is structurally invalid ` +
        `(${problems.map((p) => `${p.path} ${p.message}`).join('; ')}) — ` +
        'falling back to the archetype.',
    );
    return null;
  }

  return normalized;
}

export interface LayoutDraft {
  /** Normalised, but NOT known to be structurally valid. Null if the shape is unreadable. */
  spec: PosterLayoutSpec | null;
  /** Empty when the draft is good enough to render. */
  problems: LayoutSpecProblem[];
}

/**
 * Parses a stored spec for *editing* rather than for rendering.
 *
 * The difference from `parseLayoutSpec` is the whole point. That one answers
 * "may this draw a poster?" and returns null for anything it will not draw,
 * which is correct for the render path and useless for the console: a draft
 * rejected for having two headlines is one edit away from being right, and
 * telling an operator "no layout read from this template yet" hides both the
 * mistake and the fix.
 *
 * This returns the draft plus the reasons it is not usable, so the console can
 * show the geometry, name the fault, and let it be corrected. A shape this build
 * cannot read at all still comes back null — there is nothing to edit.
 */
export function parseLayoutDraft(value: unknown): LayoutDraft {
  if (value === null || value === undefined) return { spec: null, problems: [] };

  const parsed = posterLayoutSpecSchema.safeParse(value);
  if (!parsed.success) {
    return {
      spec: null,
      problems: parsed.error.issues.slice(0, 4).map((issue) => ({
        path: issue.path.join('.') || 'spec',
        message: issue.message,
      })),
    };
  }

  const spec = normalizeLayoutSpec(parsed.data);
  return { spec, problems: validateLayoutSpec(spec) };
}

/** Every photo slot in the spec, in render order. Drives the diffusion requests. */
export function countPhotoSlots(spec: PosterLayoutSpec): number {
  return spec.rows.reduce(
    (total, row) =>
      total +
      row.cells.reduce(
        (cellTotal, cell) =>
          cellTotal + cell.slots.filter((slot) => slot === 'photo').length,
        0,
      ),
    0,
  );
}

/**
 * What a layout wants from the copy stage.
 *
 * The renderer ignores content for slots a spec does not declare, so this is not
 * about correctness — it is about not asking the model for words that will never
 * be drawn, and about asking for the right *number* of feature items. A template
 * whose feature strip has room for three reads badly with four, and the copy
 * stage has no other way to know.
 */
export interface LayoutCopyShape {
  hasEyebrow: boolean;
  hasBody: boolean;
  hasFeatures: boolean;
  /** How many feature items the template has room for. */
  featureCount: number;
  /** False when the cards are label-only, so bodies are written but never drawn. */
  featureBodies: boolean;
  /** Share of the canvas width the headline column gets, 0–1. */
  headlineWidthShare: number;
}

export function describeCopyShape(spec: PosterLayoutSpec): LayoutCopyShape {
  const slots = new Set<LayoutSlot>();
  let headlineWidthShare = 1;

  for (const row of spec.rows) {
    const totalWeight = row.cells.reduce((sum, cell) => sum + cell.weight, 0);
    for (const cell of row.cells) {
      for (const slot of cell.slots) slots.add(slot);
      if (cell.slots.includes('headline') && totalWeight > 0) {
        headlineWidthShare = cell.weight / totalWeight;
      }
    }
  }

  return {
    hasEyebrow: slots.has('eyebrow'),
    hasBody: slots.has('body'),
    hasFeatures: slots.has('features'),
    featureCount: spec.featureCount,
    featureBodies: spec.featureStyle === 'labelAndBody',
    headlineWidthShare,
  };
}
