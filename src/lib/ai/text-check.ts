import sharp from 'sharp';

import { generateStructured, supportsTemperature } from '@/lib/ai/openai';
import { describeBoxPosition } from '@/lib/ai/studio-prompts';
import { optionalEnv } from '@/lib/env';
import {
  carriesTemplateContactDetail,
  CONTENT_KINDS,
  IMAGE_KINDS,
  textCheckResultSchema,
  type ResolvedElement,
  type TemplateElementsDoc,
  type TextCheckResult,
} from '@/lib/types/template-elements';
import type { UsageContext } from '@/lib/usage';

/**
 * Reads a cloned poster's words back and compares them with what was asked for.
 *
 * An image model spells most text right and some text wrong, and a phone number
 * with one wrong digit looks exactly as finished as a correct one. This is the
 * check that tells an admin which is which before a poster is approved.
 *
 * **The model reads; code judges.** The model is never shown the expected words —
 * given them, a vision model tends to find them. It is shown each place by label
 * and position and asked what is printed there, and separately asked for every
 * block of text on the poster. Whether that matches is decided here, by a plain
 * comparison that ignores case and whitespace and nothing else, so "match" means
 * the same thing on every poster.
 *
 * Leftovers — template words that should have changed or gone but are still on
 * the poster — come from the same full read, so a headline the model kept in a
 * second place is caught even when the place asked about is correct. Template
 * words kept on purpose that still hold the template business's web address,
 * email or phone number are listed as leftovers too.
 */

/**
 * Model for the read-back, from `OPENAI_TEXT_CHECK_MODEL`. Defaults to the model
 * the element reader uses, which grounds places on a poster where gpt-4o does not
 * (see `template-elements.ts`).
 */
function textCheckModel(): string {
  return optionalEnv('OPENAI_TEXT_CHECK_MODEL', 'gpt-5.4');
}

/** Shortest edge the poster is sent at: what `detail: 'high'` reduces it to anyway. */
const MODEL_SHORT_EDGE = 768;

/** Template words at least this long count as a leftover when found inside a longer block. */
const MIN_CONTAINED_LEFTOVER = 12;

/**
 * Longest the read-back may take. The check runs while the day's generation
 * claim is held, after the image was paid for: a slow answer must end well
 * before the claim goes stale (`STALE_GENERATION_MS`), or another run could take
 * the day and pay for a second poster. One request, no retries — a failed check
 * leaves the poster unchecked, never unsaved.
 */
export const TEXT_CHECK_TIMEOUT_MS = 90_000;

const TEXT_CHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['places', 'blocks'],
  properties: {
    places: {
      type: 'array',
      description: 'One entry per numbered place.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['number', 'found'],
        properties: {
          number: { type: 'integer' },
          found: {
            type: ['string', 'null'],
            description: 'The words printed in that place, exactly as printed. Null if none are legible there.',
          },
        },
      },
    },
    blocks: {
      type: 'array',
      description: 'Every block of text visible anywhere on the poster, in reading order, each once.',
      items: { type: 'string' },
    },
  },
} as const;

const SYSTEM_PROMPT = `You proofread generated marketing posters. Read text exactly as it is printed: copy spelling, capitals, digits and punctuation character for character. Never correct a misspelling, complete a cut-off word, or guess at text you cannot read — a wrong digit must be reported as the wrong digit. Join the lines of one block of text with a single space. Ignore words that are part of a photograph, such as a sign on a wall or a print on clothing.`;

export async function checkCloneText(input: {
  /** The finished poster, after identity compositing. */
  bytes: Buffer;
  mimeType: string;
  resolved: readonly ResolvedElement[];
  templateDoc: TemplateElementsDoc;
  bill?: UsageContext;
}): Promise<TextCheckResult> {
  const model = textCheckModel();
  const expected = expectedTexts(input.resolved, input.templateDoc);

  const png = await sharp(input.bytes)
    .resize({ width: MODEL_SHORT_EDGE, height: MODEL_SHORT_EDGE, fit: 'outside', withoutEnlargement: true })
    .png()
    .toBuffer();

  const userPrompt = [
    expected.length > 0
      ? [
          'Numbered places on this poster (x, y, width, height as fractions of the poster, from the top-left; the design may have shifted slightly):',
          ...expected.map(
            (item, index) =>
              `${index + 1}. ${item.label}, ${describeBoxPosition(item.box)}: x ${item.box.x.toFixed(3)} y ${item.box.y.toFixed(3)} w ${item.box.w.toFixed(3)} h ${item.box.h.toFixed(3)}`,
          ),
          '',
          'For each numbered place, give the words printed there.',
        ].join('\n')
      : 'There are no numbered places; return an empty places list.',
    'Then list every block of text visible anywhere on the poster.',
  ].join('\n');

  const generated = await generateStructured<unknown>({
    label: 'clone-text-check',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    imageDataUri: `data:image/png;base64,${png.toString('base64')}`,
    schema: TEXT_CHECK_SCHEMA as unknown as Record<string, unknown>,
    schemaName: 'clone_text_check',
    model,
    temperature: supportsTemperature(model) ? 0 : undefined,
    maxTokens: supportsTemperature(model) ? 4_000 : 12_000,
    bill: input.bill ? { ...input.bill, operation: 'text-check' } : undefined,
    timeoutMs: TEXT_CHECK_TIMEOUT_MS,
    maxAttempts: 1,
  });

  const read = readAnswer(generated, expected.length);
  return judgeCloneText({ expected, read, resolved: input.resolved, templateDoc: input.templateDoc, model });
}

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

