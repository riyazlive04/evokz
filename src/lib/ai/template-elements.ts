import sharp from 'sharp';
import { z } from 'zod';

import { generateStructured, supportsTemperature } from '@/lib/ai/openai';
import { optionalEnv } from '@/lib/env';
import { detectTextBlocks } from '@/lib/poster/text-detect';
import {
  elementIdHighWater,
  elementIdNumber,
  IMAGE_KINDS,
  MAX_ELEMENT_TEXT,
  MAX_TEMPLATE_ELEMENTS,
  TEMPLATE_ELEMENT_KINDS,
  templateElementsDocSchema,
  type ElementBox,
  type TemplateElement,
  type TemplateElementsDoc,
} from '@/lib/types/template-elements';
import type { UsageContext } from '@/lib/usage';

/**
 * Reads every changeable element of a template poster, once, at upload.
 *
 * Clone mode reuses a template as it is and changes only its words, its
 * photographs and the business identity printed on it. That needs a list of
 * those elements — what each one is, what it says and where it sits — which is
 * this module's output, stored on `CategoryTemplate.elements`.
 *
 * **Measure, then name.** The same split `plate-labeller.ts` arrived at: a vision
 * model asked where text sits answers to within a line or two, so position comes
 * from the pixels wherever the pixels can give it. Two measurements:
 *
 *   - `detectTextBlocks` finds blocks of type. The model is shown them numbered
 *     and says which block holds which element.
 *   - `measureInkBoxes` cuts each block into its separate marks of ink — a word,
 *     a line, an icon — because a block often runs across several elements: three
 *     lines of a contact bar, or a headline and the row of cards beneath it.
 *
 * The model reads the words, names each element, counts its printed lines and
 * estimates a box for everything. `mergeElementBoxes` then places each element on
 * measured ink where it can and falls back to the estimate where it cannot — a
 * photograph, a logo mark, faint type the detector missed.
 *
 * **Two images, not one.** The model reads the clean poster, so the words are
 * exact, and matches numbers on a copy with the measured boxes drawn over it. One
 * annotated image would put the numbers on top of the letters being read.
 *
 * Nothing here writes. The caller stores the document; `stabilizeElementIds`
 * keeps a re-read's ids in step with the reading it replaces.
 */

/**
 * Model for the read, from `OPENAI_TEMPLATE_ELEMENTS_MODEL`.
 *
 * Its own setting rather than `OPENAI_VISION_MODEL`, because the model that
 * setting names today cannot do this job. Measured on 2026-09-17 against the
 * urology template: gpt-4o returned the measured boxes' own coordinates as its
 * "estimates" and assigned box numbers in list order — the phone number to a box
 * on the doctor's coat, the three features to each other's boxes. gpt-5.4 named
 * every box correctly, split the logo symbol from the specialty beside it, found
 * the second photograph, and estimated the contact bar's lines to within a line
 * height, in about eleven seconds. gpt-5.5 read as well in five times the time;
 * gpt-5.4-mini invented photographs out of fragments. Once per template, the
 * stronger model is the cheap part.
 */
const DEFAULT_MODEL = 'gpt-5.4';

function elementsModel(): string {
  return optionalEnv('OPENAI_TEMPLATE_ELEMENTS_MODEL', DEFAULT_MODEL);
}

/** Guards the decode against a decompression bomb, matching `text-detect.ts`. */
const MAX_PIXELS = 32_000_000;

/**
 * Shortest edge of the images sent to the model.
 *
 * At `detail: 'high'` the API scales an image so its shortest side is at most
 * 768px before the model sees it. Scaling here first changes nothing the model
 * sees, keeps the request small, and means the box numbers are drawn at the size
 * they are read at rather than shrunk into illegibility afterwards.
 */
const MODEL_SHORT_EDGE = 768;

// ---------------------------------------------------------------------------
// The model's answer
// ---------------------------------------------------------------------------

const BOX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['x', 'y', 'w', 'h'],
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    w: { type: 'number' },
    h: { type: 'number' },
  },
} as const;

/**
 * Hand-written for strict Structured Outputs: every object closed, every property
 * required, nullable fields as a `[type, "null"]` union. Kept in step with
 * `readElementSchema` and `readPhotoSchema` below, which re-check the answer.
 *
 * `photos` comes first on purpose. Properties are generated in schema order, so
 * the model has to search the poster for photographs before it starts listing
 * words — the pass that was missing when a doctor-and-patient photo and a small
 * cut-out portrait went unreported.
 */
const ELEMENTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['photos', 'elements'],
  properties: {
    photos: {
      type: 'array',
      description: 'Step 1: every photographic region on the poster.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'box'],
        properties: {
          description: { type: 'string' },
          box: { ...BOX_SCHEMA, description: 'The whole photograph, as fractions of the poster, from the top-left.' },
        },
      },
    },
    elements: {
      type: 'array',
      description: 'Step 2: every changeable element of the poster, in reading order.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'text', 'lines', 'blocks', 'box', 'group', 'description'],
        properties: {
          kind: { type: 'string', enum: [...TEMPLATE_ELEMENT_KINDS] },
          text: {
            type: ['string', 'null'],
            description: 'The words exactly as printed, lines joined with one space. Null for photo and logo.',
          },
          lines: {
            type: 'integer',
            description: 'How many printed lines the words run over. 0 for photo and logo.',
          },
          blocks: {
            type: 'array',
            description: 'Numbers of the green boxes holding this element. Empty when none does.',
            items: { type: 'integer' },
          },
          box: {
            ...BOX_SCHEMA,
            description: 'Your own estimate of the whole element, as fractions of the poster, from the top-left.',
          },
          group: {
            type: ['string', 'null'],
            description: '"features" for items of a repeated set, "contact" for a shared contact strip, otherwise null.',
          },
          description: {
            type: ['string', 'null'],
            description: 'For photo and logo: what it shows. Null for words.',
          },
        },
      },
    },
  },
} as const;

const SYSTEM_PROMPT = `You read marketing posters for Evokz ACE. The poster will be reused as a template: its layout stays exactly as it is, and only its words, its photographs and the business identity printed on it change. List every element that can change, so each one can be edited.

You receive two images of the same poster:
- Image 1 is the poster as it is. Read the words from this one.
- Image 2 is the same poster with text boxes drawn in green and numbered. The boxes were measured from the pixels. A box may hold one line, several lines of one block, or run across several neighbouring elements; list it for every element it holds. Some boxes are false detections on a photograph, an icon or a shape.

Work in two steps.

Step 1, "photos". Before anything else, search the whole poster for photographs and list every one with a short description and its box. A photograph here is a picture of people, a scene or a featured product that could be swapped for a different photograph. Check each of these: the main picture; a photograph filling the background behind everything, even where it is faded, blurred or partly covered by shapes and text; small cut-out portraits of a person, often in a circle or a corner; photographs inside cards, circles or frames. Not separate photographs: objects that are part of a larger photograph's scene (a plant, a clipboard or a laptop on the same desk), decorative sprigs of flowers or leaves, flat illustrations, icons, pictograms and shapes.

Step 2, "elements". List every changeable element, including each photograph from step 1 as a photo element. For each element give:
- kind: one of the kinds below.
- text: the words exactly as printed, with the same spelling, capitals and punctuation. Join the lines of one element with a single space. Do not correct, translate or shorten. Null for photo and logo.
- lines: how many printed lines the words run over, counted on the poster: "CARE / BEYOND / TREATMENT" is 3. 0 for photo and logo.
- blocks: the number of every green box that holds this element's words. Empty when none does (photographs, most logos, type the boxes missed). Never list a box that only covers part of a photograph or an icon.
- box: your own estimate of the whole element as fractions of the poster: x and y of its top-left corner, then width and height, each between 0 and 1, to three decimals. Always give it, even when blocks are listed. Cover every line of a block of text, the whole photograph, the whole logo. For words with an icon beside or above them — a feature, a button, a contact detail — the box covers the words only, never the icon.
- group: "features" for each item of a repeated set of features, services, benefits or steps; "contact" for details sharing one contact strip or bar; otherwise null.
- description: for photo and logo only, what it shows, concretely: "doctor in a white coat talking to a patient at a desk", "blue cross symbol above the words Midnimo Hospital". Null for words.

List the elements in reading order: top to bottom, then left to right.

Kinds for the poster's message:
  headline     the main message, usually the largest type. ONE headline, even when it runs over several lines or mixes colours, weights or a script word.
  subheadline  a short secondary line that expands on the headline
  body         a sentence or short paragraph of prose
  feature      one item of a repeated set: a service, benefit or step, group "features". When an item has a short title with a sentence beneath it in lighter or smaller type, the title is the feature and the sentence is a separate text element, also in group "features".
  cta          a call to action, usually on a button or bar: "Book an Appointment Today", "Contact us"
  badge        a short label in a seal, circle, ribbon or sticker: "Trusted by 5,000 patients", "20% OFF"
  text         any other changeable words, e.g. a closing slogan, or a label such as "Visit :"

Kinds for the business's identity. These are replaced by the client's own details, so classify them carefully:
  brandName    the business's name set in ordinary type: in a header, a footer, or beside a separate logo symbol
  tagline      the business's own slogan or descriptor printed with its name or logo, e.g. "Hospice & Palliative Care" under the name. Not the poster's message, and never a person's title or specialty.
  phone        phone or WhatsApp numbers; several numbers on one line are one phone element
  website      a web address
  email        an email address
  address      a street, area, city or directions to a place
  social       a social media handle or page name written out, e.g. "@evokzhealth". Social media icons (the LinkedIn, Facebook, X, Instagram or YouTube marks) are icons, not elements.
  logo         the business's own brand mark: its symbol, emblem or monogram, and its name when that is drawn as a wordmark. A poster usually has one logo, sometimes repeated small in a footer. Icons and pictograms are NOT logos, even standing alone in a circle or a corner: a heart with a pulse line, a clipboard, a stethoscope, a shield, a phone or map-pin icon, a feature's icon, an icon above or beside a sentence that illustrates it. When the name is part of the logo artwork, report the whole lockup as one logo. When the name is ordinary type beside a separate symbol, report the symbol as logo and the name as brandName. Words beside a logo mark that describe a specialty, a service or a person are never part of the logo: a kidney symbol in a pill beside the words "CONSULTANT UROLOGIST & ANDROLOGIST" is a logo (the symbol alone) and a credential (the words).
  personName   a person's name, e.g. "Dr. Hari Shankar Singh"
  credential   a person's degrees, registration or licence number, job title or specialty, e.g. "M.B.B.S, M.S", "Reg No. 30435", "Consultant Urologist & Andrologist". A title set over two lines is one credential.

The picture:
  photo        a photograph or photographic cut-out of people, a scene or a product. One element per separate photograph.

Rules:
1. A label and its detail are two elements: "Call us on +91 80907 20161" is a cta "Call us on" and a phone "+91 80907 20161"; "Visit : www.botphonic.ai" is a text "Visit :" and a website "www.botphonic.ai"; "Email: info@clinic.com" is a text "Email:" and an email "info@clinic.com"; "Visit us at: 12 Park Road" is a text "Visit us at:" and an address "12 Park Road". A phone, website, email or address element holds only the detail itself. A label that is only an icon is not an element.
2. A sentence that mentions the business's name among other words is content, not brandName: "Choose EDC Clinic." is text.
3. Not elements: decorative shapes, lines, dots, bullets, arrows, frames and backgrounds; icons and pictograms, including a feature's icon (its label is the feature); words that are part of a photograph, such as a sign on a wall, a print on clothing or a screen; the green boxes and numbers in image 2.
4. Every word printed on the poster outside a photograph belongs to exactly one element. Do not skip small print, and do not report the same words twice.`;

const boxSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });

/** The model's answer for one element, re-checked leniently: bad rows are dropped, not fatal. */
const readElementSchema = z.object({
  kind: z.enum(TEMPLATE_ELEMENT_KINDS),
  text: z.string().nullable(),
  /** Printed lines. Optional so readings cached before it existed still build. */
  lines: z.number().nullable().optional(),
  blocks: z.array(z.number()),
  box: boxSchema.nullable(),
  group: z.string().nullable(),
  description: z.string().nullable(),
});

/** One element as the model named it, before boxes are merged and ids assigned. */
export type ReadElementCandidate = z.infer<typeof readElementSchema>;

const readPhotoSchema = z.object({ description: z.string(), box: boxSchema });

/** One photograph from the model's dedicated photo pass. */
export type ReadPhoto = z.infer<typeof readPhotoSchema>;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface TemplateElementsInput {
  /** The template as stored. */
  bytes: Buffer;
  mimeType: string;
  /** For logs and error messages. */
  label: string;
  /** The stored file's own pixel size, which the document records its boxes against. */
  width: number;
  height: number;
  /** Attribution for the spend ledger. */
  bill?: UsageContext;
}

export async function readTemplateElements(input: TemplateElementsInput): Promise<TemplateElementsDoc> {
  const read = await readTemplateElementCandidates(input);
  return buildTemplateElementsDoc({ ...read, width: input.width, height: input.height, label: input.label });
}

/**
 * The measurements and the model's answer, before normalisation. Separate so a
 * console or a check can show what the model said beside what was stored, and so
 * a cached answer can be re-merged without another call.
 *
 * Photographs the photo pass found but the element list left out are already
 * added to `candidates` (`addMissedPhotos`).
 */
export async function readTemplateElementCandidates(input: TemplateElementsInput): Promise<{
  candidates: ReadElementCandidate[];
  measured: ElementBox[];
  inks: ElementBox[];
  model: string;
}> {
  const detection = await detectTextBlocks(input.bytes);
  if (!detection) {
    throw new Error(`Template "${input.label}" could not be decoded as an image, so its elements were not read.`);
  }
  const measured = detection.blocks.map((block) => clampBox(block));

  let clean: Buffer;
  let inks: ElementBox[];
  try {
    clean = await sharp(input.bytes, { limitInputPixels: MAX_PIXELS })
      .resize({ width: MODEL_SHORT_EDGE, height: MODEL_SHORT_EDGE, fit: 'outside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .png()
      .toBuffer();
    inks = await measureInkBoxes(input.bytes, measured);
  } catch (error) {
    throw new Error(`Template "${input.label}" could not be decoded as an image, so its elements were not read.`, {
      cause: error,
    });
  }
  const annotated = measured.length > 0 ? await drawMeasuredBlocks(clean, measured) : null;

  const model = elementsModel();
  const generated = await generateStructured<unknown>({
    label: `template-elements(${input.label})`,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: buildReaderUserPrompt(measured),
    imageDataUri: toDataUri(clean),
    additionalImageDataUris: annotated ? [toDataUri(annotated)] : undefined,
    schema: ELEMENTS_SCHEMA as unknown as Record<string, unknown>,
    schemaName: 'template_elements',
    model,
    // Reading and naming have a right answer; sampling variance is only ever a
    // misread word or a flipped kind. Reasoning models take only their default,
    // and spend part of the completion budget thinking.
    temperature: supportsTemperature(model) ? 0 : undefined,
    maxTokens: supportsTemperature(model) ? 8_000 : 16_000,
    bill: input.bill ? { ...input.bill, operation: 'template-elements' } : undefined,
  });

  const answer = generated && typeof generated === 'object' ? (generated as Record<string, unknown>) : {};
  if (!Array.isArray(answer.elements)) {
    throw new Error(`Reading the elements of template "${input.label}" returned no element list.`);
  }

  const candidates = answer.elements
    .map((row) => readElementSchema.safeParse(row))
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data as ReadElementCandidate);
  const photos = (Array.isArray(answer.photos) ? answer.photos : [])
    .map((row) => readPhotoSchema.safeParse(row))
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data as ReadPhoto);

  return { candidates: addMissedPhotos(candidates, photos), measured, inks, model };
}

function buildReaderUserPrompt(measured: readonly ElementBox[]): string {
  if (measured.length === 0) {
    return [
      'Only one image is attached: no text boxes were measured on this poster, so give every element an empty blocks list and your own box.',
      'Find the photographs, then list every changeable element of this poster, following every rule above.',
    ].join('\n');
  }
  return [
    `Measured green boxes in image 2 (x, y, width, height as fractions of the poster, from the top-left):`,
    ...measured.map(
      (box, index) => `${index + 1}. x ${box.x.toFixed(3)}  y ${box.y.toFixed(3)}  w ${box.w.toFixed(3)}  h ${box.h.toFixed(3)}`,
    ),
    '',
    'Find the photographs, then list every changeable element of this poster, following every rule above.',
  ].join('\n');
}

function toDataUri(png: Buffer): string {
  return `data:image/png;base64,${png.toString('base64')}`;
}

/**
 * The measured boxes drawn and numbered, for the model to match words to.
 *
 * Flat green with a dark outline on the numbers, scaled to the image, because the
 * vision encoder downsamples and a thin or low-contrast mark is the first thing
 * lost. Numbers sit just above a box, or just below it at the top edge.
 */
