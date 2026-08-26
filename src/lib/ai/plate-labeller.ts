import sharp from 'sharp';

import { generateStructured } from '@/lib/ai/openai';
import { optionalEnv } from '@/lib/env';
import type { TextBlock } from '@/lib/poster/text-detect';
import { PLATE_SLOTS, type PlateSlot, type PlateTextRegion } from '@/lib/types/plate-spec';
import { LAYOUT_ALIGNS } from '@/lib/types/layout-spec';
import type { UsageContext } from '@/lib/usage';

/**
 * Names the blocks of type that `detectTextBlocks` has already measured.
 *
 * **The half of the old extractor worth keeping.** `extractPlateRegions` asked
 * gpt-4o to do two jobs at once: find where each block of type sits, and say
 * what it is. It did the second competently and the first not at all — across
 * the live library, 59 of 60 stored boxes had every coordinate on a 0.05 grid,
 * which is a model describing a poster rather than measuring one.
 *
 * So the jobs are separated. Geometry is measured from the pixels, where it is
 * exact and free; this asks only "what is block 7", which is classification
 * against a fixed vocabulary — a question a vision model answers well and, more
 * to the point, a question whose wrong answers are visible to an operator
 * glancing at the numbered overlay.
 *
 * It is also the pass that discards what the detector should not have found. A
 * stethoscope, a logo mark and a decorative rule all survive pixel analysis
 * looking somewhat like type; none of them survives being asked what they say.
 */

const DEFAULT_VISION_MODEL = 'gpt-4o';

function visionModel(): string {
  return optionalEnv('OPENAI_VISION_MODEL', DEFAULT_VISION_MODEL);
}

/**
 * The vocabulary, plus the two answers that are not slots.
 *
 * `ignore` is what makes the detector's false positives harmless, and it is
 * listed first in the prompt for that reason: it must read as an ordinary
 * answer rather than a failure, or the model reaches for the nearest slot
 * instead of rejecting a photograph.
 */
const LABELS = [...PLATE_SLOTS, 'ignore'] as const;

const LABEL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['labels', 'featureCount', 'featureStyle', 'ctaShape', 'headlineCase'],
  properties: {
    labels: {
      type: 'array',
      description: 'Exactly one entry per numbered box, in any order.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['box', 'label', 'align'],
        properties: {
          box: { type: 'integer', description: 'The number printed beside the box.' },
          label: { type: 'string', enum: [...LABELS] },
          align: {
            type: 'string',
            enum: [...LAYOUT_ALIGNS],
            description:
              'How this block of type is set inside its own box: "start" for a common ' +
              'left edge, "center" for centred, "end" for a common right edge.',
          },
        },
      },
    },
    featureCount: {
      type: 'integer',
      enum: [2, 3, 4],
      description:
        'How many items the row or column of small labelled items holds. Count the ' +
        'items on the poster, not the boxes you labelled. Send 3 if there is no such block.',
    },
    featureStyle: {
      type: 'string',
      enum: ['labelAndBody', 'labelOnly'],
      description:
        '"labelOnly" when an item is an icon and one or two words and nothing else; ' +
        '"labelAndBody" when a sentence sits under the label.',
    },
    ctaShape: {
      type: 'string',
      enum: ['pill', 'rounded', 'square'],
      description:
        "The button's silhouette: \"pill\" for fully rounded ends, \"rounded\" for " +
        'softened corners, "square" for sharp. Send "pill" if there is no button.',
    },
    headlineCase: {
      type: 'string',
      enum: ['upper', 'sentence'],
      description: '"upper" when the largest block is set in capitals, "sentence" otherwise.',
    },
  },
} as const;

const SYSTEM_PROMPT = `You are a layout analyst for Evokz ACE. You are shown one reference poster with numbered green boxes drawn on it. Each box was measured from the pixels and is already correct — you are NOT being asked where anything is, and you must not question the boxes' positions.

Your only job is to say what kind of content each numbered box contains.

Answer with one of these for every box:

  ignore   the box does not contain words at all: part of a photograph, an icon
           or logo mark on its own, a decorative rule, a shape, a gradient edge.
           This is a normal answer and often the right one for several boxes.
  logo     the poster's own branding: a company name set as a wordmark, a symbol
           or monogram standing for that company, or the strapline printed under
           it. Label these "logo" even when the box holds no readable words —
           the branding belongs to the template's designer and is replaced by
           the client's, so it has to be found. A pictorial icon that merely
           decorates a service or a feature is not branding; that is "ignore".
  eyebrow  a short letterspaced line introducing the largest type
  headline the largest type on the poster, the thing it is about
  body     a sentence or two of running prose
  features one of two or more short labelled items sharing a row or a column:
           services, offers, benefits, times
  cta      a button: a short instruction inside a filled shape
  contact  a phone number, website, address or social handle

Rules that matter:

1. A block split across several boxes gets the SAME label on each. A headline set over four lines is four boxes all labelled "headline". A column of three services is three boxes all labelled "features". Do not try to pick one box as the "real" one.
2. EXACTLY ONE kind of block is the headline: the largest type on the poster. A second large block further down — a price, a date, an offer — is "body" or "features", never a second headline. Compare every large block against the largest.
3. When a box contains no words, answer "ignore" — with one exception, the branding above. Do not stretch for the nearest slot: a stethoscope is not a feature, and a photograph of a person is never type.
4. A box holding an icon AND its label together is "features" — the words are what matter.
5. If a poster has no button, no prose or no contact strip, simply no box gets that label. That is normal.

Answer for every numbered box, once each.`;

