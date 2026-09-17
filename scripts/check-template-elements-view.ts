/**
 * Fixture suite for template elements on the vertical page: how a reading is
 * grouped and summarised for the card and its dialog
 * (src/lib/templates/elements-view.ts), and how a read's outcome becomes an
 * operator message and the row's columns (src/lib/templates/elements-reading.ts).
 *
 * Pure: no database, no network, no provider. Readers are fakes, and the reader
 * failures whose wording the card depends on are produced by the real reader
 * code wherever that needs no model call.
 *
 * Run: npm run check:template-elements-view
 */
import { Prisma } from '@prisma/client';

import { LlmError } from '@/lib/ai/openai';
import { buildTemplateElementsDoc, readTemplateElementCandidates } from '@/lib/ai/template-elements';
import { MissingEnvError } from '@/lib/env';
import {
  describeElementsFailure,
  elementsCreateData,
  elementsUpdateData,
  NO_SIZE_MESSAGE,
  readElementsQuietly,
  type TemplateElementsReader,
  type TemplateElementsReading,
} from '@/lib/templates/elements-reading';
import {
  ELEMENT_CATEGORIES,
  ELEMENT_CATEGORY_TITLES,
  elementCategory,
  groupTemplateElements,
  overlayDrawOrder,
  templateElementItems,
  templateElementsState,
  UNREADABLE_ELEMENTS_MESSAGE,
} from '@/lib/templates/elements-view';
import type { TemplateElementsInput } from '@/lib/ai/template-elements';
import {
  CONTENT_KINDS,
  isBrandBound,
  summarizeTemplateElements,
  TEMPLATE_ELEMENT_KINDS,
  UNBOUND_IDENTITY_KINDS,
  type TemplateElement,
  type TemplateElementsDoc,
} from '@/lib/types/template-elements';

let bad = 0;
const t = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) bad += 1;
};
const section = (title: string) => console.log(`\n--- ${title} ${'-'.repeat(Math.max(0, 58 - title.length))}`);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Runs `body` with console.warn silenced: the quiet reader logs every failure. */
async function quietly<T>(body: () => Promise<T>): Promise<T> {
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    return await body();
  } finally {
    console.warn = warn;
  }
}

async function throwsWith(body: () => unknown): Promise<unknown> {
  try {
    await body();
    return null;
  } catch (error) {
    return error;
  }
}

const el = (
  id: string,
  kind: TemplateElement['kind'],
  text: string | null,
  box: [number, number, number, number],
  extra: Partial<TemplateElement> = {},
): TemplateElement => ({
  id,
  kind,
  text,
  box: { x: box[0], y: box[1], w: box[2], h: box[3] },
  group: null,
  description: null,
  ...extra,
});

/** The urology template's shape: identity at the top, a photo, features, a contact bar. */
const DOC: TemplateElementsDoc = {
  version: 1,
  width: 736,
  height: 920,
  model: 'gpt-5.4',
  elements: [
    el('e1', 'logo', null, [0.62, 0.02, 0.11, 0.08], { description: 'kidney symbol' }),
    el('e2', 'credential', 'CONSULTANT', [0.76, 0.04, 0.18, 0.03]),
    el('e3', 'photo', null, [0.37, 0.15, 0.63, 0.8], { description: 'doctor talking to a patient' }),
    el('e4', 'headline', 'CARE BEYOND TREATMENT', [0.05, 0.16, 0.39, 0.25]),
    el('e5', 'feature', 'Personalized Care', [0.08, 0.56, 0.22, 0.03], { group: 'features' }),
    el('e6', 'feature', 'Advanced Technology', [0.08, 0.64, 0.21, 0.04], { group: 'features' }),
    el('e7', 'cta', 'Book an Appointment Today', [0.04, 0.89, 0.29, 0.02]),
    el('e8', 'phone', '+91 80907 20161', [0.04, 0.91, 0.25, 0.02]),
    el('e9', 'personName', 'DR. HARI SHANKAR SINGH', [0.37, 0.91, 0.4, 0.03]),
    el('e10', 'photo', null, [0.81, 0.79, 0.19, 0.21], { description: 'doctor portrait' }),
  ],
};