async function drawMeasuredBlocks(png: Buffer, blocks: readonly ElementBox[]): Promise<Buffer> {
  const meta = await sharp(png).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width <= 0 || height <= 0) return png;

  const stroke = Math.max(2, Math.round(width / 320));
  const fontSize = Math.max(14, Math.round(width / 42));

  const marks = blocks
    .map((block, index) => {
      const x = block.x * width;
      const y = block.y * height;
      const w = block.w * width;
      const h = block.h * height;
      const labelY = y > fontSize * 1.2 ? y - stroke * 1.5 : y + h + fontSize;
      return (
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="none" stroke="#00E676" stroke-width="${stroke}"/>` +
        `<text x="${(x + stroke).toFixed(1)}" y="${labelY.toFixed(1)}" font-family="monospace" font-size="${fontSize}" font-weight="bold" fill="#00E676" stroke="#000000" stroke-width="${Math.max(1, stroke / 2)}" paint-order="stroke">${index + 1}</text>`
      );
    })
    .join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${marks}</svg>`;
  return sharp(png)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();
}

/**
 * Photographs from the photo pass that no photo element covers, added as photo
 * elements.
 *
 * The pass exists because the element list alone missed photographs — a
 * doctor-and-patient photo behind a headline, a small portrait in a corner circle.
 * A photo element "covers" a found photograph when the two boxes are much the
 * same area (IoU at least half) — a looser estimate of the same picture still
 * counts, but a portrait lying inside the main photograph's box does not.
 */
export function addMissedPhotos(
  candidates: readonly ReadElementCandidate[],
  photos: readonly ReadPhoto[],
): ReadElementCandidate[] {
  const out = [...candidates];
  for (const photo of photos) {
    const box = clampBox(photo.box);
    if (box.w <= 0 || box.h <= 0) continue;
    const covered = out.some(
      (candidate) => candidate.kind === 'photo' && candidate.box && iou(clampBox(candidate.box), box) >= 0.5,
    );
    if (covered) continue;
    out.push({ kind: 'photo', text: null, lines: 0, blocks: [], box, group: null, description: photo.description });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ink — measured marks inside the detected blocks
// ---------------------------------------------------------------------------

/** Long edge of the frame ink is measured in, as `text-detect.ts` does. */
const INK_EDGE = 1600;

/** Horizontal luminance step that counts as the side of a stroke. */
const INK_DELTA = 48;

/**
 * Every separate mark of ink inside the detected blocks — a word or line of type,
 * an icon, the side of a card — as boxes normalised to the poster.
 *
 * The detector's blocks are what the model names, but a block is often several
 * elements: the three lines of a contact bar and the doctor's bar beside it
 * detected as one, or a headline joined to the row of cards beneath it.
 * `cutInkBoxes` recovers the lines inside a block, which is what an element's box
 * should be made of.
 */
export async function measureInkBoxes(bytes: Buffer, blocks: readonly ElementBox[]): Promise<ElementBox[]> {
  if (blocks.length === 0) return [];
  const { data, info } = await sharp(bytes, { limitInputPixels: MAX_PIXELS })
    .resize({ width: INK_EDGE, height: INK_EDGE, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const edges = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x + 1 < width; x += 1) {
      const here = data[(y * width + x) * channels] ?? 0;
      const right = data[(y * width + x + 1) * channels] ?? 0;
      if (Math.abs(here - right) >= INK_DELTA) edges[y * width + x] = 1;
    }
  }
  return cutInkBoxes(edges, width, height, blocks);
}

/** A rectangle of pixels, half-open: [x0, x1) × [y0, y1). */
interface InkRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Smallest mark kept, in pixels of the measuring frame: below this it is a speck. */
const MIN_INK_PX = 3;

/** Horizontal reach, in pixels, that joins the stroke edges of one glyph. */
const INK_JOIN_X = 2;

/**
 * Marks join into one line when they overlap vertically by half the shorter, their
 * heights are within this ratio, and the gap between them is under
 * `INK_WORD_GAP` of the taller — a word space, not the gutter between columns.
 */
const INK_LINE_HEIGHT_RATIO = 0.45;
const INK_WORD_GAP = 0.6;

/**
 * The lines of ink inside each block, from a mask of 0/1 stroke edges
 * (`width × height`, set where luminance steps sharply to the right).
 *
 * Connected components, each cut at its own blank rows and columns
 * (`cutComponent`), then lines. A projection cut over whole blocks was tried first
 * and failed on exactly the blocks that matter: the side of a card, a pill or a
 * divider runs through every row between lines and every column between cards,
 * and photo texture fills the rest, so nothing was ever blank. As components, a
 * card's side is a tall, thin mark of its own; it joins no line, because lines
 * only join marks of comparable height, and `textMarks` later discards it with
 * the icons.
 *
 * Pure, so it can be checked on a drawn fixture.
 */
export function cutInkBoxes(
  edges: Uint8Array,
  width: number,
  height: number,
  blocks: readonly ElementBox[],
): ElementBox[] {
  // Pixels inside any block, padded a little: marks are only looked for there.
  const inside = new Uint8Array(width * height);
  for (const block of blocks) {
    const x0 = Math.max(0, Math.floor(block.x * width) - 2);
    const y0 = Math.max(0, Math.floor(block.y * height) - 2);
    const x1 = Math.min(width, Math.ceil((block.x + block.w) * width) + 2);
    const y1 = Math.min(height, Math.ceil((block.y + block.h) * height) + 2);
    for (let y = y0; y < y1; y += 1) inside.fill(1, y * width + x0, y * width + x1);
  }

  // Join each glyph's stroke edges, then label the joined mask.
  const joined = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!edges[index] || !inside[index]) continue;
      for (let dx = -INK_JOIN_X; dx <= INK_JOIN_X; dx += 1) {
        const nx = x + dx;
        if (nx >= 0 && nx < width && inside[y * width + nx]) joined[y * width + nx] = 1;
      }
    }
  }

  const marks: InkRect[] = [];
  const seen = new Uint8Array(width * height);
  const stack: number[] = [];
  for (let seed = 0; seed < joined.length; seed += 1) {
    if (!joined[seed] || seen[seed]) continue;
    let x0 = width;
    let y0 = height;
    let x1 = -1;
    let y1 = -1;
    const pixels: number[] = [];
    seen[seed] = 1;
    stack.push(seed);
    while (stack.length > 0) {
      const index = stack.pop()!;
      pixels.push(index);
      const x = index % width;
      const y = (index - x) / width;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (joined[next] && !seen[next]) {
            seen[next] = 1;
            stack.push(next);
          }
        }
      }
    }
    if (y1 - y0 + 1 < MIN_INK_PX) continue;

    // The component's own stroke edges, cut at its blank rows and columns.
    const boxWidth = x1 - x0 + 1;
    const boxHeight = y1 - y0 + 1;
    const own = new Uint8Array(boxWidth * boxHeight);
    for (const index of pixels) {
      if (!edges[index]) continue;
      const x = index % width;
      const y = (index - x) / width;
      own[(y - y0) * boxWidth + (x - x0)] = 1;
    }
    for (const piece of cutComponent(own, boxWidth, boxHeight, width)) {
      marks.push({ x0: x0 + piece.x0, y0: y0 + piece.y0, x1: x0 + piece.x1, y1: y0 + piece.y1 });
    }
  }

  // Marks into lines, left to right.
  marks.sort((a, b) => a.x0 - b.x0 || a.y0 - b.y0);
  const lines: Array<{ x0: number; y0: number; x1: number; y1: number; tallest: number }> = [];
  for (const mark of marks) {
    const markHeight = mark.y1 - mark.y0;
    let best: (typeof lines)[number] | null = null;
    let bestOverlap = 0;
    for (const line of lines) {
      const overlap = Math.min(line.y1, mark.y1) - Math.max(line.y0, mark.y0);
      const shorter = Math.min(markHeight, line.tallest);
      const taller = Math.max(markHeight, line.tallest);
      if (overlap < 0.5 * Math.min(markHeight, line.y1 - line.y0)) continue;
      if (shorter / taller < INK_LINE_HEIGHT_RATIO) continue;
      if (mark.x0 - line.x1 > INK_WORD_GAP * taller) continue;
      if (overlap > bestOverlap) {
        best = line;
        bestOverlap = overlap;
      }
    }
    if (best) {
      best.x0 = Math.min(best.x0, mark.x0);
      best.x1 = Math.max(best.x1, mark.x1);
      best.y0 = Math.min(best.y0, mark.y0);
      best.y1 = Math.max(best.y1, mark.y1);
      best.tallest = Math.max(best.tallest, markHeight);
    } else {
      lines.push({ ...mark, tallest: markHeight });
    }
  }

  return lines
    .filter((line) => line.x1 - line.x0 >= MIN_INK_PX || line.y1 - line.y0 >= 4 * MIN_INK_PX)
    .map((line) => ({
      x: line.x0 / width,
      y: line.y0 / height,
      w: (line.x1 - line.x0) / width,
      h: (line.y1 - line.y0) / height,
    }));
}

/**
 * A connected component cut at its own blank rows and columns.
 *
 * Components are not always single marks. A photograph behind a pill, the pill's
 * outline and a map-pin icon can chain into one component that swallows the two
 * lines of an address inside it — measured on a contact bar laid over an arm.
 * Inside the component, though, the rows between those lines hold only the
 * pill's two arcs and a little of the pin, while the lines themselves are dense
 * with strokes. So each component is cut the way a page is: at rows much emptier
 * than its busy ones, then at columns wide enough not to be a word space, until
 * nothing splits. Photo texture outside the component cannot fill the gaps, which
 * is what defeated the same cut applied to whole blocks.
 *
 * `mask` is the component's own edges in its bounding box; `frameWidth` scales the
 * column gap. Returns pieces in the box's coordinates. A component that has no
 * clearly busy rows comes back whole.
 */
function cutComponent(mask: Uint8Array, boxWidth: number, boxHeight: number, frameWidth: number): InkRect[] {
  const pieces: InkRect[] = [];
  const maxColumnGap = Math.max(4, Math.round(frameWidth * 0.02));

  const cut = (x0: number, y0: number, x1: number, y1: number, depth: number): void => {
    const box = trimmed(x0, y0, x1, y1);
    if (!box) return;
    ({ x0, y0, x1, y1 } = box);
    if (depth >= 24) {
      pieces.push(box);
      return;
    }

    const rows = new Array<number>(y1 - y0).fill(0);
    const columns = new Array<number>(x1 - x0).fill(0);
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        if (mask[y * boxWidth + x]) {
          rows[y - y0]! += 1;
          columns[x - x0]! += 1;
        }
      }
    }
    const inkColumns = columns.map((count) => count > 0);
    const regionHeight = y1 - y0;
    const wordGap = Math.max(4, Math.min(Math.round(regionHeight * 0.6), maxColumnGap));

    // 1. Wide gutters first: a band of icons, or cards side by side, splits into
    //    whole icons and columns before anything is cut across.
    const gutters = gaps(inkColumns, Math.max(2 * wordGap, Math.round(frameWidth * 0.03)));
    if (gutters.length > 0) {
      for (const [from, to] of spans(gutters, inkColumns.length)) cut(x0 + from, y0, x0 + to, y1, depth + 1);
      return;
    }

    // 2. Rows, only across a region at least twice as wide as tall — lines of
    //    type, a pill holding them — never inside an icon. A row is blank when it
    //    holds little beyond what runs through every row: a pill's arcs, a pin's
    //    sides.
    if (x1 - x0 >= 2 * regionHeight) {
      const baseline = quantile(rows, 0.1);
      const floor = Math.max(2, baseline + 2, 0.1 * quantile(rows, 0.75));
      const lineCuts = gaps(
        rows.map((count) => count > floor),
        1,
      );
      if (lineCuts.length > 0) {
        for (const [from, to] of mergeSlivers(spans(lineCuts, rows.length), lineCuts)) {
          cut(x0, y0 + from, x1, y0 + to, depth + 1);
        }
        return;
      }
    }

    // 3. Ordinary column gaps wider than a word space.
    const columnCuts = gaps(inkColumns, wordGap);
    if (columnCuts.length > 0) {
      for (const [from, to] of spans(columnCuts, inkColumns.length)) cut(x0 + from, y0, x0 + to, y1, depth + 1);
      return;
    }
    pieces.push(box);
  };

  // The tight box around the edges inside a rectangle, or null when it has none.
  function trimmed(x0: number, y0: number, x1: number, y1: number): InkRect | null {
    let left = x1;
    let right = x0;
    let top = y1;
    let bottom = y0;
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        if (!mask[y * boxWidth + x]) continue;
        if (x < left) left = x;
        if (x + 1 > right) right = x + 1;
        if (y < top) top = y;
        if (y + 1 > bottom) bottom = y + 1;
      }
    }
    return right > left ? { x0: left, y0: top, x1: right, y1: bottom } : null;
  }

  cut(0, 0, boxWidth, boxHeight, 0);
  return pieces.filter((piece) => piece.y1 - piece.y0 >= MIN_INK_PX && piece.x1 - piece.x0 >= 1);
}

