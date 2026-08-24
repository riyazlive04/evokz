import { generateStructured } from '@/lib/ai/openai';
import { optionalEnv } from '@/lib/env';
import {
  normalizeLayoutSpec,
  posterLayoutSpecSchema,
  validateLayoutSpec,
  type LayoutSpecProblem,
  type PosterLayoutSpec,
} from '@/lib/types/layout-spec';
import type { UsageContext } from '@/lib/usage';

/**
 * Reads an uploaded reference poster and describes its grid as a layout spec.
 *
 * Runs **once, at upload**, never per poster. That is the whole economic
 * argument for doing it this way: a vertical with forty templates pays forty
 * vision calls for its entire life, while the render path stays a deterministic
 * function of stored data — the same spec produces the same poster, which is what
 * makes a retry after a WhatsApp failure safe to compare against the original.
 *
 * **The output is a draft, not an answer.** A vision model reading a JPEG will
 * misjudge a 45/55 split, read a caption as a body paragraph, or miss that a
 * dark band is dark. Every caller must put the result in front of an operator
 * before it renders for a client — `extractLayoutSpec` returning cleanly means
 * the JSON is structurally sound, not that it matches the poster. The console's
 * side-by-side is where that second question gets answered.
 */

/**
 * Vision-capable model for this stage.
 *
 * Split from `OPENAI_MODEL` deliberately: that variable is tuned for the copy
 * stages, which run per day per client and are the bulk of the bill, and pointing
 * the fleet at a heavier model to fix extraction would be an expensive way to
 * solve the wrong problem.
 */
const DEFAULT_VISION_MODEL = 'gpt-4o';

function visionModel(): string {
  return optionalEnv('OPENAI_VISION_MODEL', DEFAULT_VISION_MODEL);
}

/**
 * Hand-written rather than derived from the Zod schema.
 *
 * `strict: true` demands `additionalProperties: false` on every object and every
 * property listed in `required` — no optionals, no unions — which is a different
 * shape from what a Zod-to-JSON-Schema conversion emits. The two are kept in
 * step by `posterLayoutSpecSchema.safeParse` on the way back: a drift between
 * them fails loudly at the parse, in the one place that would catch it.
 */
const LAYOUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reading', 'version', 'name', 'ground', 'featureCount', 'featureStyle', 'rows'],
  properties: {
    /*
     * A scratchpad, and the single most load-bearing field in this schema.
     *
     * Structured Outputs constrain generation token by token, so a model asked
     * for `rows` first has to commit to the first row before it has looked at
     * the whole poster. Asked for exactly this grid with no scratchpad, gpt-4o
     * returned *one* row for a four-band poster and stopped — 66 output tokens,
     * no error, a confidently wrong answer.
     *
     * JSON is emitted in property order, so a free-text field declared first is
     * generated first, and the rows that follow are conditioned on it. This is
     * chain-of-thought wearing a schema. Discarded before the spec is stored,
     * but shown to the operator in the review step, where "what the model
     * thought it saw" is the fastest way to spot what it got wrong.
     */
    reading: {
      type: 'string',
      description:
        'Before answering: first count the photographic regions on this poster and ' +
        'state the number. Then name the single largest block of type — that one is ' +
        'the headline, and no other block is, however large. Then list the ' +
        'horizontal bands from top to bottom, one short line each, saying what is in ' +
        'the band and — only where content truly sits side by side — how it splits. ' +
        'Say "plain ground" for an empty side. Most posters have three to six bands. ' +
        'For each band that splits, say where the vertical boundary falls as a ' +
        'percentage of the width from the left edge, and say whether the type in ' +
        'that band is left-aligned, centred or right-aligned. ' +
        'Finally, if there is a row or column of small icon-and-label items, count ' +
        'them and say whether each carries a sentence underneath or is just a label.',
    },
    version: { type: 'integer', enum: [1] },
    name: {
      type: 'string',
      description:
        'Three or four words naming the composition, e.g. "Split hero, banded detail".',
    },
    ground: {
      type: 'string',
      enum: ['light', 'dark'],
      description: 'The dominant background of the poster as a whole.',
    },
    featureCount: {
      type: 'integer',
      enum: [2, 3, 4],
      description:
        'How many items are in the feature block — the row or column of small ' +
        'icon-and-label items. Count them. Send 3 if there is no feature block.',
    },
    featureStyle: {
      type: 'string',
      enum: ['labelAndBody', 'labelOnly'],
      description:
        'labelAndBody when each feature item has a sentence of explanation under its label. labelOnly when the items are just an icon and one or two words, with no sentence.',
    },
    rows: {
      type: 'array',
      description: 'Horizontal bands, top to bottom, spanning the full width.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sizingMode', 'heightFraction', 'fill', 'cells'],
        properties: {
          sizingMode: {
            type: 'string',
            enum: ['hug', 'fixed', 'flex'],
            description:
              'hug = as tall as its text; fixed = a set share of the poster; flex = absorbs leftover space. Use flex for the largest photo row.',
          },
          heightFraction: {
            type: 'number',
            description:
              'Share of the poster height, 0 to 1. Send 0 unless sizingMode is "fixed".',
          },
          fill: {
            type: 'string',
            enum: ['inherit', 'light', 'dark', 'accent'],
          },
          cells: {
            type: 'array',
            description:
              'Columns within this row, left to right. One cell means a full-width row.',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['weight', 'fill', 'align', 'padded', 'slots'],
              properties: {
                weight: {
                  type: 'number',
                  description:
                    'Where the boundary between cells falls, as a percentage of the ' +
                    'poster width. Look at the edge and read off the position: a divide ' +
                    'a third of the way across is 33 and 67. Weights in a row sum to 100. ' +
                    'Do not round to a familiar pair — report what you measure.',
                },
                fill: {
                  type: 'string',
                  enum: ['inherit', 'light', 'dark', 'accent'],
                },
                align: {
                  type: 'string',
                  enum: ['start', 'center', 'end'],
                  description:
                    'Where the content sits inside this cell. Judge it from the left ' +
                    'edges of the lines: ragged-right lines that all begin at the same ' +
                    'left edge are "start"; lines centred about a common axis, with both ' +
                    'edges ragged, are "center"; lines ending at a common right edge are ' +
                    '"end". A full-width band of centred type is "center", not "start".',
                },
                padded: {
                  type: 'boolean',
                  description:
                    'False only for a photo that bleeds to the poster edge.',
                },
                slots: {
                  type: 'array',
                  description: 'Contents of this cell, stacked top to bottom.',
                  items: {
                    type: 'string',
                    enum: [
                      'logo',
                      'eyebrow',
                      'headline',
                      'accentRule',
                      'body',
                      'features',
                      'photo',
                      'contact',
                      'spacer',
                    ],
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

const SYSTEM_PROMPT = `You are a layout analyst for Evokz ACE. You are shown one reference poster and you describe its geometry as a grid, so that the renderer can compose new posters — different company, different photography, different palette — in the same arrangement.

You are describing STRUCTURE ONLY. Never transcribe the poster's words, never name its colours, never mention its brand. "Grand Opening Promo" is a headline slot; "@reallygreatsite" is part of the contact bar. What the poster says is irrelevant and will be replaced.

Read the poster as horizontal bands stacked top to bottom. Split a band into cells only where content genuinely sits side by side. Then map what you see onto this fixed vocabulary — there is nothing else available, so choose the nearest member rather than inventing one:

  logo       a brand mark, a company name set small above the headline, or both
  eyebrow    a short letterspaced line introducing the headline
  headline   the largest type on the poster, the thing it is about
  accentRule a short horizontal bar used as a divider under the headline
  body       a sentence or two of running prose
  features   two or more short labelled items: offers, times, addresses, benefits
  photo      a photographic region; put it in a cell with copy to overlay them
  contact    a phone number, website, address or social handle, usually a bar
  spacer     a column that is deliberately empty

Rules that matter more than fidelity to the reference:

1. Exactly one headline slot, on the whole poster. Posters routinely set a second block of large type further down — an offer, a price, a date, often in a different face — and it is NOT a second headline. Compare every large block against the largest: only the winner is the headline, and a runner-up belongs to "features" or "body" however big it looks on its own. Two headline slots makes the whole layout unusable.
2. Where the reference sets copy directly on top of a photograph, put the photo and the copy in the SAME cell — the photo becomes that cell's background and the copy is drawn over it under a darkening wash. That is an overlay, and it is how a full-bleed hero with the headline on it is described. Only split them into separate cells when the photo and the copy genuinely sit side by side with a visible edge between them. One photo per overlay cell; a second would be hidden behind the first. A photograph that continues behind more than one band is still ONE photograph, and it is an overlay, not a column: put it in the band it mostly covers, together with that band's copy, and do not emit it again for the other bands it passes through. The test for a column is a visible edge where the photograph stops. A photograph that fades out, is cut out around a person, or simply runs on under the type has no such edge — that is an overlay.
3. Mark the largest photo row "flex". Text cannot reflow to fit a canvas, so one row must be able to give up space when the copy runs long. If there is no photo, mark the tallest row.
4. Copy rows are "hug". A bar whose proportion is the point of it — a slim footer, a full-bleed contact strip — is "fixed" with its heightFraction.
5. padded is true everywhere except a photo that bleeds to the poster edge.
6. Fills are roles, not colours: the poster's darkest band is "dark", its brightest is "light", and a saturated brand-coloured band is "accent". A band with no fill of its own is "inherit".

Group small items generously. Three stacked lines each with a little icon are one "features" slot, not three cells.

Count that feature block and describe its shape, because the renderer draws exactly what you report. "featureCount" is how many items it holds — two, three or four. "featureStyle" is "labelOnly" when an item is an icon and one or two words and nothing else, and "labelAndBody" when a sentence sits under the label. Four label-only cards drawn as three labelled paragraphs is the single most common way a generated poster stops resembling the reference, and this is the only thing that prevents it. A poster with no feature block at all: send 3 and "labelAndBody", which is what the renderer already assumes.

Emit one row for EVERY band, top edge to bottom edge, leaving no vertical gap between them. A poster that ends with a coloured footer strip has a row for that strip. Most posters are three to six rows; one row is almost always a misreading.

EMPTY SPACE IS NOT A PHOTO. This is the mistake to guard against hardest. Where a band has copy on one side and plain background on the other, the empty side is a "spacer" cell — plain, unphotographed ground is the most common thing on the right of a headline. Only call a region "photo" if you can actually see a photograph in it: people, food, a room, a landscape. Count the photographs on the poster before you begin, and emit exactly that many photo slots. Many posters have one. Some have none.

Do not assume a poster is split into columns at all. Full-width stacked bands are just as common as side-by-side ones, and a band with a single cell is a perfectly good answer.

When a band IS split, measure the boundary rather than reaching for a familiar pair. Find the vertical edge where one side stops and the other begins, and report its position as a percentage of the poster width — 33 and 67, 44 and 56, 28 and 72. Judging every split as half-and-half or 40-60 is the single most common way a described layout stops matching the poster it was read from, and a boundary you have actually looked at is almost never either of those.

Read alignment the same way, per cell. Type that starts at a common left edge is "start"; type centred about an axis with both edges ragged is "center". A centred headline reported as "start" moves the whole block to one side of the poster.

Two worked examples, to show the range — do not carry their proportions or their names over to the poster you are given, which is neither of them:

  A. Photo beside a big headline, a dark strip of prose, an offer panel beside a
     second photograph, a slim coloured footer.
       row 1  hug          2 cells: photo (bleed) | logo + headline
       row 2  hug          1 cell : body, centred, dark fill
       row 3  flex         2 cells: features | photo (bleed)
       row 4  fixed ~0.07  1 cell : contact, centred, accent fill

  B. Everything stacked full width, nothing beside anything.
       row 1  hug          1 cell : logo + eyebrow + headline + accentRule + body
       row 2  flex         1 cell : photo (bleed)
       row 3  hug          1 cell : features, dark fill
       row 4  fixed ~0.10  1 cell : contact, accent fill

Name the composition from what you actually see — its own shape, in your own words.`;

export interface ExtractedLayout {
  spec: PosterLayoutSpec;
  /**
   * The model's own band-by-band reading of the poster, from the scratchpad
   * field. Not part of the spec and never stored with it — shown beside the
   * draft in the console so an operator can see the reasoning that produced a
   * wrong row before deciding how to fix it.
   */
  reading: string;
  /**
   * Structural faults found after normalisation. A non-empty list means the spec
   * must not render — surfaced to the operator so they can correct it rather
   * than discarded, since a spec that is 90% right is far more useful to edit
   * than a blank grid.
   */
  problems: LayoutSpecProblem[];
  model: string;
}

export async function extractLayoutSpec(input: {
  /** The uploaded reference, as stored — `prepareTemplateImage` output is ideal. */
  bytes: Buffer;
  mimeType: string;
  /** Falls back to the template's filename when the model returns a poor name. */
  label: string;
  /** Attribution for the spend ledger. */
  bill?: UsageContext;
}): Promise<ExtractedLayout> {
  const model = visionModel();

  const generated = await generateStructured<unknown>({
    label: `layout-extract(${input.label})`,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Describe this poster as a grid, following every rule above. Name the ' +
      'composition after its geometry, not after the business in it.',
    imageDataUri: `data:${input.mimeType};base64,${input.bytes.toString('base64')}`,
    schema: LAYOUT_SCHEMA as unknown as Record<string, unknown>,
    schemaName: 'poster_layout_spec',
    model,
    // Geometry has a right answer. The copy stages run hot to vary phrasing
    // across 365 days; reading a column split is the opposite job, and sampling
    // variance here is only ever a wrong split.
    temperature: 0,
    maxTokens: 4_000,
    bill: input.bill ? { ...input.bill, operation: 'layout-extract' } : undefined,
  });

  // The scratchpad is not part of the spec, so it is lifted off before the parse
  // rather than being widened into the stored shape.
  const { reading, ...rest } =
    (generated as { reading?: unknown }) && typeof generated === 'object' && generated
      ? (generated as Record<string, unknown>)
      : {};

  const parsed = posterLayoutSpecSchema.safeParse(rest);
  if (!parsed.success) {
    // Structured Outputs make this close to impossible — it would mean the
    // hand-written JSON Schema above and the Zod schema have drifted apart.
    throw new Error(
      `Layout extraction for "${input.label}" returned JSON this build cannot read: ` +
        parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.')} ${issue.message}`)
          .join('; '),
    );
  }

  const spec = normalizeLayoutSpec({
    ...parsed.data,
    name: parsed.data.name.trim() || input.label,
  });

  return {
    spec,
    reading: typeof reading === 'string' ? reading : '',
    problems: validateLayoutSpec(spec),
    model,
  };
}