async function main() {
  // -------------------------------------------------------------------------
  section('view: categories');

  for (const kind of TEMPLATE_ELEMENT_KINDS) {
    const expected = CONTENT_KINDS.has(kind)
      ? 'content'
      : isBrandBound(kind)
        ? 'brand'
        : UNBOUND_IDENTITY_KINDS.has(kind)
          ? 'hidden'
          : 'photo';
    t(`${kind} is ${expected}`, elementCategory(kind) === expected);
  }
  // `elementCategory` falls through to photo, so nothing but `photo` may reach it.
  t(
    'only photo falls through to the photo category',
    TEMPLATE_ELEMENT_KINDS.filter((kind) => elementCategory(kind) === 'photo').join(',') === 'photo',
  );
  t(
    'the contract sets are disjoint',
    TEMPLATE_ELEMENT_KINDS.every(
      (kind) => [CONTENT_KINDS.has(kind), isBrandBound(kind), UNBOUND_IDENTITY_KINDS.has(kind)].filter(Boolean).length <= 1,
    ),
  );
  t('every category has a title', ELEMENT_CATEGORIES.every((category) => ELEMENT_CATEGORY_TITLES[category].length > 0));
  t(
    'titles are the dialog headings',
    same(ELEMENT_CATEGORIES.map((category) => ELEMENT_CATEGORY_TITLES[category]), [
      'Words you can edit',
      'Filled from Brand Canvas',
      'Hidden by default',
      'Photo',
    ]),
  );

  // -------------------------------------------------------------------------
  section('view: items and groups');

  const items = templateElementItems(DOC);
  t('one item per element, in reading order', same(items.map((item) => item.id), DOC.elements.map((element) => element.id)));
  t('a repeated kind is numbered', items.find((item) => item.id === 'e6')?.label === 'Feature 2');
  t('a single kind is not numbered', items.find((item) => item.id === 'e4')?.label === 'Headline');
  t('words show the template text', items.find((item) => item.id === 'e8')?.detail === '+91 80907 20161');
  t('a logo shows its description', items.find((item) => item.id === 'e1')?.detail === 'kidney symbol');
  t('a photo shows its description', items.find((item) => item.id === 'e3')?.detail === 'doctor talking to a patient');
  t('boxes are passed through', same(items.find((item) => item.id === 'e7')?.box, DOC.elements[6]?.box));

  const groups = groupTemplateElements(DOC);
  t('groups follow the category order', same(groups.map((group) => group.category), ['content', 'brand', 'hidden', 'photo']));
  t(
    'words group holds headline, features and cta in order',
    same(groups[0]?.items.map((item) => item.id), ['e4', 'e5', 'e6', 'e7']),
  );
  t('Brand Canvas group holds the logo and phone', same(groups[1]?.items.map((item) => item.id), ['e1', 'e8']));
  t('hidden group holds the credential and person name', same(groups[2]?.items.map((item) => item.id), ['e2', 'e9']));
  t('photo group holds both photos, numbered', same(groups[3]?.items.map((item) => item.label), ['Photo 1', 'Photo 2']));
  t('every element is in exactly one group', groups.reduce((sum, group) => sum + group.items.length, 0) === DOC.elements.length);

  const wordsOnly: TemplateElementsDoc = { ...DOC, elements: [el('e1', 'headline', 'Hello', [0.1, 0.1, 0.5, 0.1])] };
  t('empty groups are left out', same(groupTemplateElements(wordsOnly).map((group) => group.category), ['content']));

  const drawn = overlayDrawOrder(items);
  t('overlay draws photos first', same(drawn.slice(0, 2).map((item) => item.id), ['e3', 'e10']));
  t(
    'overlay keeps every other element in reading order',
    same(drawn.slice(2).map((item) => item.id), ['e1', 'e2', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9']),
  );

  // -------------------------------------------------------------------------
  section('view: card state');

  const readAt = new Date('2026-09-17T10:30:00.000Z');
  t('nothing stored is unread', same(templateElementsState({ elements: null, elementsReadAt: null, elementsError: null }), { status: 'unread' }));
  t(
    'an error without a reading is failed',
    same(templateElementsState({ elements: null, elementsReadAt: null, elementsError: 'The image could not be decoded.' }), {
      status: 'failed',
      error: 'The image could not be decoded.',
    }),
  );
  t(
    'a blank error is no error',
    same(templateElementsState({ elements: null, elementsReadAt: null, elementsError: '   ' }), { status: 'unread' }),
  );
  t(
    'an unparseable reading is failed with a way forward',
    same(templateElementsState({ elements: { version: 2 }, elementsReadAt: readAt, elementsError: null }), {
      status: 'failed',
      error: UNREADABLE_ELEMENTS_MESSAGE,
    }),
  );
  t(
    'an unparseable reading prefers the stored error',
    same(templateElementsState({ elements: { version: 2 }, elementsReadAt: readAt, elementsError: 'Boom.' }), {
      status: 'failed',
      error: 'Boom.',
    }),
  );

  const read = templateElementsState({ elements: DOC, elementsReadAt: readAt, elementsError: null });
  t('a reading is read', read.status === 'read');
  if (read.status === 'read') {
    t('the summary is the contract summary', read.summary === summarizeTemplateElements(DOC), read.summary);
    t('readAt is an ISO string', read.readAt === '2026-09-17T10:30:00.000Z');
    t('no last error', read.lastError === null);
    t('the state is JSON-serializable', same(JSON.parse(JSON.stringify(read)), read));
  }
  const kept = templateElementsState({ elements: DOC, elementsReadAt: readAt, elementsError: 'The AI declined to read this image.' });
  t(
    'a failed re-read keeps the reading and reports the error',
    kept.status === 'read' && kept.lastError === 'The AI declined to read this image.',
  );
  const noDate = templateElementsState({ elements: DOC, elementsReadAt: null, elementsError: null });
  t('a reading without a date is still read', noDate.status === 'read' && noDate.readAt === null);

  // -------------------------------------------------------------------------
  section('reading: failure messages');

  const DEFAULT = describeElementsFailure(new Error('something unexpected'));
  t('an unknown error gets the generic message', DEFAULT === 'The elements could not be read. Check the server logs.');
  t('a non-Error gets the generic message', describeElementsFailure('nope') === DEFAULT && describeElementsFailure(null) === DEFAULT);
  t(
    'a missing key names the variable',
    describeElementsFailure(new MissingEnvError('OPENAI_API_KEY')) ===
      'The server is missing OPENAI_API_KEY, so templates cannot be read.',
  );

  const kinds = ['refusal', 'truncated', 'filtered', 'malformed', 'transport', 'config'] as const;
  const llmMessages = kinds.map((kind) => describeElementsFailure(new LlmError(`template-elements(Poster): ${kind}`, kind)));
  t('every LLM failure kind has a specific message', llmMessages.every((message) => message !== DEFAULT && message.length > 0));
  t('a transport failure says to try again', llmMessages[4]?.includes('Try again') === true);
  t('a refusal and a filter read the same', llmMessages[0] === llmMessages[2]);

  // The reader's own failures, produced by the reader's own code.
  const decode = await throwsWith(() =>
    readTemplateElementCandidates({ bytes: Buffer.from('not an image'), mimeType: 'image/png', label: 'Broken', width: 10, height: 10 }),
  );
  t('the reader refuses undecodable bytes before any model call', decode instanceof Error);
  t('an undecodable image is named', describeElementsFailure(decode) === 'The image could not be decoded.', String(decode));

  const nothing = await throwsWith(() =>
    buildTemplateElementsDoc({ candidates: [], measured: [], width: 736, height: 920, model: 'gpt-5.4', label: 'Empty' }),
  );
  t(
    'an empty reading is named',
    describeElementsFailure(nothing) === 'No words, photo or logo were found on this template.',
    String(nothing),
  );

  const unstorable = await throwsWith(() =>
    buildTemplateElementsDoc({
      candidates: [{ kind: 'headline', text: 'Hello', blocks: [], box: { x: 0.1, y: 0.1, w: 0.5, h: 0.1 }, group: null, description: null }],
      measured: [],
      width: 0,
      height: 920,
      model: 'gpt-5.4',
      label: 'Zero',
    }),
  );
  t(
    'an unstorable reading is named',
    describeElementsFailure(unstorable) === 'The AI reading could not be stored. Try again.',
    String(unstorable),
  );
  // Needs a model answer to trigger; the wording is copied from the reader.
  t(
    'a reading with no element list is named',
    describeElementsFailure(new Error('Reading the elements of template "X" returned no element list.')) ===
      'The AI returned no elements. Try again.',
  );
  t(
    'no operator message names the template',
    [decode, nothing, unstorable].every((error) => !/Broken|Empty|Zero/.test(describeElementsFailure(error))),
  );

  // -------------------------------------------------------------------------
  section('reading: readElementsQuietly');

  const calls: TemplateElementsInput[] = [];
  const good: TemplateElementsReader = async (input) => {
    calls.push(input);
    return DOC;
  };
  const input = { bytes: Buffer.from('x'), mimeType: 'image/webp', label: 'Poster', width: 736, height: 920 };

  const ok = await readElementsQuietly(input, good);
  t('a good read is ok', ok.ok);
  t('a good read carries the summary', ok.ok && ok.summary === summarizeTemplateElements(DOC));
  t('the reader gets the size', calls[0]?.width === 736 && calls[0]?.height === 920);
  t('the read is billed to the platform ledger', same(calls[0]?.bill, {}));

  const failing: TemplateElementsReader = async () => {
    throw new LlmError('template-elements(Poster): could not reach the OpenAI API', 'transport');
  };
  const failed = await quietly(() => readElementsQuietly(input, failing));
  t('a throwing reader does not throw', !failed.ok);
  t('a throwing reader returns the operator message', !failed.ok && failed.error === llmMessages[4]);

  calls.length = 0;
  const noSize = await quietly(() => readElementsQuietly({ ...input, width: null }, good));
  t('no size is not read', !noSize.ok && noSize.error === NO_SIZE_MESSAGE);
  t('no size makes no call', calls.length === 0);
  const fractional = await quietly(() => readElementsQuietly({ ...input, height: 919.5 }, good));
  t('a fractional size is not read', !fractional.ok && calls.length === 0);

  // -------------------------------------------------------------------------
  section('reading: columns');

  const now = new Date('2026-09-17T12:00:00.000Z');
  const success: TemplateElementsReading = { ok: true, doc: DOC, summary: 'x' };
  const failure: TemplateElementsReading = { ok: false, error: 'The image could not be decoded.' };

  const created = elementsCreateData(success, now);
  t('a good read stores the document', same(created.elements, DOC));
  t('a good read stamps the time', created.elementsReadAt === now);
  t('a good read clears the error', created.elementsError === null);

  const createdFailed = elementsCreateData(failure, now);
  t('a failed upload read stores a database NULL', createdFailed.elements === Prisma.DbNull);
  t('a failed upload read has no read time', createdFailed.elementsReadAt === null);
  t('a failed upload read stores the reason', createdFailed.elementsError === failure.error);

  t('a good re-read replaces everything', same(elementsUpdateData(success, now), created));
  t(
    'a failed re-read writes only the error',
    same(Object.keys(elementsUpdateData(failure, now)), ['elementsError']) &&
      elementsUpdateData(failure, now).elementsError === failure.error,
  );

  console.log(`\n${bad === 0 ? 'All checks passed.' : `${bad} check(s) FAILED.`}`);
  if (bad > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