/**
 * Row spans with slivers folded back into their neighbour: a span under 40% of the
 * height of the span beside it, across a gap of a single row, is an ascender or a
 * descender cut off its line, not a line of its own.
 */
function mergeSlivers(
  pieces: ReadonlyArray<[number, number]>,
  cuts: ReadonlyArray<[number, number]>,
): Array<[number, number]> {
  const out: Array<[number, number]> = pieces.map(([from, to]) => [from, to]);
  for (let index = out.length - 1; index > 0; index -= 1) {
    const above = out[index - 1]!;
    const below = out[index]!;
    const gap = cuts[index - 1] ? cuts[index - 1]![1] - cuts[index - 1]![0] : Infinity;
    const thin = Math.min(above[1] - above[0], below[1] - below[0]) < 0.4 * Math.max(above[1] - above[0], below[1] - below[0]);
    if (gap <= 1 && thin) {
      out.splice(index - 1, 2, [above[0], below[1]]);
    }
  }
  return out;
}

/** Blank runs at least `minimum` long strictly inside a profile, as [start, end) pairs. */
function gaps(ink: readonly boolean[], minimum: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = -1;
  for (let index = 0; index < ink.length; index += 1) {
    if (!ink[index]) {
      if (start < 0) start = index;
    } else if (start >= 0) {
      if (index - start >= minimum && start > 0) out.push([start, index]);
      start = -1;
    }
  }
  return out;
}

/** The inked spans between gaps, as [start, end) pairs over a profile of `length`. */
function spans(cuts: ReadonlyArray<[number, number]>, length: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let from = 0;
  for (const [start, end] of cuts) {
    out.push([from, start]);
    from = end;
  }
  out.push([from, length]);
  return out;
}

function quantile(values: readonly number[], share: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] ?? 0;
}

// ---------------------------------------------------------------------------
// Normalisation — pure
// ---------------------------------------------------------------------------

/**
 * Turns the model's answer into a valid document: cleans each element, merges its
 * boxes, orders, caps and numbers the list, and validates it.
 *
 * Throws when nothing usable is left — an empty document stored as a success
 * would show an admin a template with nothing to edit and no reason why.
 */
export function buildTemplateElementsDoc(input: {
  candidates: readonly ReadElementCandidate[];
  measured: readonly ElementBox[];
  /** Marks of ink inside the measured blocks (`measureInkBoxes`). Omitted, boxes come from blocks and estimates only. */
  inks?: readonly ElementBox[];
  width: number;
  height: number;
  model: string;
  label: string;
}): TemplateElementsDoc {
  const cleaned = splitLabelledDetails(
    input.candidates.map(cleanCandidate).filter((candidate): candidate is ReadElementCandidate => candidate !== null),
  );

  const boxes = mergeElementBoxes(cleaned, input.measured, input.inks ?? []);

  const placed: Array<Omit<TemplateElement, 'id'>> = [];
  cleaned.forEach((candidate, index) => {
    const box = boxes[index];
    if (!box || box.w * box.h < MIN_ELEMENT_AREA) return;
    const element = {
      kind: candidate.kind,
      text: candidate.text,
      box,
      group: candidate.group,
      description: candidate.description,
    };
    const duplicate = placed.find((existing) => isDuplicate(existing, element));
    if (duplicate) {
      // One picture described twice covers both estimates.
      if (duplicate.kind === 'photo') duplicate.box = clampBox(unionBoxes([duplicate.box, element.box]));
      return;
    }
    placed.push(element);
  });

  const elements = orderElements(placed)
    .slice(0, MAX_TEMPLATE_ELEMENTS)
    .map((element, index) => ({ id: `e${index + 1}`, ...element }));

  if (elements.length === 0) {
    throw new Error(`Reading the elements of template "${input.label}" found nothing that can be changed.`);
  }

  const parsed = templateElementsDocSchema.safeParse({
    version: 1,
    width: Math.round(input.width),
    height: Math.round(input.height),
    model: input.model.slice(0, 80),
    elements,
    lastId: elements.length,
  });
  if (!parsed.success) {
    throw new Error(
      `Reading the elements of template "${input.label}" produced a document this build cannot store: ` +
        parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.')} ${issue.message}`)
          .join('; '),
    );
  }
  return parsed.data;
}

/** Contact kinds whose element should hold only the detail, never a label before it. */
const DETAIL_KINDS: ReadonlySet<TemplateElement['kind']> = new Set(['phone', 'website', 'email', 'address', 'social']);

/**
 * "Visit : www.botphonic.ai" read as one website becomes a text "Visit :" and a
 * website "www.botphonic.ai".
 *
 * The prompt asks for the split, and the model mostly makes it — but not every
 * time, and a label left inside a contact detail is replaced along with it by the
 * client's website, or hidden with another business's address. So the split is
 * made here too, whenever a contact element starts with a short label and a
 * colon: a few words, no digits, no "@", and not a URL's own "https:". The
 * estimate is divided at the label's share of the characters; placement on ink
 * refines both.
 */
export function splitLabelledDetails(candidates: readonly ReadElementCandidate[]): ReadElementCandidate[] {
  const out: ReadElementCandidate[] = [];
  for (const candidate of candidates) {
    const match = DETAIL_KINDS.has(candidate.kind) && candidate.text ? /^([^:]{1,24}?:)\s*(\S.*)$/.exec(candidate.text) : null;
    const label = match?.[1]?.trim() ?? '';
    const detail = match?.[2]?.trim() ?? '';
    const isLabel =
      label.length > 1 &&
      /\p{L}/u.test(label) &&
      !/[\d@/.]/.test(label) &&
      label.split(/\s+/).length <= 4 &&
      !detail.startsWith('//');
    if (!match || !isLabel || !detail || !candidate.text) {
      out.push(candidate);
      continue;
    }
    const share = label.length / candidate.text.length;
    const box = candidate.box;
    out.push({
      ...candidate,
      kind: 'text',
      text: label,
      box: box ? { ...box, w: box.w * share } : null,
    });
    out.push({
      ...candidate,
      text: detail,
      box: box ? { ...box, x: box.x + box.w * share, w: box.w * (1 - share) } : null,
    });
  }
  return out;
}

/** Smallest share of the poster an element may cover; below it the box is a slip, not an element. */
const MIN_ELEMENT_AREA = 0.00005;

/**
 * One candidate made storable: text for words only, a description for pictures
 * only, whitespace collapsed, lengths capped. Null when a word element has no
 * words — there is nothing for an admin to edit.
 */
function cleanCandidate(candidate: ReadElementCandidate): ReadElementCandidate | null {
  const isImage = IMAGE_KINDS.has(candidate.kind);
  const text = isImage ? null : squash(candidate.text, MAX_ELEMENT_TEXT);
  // Words need a letter or a digit: "•••" or a lone dash is ornament, not copy.
  if (!isImage && !(text && /[\p{L}\p{N}]/u.test(text))) return null;

  const description = isImage
    ? squash(candidate.description, MAX_ELEMENT_TEXT) ?? (candidate.kind === 'photo' ? 'photograph' : 'logo mark')
    : null;
  const group = squash(candidate.group, 40)?.toLowerCase() ?? null;
  // The sentence under a feature's title is part of the features, not the poster's
  // body copy: as `body` it would be read into the day's supporting text.
  const kind = candidate.kind === 'body' && group === 'features' ? 'text' : candidate.kind;
  const lines = !isImage && typeof candidate.lines === 'number' && candidate.lines >= 1 ? Math.round(candidate.lines) : null;

  return {
    kind,
    text,
    lines,
    // A photograph is never located by type boxes: any the model lists are the
    // detector's false hits on the picture, and their union is a fragment of it.
    blocks: candidate.kind === 'photo' ? [] : candidate.blocks,
    box: candidate.box,
    group,
    description,
  };
}

function squash(value: string | null, max: number): string | null {
  const collapsed = value?.replace(/\s+/g, ' ').trim();
  return collapsed ? collapsed.slice(0, max).trim() : null;
}

/**
 * The same words read twice, or the same picture reported twice.
 *
 * Two photographs are one only when they cover much the same area. Containment is
 * not enough: a small cut-out portrait sits inside the main photograph's box and
 * is still a photograph of its own.
 */
function isDuplicate(a: Omit<TemplateElement, 'id'>, b: Omit<TemplateElement, 'id'>): boolean {
  if (a.kind === 'photo' && b.kind === 'photo') return iou(a.box, b.box) >= 0.5;
  if (a.text === null || b.text === null) return false;
  return a.text.toLowerCase() === b.text.toLowerCase() && overlapRatio(a.box, b.box) > 0.5;
}

// ---------------------------------------------------------------------------
// Boxes — pure
// ---------------------------------------------------------------------------

/**
 * Margin added around the model's estimate when deciding whether a measured box
 * is anywhere near the element at all, and when cutting an oversized union.
 */
