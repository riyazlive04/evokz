import { generateStructured } from '@/lib/ai/openai';
import { optionalEnv } from '@/lib/env';
import { sampleRegionInk } from '@/lib/poster/plate-ink';
import {
  PLATE_SLOTS,
  type PlateSlot,
  type PlateTextRegion,
  type PosterPlateSpec,
} from '@/lib/types/plate-spec';
import { LAYOUT_ALIGNS, LAYOUT_CTA_SHAPES, LAYOUT_EMPHASES } from '@/lib/types/layout-spec';
import type { UsageContext } from '@/lib/usage';

/**
 * Reads an uploaded reference and proposes where each block of type sits on it,
 * as a `PosterPlateSpec`'s text regions.
 *
 * The counterpart to `extractLayoutSpec`, and the reason the plate path is
 * usable at all. A plate's photo regions are measured from its own transparency
 * — `findPlateHoles` reads back exactly what the operator erased — but its text
 * regions have nothing to measure: the words are gone from the plate by
 * definition, and where they *were* is only recoverable from the reference. Left
 * to hand, that is six or seven boxes typed as normalised coordinates for every
 * template in a vertical, which is the kind of work that quietly stops a feature
 * being used.
 *
 * So this runs on the **reference**, not the plate — the image that still has
 * its own type on it — and the boxes it returns land on the plate unchanged
 * because both are normalised 0-1 against the same composition.
 *
 * **A draft, exactly like the grid extractor's.** The output is a starting set
 * of boxes for an operator to drag, and `plateApprovedAt` stays null until
 * somebody has seen the composite. The economics are the same too: one vision
 * call per template for its whole life, never one per poster.
 */

const DEFAULT_VISION_MODEL = 'gpt-4o';

function visionModel(): string {
  return optionalEnv('OPENAI_VISION_MODEL', DEFAULT_VISION_MODEL);
}

/**
 * Hand-written rather than derived from Zod, for the reason
 * `layout-extractor.ts` gives: `strict: true` wants a shape a Zod conversion
 * does not emit. Kept in step by the clamp-and-parse on the way back.
 *
 * No `minimum`/`maximum` on the coordinates — Structured Outputs' strict subset
 * does not carry numeric bounds, so the range is stated in each description and
 * enforced by `clampBox` below.
 */
const PLATE_REGION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'reading',
    'regions',
    'featureCount',
    'featureStyle',
    'ctaShape',
    'headlineEmphasis',
    'headlineCase',
  ],
  properties: {
    /*
     * The scratchpad, and load-bearing for the same reason it is in the grid
     * extractor: generation is token by token, so a model asked for `regions`
     * first commits to the first box before it has looked at the whole poster.
     * Kept and shown to the operator — "what the model thought it saw" is the
     * fastest way to understand a box that landed in the wrong place.
     */
    reading: {
      type: 'string',
      description:
        'Before answering: list every block of type on this poster, top to bottom, ' +
        'one short line each. For each, say what it is (a brand mark, a small ' +
        'introductory line, the largest type, a paragraph of prose, a row of small ' +
        'labelled items, a button, a strip of contact details), roughly where its ' +
        'left and right edges fall as percentages of the width, and where its top ' +
        'and bottom edges fall as percentages of the height. Then say how many lines ' +
        'the largest block has and whether any line is set heavier or in a different ' +
        'colour. Then, if there is a row or column of small icon-and-label items, ' +
        'count them and say whether each carries a sentence underneath.',
    },
    regions: {
      type: 'array',
      description: 'One entry per block of type. Never two for the same slot.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['slot', 'x', 'y', 'w', 'h', 'align', 'valign'],
        properties: {
          slot: { type: 'string', enum: [...PLATE_SLOTS] },
          x: {
            type: 'number',
            description:
              "The box's left edge as a fraction of the poster's width, 0 at the left " +
              'edge and 1 at the right. Three decimal places.',
          },
          y: {
            type: 'number',
            description:
              "The box's top edge as a fraction of the poster's height, 0 at the top " +
              'edge and 1 at the bottom. Three decimal places.',
          },
          w: {
            type: 'number',
            description:
              "The box's width as a fraction of the poster's width. Report the width of " +
              'the COLUMN the block is set in — the horizontal space the designer left ' +
              'for it — not the width of the particular words in front of you.',
          },
          h: {
            type: 'number',
            description:
              "The box's height as a fraction of the poster's height, covering every " +
              'line of the block.',
          },
          align: {
            type: 'string',
            enum: [...LAYOUT_ALIGNS],
            description:
              'How the type is set horizontally inside its box: "start" for a common ' +
              'left edge, "center" for centred with both edges ragged, "end" for a ' +
              'common right edge.',
          },
          valign: {
            type: 'string',
            enum: [...LAYOUT_ALIGNS],
            description:
              'Where the block sits vertically inside its box. "start" unless the block ' +
              'is obviously centred in a panel taller than itself.',
          },
        },
      },
    },
    featureCount: {
      type: 'integer',
      enum: [2, 3, 4],
      description:
        'How many items the row or column of small labelled items holds. Send 3 if ' +
        'there is no such block.',
    },
    featureStyle: {
      type: 'string',
      enum: ['labelAndBody', 'labelOnly'],
      description:
        '"labelOnly" when an item is an icon and one or two words and nothing else; ' +
        '"labelAndBody" when a sentence sits under the label. Send "labelAndBody" if ' +
        'there is no such block.',
    },
    ctaShape: {
      type: 'string',
      enum: [...LAYOUT_CTA_SHAPES],
      description:
        "The button's silhouette: \"pill\" for fully rounded ends, \"rounded\" for " +
        'softened corners, "square" for sharp ones. Send "pill" if there is no button.',
    },
    headlineEmphasis: {
      type: 'array',
      description:
        'One entry per line of the largest block of type, top to bottom. "heavy" for a ' +
        'line in noticeably bolder type, "accent" for a line in a different colour from ' +
        'its neighbours, "plain" otherwise. A uniformly set headline is every line ' +
        '"heavy". Empty if there is somehow no headline.',
      items: { type: 'string', enum: [...LAYOUT_EMPHASES] },
    },
    headlineCase: {
      type: 'string',
      enum: ['upper', 'sentence'],
      description:
        '"upper" when the largest block is set in capitals, "sentence" otherwise.',
    },
  },
} as const;

