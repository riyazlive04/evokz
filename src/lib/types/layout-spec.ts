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
 * else. A spec chooses *where* the slots go and, through `featureCount`,
 * `featureStyle` and `ctaShape`, how one of them is drawn; it can neither invent
 * a new slot nor restyle one, which is what keeps every poster in a campaign
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
 *
 * `cta` is the second, and it is a different mark from `contact` rather than a
 * variation on it. A contact bar is a full-bleed strip carrying a phone number
 * and a website; a CTA is a filled button with one imperative inside it. Whole
 * families of reference poster — web banners especially — are built around the
 * button and carry no contact bar at all, and describing one as the other put a
 * phone number where the reference had "Start investing now".
 */
export const LAYOUT_SLOTS = [
  'logo',
  'eyebrow',
  'headline',
  'accentRule',
  'body',
  'features',
  'cta',
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

/**
 * What a photograph in a cell actually is.
 *
 * `scene` is a photographic region — a room, a landscape, people at a table —
 * that fills its cell edge to edge. Everything before this field was one.
 *
 * `subject` is a person or object with the background removed, standing on the
 * cell's own fill. It is the shape a great many banner references use: flat
 * ground, type on the left, a cut-out figure on the right. Rendering one as a
 * `scene` brings the diffusion model's own invented backdrop onto a poster whose
 * whole design is a flat colour, which reads as a photograph pasted over the
 * artwork rather than as the reference it came from.
 *
 * On the cell rather than the spec because a template may legitimately hold one
 * of each — a scene band above, a cut-out figure beside the headline.
 */
export const LAYOUT_PHOTO_KINDS = ['scene', 'subject'] as const;

export type LayoutPhotoKind = (typeof LAYOUT_PHOTO_KINDS)[number];

export const layoutPhotoKindSchema = z.enum(LAYOUT_PHOTO_KINDS);

/**
 * The button's silhouette. Purely presentational, and the only thing about a CTA
 * a spec is allowed to carry — its colour comes from the client's accent and its
 * words from the day's copy, exactly like every other slot.
 */
/**
 * Chrome a cell can be drawn on, beyond a flat fill.
 *
 * The grid's blind spot, and the reason a rebuilt poster reads as emptier than
 * the reference it came from. A template's density is rarely its photograph —
 * it is the panel behind the service list, the card under the feature block, the
 * shape behind the cut-out figure. Measured on the HealthFirst reference: the
 * spec was a faithful reading and the render still came out 60% bare ground,
 * because every one of those marks was outside the vocabulary.
 *
 * `card` is a rounded surface with a hairline edge, drawn in the cell's own
 * fill. Deliberately one primitive rather than a catalogue: a designer's panel
 * is a rounded rectangle in nine cases out of ten, and a vocabulary the
 * extractor has to choose *between* is one it will choose wrongly — the same
 * failure that put a `spacer` where a person was standing.
 */
export const LAYOUT_SURFACES = ['none', 'card'] as const;

export type LayoutSurface = (typeof LAYOUT_SURFACES)[number];

export const layoutSurfaceSchema = z.enum(LAYOUT_SURFACES);

/**
 * A shape painted behind a cell's content.
 *
 * Exists for one job: a `subject` photo is a person with their background
 * removed, and standing them on bare canvas is what makes a composite look
 * unfinished. Nearly every reference that uses a cut-out puts a shape behind
 * them — a swoosh, a disc, a wedge of brand colour — and `blob` is the general
 * case of it: a large accent form anchored to the bottom of the cell that the
 * figure stands in front of.
 *
 * Painted in the theme accent, never a stored hex, for the reason on
 * `LAYOUT_FILLS`: one template has to serve every tenant.
 *
 * `scene` is the photographic version of the same job, and it exists because
 * `blob` did not solve it. A painted shape behind a cut-out stops the figure
 * floating but leaves the poster reading as a figure on a panel; what the
 * references have behind their subject is a *place* — a corridor, a ward, a room
 * with depth in it. So `scene` generates a second frame and composites the
 * cut-out over it.
 *
 * **It costs a second diffusion call per poster.** That is the whole reason it is
 * a per-cell opt-in rather than a default, and why `countPhotoSlots` counts it:
 * the two-photo cap is a budget, and a backdrop spends half of it. See
 * `docs/layout-backlog.md` for the arithmetic across a campaign.
 *
 * The brief comes from the day's `backgroundPrompt`, never from the spec — a
 * spec holds no strings. A `scene` backdrop on a day that has no background
 * prompt falls back to `blob`, so a sheet that has not been updated still draws
 * something behind its figure rather than nothing.
 */
export const LAYOUT_BACKDROPS = ['none', 'blob', 'scene'] as const;

export type LayoutBackdrop = (typeof LAYOUT_BACKDROPS)[number];

export const layoutBackdropSchema = z.enum(LAYOUT_BACKDROPS);

/**
 * How a filled row meets the row above it.
 *
 * `curveTop` gives the band a curved upper edge instead of a straight one —
 * the wave over a footer, the sweep under a hero. It is drawn *inside* the row
 * rather than overhanging the one above, because the canvas clips overflow and
 * a shape hanging upward would be cut off at the boundary it is trying to blur.
 */
export const LAYOUT_EDGES = ['none', 'curveTop'] as const;

export type LayoutEdge = (typeof LAYOUT_EDGES)[number];

export const layoutEdgeSchema = z.enum(LAYOUT_EDGES);

export const LAYOUT_CTA_SHAPES = ['pill', 'rounded', 'square'] as const;

export type LayoutCtaShape = (typeof LAYOUT_CTA_SHAPES)[number];

export const layoutCtaShapeSchema = z.enum(LAYOUT_CTA_SHAPES);

/**
 * What the `accentRule` slot draws.
 *
 * `bar` is the original: a short solid rectangle in the accent colour.
 *
 * `pulse` is an ECG trace — a hairline with a heartbeat spike near its centre.
 * It exists because it is not decoration in a medical vertical, it is the mark
 * every reference in the library shares: all fourteen Medicals templates set one
 * under the headline, and a spec that drew a plain bar there could not match any
 * of them however carefully the rest of its geometry was written. A vocabulary
 * that cannot say the one thing every design says is the thing stopping those
 * designs from being restated at all.
 *
 * Kept a separate style rather than a separate slot: it occupies the same place
 * in the stack, takes the same colour, and answers the same question about
 * vertical rhythm, so a spec should be able to switch it without restructuring.
 */
export const LAYOUT_ACCENT_RULE_STYLES = ['bar', 'pulse'] as const;

export type LayoutAccentRuleStyle = (typeof LAYOUT_ACCENT_RULE_STYLES)[number];

export const layoutAccentRuleStyleSchema = z.enum(LAYOUT_ACCENT_RULE_STYLES);

/**
 * How one headline line is set against its siblings.
 *
 * A structural property of the template, not of the day's words: references
 * routinely set one line of a three-line headline heavier or in the brand
 * colour, and reproducing that is most of what makes a generated headline look
 * like the reference's headline.
 *
 * **Per line, deliberately, and never per word.** A reference emphasising a
 * single word inside a line ("making you RICH") cannot be honoured, because the
 * template's words are discarded and replaced by the copy stage — a per-word
 * emphasis map would have nothing to attach to on the generated poster. The line
 * is the finest unit that survives word replacement.
 */
export const LAYOUT_EMPHASES = ['plain', 'heavy', 'accent'] as const;

export type LayoutEmphasis = (typeof LAYOUT_EMPHASES)[number];

export const layoutEmphasisSchema = z.enum(LAYOUT_EMPHASES);

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
  /**
   * What a `photo` slot in this cell is. Ignored when the cell holds no photo,
   * exactly as `heightFraction` is ignored unless a row is `fixed` — Structured
   * Outputs permit no optional properties, so a field that only applies
   * sometimes is a field that is always present and sometimes unread.
   *
   * Defaults to `scene`, which is what every spec stored before this field
   * existed meant and the only behaviour the renderer had.
   */
  photoKind: layoutPhotoKindSchema.default('scene'),
  /**
   * Chrome drawn under this cell's content. Defaults to `none`, which is what
   * every spec stored before this field existed means and exactly what they
   * drew.
   */
  surface: layoutSurfaceSchema.default('none'),
  /** A shape painted behind the content — see `LAYOUT_BACKDROPS`. */
  backdrop: layoutBackdropSchema.default('none'),
  /**
   * Where the cell's content sits vertically when the row is taller than it.
   *
   * **The single largest source of dead space in a rebuilt poster**, and until
   * this field the renderer simply centred everything: a copy column in a tall
   * flex band got equal gaps above and below, so a poster whose reference starts
   * its headline near the top came out with a third of the canvas blank over it.
   * `cell.align` never governed this — it is horizontal only.
   *
   * Defaults to `center`, which is what the renderer did unconditionally, so no
   * stored spec moves.
   */
  valign: layoutAlignSchema.default('center'),
  /** Stacked top to bottom, in this order. */
  slots: z.array(layoutSlotSchema),
});