const ESTIMATE_MARGIN = 0.02;

/**
 * How much larger than its (padded) estimate a merged box may be before it is cut
 * down to the estimate. Measured boxes are routinely a little larger or smaller
 * than an estimate; three times the area means the box has swallowed something
 * else.
 */
const OVERSIZE_RATIO = 3;

/**
 * Share of an element's estimate a shared box must contain for that box to say
 * anything about the element, when no ink could place it. Below it the detector
 * stopped short of the element and the estimate is the better answer.
 */
const MIN_SHARED_COVER = 0.5;

/** Horizontal slack around an estimate when collecting the ink that belongs to it. */
const INK_X_MARGIN = 0.015;

/**
 * An ink mark this much taller than the typical line of type around it, and not
 * much wider than tall, is an icon — the pictogram above a feature or beside a phone
 * number — and never part of a text element's box.
 */
const ICON_HEIGHT_RATIO = 1.7;
const ICON_MAX_ASPECT = 1.6;
/**
 * Taller than this share of typical, a mark is a graphic whatever its shape: a
 * wide pictogram (an ID card above "Credentialing & Provider Enrollment" measured
 * 2.45 lines tall), a divider, a card's side. Mixed sizes within one element —
 * a script word in a headline — stay well under it.
 */
const ICON_FAR_TALLER = 2.2;

/**
 * Costs for placing a stack of elements on measured rows, in multiples of the
 * stack's typical line height. See `placeStack`.
 */
const COST_NO_ROWS = 10;
const COST_SKIPPED_ROW = 3;
const COST_LINE_MISMATCH = 3;
const COST_ODD_ROW = 2;
/**
 * Weight on the difference between a run's width and the estimate's, in poster
 * fractions like the endpoint distances. Widths are what the model estimates
 * best, and what tells a line of words from the leaf of a plant beside it.
 */
const COST_WIDTH = 0.5;
/** Rows narrower than this multiple of their height are icons, not lines of words. */
const MIN_ROW_ASPECT = 1.2;
/** Rows at least this much wider than tall are unmistakably lines of words. */
const TEXT_ROW_ASPECT = 2.5;
/** How far, in line heights, a placement may sit from its estimate. */
const PLACEMENT_REACH = 3;

type MergeCandidate = Pick<ReadElementCandidate, 'kind' | 'blocks' | 'box'> & {
  lines?: number | null;
  group?: string | null;
};

/**
 * Each candidate's final box, or null when it has none.
 *
 * Positions come from measurement wherever they can, in this order:
 *
 *   1. **Photographs** keep their estimate: nothing measures a photo's extent.
 *   2. **Logos** take the blocks they name, added to their estimate — the logo box
 *      is where the client's logo goes, and the detector sees only lettering.
 *   3. **Words in blocks of their own.** An element that is the only one naming
 *      its blocks takes the ink inside them that lies in its estimate's columns,
 *      less any icon: the block around a feature often holds the feature's
 *      pictogram too.
 *   4. **Everything else** — words in a block shared with other elements, in a
 *      block that swallowed a neighbour, or in no block at all — is placed on the
 *      rows of ink near its estimate by `placeStack`, which lines up a stack of
 *      elements with a stack of rows together. That is what corrects the usual
 *      error: estimates a line or so off, the same way, down a whole contact bar.
 *   5. Words with no ink to place them fall back to the old rules: the estimate
 *      clipped to a shared block that holds most of it, else the estimate.
 *
 * A named block that does not touch the (padded) estimate is a misnumbering and is
 * ignored. Block numbers are the 1-based numbers the model was shown. Everything
 * is clamped to the poster.
 */
export function mergeElementBoxes(
  candidates: ReadonlyArray<MergeCandidate>,
  measured: readonly ElementBox[],
  inks: readonly ElementBox[] = [],
): Array<ElementBox | null> {
  const estimates = candidates.map((candidate) => {
    const estimate = candidate.box ? clampBox(candidate.box) : null;
    return estimate && estimate.w > 0 && estimate.h > 0 ? estimate : null;
  });

  const named = candidates.map((candidate, position) => {
    const around = estimates[position] ? padBox(estimates[position]!, ESTIMATE_MARGIN) : null;
    return [
      ...new Set(
        candidate.blocks
          .map((number) => Math.round(number) - 1)
          .filter((index) => index >= 0 && index < measured.length)
          .filter((index) => !around || intersectBoxes(measured[index]!, around) !== null),
      ),
    ];
  });
  const claims = new Map<number, number>();
  for (const list of named) {
    for (const index of list) claims.set(index, (claims.get(index) ?? 0) + 1);
  }

  const result: Array<ElementBox | null> = candidates.map(() => null);
  const reserved = new Set<number>();
  const floating: number[] = [];

  candidates.forEach((candidate, position) => {
    const estimate = estimates[position] ?? null;
    const blocks = (named[position] ?? []).map((index) => measured[index]!);

    if (candidate.kind === 'photo') {
      result[position] = estimate;
      return;
    }

    if (candidate.kind === 'logo') {
      const parts = (named[position] ?? []).map((index) =>
        (claims.get(index) ?? 0) > 1 && estimate ? intersectBoxes(measured[index]!, estimate) : measured[index]!,
      );
      const box = [...parts.filter((part): part is ElementBox => part !== null), ...(estimate ? [estimate] : [])];
      result[position] = box.length > 0 ? clampBox(unionBoxes(box)) : null;
      return;
    }

    const own = (named[position] ?? []).every((index) => (claims.get(index) ?? 0) === 1);
    if (blocks.length > 0 && own) {
      const region = unionBoxes(blocks);
      const oversized = estimate !== null && boxArea(region) > OVERSIZE_RATIO * boxArea(padBox(estimate, ESTIMATE_MARGIN));
      if (!oversized) {
        const inside = inks
          .map((ink, index) => ({ ink, index }))
          .filter(({ ink }) => {
            const overlap = intersectBoxes(ink, padBox(region, 0.002));
            return overlap !== null && boxArea(overlap) >= 0.6 * boxArea(ink);
          });
        // The estimate's columns are the one reliable cue for an icon beside the
        // words: the model is told to leave icons out of its box, and it places
        // columns far better than lines. Icons broken into wide pieces by the ink
        // cut no longer look like icons, but they still lie outside those columns.
        const inColumns = inside
          .map(({ ink }) => ink)
          .filter((ink) => {
            if (!estimate) return true;
            const overlap = Math.min(ink.x + ink.w, estimate.x + estimate.w) - Math.max(ink.x, estimate.x);
            return overlap >= 0.5 * ink.w;
          });
        const words = textMarks(inColumns, estimate ? estimate.h / Math.max(1, candidate.lines ?? 1) : null, {
          squareGraphicsOnly: true,
        });
        for (const { index } of inside) reserved.add(index);
        result[position] = clampBox(words.length > 0 ? unionBoxes(words) : region);
        return;
      }
    }

    floating.push(position);
  });

  // Words not anchored to blocks of their own: place stacks of them on ink rows.
  const available = inks.filter((_, index) => !reserved.has(index));
  const placeable = floating.filter((position) => estimates[position]);
  const snapped = snapRowColumns(
    placeable.map((position) => ({
      position,
      box: estimates[position]!,
      group: candidates[position]?.group ?? null,
    })),
    available,
  );
  const placing = (position: number) => snapped.get(position) ?? estimates[position]!;
  for (const stack of stacks(placeable.map((position) => ({ position, box: placing(position) })))) {
    const placed = placeStack(
      stack.map((position) => ({ box: placing(position), lines: candidates[position]?.lines ?? null })),
      available,
    );
    stack.forEach((position, index) => {
      if (placed[index]) result[position] = clampBox(placed[index]!);
    });
  }

  // Fallbacks for words no ink could place.
  for (const position of floating) {
    if (result[position]) continue;
    const estimate = estimates[position] ?? null;
    const shared = (named[position] ?? [])
      .filter((index) => (claims.get(index) ?? 0) > 1)
      .map((index) => (estimate ? intersectBoxes(measured[index]!, estimate) : null))
      .filter((part): part is ElementBox => part !== null && estimate !== null && boxArea(part) >= MIN_SHARED_COVER * boxArea(estimate));
    if (shared.length > 0) {
      result[position] = clampBox(unionBoxes(shared));
      continue;
    }
    const blocks = (named[position] ?? []).map((index) => measured[index]!);
    if (blocks.length > 0 && !estimate) {
      result[position] = clampBox(unionBoxes(blocks));
      continue;
    }
    if (blocks.length > 0 && estimate && (named[position] ?? []).every((index) => (claims.get(index) ?? 0) === 1)) {
      // An oversized block of its own: cut to the padded estimate.
      result[position] = clampBox(intersectBoxes(unionBoxes(blocks), padBox(estimate, ESTIMATE_MARGIN)) ?? estimate);
      continue;
    }
    result[position] = estimate;
  }

  alignLabelsWithDetails(candidates, estimates, result);
  return result;
}

/**
 * A label set on the same line as its contact detail — "Call us on" before a
 * phone number, "Visit us at:" before an address — takes the detail's top edge.
 *
 * The model splits such a line in two, as it is told to, but estimates the short
 * label as vertically centred in its pill; placed on its own, the label then lands
 * on the detail's second line, or below the pill. The detail, being longer, is
 * placed reliably, and the two were one printed line. A label here is a text or
 * call to action immediately left of a contact detail (within 5% of the poster),
 * with estimates overlapping vertically by half the shorter.
 */