export interface LabelledBlock {
  block: TextBlock;
  label: (typeof LABELS)[number];
  align: PlateTextRegion['align'];
}

export interface PlateLabelling {
  labelled: LabelledBlock[];
  featureCount: 2 | 3 | 4;
  featureStyle: 'labelAndBody' | 'labelOnly';
  ctaShape: 'pill' | 'rounded' | 'square';
  headlineCase: 'upper' | 'sentence';
  model: string;
}

/**
 * Draws the measured boxes onto the reference, numbered, for the model to read.
 *
 * The numbers are the whole interface: the model never states a coordinate, so
 * nothing it says can move a box. Drawn in a single flat green with a heavy
 * stroke because the image is downscaled by the vision encoder, and a thin or
 * low-contrast outline is the first thing to disappear.
 */
export async function drawNumberedBoxes(
  bytes: Buffer,
  blocks: TextBlock[],
): Promise<Buffer> {
  const meta = await sharp(bytes).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width <= 0 || height <= 0) return bytes;

  // Scaled to the poster so the annotation stays legible on a 900px reference
  // and on a 3000px one.
  const stroke = Math.max(3, Math.round(width / 260));
  const fontSize = Math.max(18, Math.round(width / 38));

  const marks = blocks
    .map((block, index) => {
      const x = block.x * width;
      const y = block.y * height;
      const w = block.w * width;
      const h = block.h * height;
      const labelY = y > fontSize * 1.3 ? y - stroke * 2 : y + h + fontSize;

      return (
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" ` +
        `stroke="#00E676" stroke-width="${stroke}"/>` +
        `<text x="${x + stroke}" y="${labelY}" font-family="monospace" ` +
        `font-size="${fontSize}" font-weight="bold" fill="#00E676" ` +
        `stroke="#000000" stroke-width="${Math.max(1, stroke / 3)}" ` +
        `paint-order="stroke">${index + 1}</text>`
      );
    })
    .join('');

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${marks}</svg>`;

  return sharp(bytes)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();
}

const LABEL_SET = new Set<string>(LABELS);
const ALIGN_SET = new Set<string>(LAYOUT_ALIGNS);

export async function labelTextBlocks(input: {
  /** The reference as stored — the image that still has its words on it. */
  bytes: Buffer;
  mimeType: string;
  label: string;
  blocks: TextBlock[];
  bill?: UsageContext;
}): Promise<PlateLabelling> {
  const model = visionModel();

  if (input.blocks.length === 0) {
    return {
      labelled: [],
      featureCount: 3,
      featureStyle: 'labelAndBody',
      ctaShape: 'pill',
      headlineCase: 'upper',
      model,
    };
  }

  const annotated = await drawNumberedBoxes(input.bytes, input.blocks);

  const generated = await generateStructured<Record<string, unknown>>({
    label: `plate-labels(${input.label})`,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      `There are ${input.blocks.length} numbered boxes on this poster. Say what kind of ` +
      'content each one holds, using "ignore" for any box that does not contain words.',
    imageDataUri: `data:image/png;base64,${annotated.toString('base64')}`,
    schema: LABEL_SCHEMA as unknown as Record<string, unknown>,
    schemaName: 'plate_block_labels',
    // Classification against a fixed vocabulary has a right answer, the same
    // argument the extractors both make about geometry.
    temperature: 0,
    maxTokens: 4_000,
    model,
    bill: input.bill ? { ...input.bill, operation: 'plate-labels' } : undefined,
  });

  const raw = Array.isArray(generated.labels) ? generated.labels : [];
  const seen = new Set<number>();
  const labelled: LabelledBlock[] = [];

  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;

    const index = typeof row.box === 'number' ? Math.round(row.box) - 1 : -1;
    const block = input.blocks[index];
    // A box named twice, or a number that does not exist, is dropped rather
    // than repaired: the block simply goes unlabelled, which drops it from the
    // spec, and an unlabelled block is a far better failure than a mislabelled
    // one placed over somebody's face.
    if (!block || seen.has(index)) continue;
    seen.add(index);

    const label =
      typeof row.label === 'string' && LABEL_SET.has(row.label)
        ? (row.label as (typeof LABELS)[number])
        : 'ignore';
    const align =
      typeof row.align === 'string' && ALIGN_SET.has(row.align)
        ? (row.align as PlateTextRegion['align'])
        : 'start';

    labelled.push({ block, label, align });
  }

  const featureCount = typeof generated.featureCount === 'number' ? generated.featureCount : 3;

  return {
    labelled,
    featureCount: Math.min(Math.max(Math.round(featureCount), 2), 4) as 2 | 3 | 4,
    featureStyle: generated.featureStyle === 'labelOnly' ? 'labelOnly' : 'labelAndBody',
    ctaShape:
      generated.ctaShape === 'rounded' || generated.ctaShape === 'square'
        ? generated.ctaShape
        : 'pill',
    headlineCase: generated.headlineCase === 'sentence' ? 'sentence' : 'upper',
    model,
  };
}

/**
 * Unions the labelled lines into one region per slot.
 *
 * A headline set over four lines is four measured boxes; the plate spec wants
 * one. The union of the lines is the column the designer left for it, which is
 * exactly what `renderPlateSpec` needs and what the old extractor was asked for
 * in prose ("report the COLUMN, not the words") and never delivered.
 *
 * `valign` is always `start`. The measured box is the extent of the reference's
 * own copy, and this day's is a different length — hanging it from the top of
 * that extent is the only choice that does not move the first line, which is the
 * line a reader's eye lands on.
 */
/**
 * Vertical gap, as a share of the poster, that ends a run of lines.
 *
 * Lines of one block sit within a line-height of each other; a gap this large is
 * a different part of the poster. Generous enough to hold a feature column whose
 * items are spaced apart, tight enough to separate a headline from the body
 * beneath it.
 */
const RUN_BREAK = 0.08;

/**
 * The largest contiguous run of lines carrying one label.
 *
 * **Without this a single mislabelled block ruins the slot.** The union is taken
 * over every block sharing a label, so one stray box at the foot of the poster
 * that the model called `features` stretches the features region from wherever
 * the features actually are all the way down to it. Measured on Med-SM-1: a
 * features region of `y 38.5, h 58.0` — the eyebrow to the bottom edge —
 * swallowing the body at y 71 and the contact bar at y 81, which is precisely
 * the overlapping mess it rendered.
 *
 * Runs are broken on vertical gaps and the heaviest one wins, weighed by cells
 * rather than by count: three lines of a real feature column outweigh two stray
 * marks, whatever the arithmetic of a plain majority would say.
 */
function largestRun(entries: LabelledBlock[]): LabelledBlock[] {
  if (entries.length < 2) return entries;

  const sorted = [...entries].sort((a, b) => a.block.y - b.block.y);

  const runs: LabelledBlock[][] = [];
  let current: LabelledBlock[] = [sorted[0]!];
  let reach = sorted[0]!.block.y + sorted[0]!.block.h;

  for (const entry of sorted.slice(1)) {
    if (entry.block.y - reach > RUN_BREAK) {
      runs.push(current);
      current = [];
    }
    current.push(entry);
    reach = Math.max(reach, entry.block.y + entry.block.h);
  }
  runs.push(current);

  if (runs.length === 1) return entries;

  let best = runs[0]!;
  let bestWeight = -1;
  for (const run of runs) {
    const weight = run.reduce((sum, entry) => sum + entry.block.cells, 0);
    if (weight > bestWeight) {
      bestWeight = weight;
      best = run;
    }
  }

  const dropped = entries.length - best.length;
  if (dropped > 0) {
    console.warn(
      `[ace:plate] the "${best[0]!.label}" label was given to ${entries.length} blocks in ` +
        `${runs.length} separate places; keeping the ${best.length} that sit together and ` +
        `dropping ${dropped}.`,
    );
  }

  return best;
}

export function unionIntoRegions(labelled: LabelledBlock[]): PlateTextRegion[] {
  const bySlot = new Map<PlateSlot, LabelledBlock[]>();

  for (const entry of labelled) {
    if (entry.label === 'ignore') continue;
    const slot = entry.label as PlateSlot;
    const existing = bySlot.get(slot);
    if (existing) existing.push(entry);
    else bySlot.set(slot, [entry]);
  }

  const regions: PlateTextRegion[] = [];

  for (const [slot, all] of bySlot) {
    const entries = largestRun(all);

    let x0 = 1;
    let y0 = 1;
    let x1 = 0;
    let y1 = 0;

    for (const { block } of entries) {
      x0 = Math.min(x0, block.x);
      y0 = Math.min(y0, block.y);
      x1 = Math.max(x1, block.x + block.w);
      y1 = Math.max(y1, block.y + block.h);
    }

    // The alignment the most of its lines agreed on. A single ragged line in a
    // centred block should not flip the whole slot to left-aligned.
    const votes = new Map<string, number>();
    for (const entry of entries) {
      votes.set(entry.align, (votes.get(entry.align) ?? 0) + 1);
    }
    let align: PlateTextRegion['align'] = 'start';
    let best = 0;
    for (const [candidate, count] of votes) {
      if (count > best) {
        best = count;
        align = candidate as PlateTextRegion['align'];
      }
    }

    regions.push({
      x: x0,
      y: y0,
      w: Math.max(0.001, x1 - x0),
      h: Math.max(0.001, y1 - y0),
      slot,
      align,
      valign: 'start',
      // Filled by measurement afterwards, never by the model — `sampleRegionInk`.
      color: null,
    });
  }

  return regions;
}