const SYSTEM_PROMPT = `You are a layout analyst for Evokz ACE. You are shown one reference poster. Its artwork is going to be reused as-is — the masks, the cards, the curves, the colours all stay — and only its WORDS are replaced, with another company's copy. Your job is to say where each block of words sits, as a rectangle, so the new copy can be set in the same places.

You are reporting POSITION ONLY. Never transcribe what the poster says, never name a colour, never mention the brand. What it says is irrelevant and will be replaced.

Coordinates are fractions of the poster, from its top-left corner: x and w against the width, y and h against the height. A block starting a tenth of the way across and running to the middle is x 0.1, w 0.4. Give three decimal places. Measure against the whole poster every time — never against a panel or a band inside it.

The vocabulary is fixed. Choose the nearest member; there is nothing else available:

  logo     a brand mark, a company name set small, or both together
  eyebrow  a short letterspaced line introducing the largest type
  headline the largest type on the poster, the thing it is about
  body     a sentence or two of running prose
  features two or more short labelled items sharing a row or a column: services,
           offers, benefits, times. Report ONE box covering the whole group.
  cta      a button: a filled shape with a short instruction inside it
  contact  a phone number, website, address or social handle, usually in a strip

Rules that matter more than fidelity:

1. EXACTLY ONE headline, and at most one of every other slot. A poster that sets a second block of large type further down — a price, a date, an offer — has a headline and a "body" or a "features", not two headlines. Compare every large block against the largest: only the winner is the headline.
2. Report the COLUMN, not the words. The replacement copy is a different length from what you can see, and the box you give is the space it is allowed. A headline occupying the left half of the poster is w 0.5 even if its longest line happens to stop short of that. A box drawn tight around the reference's particular words sets the new company's headline in type two sizes smaller.
3. Report a block even if you suspect it belongs to the artwork. A box that should not be there is deleted with one click; a box that is missing has to be drawn by hand.
4. Group generously. Four icons with a word under each are ONE features box spanning all four, never four boxes. A phone number, an address and a website along the bottom are ONE contact box.
5. Boxes may overlap the artwork freely, and may run off an edge where the reference's own type bleeds off it. Do not shrink a box to avoid a photograph.
6. Leave out anything that is not type: photographs, icons on their own, rules, decorative shapes. Those are already in the artwork.

The height matters less than the width — a block whose copy runs longer than the reference's grows downward from where you put it — but a box whose TOP edge is wrong moves the whole block, so read the top edge carefully.

A poster with no button, no prose or no contact strip simply has no region for it. Three or four regions is a perfectly normal answer.`;

export interface ExtractedPlateRegions {
  regions: PlateTextRegion[];
  featureCount: PosterPlateSpec['featureCount'];
  featureStyle: PosterPlateSpec['featureStyle'];
  ctaShape: PosterPlateSpec['ctaShape'];
  headlineEmphasis: PosterPlateSpec['headlineEmphasis'];
  headlineCase: PosterPlateSpec['headlineCase'];
  /** The model's own reading, for the console. Never stored in the spec. */
  reading: string;
  model: string;
}

/** Coordinates the model reported, held loosely until they are checked. */
interface RawRegion {
  slot: unknown;
  x: unknown;
  y: unknown;
  w: unknown;
  h: unknown;
  align: unknown;
  valign: unknown;
}