function alignLabelsWithDetails(
  candidates: ReadonlyArray<MergeCandidate>,
  estimates: ReadonlyArray<ElementBox | null>,
  result: Array<ElementBox | null>,
): void {
  candidates.forEach((candidate, position) => {
    const labelBox = result[position];
    const labelEstimate = estimates[position];
    if (!labelBox || !labelEstimate || (candidate.kind !== 'text' && candidate.kind !== 'cta')) return;

    let detail: number | null = null;
    let nearest = Infinity;
    candidates.forEach((other, index) => {
      const otherEstimate = estimates[index];
      if (!otherEstimate || !result[index] || !DETAIL_KINDS.has(other.kind)) return;
      const gap = otherEstimate.x - (labelEstimate.x + labelEstimate.w);
      const overlapY =
        Math.min(labelEstimate.y + labelEstimate.h, otherEstimate.y + otherEstimate.h) - Math.max(labelEstimate.y, otherEstimate.y);
      if (gap < -0.02 || gap > 0.05 || overlapY < 0.5 * Math.min(labelEstimate.h, otherEstimate.h)) return;
      if (gap < nearest) {
        nearest = gap;
        detail = index;
      }
    });
    if (detail === null) return;

    const detailBox = result[detail]!;
    result[position] = clampBox({ ...labelBox, y: detailBox.y, h: Math.min(labelBox.h, detailBox.h) });
  });
}

/**
 * The ink marks that are type, from marks that may include icons and shapes.
 *
 * "Typical" is the height of type here: the median mark height weighted by width,
 * so a few wide lines of words outweigh the many specks an icon breaks into. Given
 * the element's estimated `lineHeight`, marks far below it are left out of that
 * median, and specks are judged against the smaller of the two. Against it:
 *
 *   - a **graphic** is a mark well above typical height that is either not much
 *     wider than tall (a pictogram) or far taller than any line (the side of a
 *     card, a divider);
 *   - the **fragments** of a graphic — the sparkles over a vegetable icon — are
 *     the smaller marks lying mostly inside its box, padded a little;
 *   - a **speck** is a mark well below typical height — or below the element's
 *     own line height, when that is smaller — and not wide either.
 *
 * All three go. What is left are lines of type.
 *
 * `squareGraphicsOnly` keeps wide marks however tall: inside a block that belongs
 * to one element, large display type breaks into wide chunks of uneven height,
 * and the only thing to remove there is a pictogram beside or above the words.
 */
export function textMarks(
  marks: readonly ElementBox[],
  lineHeight: number | null = null,
  options: { squareGraphicsOnly?: boolean } = {},
): ElementBox[] {
  if (marks.length < 2) return [...marks];
  const hint = lineHeight !== null && lineHeight > 0 ? lineHeight : null;
  // A known line height keeps wide, flat photo texture out of the measurement —
  // it would otherwise drag typical down until a real line looked like a graphic.
  // It only filters: estimates run loose, and typical itself stays measured.
  const sample = hint !== null ? marks.filter((mark) => mark.h >= 0.3 * hint) : marks;
  const typical = weightedMedian((sample.length > 0 ? sample : marks).map((mark) => ({ value: mark.h, weight: mark.w })));
  if (typical <= 0) return [...marks];

  const graphics = marks.filter(
    (mark) =>
      mark.h > ICON_HEIGHT_RATIO * typical &&
      (mark.w / mark.h < ICON_MAX_ASPECT || (!options.squareGraphicsOnly && mark.h > ICON_FAR_TALLER * typical)),
  );
  const fragment = (mark: ElementBox) =>
    graphics.some((graphic) => {
      // Shorter, and no wider: a line of words beside a pill-sized graphic lies
      // inside its padded box too, but runs wider than it and is not a piece of it.
      if (graphic === mark || mark.h >= 0.5 * graphic.h || mark.w > graphic.w) return false;
      const padded = padBox(graphic, 0.15 * Math.max(graphic.w, graphic.h));
      const overlap = intersectBoxes(mark, padded);
      return overlap !== null && boxArea(overlap) >= 0.6 * boxArea(mark);
    });
  // Measured against the smaller of typical and the element's own line height, so
  // small letter-spaced type under a large wordmark is not taken for specks.
  const small = hint !== null ? Math.min(typical, hint) : typical;
  const speck = (mark: ElementBox) => mark.h < 0.45 * small && mark.w < 2 * small;

  return marks.filter((mark) => !graphics.includes(mark) && !fragment(mark) && !speck(mark));
}

/**
 * Estimates with their columns snapped to measured ink, for rows of repeated items.
 *
 * The model's columns are good for one element and drift across a row: measured
 * on a strip of five features, the first estimate sat 0.05 of the poster left of
 * its words and the last 0.09 right, so the middle ones reached into their
 * neighbours. What the pixels do know is how many columns of type the row has.
 * So a row — elements of one group, side by side, their estimates overlapping
 * vertically — has the type marks in its band clustered into columns, and when
 * there are exactly as many columns as elements, each element (left to right)
 * takes its column's extent in place of its own estimate's. Rows are still found
 * by `placeStack`. When the counts differ nothing is snapped: a guess is worse
 * than the estimate.
 */
function snapRowColumns(
  items: ReadonlyArray<{ position: number; box: ElementBox; group: string | null }>,
  inks: readonly ElementBox[],
): Map<number, ElementBox> {
  const snapped = new Map<number, ElementBox>();
  const byGroup = new Map<string, Array<{ position: number; box: ElementBox }>>();
  for (const item of items) {
    // Not contact strips: their icons sit tight against the words and join them
    // into one column, and their estimates have not shown the drift.
    if (item.group === null || item.group === 'contact') continue;
    byGroup.set(item.group, [...(byGroup.get(item.group) ?? []), item]);
  }

  for (const members of byGroup.values()) {
    // Rows within the group: estimates overlapping vertically by half the shorter.
    const rows: Array<Array<{ position: number; box: ElementBox }>> = [];
    for (const member of [...members].sort((a, b) => a.box.x - b.box.x)) {
      const row = rows.find((candidate) =>
        candidate.every((other) => {
          const overlapY = Math.min(other.box.y + other.box.h, member.box.y + member.box.h) - Math.max(other.box.y, member.box.y);
          const overlapX = Math.min(other.box.x + other.box.w, member.box.x + member.box.w) - Math.max(other.box.x, member.box.x);
          return overlapY >= 0.5 * Math.min(other.box.h, member.box.h) && overlapX < 0.3 * Math.min(other.box.w, member.box.w);
        }),
      );
      if (row) row.push(member);
      else rows.push([member]);
    }

    for (const row of rows) {
      if (row.length < 2) continue;
      const top = Math.min(...row.map((member) => member.box.y));
      const bottom = Math.max(...row.map((member) => member.box.y + member.box.h));
      const left = Math.min(...row.map((member) => member.box.x)) - 0.05;
      const right = Math.max(...row.map((member) => member.box.x + member.box.w)) + 0.05;
      const lineHeight = median(row.map((member) => member.box.h));
      const band = textMarks(
        inks.filter((ink) => {
          const middle = centreY(ink);
          return middle >= top && middle <= bottom && ink.x >= left && ink.x + ink.w <= right && ink.h <= 2 * lineHeight;
        }),
        lineHeight,
      );

      const columns: ElementBox[] = [];
      for (const mark of [...band].sort((a, b) => a.x - b.x)) {
        const column = columns.findIndex(
          (candidate) => Math.min(candidate.x + candidate.w, mark.x + mark.w) - Math.max(candidate.x, mark.x) >= 0.3 * Math.min(candidate.w, mark.w),
        );
        if (column >= 0) columns[column] = unionBoxes([columns[column]!, mark]);
        else columns.push(mark);
      }
      if (columns.length !== row.length) continue;

      columns.sort((a, b) => a.x - b.x);
      row.forEach((member, index) => {
        const column = columns[index]!;
        snapped.set(member.position, { ...member.box, x: column.x, w: column.w });
      });
    }
  }
  return snapped;
}

/**
 * Elements that stack in one column: they overlap horizontally by at least half
 * the wider one, barely overlap vertically, and sit within a line of each other.
 * Chains are followed, so a whole contact bar is one stack.
 *
 * Half of the *wider*: a headline above a row of cards overlaps each card, and
 * judged against the narrower card it would chain the cards — side by side — into
 * one column.
 */
function stacks(items: ReadonlyArray<{ position: number; box: ElementBox }>): number[][] {
  const parent = items.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    return root;
  };
  for (let a = 0; a < items.length; a += 1) {
    for (let b = a + 1; b < items.length; b += 1) {
      const boxA = items[a]!.box;
      const boxB = items[b]!.box;
      const overlapX = Math.min(boxA.x + boxA.w, boxB.x + boxB.w) - Math.max(boxA.x, boxB.x);
      const gapY = Math.max(boxA.y, boxB.y) - Math.min(boxA.y + boxA.h, boxB.y + boxB.h);
      const overlapY = -gapY;
      if (
        overlapX >= 0.5 * Math.max(boxA.w, boxB.w) &&
        overlapY <= 0.3 * Math.min(boxA.h, boxB.h) &&
        gapY <= Math.max(boxA.h, boxB.h)
      ) {
        parent[find(a)] = find(b);
      }
    }
  }
  const groups = new Map<number, number[]>();
  items.forEach((item, index) => {
    const root = find(index);
    groups.set(root, [...(groups.get(root) ?? []), item.position]);
  });
  return [...groups.values()];
}

interface InkRow {
  box: ElementBox;
  marks: ElementBox[];
}

/**
 * Places a stack of elements on the rows of ink beside their estimates.
 *
 * Returns each element's box (index-aligned), or null where no rows fit.
 *
 * The rows are the ink marks within the stack's columns, less icons, grouped into
 * lines. Elements are then matched to consecutive runs of rows in order — the
 * first element above the second, and so on — at the lowest total cost:
 *
 *   - the distance between a run's top and bottom and the estimate's;
 *   - the difference between the run's rows and the lines the model counted;
 *   - every row of words inside the span of a stack of several elements that
 *     none takes;
 *   - the difference between the run's width and the estimate's;
 *   - every row in the run far off the element's own expected line height;
 *   - a fixed cost for an element given no rows at all.
 *
 * Together these prefer the reading in which every line of a bar belongs to
 * someone, which is what fixes a whole stack of estimates sitting a line low — no
 * single element could tell that from its own estimate. Each element keeps only
 * the part of its rows within its own columns.
 */