export interface ExpectedText {
  elementId: string;
  label: string;
  expected: string;
  box: TemplateElementsDoc['elements'][number]['box'];
}

/** What the poster should say: every word element the day replaces or keeps. */
export function expectedTexts(
  resolved: readonly ResolvedElement[],
  templateDoc: TemplateElementsDoc,
): ExpectedText[] {
  const template = new Map(templateDoc.elements.map((element) => [element.id, element]));
  const out: ExpectedText[] = [];
  for (const item of resolved) {
    if (IMAGE_KINDS.has(item.element.kind)) continue;
    const element = template.get(item.element.id) ?? item.element;
    const text =
      item.action.type === 'replace' ? item.action.text : item.action.type === 'keep' ? element.text : null;
    if (!text?.trim()) continue;
    out.push({ elementId: element.id, label: item.label, expected: text, box: element.box });
  }
  return out;
}

export interface TextReadBack {
  /** Words found in each numbered place, index-aligned with the expected list. */
  places: Array<string | null>;
  /** Every block of text on the poster, in reading order. */
  blocks: string[];
}

/** Case- and whitespace-insensitive, with typographic quotes and dashes folded to plain ones. */
export function normalizeCheckText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * The verdict, from what the model read. Pure, so the comparison is testable and
 * the same everywhere.
 *
 * An expected text matches when the place read equals it, or — because a model
 * reading "the words in the top-left" sometimes stops at a line break — when a
 * block, or two or three consecutive blocks joined, equals it. A template text is
 * a leftover when it is still readable anywhere: equal to a block or a joined
 * run, or, for a long enough text, contained in one — unless the new words
 * themselves contain it. A content text the poster is asked to print that still
 * carries a contact detail of the template's own words is always a leftover
 * (`carriesTemplateContactDetail`).
 */
export function judgeCloneText(input: {
  expected: readonly ExpectedText[];
  read: TextReadBack;
  resolved: readonly ResolvedElement[];
  templateDoc: TemplateElementsDoc;
  model: string;
  now?: Date;
}): TextCheckResult {
  const runs = joinedRuns(input.read.blocks.filter((block) => block.trim()));
  const normalizedRuns = runs.map(normalizeCheckText);

  const items = input.expected.map((item, index) => {
    const found = input.read.places[index] ?? null;
    const want = normalizeCheckText(item.expected);
    if (found !== null && normalizeCheckText(found) === want) {
      return { elementId: item.elementId, label: item.label, expected: item.expected, found, match: true };
    }
    const run = normalizedRuns.indexOf(want);
    return {
      elementId: item.elementId,
      label: item.label,
      expected: item.expected,
      found: run >= 0 ? runs[run]! : found,
      match: run >= 0,
    };
  });

  const wanted = input.expected.map((item) => normalizeCheckText(item.expected));
  const seen = [...normalizedRuns, ...input.read.places.filter((place): place is string => place !== null).map(normalizeCheckText)];
  const template = new Map(input.templateDoc.elements.map((element) => [element.id, element]));

  const leftovers: string[] = [];
  for (const item of input.resolved) {
    if (item.action.type !== 'replace' && item.action.type !== 'remove') continue;
    const text = (template.get(item.element.id) ?? item.element).text;
    if (!text) continue;
    const old = normalizeCheckText(text);
    if (!old || wanted.some((want) => want.includes(old))) continue;
    const visible = seen.some(
      (candidate) => candidate === old || (old.length >= MIN_CONTAINED_LEFTOVER && candidate.includes(old)),
    );
    if (visible && !leftovers.includes(text)) leftovers.push(text);
  }

  // Words kept from the template that still carry its business's web address,
  // email or phone number: an admin showed them, or only the business name was
  // swapped. Listed whether or not they were read back — they are asked for —
  // so the admin sees another business's contact detail before approving.
  for (const item of input.resolved) {
    if (!CONTENT_KINDS.has(item.element.kind)) continue;
    const templateText = (template.get(item.element.id) ?? item.element).text;
    const printed = item.action.type === 'keep' ? templateText : item.action.type === 'replace' ? item.action.text : null;
    if (printed && carriesTemplateContactDetail(printed, templateText) && !leftovers.includes(printed)) leftovers.push(printed);
  }

  return textCheckResultSchema.parse({
    checkedAt: (input.now ?? new Date()).toISOString(),
    model: input.model,
    ok: items.every((item) => item.match) && leftovers.length === 0,
    items,
    leftovers,
  });
}

/** Each block, and each run of two or three consecutive blocks joined with a space. */
function joinedRuns(blocks: readonly string[]): string[] {
  const runs: string[] = [];
  for (let start = 0; start < blocks.length; start += 1) {
    for (let length = 1; length <= 3 && start + length <= blocks.length; length += 1) {
      runs.push(blocks.slice(start, start + length).join(' '));
    }
  }
  return runs;
}

function readAnswer(generated: unknown, places: number): TextReadBack {
  const answer = generated && typeof generated === 'object' ? (generated as Record<string, unknown>) : {};
  const found: Array<string | null> = Array.from({ length: places }, () => null);
  if (Array.isArray(answer.places)) {
    for (const entry of answer.places) {
      if (!entry || typeof entry !== 'object') continue;
      const row = entry as Record<string, unknown>;
      const index = typeof row.number === 'number' ? Math.round(row.number) - 1 : -1;
      if (index < 0 || index >= places || found[index] !== null) continue;
      found[index] = typeof row.found === 'string' && row.found.trim() ? row.found : null;
    }
  }
  const blocks = Array.isArray(answer.blocks)
    ? answer.blocks.filter((block): block is string => typeof block === 'string')
    : [];
  return { places: found, blocks };
}