export type LayoutCell = z.infer<typeof layoutCellSchema>;

export const layoutRowSchema = z.object({
  sizingMode: layoutSizingModeSchema,
  /** How this row's fill meets the row above — see `LAYOUT_EDGES`. */
  edge: layoutEdgeSchema.default('none'),
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
  /**
   * The reference template's own width ÷ height, and therefore the shape of
   * every poster drawn from it.
   *
   * **Measured from the uploaded file, never read off the image by the vision
   * model.** The extractor is asked about geometry it has to judge; an aspect
   * ratio is a property of the bytes, and `prepareTemplateImage` already knows
   * it exactly. Asking a model to estimate a number we hold is how a square
   * reference becomes "about 1.1:1".
   *
   * **Zero means unknown**, and unknown falls back to the client's output preset
   * — which is what every spec stored before this field existed carries, and why
   * adding this changes nothing for a template until it is re-read. See
   * `resolvePosterCanvas` in src/lib/poster/canvas.ts for what honours it.
   */
  aspect: z.number().min(0).finite().default(0),
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
  /**
   * The CTA button's silhouette.
   *
   * On the spec rather than the cell for the same reason as `featureCount`:
   * `validateLayoutSpec` caps a spec at one `cta`, so there is nowhere else it
   * could apply.
   */
  ctaShape: layoutCtaShapeSchema.default('pill'),
  /**
   * What an `accentRule` slot draws. Defaults to `bar`, so every spec stored
   * before this field existed keeps the rule it has always drawn.
   */
  accentRuleStyle: layoutAccentRuleStyleSchema.default('bar'),
  /**
   * How each headline line is set, indexed by line.
   *
   * **Empty is not "all plain" — it is "not measured", and it falls the renderer
   * back to `PosterCopy.accentLineIndex`.** That distinction is what lets every
   * spec stored before this field existed keep drawing the headline it always
   * drew. A newly extracted spec carries a real pattern and overrides it.
   *
   * May be shorter or longer than the day's headline: the copy stage writes 2-4
   * lines and knows nothing about which template the day landed in. The renderer
   * indexes into it and treats a missing entry as `plain`.
   */
  headlineEmphasis: z.array(layoutEmphasisSchema).max(4).default([]),
  /**
   * Whether the template sets its headline in capitals.
   *
   * Defaults to `upper`, which is what the renderer hardcoded before this field
   * and therefore what every stored spec means.
   */
  headlineCase: z.enum(['upper', 'sentence']).default('upper'),
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
  'cta',
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

  for (const slot of ['contact', 'logo', 'body', 'features', 'cta'] as const) {
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
 * Null rather than throwing: the column is free-form JSON, and a spec written by
 * a build whose shape has since moved on must take that one template out of its
 * vertical's rotation rather than fail every render for the vertical.
 *
 * There is nothing behind it. The archetypes this once degraded to are gone —
 * `resolveDayLayout` reports `pinned-unreadable` or `no-approved-templates` and
 * the day fails with a message naming the fix, which is the honest outcome when
 * the only description of the poster cannot be read.
 */
export function parseLayoutSpec(value: unknown): PosterLayoutSpec | null {
  if (value === null || value === undefined) return null;

  const parsed = posterLayoutSpecSchema.safeParse(value);
  if (!parsed.success) {
    console.warn(
      `[ace:layout] stored spec is not readable by this build (${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}) — this template is out of rotation until it is re-read.`,
    );
    return null;
  }

  const normalized = normalizeLayoutSpec(parsed.data);
  const problems = validateLayoutSpec(normalized);
  if (problems.length > 0) {
    console.warn(
      `[ace:layout] stored spec "${normalized.name}" is structurally invalid ` +
        `(${problems.map((p) => `${p.path} ${p.message}`).join('; ')}) — ` +
        'this template is out of rotation until it is re-read.',
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

/**
 * Whether a template is carrying its vertical's standard layout rather than one
 * written for its own reference image.
 *
 * **Why this is derived and not a column.** An upload inherits
 * `Category.defaultLayoutSpec` so it does not burn a vision call on an estimate,
 * which is right. What was wrong was recording that as `layoutAuthoredAt`:
 * nobody authored that spec *for this image*, and the stamp bought it the
 * protection of a hand-authored layout — re-reading refused — so a genuinely
 * different design could be assimilated into the vertical and then locked
 * against correction. Inheritance is a fact about two rows, so it is read from
 * the rows.
 *
 * Both sides are parsed before comparing: Zod emits keys in schema order, so two
 * specs that mean the same thing serialise identically regardless of how they
 * were stored. An unreadable spec on either side is not inheritance.
 */
export function isInheritedLayout(stored: unknown, categoryDefault: unknown): boolean {
  const mine = parseLayoutSpec(stored);
  if (!mine) return false;

  const standard = parseLayoutSpec(categoryDefault);
  if (!standard) return false;

  return JSON.stringify(mine) === JSON.stringify(standard);
}

/** Every photo slot in the spec, in render order. Drives the diffusion requests. */
export function countPhotoSlots(spec: PosterLayoutSpec): number {
  return spec.rows.reduce(
    (total, row) =>
      total +
      row.cells.reduce(
        (cellTotal, cell) =>
          cellTotal +
          cell.slots.filter((slot) => slot === 'photo').length +
          // A `scene` backdrop is a second generated frame, not chrome. It costs a
          // diffusion call exactly as a slot does, so everything that budgets,
          // caps or orders photographs has to see it — including the two-photo
          // limit and `render.tsx`'s "declares N photo cell(s)" guard.
          (cell.backdrop === 'scene' ? 1 : 0),
        0,
      ),
    0,
  );
}

/**
 * Photo cells this layout composites as a cut-out figure rather than a scene.
 *
 * The distinction the image brief has to honour. A `subject` frame is passed
 * through background removal and drawn on the poster's own ground, so a brief
 * that does not describe one standing person yields an empty or partial matte —
 * a pair of disembodied hands, or nothing. `checkRowFit` reads this to warn at
 * import instead of at delivery.
 */
export function countSubjectSlots(spec: PosterLayoutSpec): number {
  return spec.rows.reduce(
    (total, row) =>
      total +
      row.cells.reduce(
        (cellTotal, cell) =>
          cellTotal +
          (cell.photoKind === 'subject'
            ? cell.slots.filter((slot) => slot === 'photo').length
            : 0),
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
  /** Whether a CTA button will be drawn, and so whether its label is seen. */
  hasCta: boolean;
  /** How many feature items the template has room for. */
  featureCount: number;
  /** False when the cards are label-only, so bodies are written but never drawn. */
  featureBodies: boolean;
  /** Share of the canvas width the headline column gets, 0–1. */
  headlineWidthShare: number;
  /**
   * How many headline lines the template was measured to have. 0 when unknown.
   *
   * The emphasis pattern is indexed by line, so a mismatch between it and the
   * copy silently flattens the headline: a template measured at three lines
   * (`accent, accent, heavy`) handed two lines gives both of them `accent`, and
   * the contrast that made the reference's headline look designed disappears
   * entirely. The copy stage had no way to know the count and no reason to guess
   * it right.
   */
  headlineLineCount: number;
  /**
   * Share of the canvas width the feature block gets, 0–1.
   *
   * Reported for the same reason as the headline's: the block cannot reflow to
   * fit, so a column narrower than its words is a column that either shrinks its
   * type or stacks one word per line. The renderer now does the first, and this
   * lets the copy stage stop causing it — a nine-word sentence in a quarter-width
   * column is set tiny however well the fitter behaves.
   */
  featureWidthShare: number;
}

export function describeCopyShape(spec: PosterLayoutSpec): LayoutCopyShape {
  const slots = new Set<LayoutSlot>();
  let headlineWidthShare = 1;
  let featureWidthShare = 1;

  for (const row of spec.rows) {
    const totalWeight = row.cells.reduce((sum, cell) => sum + cell.weight, 0);
    for (const cell of row.cells) {
      for (const slot of cell.slots) slots.add(slot);
      if (totalWeight <= 0) continue;
      if (cell.slots.includes('headline')) {
        headlineWidthShare = cell.weight / totalWeight;
      }
      if (cell.slots.includes('features')) {
        featureWidthShare = cell.weight / totalWeight;
      }
    }
  }

  return {
    hasEyebrow: slots.has('eyebrow'),
    hasBody: slots.has('body'),
    hasFeatures: slots.has('features'),
    hasCta: slots.has('cta'),
    featureCount: spec.featureCount,
    featureBodies: spec.featureStyle === 'labelAndBody',
    headlineWidthShare,
    featureWidthShare,
    // Empty means the template was read before emphasis was measured, which is
    // "unknown" rather than "zero lines" — see the field's own note.
    headlineLineCount: spec.headlineEmphasis.length,
  };
}