export function placeStack(
  members: ReadonlyArray<{ box: ElementBox; lines: number | null }>,
  inks: readonly ElementBox[],
): Array<ElementBox | null> {
  if (members.length === 0 || inks.length === 0) return members.map(() => null);

  const order = members.map((_, index) => index).sort((a, b) => centreY(members[a]!.box) - centreY(members[b]!.box));
  const x0 = Math.min(...members.map((member) => member.box.x)) - INK_X_MARGIN;
  const x1 = Math.max(...members.map((member) => member.box.x + member.box.w)) + INK_X_MARGIN;
  const typicalEstimate = median(members.map((member) => member.box.h / Math.max(1, member.lines ?? 1)));
  const top = Math.min(...members.map((member) => member.box.y));
  const bottom = Math.max(...members.map((member) => member.box.y + member.box.h));
  const reachY = PLACEMENT_REACH * Math.max(typicalEstimate, 0.01);

  // A mark belongs to the stack's columns when it lies mostly inside them, or is a
  // line a few times wider — "Call us on +220 …" for the "Call us on" element —
  // and no taller than a few of the stack's own lines. Anything taller is
  // something else passing through: cards joined by a photograph.
  const stackWidth = x1 - x0;
  const tallest = 3 * Math.max(typicalEstimate, 0.01);
  const pool = textMarks(
    inks.filter((ink) => {
      const inside = Math.min(ink.x + ink.w, x1) - Math.max(ink.x, x0);
      const middle = centreY(ink);
      const columns = inside >= 0.5 * ink.w || (ink.w <= 3 * stackWidth && inside >= 0.5 * stackWidth);
      return columns && ink.h <= tallest && middle >= top - reachY && middle <= bottom + reachY;
    }),
    typicalEstimate,
  );
  if (pool.length === 0) return members.map(() => null);

  // A line of words is wider than tall. A square row is an icon beside the words
  // — a water drop beside "Drink" — that happened to fall under the graphic test.
  // And a line of an element spans a fair part of it: a lone speck far narrower
  // than any of the stack's elements, above a card's words, is not one of its lines.
  const narrowest = 0.2 * median(members.map((member) => member.box.w));
  const rows = inkRows(pool).filter((row) => row.box.w >= MIN_ROW_ASPECT * row.box.h && row.box.w >= narrowest);
  if (rows.length === 0) return members.map(() => null);
  const lineHeight = median(rows.map((row) => row.box.h)) || 0.02;
  // Three lines beyond the estimates: a stack sitting a line or two low leaves its
  // first line above them, and that line still counts — but not the row of cards
  // under a headline.
  const hullTop = top - 3 * lineHeight;
  const hullBottom = bottom + 3 * lineHeight;
  // Unclaimed rows cost only in a stack of several elements, where they are what
  // exposes a shared offset. A lone element leaving an icon's fragments unused is
  // not a fault.
  // Only rows that look like lines of words count: fragments of a plant or an icon
  // left unclaimed are not a missing line.
  const counts = rows.map(
    (row) =>
      members.length > 1 &&
      row.box.w >= TEXT_ROW_ASPECT * row.box.h &&
      centreY(row.box) >= hullTop &&
      centreY(row.box) <= hullBottom,
  );
  // Rows far off an element's own expected line height — a wordmark above a small
  // tagline, a speck above a card's words — or much taller than the pool's rows —
  // a piece of the pictogram above a card's words — may still be taken, but each
  // costs. Only taller than the pool: a small tagline under a large wordmark is
  // shorter than the pool's typical row and still a line.
  const oddCost = (member: { box: ElementBox; lines: number | null }, from: number, to: number) => {
    const expected = member.box.h / Math.max(1, member.lines ?? 1);
    let cost = 0;
    for (let index = from; index <= to; index += 1) {
      const height = rows[index]!.box.h;
      if (height > 2.2 * expected || height < 0.3 * expected || height > 1.6 * lineHeight) {
        cost += COST_ODD_ROW * lineHeight;
      }
    }
    return cost;
  };
  const skipCost = (from: number, to: number) => {
    let cost = 0;
    for (let index = from; index < to; index += 1) if (counts[index]) cost += COST_SKIPPED_ROW * lineHeight;
    return cost;
  };

  // dp[i][j]: cheapest placement of the first i members (in stack order) using
  // rows before j; choice[i][j] records how member i-1 got there.
  const k = order.length;
  const n = rows.length;
  const dp: number[][] = Array.from({ length: k + 1 }, () => new Array<number>(n + 1).fill(Infinity));
  const choice: Array<Array<{ from: number; run: [number, number] | null } | null>> = Array.from({ length: k + 1 }, () =>
    new Array(n + 1).fill(null),
  );
  dp[0]![0] = 0;

  for (let i = 0; i < k; i += 1) {
    const member = members[order[i]!]!;
    const estimate = member.box;
    for (let j = 0; j <= n; j += 1) {
      const base = dp[i]![j]!;
      if (!Number.isFinite(base)) continue;

      // Estimates are often several lines out, so giving up must cost more than a
      // far placement within reach: every line of the element's own height, too.
      const none = base + COST_NO_ROWS * lineHeight + estimate.h;
      if (none < dp[i + 1]![j]!) {
        dp[i + 1]![j] = none;
        choice[i + 1]![j] = { from: j, run: null };
      }

      for (let a = j; a < n; a += 1) {
        if (rows[a]!.box.y < estimate.y - reachY) continue;
        if (rows[a]!.box.y > estimate.y + estimate.h + reachY) break;
        for (let b = a; b < n; b += 1) {
          const last = rows[b]!.box;
          if (last.y + last.h > estimate.y + estimate.h + reachY) break;
          const lineCost =
            member.lines !== null ? COST_LINE_MISMATCH * lineHeight * Math.abs(b - a + 1 - member.lines) : 0;
          const cost =
            base +
            skipCost(j, a) +
            Math.abs(rows[a]!.box.y - estimate.y) +
            Math.abs(last.y + last.h - (estimate.y + estimate.h)) +
            lineCost +
            oddCost(member, a, b) +
            COST_WIDTH * Math.abs(runWidth(rows, a, b, estimate) - estimate.w);
          if (cost < dp[i + 1]![b + 1]!) {
            dp[i + 1]![b + 1] = cost;
            choice[i + 1]![b + 1] = { from: j, run: [a, b] };
          }
        }
      }
    }
  }

  let best = -1;
  let bestCost = Infinity;
  for (let j = 0; j <= n; j += 1) {
    const total = dp[k]![j]! + skipCost(j, n);
    if (total < bestCost) {
      bestCost = total;
      best = j;
    }
  }

  const out: Array<ElementBox | null> = members.map(() => null);
  let j = best;
  for (let i = k; i > 0 && j >= 0; i -= 1) {
    const step = choice[i]![j];
    if (!step) break;
    if (step.run) {
      const member = members[order[i - 1]!]!;
      const left = member.box.x - INK_X_MARGIN;
      const right = member.box.x + member.box.w + INK_X_MARGIN;
      // A mark almost wholly (85%) inside the element's columns is taken whole —
      // estimates run a little narrow. Anything less is a shared line ("Call us on
      // +220 …") or text joined to an icon beside it, and only the part in the
      // element's columns is taken.
      const marks = rows
        .slice(step.run[0], step.run[1] + 1)
        .flatMap((row) => row.marks)
        .map((mark) => {
          const part = intersectBoxes(mark, { x: left, y: mark.y, w: right - left, h: mark.h });
          return part && part.w >= 0.85 * mark.w ? mark : part;
        })
        .filter((mark): mark is ElementBox => mark !== null);
      out[order[i - 1]!] = marks.length > 0 ? unionBoxes(marks) : null;
    }
    j = step.from;
  }
  return out;
}

/** Width of the marks in rows `a..b` that fall within an estimate's columns, clipped to them. */
function runWidth(rows: readonly InkRow[], a: number, b: number, estimate: ElementBox): number {
  const left = estimate.x - INK_X_MARGIN;
  const right = estimate.x + estimate.w + INK_X_MARGIN;
  let x0 = Infinity;
  let x1 = -Infinity;
  for (let index = a; index <= b; index += 1) {
    for (const mark of rows[index]!.marks) {
      const from = Math.max(mark.x, left);
      const to = Math.min(mark.x + mark.w, right);
      if (to <= from) continue;
      x0 = Math.min(x0, from);
      x1 = Math.max(x1, to);
    }
  }
  return x1 > x0 ? x1 - x0 : 0;
}

/**
 * Ink marks grouped into rows: a mark joins a row when its centre is within half a
 * line of the row's centre, measured against the smaller of the mark and the
 * row's typical mark.
 *
 * Centres rather than the row's growing box: a tall piece of a logo symbol beside
 * a two-line name overlaps both lines, and a row that grew to include it would
 * then swallow the second line too — measured on a lockup whose name then
 * claimed the headline's first line to make up its count.
 */