const SLOT_SET = new Set<string>(PLATE_SLOTS);
const ALIGN_SET = new Set<string>(LAYOUT_ALIGNS);

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Brings one reported box inside what `boxSchema` will accept.
 *
 * The bounds are the schema's own, not 0-1: a box is deliberately allowed to run
 * past an edge, because type bleeding off the right is a real design and
 * clamping it to the edge would silently move it. What this refuses is a box
 * that cannot be a box at all — a zero width, a NaN, a coordinate three posters
 * away — which is a misread rather than a design.
 */
function clampBox(raw: RawRegion): PlateTextRegion | null {
  const slot = typeof raw.slot === 'string' && SLOT_SET.has(raw.slot) ? (raw.slot as PlateSlot) : null;
  if (!slot) return null;

  const x = asNumber(raw.x);
  const y = asNumber(raw.y);
  const w = asNumber(raw.w);
  const h = asNumber(raw.h);
  if (x === null || y === null || w === null || h === null) return null;
  if (w <= 0 || h <= 0) return null;

  const align = typeof raw.align === 'string' && ALIGN_SET.has(raw.align) ? raw.align : 'start';
  const valign = typeof raw.valign === 'string' && ALIGN_SET.has(raw.valign) ? raw.valign : 'start';

  return {
    x: Math.min(Math.max(x, -1), 2),
    y: Math.min(Math.max(y, -1), 2),
    w: Math.min(w, 3),
    h: Math.min(h, 3),
    slot,
    align: align as PlateTextRegion['align'],
    valign: valign as PlateTextRegion['valign'],
    // Filled below by measurement, never by the model — see `sampleRegionInk`.
    color: null,
  };
}

export async function extractPlateRegions(input: {
  /** The reference as stored — the image that still has its own words on it. */
  bytes: Buffer;
  mimeType: string;
  label: string;
  /**
   * Whether to measure each region's ink colour from the reference.
   *
   * Only read under `paletteSource: "template"`, but measured regardless: the
   * palette choice is a toggle in the console and re-running a vision pass to
   * fill in a field that costs milliseconds would be the wrong trade.
   */
  sampleInk?: boolean;
  bill?: UsageContext;
}): Promise<ExtractedPlateRegions> {
  const model = visionModel();

  const generated = await generateStructured<Record<string, unknown>>({
    label: `plate-regions(${input.label})`,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Give the box for every block of type on this poster, following every rule ' +
      'above. Measure each box against the whole poster.',
    imageDataUri: `data:${input.mimeType};base64,${input.bytes.toString('base64')}`,
    schema: PLATE_REGION_SCHEMA as unknown as Record<string, unknown>,
    schemaName: 'poster_plate_regions',
    // Geometry has a right answer — the same argument `extractLayoutSpec` makes.
    temperature: 0,
    maxTokens: 4_000,
    model,
    bill: input.bill ? { ...input.bill, operation: 'plate-regions' } : undefined,
  });

  const rawRegions = Array.isArray(generated.regions) ? generated.regions : [];

  const seen = new Set<PlateSlot>();
  const regions: PlateTextRegion[] = [];
  for (const raw of rawRegions) {
    const region = clampBox(raw as RawRegion);
    if (!region) continue;
    // Deduped here as well as in `normalizePlateSpec`, so the count this
    // function reports is the count that will be stored.
    if (seen.has(region.slot)) continue;
    seen.add(region.slot);
    regions.push(region);
  }

  if (input.sampleInk !== false) {
    // Sequential rather than parallel: seven crops of one already-decoded buffer
    // is a few tens of milliseconds, and sharp's own thread pool is shared with
    // whatever else the request is doing.
    for (const region of regions) {
      region.color = await sampleRegionInk(input.bytes, region);
    }
  }

  const featureCount = asNumber(generated.featureCount) ?? 3;
  const emphasis = Array.isArray(generated.headlineEmphasis)
    ? generated.headlineEmphasis.filter(
        (value): value is PosterPlateSpec['headlineEmphasis'][number] =>
          typeof value === 'string' && (LAYOUT_EMPHASES as readonly string[]).includes(value),
      )
    : [];

  return {
    regions,
    featureCount: Math.min(Math.max(Math.round(featureCount), 2), 4),
    featureStyle: generated.featureStyle === 'labelOnly' ? 'labelOnly' : 'labelAndBody',
    ctaShape:
      generated.ctaShape === 'rounded' || generated.ctaShape === 'square'
        ? generated.ctaShape
        : 'pill',
    // Capped at the schema's four: a headline longer than that is a misread, and
    // `posterPlateSpecSchema` would refuse the whole spec over it.
    headlineEmphasis: emphasis.slice(0, 4),
    headlineCase: generated.headlineCase === 'sentence' ? 'sentence' : 'upper',
    reading: typeof generated.reading === 'string' ? generated.reading : '',
    model,
  };
}