function inkRows(marks: readonly ElementBox[]): InkRow[] {
  const rows: Array<InkRow & { centres: number[]; heights: number[] }> = [];
  for (const mark of [...marks].sort((a, b) => a.y - b.y)) {
    const row = rows.find((candidate) => {
      const reach = 0.5 * Math.min(mark.h, median(candidate.heights));
      return Math.abs(centreY(mark) - median(candidate.centres)) <= reach;
    });
    if (row) {
      row.marks.push(mark);
      row.centres.push(centreY(mark));
      row.heights.push(mark.h);
      row.box = unionBoxes([row.box, mark]);
    } else {
      rows.push({ box: mark, marks: [mark], centres: [centreY(mark)], heights: [mark.h] });
    }
  }
  return rows.map(({ box, marks: rowMarks }) => ({ box, marks: rowMarks })).sort((a, b) => a.box.y - b.box.y);
}

/** A box forced inside the poster: corners clamped to 0-1, non-finite values to 0. */
export function clampBox(box: { x: number; y: number; w: number; h: number }): ElementBox {
  const finite = (value: number) => (Number.isFinite(value) ? value : 0);
  const x = Math.min(Math.max(finite(box.x), 0), 1);
  const y = Math.min(Math.max(finite(box.y), 0), 1);
  const right = Math.min(Math.max(finite(box.x) + Math.max(finite(box.w), 0), 0), 1);
  const bottom = Math.min(Math.max(finite(box.y) + Math.max(finite(box.h), 0), 0), 1);
  return { x, y, w: round4(Math.max(right - x, 0)), h: round4(Math.max(bottom - y, 0)) };
}

export function unionBoxes(boxes: readonly ElementBox[]): ElementBox {
  const x0 = Math.min(...boxes.map((box) => box.x));
  const y0 = Math.min(...boxes.map((box) => box.y));
  const x1 = Math.max(...boxes.map((box) => box.x + box.w));
  const y1 = Math.max(...boxes.map((box) => box.y + box.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The overlap of two boxes, or null when they do not overlap. */
export function intersectBoxes(a: ElementBox, b: ElementBox): ElementBox | null {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

function padBox(box: ElementBox, margin: number): ElementBox {
  return clampBox({ x: box.x - margin, y: box.y - margin, w: box.w + margin * 2, h: box.h + margin * 2 });
}

function boxArea(box: ElementBox): number {
  return box.w * box.h;
}

function centreY(box: ElementBox): number {
  return box.y + box.h / 2;
}

/** Overlap as a share of the smaller box. */
function overlapRatio(a: ElementBox, b: ElementBox): number {
  const overlap = intersectBoxes(a, b);
  const smaller = Math.min(boxArea(a), boxArea(b));
  return overlap && smaller > 0 ? boxArea(overlap) / smaller : 0;
}

function iou(a: ElementBox, b: ElementBox): number {
  const overlap = intersectBoxes(a, b);
  if (!overlap) return 0;
  const shared = boxArea(overlap);
  return shared / (boxArea(a) + boxArea(b) - shared);
}

function weightedMedian(entries: ReadonlyArray<{ value: number; weight: number }>): number {
  const sorted = entries.filter((entry) => entry.weight > 0).sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, entry) => sum + entry.weight, 0);
  let running = 0;
  for (const entry of sorted) {
    running += entry.weight;
    if (running >= total / 2) return entry.value;
  }
  return 0;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

// ---------------------------------------------------------------------------
// Reading order — pure
// ---------------------------------------------------------------------------

/**
 * Share of the poster's height above which an element never shares a line: a
 * photograph behind half the poster is not "beside" anything.
 */
const TALL_ELEMENT = 0.4;

/** Two elements share a line only when the shorter is at least this share of the taller. */
const MIN_LINE_HEIGHT_RATIO = 0.4;

/**
 * Elements in reading order: lines top to bottom, left to right within a line,
 * and the members of a group kept together where the group's first member falls.
 *
 * Two elements share a line when their vertical centres are closer than half the
 * shorter one's height and their heights are comparable. Photographs and anything
 * taller than `TALL_ELEMENT` stand on a line of their own, placed by their top
 * edge: a background photograph whose centre happened to sit beside a feature
 * used to pull that feature — and with it the whole features group — to the top
 * of the list, ahead of the logo. Deterministic, so a re-read of an unchanged
 * template numbers its elements the same way.
 */
export function orderElements<T extends { box: ElementBox; group: string | null; kind?: string }>(
  elements: readonly T[],
): T[] {
  const byTop = [...elements].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const alone = (element: T) => element.kind === 'photo' || element.box.h > TALL_ELEMENT;

  const lines: Array<{ leader: T; members: T[]; closed: boolean }> = [];
  for (const element of byTop) {
    const line = alone(element)
      ? undefined
      : lines.find(({ leader, closed }) => !closed && sameLine(leader.box, element.box));
    if (line) line.members.push(element);
    else lines.push({ leader: element, members: [element], closed: alone(element) });
  }

  const flat = lines.flatMap(({ members }) => [...members].sort((a, b) => a.box.x - b.box.x || a.box.y - b.box.y));

  const ordered: T[] = [];
  const placedGroups = new Set<string>();
  for (const element of flat) {
    if (element.group === null) {
      ordered.push(element);
      continue;
    }
    if (placedGroups.has(element.group)) continue;
    placedGroups.add(element.group);
    ordered.push(...flat.filter((candidate) => candidate.group === element.group));
  }
  return ordered;
}

function sameLine(a: ElementBox, b: ElementBox): boolean {
  const shorter = Math.min(a.h, b.h);
  const taller = Math.max(a.h, b.h);
  if (taller > 0 && shorter / taller < MIN_LINE_HEIGHT_RATIO) return false;
  return Math.abs(centreY(a) - centreY(b)) < Math.max(shorter, 0.005) / 2;
}

// ---------------------------------------------------------------------------
// Stable ids across re-reads — pure
// ---------------------------------------------------------------------------

/** Lowest score at which a re-read element is taken to be a previous one. */
const MIN_ID_MATCH = 0.3;

/**
 * A re-read document with the ids of the reading it replaces, wherever an
 * element is recognisably the same one.
 *
 * Campaign days store their words per element id, so a re-read that renumbered
 * the elements would silently move a day's headline onto its sub-headline. Each
 * new element is matched to at most one previous element **of the same kind**, by
 * the best score — mostly how alike the words are, partly how much the boxes
 * overlap; for a photo or logo mostly the overlap — greedily from the best pair
 * down. A matched element keeps the previous id. The new reading order is kept.
 *
 * An element with no match (a new one, or one whose kind changed) gets a fresh
 * id after the template's **high-water mark** (`lastId`: the highest id any
 * earlier reading ever used, not just the previous one), and the result records
 * the new mark. So an id retired by one re-read is never handed to a different
 * element by the next: a campaign day still holding it keeps pointing at nothing
 * rather than at the wrong words.
 */
export function stabilizeElementIds(previous: TemplateElementsDoc | null, next: TemplateElementsDoc): TemplateElementsDoc {
  if (!previous) {
    const lastId = elementIdHighWater(next);
    return next.lastId === lastId ? next : { ...next, lastId };
  }

  const pairs: Array<{ next: number; previous: number; score: number }> = [];
  next.elements.forEach((element, nextIndex) => {
    previous.elements.forEach((candidate, previousIndex) => {
      if (candidate.kind !== element.kind) return;
      const score = elementMatchScore(candidate, element);
      if (score >= MIN_ID_MATCH) pairs.push({ next: nextIndex, previous: previousIndex, score });
    });
  });
  pairs.sort(
    (a, b) => b.score - a.score || Math.abs(a.next - a.previous) - Math.abs(b.next - b.previous) || a.next - b.next,
  );

  const ids = new Map<number, string>();
  const taken = new Set<number>();
  for (const pair of pairs) {
    if (ids.has(pair.next) || taken.has(pair.previous)) continue;
    ids.set(pair.next, previous.elements[pair.previous]!.id);
    taken.add(pair.previous);
  }

  const highWater = elementIdHighWater(previous);
  const used = new Set(previous.elements.map((element) => elementIdNumber(element.id)));
  for (const id of ids.values()) used.add(elementIdNumber(id));
  let counter = highWater;
  let wrapped = false;
  const fresh = (): string => {
    counter += 1;
    if (counter > 999 && !wrapped) {
      // The id pattern allows three digits; past that, reuse the lowest numbers no
      // element of either reading holds.
      wrapped = true;
      counter = 1;
    }
    if (wrapped) while (used.has(counter)) counter += 1;
    used.add(counter);
    return `e${counter}`;
  };

  const elements = next.elements.map((element, index) => ({ ...element, id: ids.get(index) ?? fresh() }));
  return {
    ...next,
    elements,
    lastId: Math.min(999, Math.max(highWater, ...elements.map((element) => elementIdNumber(element.id)))),
  };
}

/** 0-1: how likely two same-kind elements from two readings are the same element. */
function elementMatchScore(a: TemplateElement, b: TemplateElement): number {
  const overlap = iou(a.box, b.box);
  if (IMAGE_KINDS.has(a.kind)) return 0.75 * overlap + 0.25 * textSimilarity(a.description, b.description);
  return 0.65 * textSimilarity(a.text, b.text) + 0.35 * overlap;
}

/** Dice coefficient over character bigrams of the case-, space- and punctuation-folded text. */
function textSimilarity(a: string | null, b: string | null): number {
  const fold = (value: string | null) =>
    (value ?? '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  const left = fold(a);
  const right = fold(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const bigrams = (value: string) => {
    const counts = new Map<string, number>();
    for (let index = 0; index + 1 < value.length; index += 1) {
      const gram = value.slice(index, index + 2);
      counts.set(gram, (counts.get(gram) ?? 0) + 1);
    }
    return counts;
  };
  const leftGrams = bigrams(left);
  const rightGrams = bigrams(right);
  let shared = 0;
  for (const [gram, count] of leftGrams) shared += Math.min(count, rightGrams.get(gram) ?? 0);
  const total = Math.max(1, left.length - 1) + Math.max(1, right.length - 1);
  return (2 * shared) / total;
}
