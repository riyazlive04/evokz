/**
 * Fixture suite for template clone mode: the shared contract
 * (src/lib/types/template-elements.ts), the element reader's normalisation
 * (src/lib/ai/template-elements.ts), the clone prompt (buildClonePrompt), the
 * text check's verdict (src/lib/ai/text-check.ts) and the identity compositor's
 * geometry (src/lib/poster-studio/clone-identity.ts).
 *
 * Pure: no database, no network, no provider. The one composite rendered here
 * places a synthetic logo, which needs no fonts.
 *
 * Run: npm run check:template-elements
 */
import sharp from 'sharp';

import {
  addMissedPhotos,
  buildTemplateElementsDoc,
  clampBox,
  cutInkBoxes,
  mergeElementBoxes,
  orderElements,
  placeStack,
  splitLabelledDetails,
  stabilizeElementIds,
  textMarks,
  type ReadElementCandidate,
} from '@/lib/ai/template-elements';
import { generateStructured, LlmError } from '@/lib/ai/openai';
import { buildClonePrompt, cloneAccentColors, describeBoxPosition, isCodeDrawnIdentity } from '@/lib/ai/studio-prompts';
import { checkCloneText, expectedTexts, judgeCloneText, normalizeCheckText, TEXT_CHECK_TIMEOUT_MS } from '@/lib/ai/text-check';
import { STALE_GENERATION_MS } from '@/lib/campaign/poster-generation';
import type { ResolvedStudioLogo } from '@/lib/poster-studio/brand-logo';
import { clearPartFromPixels, composeCloneIdentity, identityTextAlign, inkFor, lockupMarkBox, longestRun, toPixelBox } from '@/lib/poster-studio/clone-identity';
import { cloneSizeFor } from '@/lib/poster-studio/clone-size';
import {
  carriesTemplateContactDetail,
  cloneTemplateElements,
  contactLabelTargets,
  containsContactDetail,
  elementIdHighWater,
  elementLabel,
  isBoundElement,
  isLogoLockupBox,
  legacyContentFields,
  materializeDayElements,
  MAX_TEMPLATE_ELEMENTS,
  parseDayPosterElements,
  parseTemplateElements,
  reconcileDayElements,
  replaceBusinessName,
  resolveDayElements,
  sameDayElements,
  seedDayElementsFromLegacy,
  summarizeTemplateElements,
  templateBindings,
  textCheckIssueCount,
  type CloneBrandValues,
  type DayPosterElementsDoc,
  type ElementAction,
  type ResolvedElement,
  type TemplateElement,
  type TemplateElementsDoc,
} from '@/lib/types/template-elements';

let bad = 0;
const t = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) bad += 1;
};
const section = (title: string) => console.log(`\n--- ${title} ${'-'.repeat(Math.max(0, 58 - title.length))}`);

/**
 * No network: every request the OpenAI SDK makes goes to `fetchHandler`, which
 * the bounded-request checks set. Installed before any client is constructed
 * (the SDK captures `fetch` when it builds its client).
 */
let fetchCalls = 0;
let fetchHandler: (init: RequestInit | undefined) => Promise<Response> = async () => {
  throw new Error('network disabled by check:template-elements');
};
globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
  fetchCalls += 1;
  return fetchHandler(init);
}) as typeof fetch;

const TEMPLATE_ID = '03c6d26a-5752-4acc-8b84-f6952346a6c9';
const OTHER_TEMPLATE_ID = 'b58b0a93-c87e-44fb-8afc-4870fcf07079';

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

/** Shaped on the urology template: logo, specialty, headline, photo, features, contact bar, doctor bar. */
const DOC: TemplateElementsDoc = {
  version: 1,
  width: 736,
  height: 920,
  model: 'gpt-4o',
  elements: [
    el('e1', 'logo', null, [0.65, 0.03, 0.08, 0.07], { description: 'kidney symbol' }),
    el('e2', 'credential', 'CONSULTANT UROLOGIST & ANDROLOGIST', [0.74, 0.04, 0.24, 0.05]),
    el('e3', 'headline', 'CARE BEYOND TREATMENT', [0.054, 0.157, 0.391, 0.252]),
    el('e4', 'subheadline', 'Expert urology care with compassion.', [0.065, 0.435, 0.25, 0.078]),
    el('e5', 'photo', null, [0.33, 0.2, 0.67, 0.68], { description: 'doctor in a white coat talking to a patient' }),
    el('e6', 'feature', 'Personalized Care', [0.17, 0.557, 0.14, 0.035], { group: 'features' }),
    el('e7', 'feature', 'Advanced Technology', [0.17, 0.643, 0.14, 0.043], { group: 'features' }),
    el('e8', 'feature', 'Trusted Support', [0.17, 0.73, 0.12, 0.043], { group: 'features' }),
    el('e9', 'cta', 'Book an Appointment Today', [0.05, 0.878, 0.25, 0.02]),
    el('e10', 'phone', '+91 80907 20161', [0.05, 0.905, 0.2, 0.025]),
    el('e11', 'address', 'Peerzadiguda', [0.05, 0.935, 0.16, 0.025]),
    el('e12', 'credential', 'Reg No. 30435', [0.37, 0.88, 0.1, 0.02]),
    el('e13', 'personName', 'Dr. HARI SHANKAR SINGH', [0.37, 0.9, 0.3, 0.035]),
    el('e14', 'brandName', 'Urocare Clinic', [0.37, 0.95, 0.2, 0.02]),
    el('e15', 'website', 'www.urocare.in', [0.6, 0.95, 0.15, 0.02]),
    el('e16', 'tagline', 'Healthy kidneys, better life', [0.37, 0.975, 0.25, 0.02]),
    el('e17', 'photo', null, [0.78, 0.77, 0.22, 0.23], { description: 'portrait of a doctor with arms crossed' }),
  ],
};

const BRAND: CloneBrandValues = {
  companyName: 'Sirah healthcare agents',
  tagline: 'Automate your healthcare  business',
  phone: '6381780846',
  website: 'sirahdigital.in',
  hasLogo: true,
};

const actionOf = (resolved: ResolvedElement[], id: string): ElementAction | undefined =>
  resolved.find((item) => item.element.id === id)?.action;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  // ===========================================================================
  section('contract: parse, labels, summary');
  // ===========================================================================
  t('a valid document parses', parseTemplateElements(DOC) !== null);
  t(
    'duplicate element ids are rejected',
    parseTemplateElements({ ...DOC, elements: [DOC.elements[0], { ...DOC.elements[1]!, id: 'e1' }] }) === null,
  );
  t('a box outside 0-1 is rejected', parseTemplateElements({ ...DOC, elements: [el('e1', 'headline', 'x', [0, 0, 1.2, 0.1])] }) === null);
  t('a repeated kind is numbered', elementLabel(DOC, DOC.elements[6]!) === 'Feature 2');
  t('a single kind is not numbered', elementLabel(DOC, DOC.elements[2]!) === 'Headline');
  t('two credentials are numbered in order', elementLabel(DOC, DOC.elements[11]!) === 'Credential 2');
  t(
    'summary counts repeated kinds',
    summarizeTemplateElements(DOC).includes('3 features') && summarizeTemplateElements(DOC).includes('2 photos'),
    summarizeTemplateElements(DOC),
  );

  // ===========================================================================
  section('contract: cloneTemplateElements');
  // ===========================================================================
  const day = cloneTemplateElements(DOC, TEMPLATE_ID);
  const value = (doc: DayPosterElementsDoc, id: string) => doc.values.find((entry) => entry.id === id);
  t('one value per element, in template order', same(day.values.map((entry) => entry.id), DOC.elements.map((element) => element.id)));
  t('records the template id', day.templateId === TEMPLATE_ID && day.version === 1);
  t('content text is copied from the template', value(day, 'e3')?.text === 'CARE BEYOND TREATMENT' && value(day, 'e9')?.text === 'Book an Appointment Today');
  t('brand-bound identity carries no text and is shown', value(day, 'e10')?.text === null && value(day, 'e10')?.removed === false && value(day, 'e14')?.removed === false);
  t('logo and photo carry no text and are shown', value(day, 'e1')?.text === null && value(day, 'e1')?.removed === false && value(day, 'e5')?.removed === false);
  t(
    'unbound identity (credential, person, address) is hidden',
    ['e2', 'e11', 'e12', 'e13'].every((id) => value(day, id)?.removed === true && value(day, id)?.text === null),
  );
  t('every value starts from the template', day.values.every((entry) => entry.source === 'template'));
  t('every value records its element’s kind', day.values.every((entry, index) => entry.kind === DOC.elements[index]!.kind));
  const withoutKinds = (doc: DayPosterElementsDoc): DayPosterElementsDoc => ({ ...doc, values: doc.values.map(({ kind: _kind, ...rest }) => rest) });
  t('a stored day with kinds parses and keeps them; one without still parses', parseDayPosterElements(day)?.values[2]?.kind === 'headline' && parseDayPosterElements(withoutKinds(day))?.values[2]?.kind === undefined);
  t('sameDayElements ignores kind (an old stored day is not "changed")', sameDayElements(day, withoutKinds(day)) && !sameDayElements(day, { ...day, values: day.values.map((entry) => (entry.id === 'e3' ? { ...entry, removed: true } : entry)) }));

  // ===========================================================================
  section('contract: reconcileDayElements');
  // ===========================================================================
  t('no stored day gives a fresh clone', same(reconcileDayElements(DOC, null, TEMPLATE_ID), day));
  const edited: DayPosterElementsDoc = {
    ...day,
    values: day.values.map((entry) => (entry.id === 'e3' ? { ...entry, text: 'NEW HEADLINE', source: 'admin' } : entry)),
  };
  t('a day cloned from another template is re-cloned', same(reconcileDayElements(DOC, { ...edited, templateId: OTHER_TEMPLATE_ID }, TEMPLATE_ID), day));
  t('stored values are kept', value(reconcileDayElements(DOC, edited, TEMPLATE_ID), 'e3')?.text === 'NEW HEADLINE');
  const shrunk: TemplateElementsDoc = { ...DOC, elements: DOC.elements.filter((element) => element.id !== 'e4') };
  const grown: TemplateElementsDoc = { ...DOC, elements: [...DOC.elements, el('e18', 'badge', '20% OFF', [0.1, 0.8, 0.1, 0.05])] };
  t('a value for a dropped element is removed', value(reconcileDayElements(shrunk, edited, TEMPLATE_ID), 'e4') === undefined);
  const added = value(reconcileDayElements(grown, edited, TEMPLATE_ID), 'e18');
  t('a new element is added as a fresh clone', added?.text === '20% OFF' && added.removed === false && added.source === 'template');

  // A re-read gave e3 to a different kind of element: the stored headline must not print there.
  const rekinded: TemplateElementsDoc = { ...DOC, elements: DOC.elements.map((element) => (element.id === 'e3' ? { ...element, kind: 'badge' as const, text: 'NEW BADGE' } : element)) };
  const staleValue = value(reconcileDayElements(rekinded, edited, TEMPLATE_ID), 'e3');
  t('a stored value whose kind differs from the element’s is dropped (fresh clone instead)', staleValue?.text === 'NEW BADGE' && staleValue.source === 'template' && staleValue.kind === 'badge');
  const kindless = withoutKinds(edited);
  t('a stored value without a kind cannot be checked and is kept (old behaviour)', value(reconcileDayElements(rekinded, kindless, TEMPLATE_ID), 'e3')?.text === 'NEW HEADLINE');
  t('reconcile writes the element’s kind onto every value it returns', reconcileDayElements(DOC, kindless, TEMPLATE_ID).values.every((entry, index) => entry.kind === DOC.elements[index]!.kind));

  // A re-read that fixed a misread word, or a client renamed: template words follow; hidden stays hidden.
  const reread: TemplateElementsDoc = { ...DOC, elements: DOC.elements.map((element) => (element.id === 'e6' ? { ...element, text: 'Personalised Care' } : element)) };
  const hiddenFeature: DayPosterElementsDoc = { ...edited, values: edited.values.map((entry) => (entry.id === 'e7' ? { ...entry, removed: true } : entry)) };
  const rereadDay = reconcileDayElements(reread, hiddenFeature, TEMPLATE_ID);
  t('a template-sourced value takes its words from the fresh clone after a re-read', value(rereadDay, 'e6')?.text === 'Personalised Care' && value(rereadDay, 'e6')?.source === 'template');
  t('…keeping only whether the day hides it', value(rereadDay, 'e7')?.removed === true && value(rereadDay, 'e7')?.text === 'Advanced Technology');
  t('…while words an admin wrote stay', value(rereadDay, 'e3')?.text === 'NEW HEADLINE' && value(rereadDay, 'e3')?.source === 'admin');
  const aiEdited: DayPosterElementsDoc = { ...edited, values: edited.values.map((entry) => (entry.id === 'e6' ? { ...entry, text: 'Care made personal', source: 'ai' as const } : entry)) };
  t('…and so do words the AI wrote', value(reconcileDayElements(reread, aiEdited, TEMPLATE_ID), 'e6')?.text === 'Care made personal');
  const namedTemplate: TemplateElementsDoc = { ...DOC, elements: [...DOC.elements, el('e18', 'text', 'Choose Urocare Clinic.', [0.05, 0.6, 0.2, 0.03])] };
  const filledBeforeRename = cloneTemplateElements(namedTemplate, TEMPLATE_ID, { businessName: 'Old Name Dental' });
  t('a template-sourced value follows a new business name', value(reconcileDayElements(namedTemplate, filledBeforeRename, TEMPLATE_ID, { businessName: 'Sirah Dental' }), 'e18')?.text === 'Choose Sirah Dental.');

  // ===========================================================================
  section('contract: seeding a day’s existing content');
  // ===========================================================================
  const aiContent = { headline: '  Kidney care,   close to home ', supportingText: 'Same-week appointments for every family.', cta: 'Call us today' };
  const seeded = seedDayElementsFromLegacy(DOC, TEMPLATE_ID, aiContent);
  t('the headline goes into the first headline element, as the admin’s', value(seeded, 'e3')?.text === 'Kidney care, close to home' && value(seeded, 'e3')?.source === 'admin' && value(seeded, 'e3')?.removed === false);
  t('supporting text goes into the first sub-headline', value(seeded, 'e4')?.text === 'Same-week appointments for every family.' && value(seeded, 'e4')?.source === 'admin');
  t('the call to action goes into the first CTA', value(seeded, 'e9')?.text === 'Call us today' && value(seeded, 'e9')?.source === 'admin');
  t('everything else is the fresh clone', same(seeded.values.filter((entry) => !['e3', 'e4', 'e9'].includes(entry.id)), day.values.filter((entry) => !['e3', 'e4', 'e9'].includes(entry.id))));
  t('the legacy fields read back exactly the content seeded', same(legacyContentFields(resolveDayElements(DOC, seeded, BRAND, null)), { headline: 'Kidney care, close to home', supportingText: 'Same-week appointments for every family.', cta: 'Call us today' }));
  t('no content gives exactly the fresh clone', same(seedDayElementsFromLegacy(DOC, TEMPLATE_ID, { headline: null, supportingText: '   ', cta: null }), day));
  t('content that already reads as the template’s words gives the fresh clone', same(seedDayElementsFromLegacy(DOC, TEMPLATE_ID, { headline: 'CARE BEYOND TREATMENT', supportingText: 'Expert urology care with compassion.', cta: 'Book an Appointment Today' }), day));
  const bodyOnly: TemplateElementsDoc = { ...DOC, elements: [el('e1', 'headline', 'Old', [0, 0, 0.5, 0.1]), el('e2', 'body', 'Body words.', [0, 0.2, 0.5, 0.1]), el('e3', 'body', 'More body.', [0, 0.4, 0.5, 0.1])] };
  const bodySeeded = seedDayElementsFromLegacy(bodyOnly, TEMPLATE_ID, aiContent);
  t('with no sub-headline, supporting text goes into the first body', value(bodySeeded, 'e2')?.text === aiContent.supportingText && value(bodySeeded, 'e3')?.text === 'More body.');
  t('a text the template has no element for is not placed anywhere', bodySeeded.values.every((entry) => entry.text !== 'Call us today'));
  const phoneCta: TemplateElementsDoc = { ...DOC, elements: DOC.elements.map((element) => (element.id === 'e9' ? { ...element, text: 'Call +91 80907 20161 today' } : element)) };
  t('a CTA hidden for its contact detail is shown with the day’s own words', value(seedDayElementsFromLegacy(phoneCta, TEMPLATE_ID, aiContent), 'e9')?.removed === false && value(seedDayElementsFromLegacy(phoneCta, TEMPLATE_ID, aiContent), 'e9')?.text === 'Call us today');
  t('…but stays hidden when the day’s words are the template’s', value(seedDayElementsFromLegacy(phoneCta, TEMPLATE_ID, { ...aiContent, cta: 'Call +91 80907 20161 today' }), 'e9')?.removed === true);
  t('materialize: no stored copy seeds from the content', same(materializeDayElements(DOC, null, TEMPLATE_ID, aiContent), seeded));
  t('materialize: a stored copy is reconciled and the content is not re-applied', value(materializeDayElements(DOC, edited, TEMPLATE_ID, aiContent), 'e3')?.text === 'NEW HEADLINE' && value(materializeDayElements(DOC, edited, TEMPLATE_ID, aiContent), 'e4')?.text === 'Expert urology care with compassion.');
  t('materialize: a copy of another template is re-cloned fresh', same(materializeDayElements(DOC, { ...edited, templateId: OTHER_TEMPLATE_ID }, TEMPLATE_ID, aiContent), day));

  // ===========================================================================
  section('contract: another business’s contact details in template words');
  // ===========================================================================
  const CONTACT: TemplateElementsDoc = {
    ...DOC,
    elements: [
      el('e1', 'headline', 'Smile brighter', [0, 0, 0.5, 0.1]),
      el('e2', 'cta', 'Call 98765 43210 to book', [0, 0.2, 0.5, 0.05]),
      el('e3', 'text', 'Visit www.oldclinic.in', [0, 0.3, 0.5, 0.05]),
      el('e4', 'feature', 'Mail hello@oldclinic.com', [0, 0.4, 0.5, 0.05]),
      el('e5', 'feature', 'Open 7 days', [0, 0.5, 0.5, 0.05]),
      el('e6', 'phone', '98765 43210', [0, 0.6, 0.5, 0.05]),
    ],
  };
  const contactDay = cloneTemplateElements(CONTACT, TEMPLATE_ID);
  t('patterns: web, email and phone-like numbers', containsContactDetail('www.x.in') && containsContactDetail('a@b.co') && containsContactDetail('+91 80907 20161') && !containsContactDetail('Open 7 days') && !containsContactDetail(null));
  t('content words holding a phone, web address or email start hidden', ['e2', 'e3', 'e4'].every((id) => value(contactDay, id)?.removed === true));
  t('content words without one are shown; bound identity is unaffected', value(contactDay, 'e1')?.removed === false && value(contactDay, 'e5')?.removed === false && value(contactDay, 'e6')?.removed === false);
  t('hidden content is erased on the poster', same(actionOf(resolveDayElements(CONTACT, contactDay, BRAND, null), 'e2'), { type: 'remove' }));
  t('patterns: registration and tax numbers', containsContactDetail('Reg No. 30435') && containsContactDetail('GSTIN: 29ABCDE1234F1Z5') && containsContactDetail('Licence #MH-2231') && !containsContactDetail('Registered care team') && !containsContactDetail('Open 24x7'));
  t('carries a template detail: the template’s registration number', carriesTemplateContactDetail('Reg No. 30435', 'Reg No. 30435') && !carriesTemplateContactDetail('Reg No. 11111', 'Reg No. 30435'));
  t('carries a template detail: kept words', carriesTemplateContactDetail('Call 98765 43210 to book', 'Call 98765 43210 to book'));
  t('…the same number with other spacing or a swapped name', carriesTemplateContactDetail('Ring 98765-43210 at Sirah', 'Call 98765 43210 to book') && carriesTemplateContactDetail('Visit WWW.OLDCLINIC.IN', 'Visit www.oldclinic.in'));
  t('…but not the admin’s own number, or no number at all', !carriesTemplateContactDetail('Call 080 4000 1234 to book', 'Call 98765 43210 to book') && !carriesTemplateContactDetail('Book online', 'Call 98765 43210 to book') && !carriesTemplateContactDetail('Call 98765 43210', 'Open 7 days'));

  const shownContact: DayPosterElementsDoc = {
    ...contactDay,
    values: contactDay.values.map((entry) =>
      entry.id === 'e2' || entry.id === 'e3' ? { ...entry, removed: false } : entry.id === 'e4' ? { ...entry, removed: false, text: 'Mail hi@sirah.in', source: 'admin' as const } : entry,
    ),
  };
  const contactResolved = resolveDayElements(CONTACT, shownContact, BRAND, null);
  const contactExpected = expectedTexts(contactResolved, CONTACT);
  const contactVerdict = judgeCloneText({
    expected: contactExpected,
    read: { places: contactExpected.map((entry) => entry.expected), blocks: contactExpected.map((entry) => entry.expected) },
    resolved: contactResolved,
    templateDoc: CONTACT,
    model: 'm',
  });
  t('the text check lists kept template words with another business’s contact detail as leftovers', contactVerdict.leftovers.includes('Call 98765 43210 to book') && contactVerdict.leftovers.includes('Visit www.oldclinic.in'), JSON.stringify(contactVerdict.leftovers));
  t('…even when every place matched, so the poster is not ok', contactVerdict.items.every((entry) => entry.match) && !contactVerdict.ok && textCheckIssueCount(contactVerdict) === 2);
  t('…but not the admin’s own words', !contactVerdict.leftovers.includes('Mail hi@sirah.in'));

  // ===========================================================================
  section('contract: resolveDayElements');
  // ===========================================================================
  const set = (doc: DayPosterElementsDoc, id: string, patch: Partial<DayPosterElementsDoc['values'][number]>): DayPosterElementsDoc => ({
    ...doc,
    values: doc.values.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
  });
  let dayDoc = set(day, 'e3', { text: 'AUTOMATE BEYOND ROUTINE', source: 'ai' });
  dayDoc = set(dayDoc, 'e4', { text: '  Expert urology   care with compassion. ' });
  dayDoc = set(dayDoc, 'e7', { removed: true });
  dayDoc = set(dayDoc, 'e8', { text: '   ' });
  let resolved = resolveDayElements(DOC, dayDoc, BRAND, '  a nurse using a tablet  ');

  t('changed text is replaced', same(actionOf(resolved, 'e3'), { type: 'replace', text: 'AUTOMATE BEYOND ROUTINE' }));
  t('text equal after whitespace is kept', same(actionOf(resolved, 'e4'), { type: 'keep' }));
  t('unchanged text is kept', same(actionOf(resolved, 'e6'), { type: 'keep' }));
  t('a removed element is removed', same(actionOf(resolved, 'e7'), { type: 'remove' }));
  t('blank text is removed', same(actionOf(resolved, 'e8'), { type: 'remove' }));
  t('phone takes the Brand Canvas value', same(actionOf(resolved, 'e10'), { type: 'replace', text: '6381780846' }));
  t('tagline whitespace is normalised', same(actionOf(resolved, 'e16'), { type: 'replace', text: 'Automate your healthcare business' }));
  t('brand name and website take their values', same(actionOf(resolved, 'e14'), { type: 'replace', text: 'Sirah healthcare agents' }) && same(actionOf(resolved, 'e15'), { type: 'replace', text: 'sirahdigital.in' }));
  t('logo with a brand logo is a logo action', same(actionOf(resolved, 'e1'), { type: 'logo' }));
  t('photo carries the trimmed image prompt', same(actionOf(resolved, 'e5'), { type: 'photo', prompt: 'a nurse using a tablet' }));
  t('unbound identity is removed by default', ['e2', 'e11', 'e12', 'e13'].every((id) => same(actionOf(resolved, id), { type: 'remove' })));
  t('labels come from the template', resolved.find((item) => item.element.id === 'e7')?.label === 'Feature 2');

  const bare: CloneBrandValues = { companyName: 'Sirah', tagline: '   ', phone: null, website: '', hasLogo: false };
  const bareResolved = resolveDayElements(DOC, day, bare, null);
  t('missing phone is removed', same(actionOf(bareResolved, 'e10'), { type: 'remove' }));
  t('blank tagline and website are removed', same(actionOf(bareResolved, 'e16'), { type: 'remove' }) && same(actionOf(bareResolved, 'e15'), { type: 'remove' }));
  t('logo without a brand logo is removed', same(actionOf(bareResolved, 'e1'), { type: 'remove' }));
  t('no image prompt gives a photo with a null prompt', same(actionOf(bareResolved, 'e5'), { type: 'photo', prompt: null }));
  t('a blank image prompt is null too', same(actionOf(resolveDayElements(DOC, day, BRAND, '   '), 'e5'), { type: 'photo', prompt: null }));

  const hidden = set(set(set(day, 'e1', { removed: true }), 'e5', { removed: true }), 'e10', { removed: true });
  const hiddenResolved = resolveDayElements(DOC, hidden, BRAND, 'x');
  t('a removed logo stays removed with a brand logo', same(actionOf(hiddenResolved, 'e1'), { type: 'remove' }));
  t('a removed photo is removed', same(actionOf(hiddenResolved, 'e5'), { type: 'remove' }));
  t('a removed phone is removed despite a brand value', same(actionOf(hiddenResolved, 'e10'), { type: 'remove' }));
  const typed = set(day, 'e13', { removed: false, text: 'Dr. Asha Rao', source: 'admin' });
  t('unbound identity the admin fills in is shown', same(actionOf(resolveDayElements(DOC, typed, BRAND, null), 'e13'), { type: 'replace', text: 'Dr. Asha Rao' }));
  const missingValue: DayPosterElementsDoc = { ...day, values: day.values.filter((entry) => entry.id !== 'e3' && entry.id !== 'e13') };
  const missingResolved = resolveDayElements(DOC, missingValue, BRAND, null);
  t('an element with no stored value and content kind is removed (no text)', same(actionOf(missingResolved, 'e3'), { type: 'remove' }));
  t('an unbound identity with no stored value stays hidden', same(actionOf(missingResolved, 'e13'), { type: 'remove' }));

  // ===========================================================================
  section('contract: legacyContentFields');
  // ===========================================================================
  const legacy = legacyContentFields(resolved);
  t('headline from the replaced headline', legacy.headline === 'AUTOMATE BEYOND ROUTINE', String(legacy.headline));
  t('supporting text from kept sub-headline', legacy.supportingText === 'Expert urology care with compassion.', String(legacy.supportingText));
  t('cta from the kept cta', legacy.cta === 'Book an Appointment Today');
  const removedAll = resolveDayElements(DOC, set(set(set(day, 'e3', { removed: true }), 'e4', { removed: true }), 'e9', { removed: true }), BRAND, null);
  t('removed elements give nulls', same(legacyContentFields(removedAll), { headline: null, supportingText: null, cta: null }));
  const twoBody: TemplateElementsDoc = {
    ...DOC,
    elements: [el('e1', 'subheadline', 'First.', [0, 0, 0.5, 0.1]), el('e2', 'body', 'Second.', [0, 0.2, 0.5, 0.1]), el('e3', 'cta', 'Go', [0, 0.4, 0.2, 0.1]), el('e4', 'cta', 'Later', [0, 0.6, 0.2, 0.1])],
  };
  const twoBodyFields = legacyContentFields(resolveDayElements(twoBody, cloneTemplateElements(twoBody, TEMPLATE_ID), BRAND, null));
  t('supporting text joins sub-headline and body', twoBodyFields.supportingText === 'First. Second.');
  t('cta is the first cta', twoBodyFields.cta === 'Go');

  // ===========================================================================
  section('reader: boxes');
  // ===========================================================================
  const near = (a: { x: number; y: number; w: number; h: number } | null | undefined, b: [number, number, number, number]) =>
    Boolean(a) && Math.abs(a!.x - b[0]) < 1e-3 && Math.abs(a!.y - b[1]) < 1e-3 && Math.abs(a!.w - b[2]) < 1e-3 && Math.abs(a!.h - b[3]) < 1e-3;

  t('clamp: negative origin moves to 0 and keeps the far edge', near(clampBox({ x: -0.1, y: 0.2, w: 0.3, h: 0.1 }), [0, 0.2, 0.2, 0.1]));
  t('clamp: overflow is cut at the edge', near(clampBox({ x: 0.9, y: 0.95, w: 0.3, h: 0.2 }), [0.9, 0.95, 0.1, 0.05]));
  t('clamp: non-finite values become 0', near(clampBox({ x: Number.NaN, y: 0.5, w: Number.POSITIVE_INFINITY, h: -1 }), [0, 0.5, 0, 0]));

  const measured = [
    { x: 0.05, y: 0.15, w: 0.4, h: 0.25 }, // 1 headline
    { x: 0.0, y: 0.86, w: 0.78, h: 0.1 }, // 2 bottom bar: two elements
    { x: 0.1, y: 0.5, w: 0.2, h: 0.03 }, // 3 feature line 1
    { x: 0.1, y: 0.54, w: 0.25, h: 0.03 }, // 4 feature line 2
    { x: 0.05, y: 0.2, w: 0.9, h: 0.3 }, // 5 a box that swallowed a neighbour
  ];
  const cand = (
    blocks: number[],
    box: [number, number, number, number] | null,
    kind: ReadElementCandidate['kind'] = 'headline',
  ): Pick<ReadElementCandidate, 'kind' | 'blocks' | 'box'> => ({
    kind,
    blocks,
    box: box ? { x: box[0], y: box[1], w: box[2], h: box[3] } : null,
  });
  const merged = mergeElementBoxes(
    [
      cand([1], [0.06, 0.16, 0.35, 0.2]), // measured wins over a sloppy estimate
      cand([3, 4], [0.1, 0.5, 0.2, 0.06]), // union of two lines
      cand([], [0.3, 0.2, 0.7, 0.7]), // photo-like: estimate only
      cand([2], [0.0, 0.88, 0.3, 0.05]), // shared block, left: its own estimate inside the block
      cand([2], [0.45, 0.85, 0.3, 0.05]), // shared block, right: estimate pokes above the block
      cand([99, 0, -3], [0.5, 0.5, 0.1, 0.1]), // unknown numbers ignored
      cand([5], [0.05, 0.2, 0.2, 0.05]), // oversized union is cut to the padded estimate
      cand([], null), // nothing at all
    ],
    measured,
  );
  t('a single measured box wins over the estimate', near(merged[0], [0.05, 0.15, 0.4, 0.25]));
  t('several measured boxes are unioned', near(merged[1], [0.1, 0.5, 0.25, 0.07]));
  t('no measured box keeps the estimate', near(merged[2], [0.3, 0.2, 0.7, 0.7]));
  t('a shared box sizes nothing: the estimate inside it', near(merged[3], [0, 0.88, 0.3, 0.05]), JSON.stringify(merged[3]));
  t('a shared box clips the estimate to its edge', near(merged[4], [0.45, 0.86, 0.3, 0.04]), JSON.stringify(merged[4]));
  t('unknown block numbers fall back to the estimate', near(merged[5], [0.5, 0.5, 0.1, 0.1]));
  t('an oversized union is cut to the padded estimate', near(merged[6], [0.05, 0.2, 0.22, 0.07]), JSON.stringify(merged[6]));
  t('no blocks and no estimate gives null', merged[7] === null);
  const edgeCases = mergeElementBoxes(
    [
      cand([4], [0.6, 0.1, 0.2, 0.05]), // a named box far from the estimate is a misnumbering
      cand([2], [0.7, 0.86, 0.2, 0.2]), // shared box holding under half the estimate
      cand([2], [0.05, 0.9, 0.2, 0.03]), // the other claimant of that box
      cand([1], [0.04, 0.14, 0.45, 0.3], 'logo'), // a logo keeps its estimate's extent
    ],
    measured,
  );
  t('a named box far from the estimate is ignored', near(edgeCases[0], [0.6, 0.1, 0.2, 0.05]), JSON.stringify(edgeCases[0]));
  t('a shared box that holds under half the estimate is ignored', near(edgeCases[1], [0.7, 0.86, 0.2, 0.14]), JSON.stringify(edgeCases[1]));
  t('a logo unions its measured box with its estimate', near(edgeCases[3], [0.04, 0.14, 0.45, 0.3]), JSON.stringify(edgeCases[3]));
  t(
    'a block number repeated by one element is not a shared block',
    near(mergeElementBoxes([cand([1, 1], [0.06, 0.16, 0.35, 0.2])], measured)[0], [0.05, 0.15, 0.4, 0.25]),
  );

  // ===========================================================================
  section('reader: reading order');
  // ===========================================================================
  type O = { name: string; box: { x: number; y: number; w: number; h: number }; group: string | null };
  const o = (name: string, box: [number, number, number, number], group: string | null = null): O => ({
    name,
    box: { x: box[0], y: box[1], w: box[2], h: box[3] },
    group,
  });
  const names = (list: O[]) => list.map((item) => item.name).join(',');
  t(
    'top to bottom, then left to right on a line',
    names(orderElements([o('c', [0.1, 0.8, 0.2, 0.05]), o('b', [0.6, 0.1, 0.2, 0.05]), o('a', [0.1, 0.11, 0.2, 0.05])])) === 'a,b,c',
  );
  t(
    'a tall photo does not pull everything onto its line',
    names(orderElements([o('photo', [0.4, 0.1, 0.6, 0.8]), o('head', [0.05, 0.2, 0.3, 0.1]), o('sub', [0.05, 0.7, 0.3, 0.05])])) === 'photo,head,sub',
  );
  t(
    'group members stay together at the first member',
    names(
      orderElements([
        o('f1', [0.05, 0.5, 0.2, 0.04], 'features'),
        o('side', [0.6, 0.55, 0.3, 0.04]),
        o('f2', [0.05, 0.6, 0.2, 0.04], 'features'),
        o('f3', [0.05, 0.7, 0.2, 0.04], 'features'),
        o('cta', [0.05, 0.9, 0.3, 0.04]),
      ]),
    ) === 'f1,f2,f3,side,cta',
  );
  t(
    'a row of cards reads left to right',
    names(orderElements([o('c3', [0.5, 0.401, 0.2, 0.05], 'features'), o('c1', [0.1, 0.4, 0.2, 0.05], 'features'), o('c2', [0.3, 0.402, 0.2, 0.05], 'features')])) === 'c1,c2,c3',
  );
  type K = O & { kind: string };
  const k = (name: string, box: [number, number, number, number], kind: string, group: string | null = null): K => ({ ...o(name, box, group), kind });
  const kNames = (list: K[]) => list.map((item) => item.name).join(',');
  t(
    'a background photo never joins a line: the features group stays after the logo',
    kNames(
      orderElements([
        k('photo', [0, 0, 1, 1], 'photo'),
        k('f3', [0.08, 0.478, 0.3, 0.03], 'feature', 'features'),
        k('logo', [0, 0.022, 0.22, 0.05], 'logo'),
        k('f1', [0.08, 0.287, 0.3, 0.03], 'feature', 'features'),
        k('f2', [0.08, 0.384, 0.3, 0.03], 'feature', 'features'),
      ]),
    ) === 'photo,logo,f1,f2,f3',
  );
  t(
    'anything taller than 40% of the poster stands on a line of its own',
    kNames(orderElements([k('tall', [0.5, 0.1, 0.4, 0.6], 'body'), k('left', [0.05, 0.39, 0.3, 0.02], 'text')])) === 'tall,left',
  );
  t(
    'a line needs comparable heights: a caption beside a big headline is its own line',
    kNames(orderElements([k('caption', [0.05, 0.125, 0.3, 0.02], 'text'), k('headline', [0.4, 0.1, 0.5, 0.08], 'headline')])) === 'headline,caption',
  );

  // ===========================================================================
  section('reader: buildTemplateElementsDoc');
  // ===========================================================================
  const c = (kind: ReadElementCandidate['kind'], text: string | null, blocks: number[], box: [number, number, number, number], extra: Partial<ReadElementCandidate> = {}): ReadElementCandidate => ({
    kind,
    text,
    blocks,
    box: { x: box[0], y: box[1], w: box[2], h: box[3] },
    group: null,
    description: null,
    ...extra,
  });
  const built = buildTemplateElementsDoc({
    candidates: [
      c('cta', 'Book  now', [2], [0.0, 0.86, 0.3, 0.1]),
      c('headline', ' CARE\nBEYOND  TREATMENT ', [1], [0.06, 0.16, 0.35, 0.2]),
      c('photo', 'should be dropped', [3, 4], [0.3, 0.2, 0.7, 0.6], { description: '  doctor   at a desk ' }),
      c('logo', null, [], [0.8, 0.02, 0.1, 0.08], { description: '   ' }),
      c('body', '   ', [], [0.1, 0.6, 0.3, 0.05]),
      c('text', '•••', [], [0.1, 0.65, 0.1, 0.02]),
      c('phone', '+91 80907 20161', [2], [0.45, 0.86, 0.3, 0.1], { group: '  Contact ', description: 'ignored for words' }),
      c('headline', 'care beyond treatment', [1], [0.06, 0.16, 0.35, 0.2]),
    ],
    measured,
    width: 736.4,
    height: 920,
    model: 'gpt-4o',
    label: 'fixture',
  });
  t('ids run e1..eN', same(built.elements.map((element) => element.id), built.elements.map((_, index) => `e${index + 1}`)));
  t('elements are in reading order', same(built.elements.map((element) => element.kind), ['logo', 'headline', 'photo', 'cta', 'phone']), built.elements.map((element) => element.kind).join(','));
  t('an element with empty text is dropped', !built.elements.some((element) => element.kind === 'body'));
  t('ornament with no letters or digits is dropped', !built.elements.some((element) => element.kind === 'text'));
  t('the same words read twice are kept once', built.elements.filter((element) => element.kind === 'headline').length === 1);
  t('text whitespace is collapsed', built.elements.find((element) => element.kind === 'headline')?.text === 'CARE BEYOND TREATMENT');
  const photo = built.elements.find((element) => element.kind === 'photo');
  t('a photo has no text, a cleaned description, and ignores type boxes', photo?.text === null && photo.description === 'doctor at a desk' && near(photo.box, [0.3, 0.2, 0.7, 0.6]));
  t('a logo with no description gets a fallback', built.elements.find((element) => element.kind === 'logo')?.description === 'logo mark');
  const phone = built.elements.find((element) => element.kind === 'phone');
  t('words have no description; groups are trimmed and lower-cased', phone?.description === null && phone.group === 'contact');
  t('size is recorded as integers', built.width === 736 && built.height === 920);
  t('the document parses as stored', parseTemplateElements(built) !== null);
  t('a first reading records its high-water mark (its last id)', built.lastId === built.elements.length && parseTemplateElements(built)?.lastId === built.elements.length);

  const many = Array.from({ length: 55 }, (_, index) => c('feature', `Item ${index}`, [], [0.05, index / 60, 0.2, 0.01]));
  t('the list is capped', buildTemplateElementsDoc({ candidates: many, measured: [], width: 10, height: 10, model: 'm', label: 'many' }).elements.length === MAX_TEMPLATE_ELEMENTS);
  let threw = false;
  try {
    buildTemplateElementsDoc({ candidates: [c('body', ' ', [], [0, 0, 0.1, 0.1])], measured: [], width: 10, height: 10, model: 'm', label: 'empty' });
  } catch (error) {
    threw = error instanceof Error && error.message.includes('empty');
  }
  t('nothing usable throws a clear error', threw);

  const featureSentence = buildTemplateElementsDoc({
    candidates: [
      c('feature', 'Prevent injuries', [], [0.15, 0.61, 0.14, 0.015], { group: 'features' }),
      c('body', 'Protect lives', [], [0.15, 0.63, 0.1, 0.012], { group: 'features' }),
      c('body', 'A safe workplace is the foundation.', [], [0.06, 0.25, 0.43, 0.07]),
    ],
    measured: [],
    width: 736,
    height: 920,
    model: 'm',
    label: 'features',
  });
  t(
    "a feature's sentence is text, not body copy; other body stays body",
    featureSentence.elements.find((element) => element.text === 'Protect lives')?.kind === 'text' &&
      featureSentence.elements.find((element) => element.text?.startsWith('A safe'))?.kind === 'body',
  );

  const photos = buildTemplateElementsDoc({
    candidates: [
      c('photo', null, [], [0.36, 0.14, 0.64, 0.86], { description: 'doctor and patient' }),
      c('photo', null, [], [0.81, 0.78, 0.19, 0.22], { description: 'portrait in a circle' }),
      c('photo', null, [], [0.35, 0.15, 0.62, 0.84], { description: 'the same photo again' }),
      c('headline', 'Hello', [], [0.05, 0.1, 0.3, 0.1]),
    ],
    measured: [],
    width: 736,
    height: 920,
    model: 'm',
    label: 'photos',
  });
  const photoBoxes = photos.elements.filter((element) => element.kind === 'photo');
  t('a portrait inside the main photograph is a photograph of its own', photoBoxes.length === 2, photoBoxes.map((p) => p.description).join(' | '));
  t(
    'the same photograph read twice is kept once, covering both estimates',
    near(photoBoxes.find((p) => p.description === 'doctor and patient')?.box, [0.35, 0.14, 0.65, 0.86]),
    JSON.stringify(photoBoxes[0]?.box),
  );

  const withPhotos = addMissedPhotos(
    [c('photo', null, [], [0.35, 0.15, 0.65, 0.85], { description: 'main' }), c('headline', 'Hi', [], [0.05, 0.1, 0.3, 0.1])],
    [
      { description: 'main, found again', box: { x: 0.36, y: 0.16, w: 0.6, h: 0.8 } },
      { description: 'portrait in a circle', box: { x: 0.8, y: 0.78, w: 0.2, h: 0.22 } },
    ],
  );
  t('the photo pass adds a photograph the element list missed', withPhotos.some((candidate) => candidate.description === 'portrait in a circle' && candidate.kind === 'photo'));
  t('the photo pass does not add one the element list already has', withPhotos.length === 3);

  const split = splitLabelledDetails([
    c('website', 'Visit : www.botphonic.ai', [], [0.58, 0.917, 0.29, 0.034], { group: 'contact' }),
    c('email', 'Email: info@clinic.com', [], [0.1, 0.6, 0.3, 0.02]),
    c('website', 'https://clinic.com', [], [0.1, 0.7, 0.3, 0.02]),
    c('phone', '+91 80907 20161', [], [0.1, 0.8, 0.3, 0.02]),
    c('address', 'Visit us at: Opposite Wulingkama Junction', [], [0.6, 0.83, 0.3, 0.05]),
  ]);
  const splitTexts = split.map((candidate) => `${candidate.kind}:${candidate.text}`).join(' | ');
  t(
    'a label and a colon before a contact detail become a text and the detail',
    splitTexts ===
      'text:Visit : | website:www.botphonic.ai | text:Email: | email:info@clinic.com | website:https://clinic.com | phone:+91 80907 20161 | text:Visit us at: | address:Opposite Wulingkama Junction',
    splitTexts,
  );
  const visitLabel = split[0]!.box!;
  const visitDetail = split[1]!.box!;
  t(
    'the estimate is divided at the label: the label on the left, the detail after it',
    Math.abs(visitLabel.x - 0.58) < 1e-9 && Math.abs(visitDetail.x - (visitLabel.x + visitLabel.w)) < 1e-9 && Math.abs(visitLabel.w + visitDetail.w - 0.29) < 1e-9 && split[1]!.group === 'contact',
  );

  // ===========================================================================
  section('reader: ink');
  // ===========================================================================
  // A 200×60 edge mask: a pill whose two sides run through every row, and two
  // lines of type inside it made of vertical strokes every 4px.
  const inkWidth = 200;
  const inkHeight = 60;
  const pillMask = (bridged: boolean) => {
    const edges = new Uint8Array(inkWidth * inkHeight);
    const set = (x: number, y: number) => {
      edges[y * inkWidth + x] = 1;
    };
    for (let y = 5; y < 55; y += 1) {
      set(8, y);
      set(191, y);
    }
    for (const [top, bottom] of [
      [15, 25],
      [35, 45],
    ] as const) {
      for (let y = top; y < bottom; y += 1) for (let x = 40; x <= 160; x += 4) set(x, y);
    }
    // Photo texture across the pill, joining its sides and both lines into one component.
    if (bridged) for (let x = 8; x <= 191; x += 2) set(x, 30);
    return edges;
  };
  const whole = [{ x: 0, y: 0, w: 1, h: 1 }];
  const lineOne: [number, number, number, number] = [0.2, 0.25, 0.605, 10 / 60];
  const lineTwo: [number, number, number, number] = [0.2, 35 / 60, 0.605, 10 / 60];
  const plain = cutInkBoxes(pillMask(false), inkWidth, inkHeight, whole);
  t('two lines inside a pill come out as two marks', plain.some((box) => near(box, lineOne)) && plain.some((box) => near(box, lineTwo)), JSON.stringify(plain));
  t("the pill's sides are tall, thin marks of their own", plain.filter((box) => box.w < 0.01 && box.h > 0.8).length === 2);
  const bridged = cutInkBoxes(pillMask(true), inkWidth, inkHeight, whole);
  t('a component bridged by photo texture is still cut into its lines', bridged.some((box) => near(box, lineOne)) && bridged.some((box) => near(box, lineTwo)), JSON.stringify(bridged));
  t('nothing outside the blocks is measured', cutInkBoxes(pillMask(false), inkWidth, inkHeight, [{ x: 0.9, y: 0, w: 0.1, h: 0.05 }]).length === 0);

  const inkLine = (x: number, y: number, w: number, h = 0.02) => ({ x, y, w, h });
  const pictogram = { x: 0.05, y: 0.5, w: 0.05, h: 0.05 };
  const pictogramPiece = { x: 0.055, y: 0.495, w: 0.012, h: 0.012 };
  const speck = { x: 0.5, y: 0.5, w: 0.004, h: 0.004 };
  const label = [inkLine(0.12, 0.5, 0.3), inkLine(0.12, 0.525, 0.2)];
  t('an icon, its fragments and specks are not type', same(textMarks([pictogram, pictogramPiece, speck, ...label]), label));
  const chunk = { x: 0.1, y: 0.3, w: 0.3, h: 0.06 };
  t('a wide mark far taller than the lines is a graphic', !textMarks([chunk, ...label]).includes(chunk));
  t('…unless only square graphics are removed: large display type', textMarks([chunk, ...label], null, { squareGraphicsOnly: true }).includes(chunk));
  const texture = [inkLine(0.1, 0.9, 0.4, 0.004), inkLine(0.1, 0.95, 0.4, 0.004)];
  const website = inkLine(0.2, 0.8, 0.3, 0.026);
  t('without a line height, flat photo texture makes a real line look like a graphic', !textMarks([...texture, website]).includes(website));
  t('given the line height, the texture is left out and the line is type', textMarks([...texture, website], 0.026).includes(website));

  // ===========================================================================
  section('reader: placing words on ink');
  // ===========================================================================
  const contactRows = [inkLine(0.05, 0.88, 0.25, 0.015), inkLine(0.05, 0.905, 0.2, 0.015), inkLine(0.05, 0.93, 0.15, 0.015)];
  const lowStack = placeStack(
    [
      { box: { x: 0.05, y: 0.905, w: 0.25, h: 0.02 }, lines: 1 },
      { box: { x: 0.05, y: 0.93, w: 0.2, h: 0.02 }, lines: 1 },
      { box: { x: 0.05, y: 0.955, w: 0.15, h: 0.02 }, lines: 1 },
    ],
    contactRows,
  );
  t(
    'a whole stack of estimates a line low lands on its own lines',
    near(lowStack[0], [0.05, 0.88, 0.25, 0.015]) && near(lowStack[1], [0.05, 0.905, 0.2, 0.015]) && near(lowStack[2], [0.05, 0.93, 0.15, 0.015]),
    JSON.stringify(lowStack),
  );

  const cardRows = [inkLine(0.1, 0.8, 0.15, 0.015), inkLine(0.1, 0.82, 0.12, 0.015), inkLine(0.1, 0.845, 0.13, 0.015), inkLine(0.1, 0.865, 0.1, 0.015)];
  const titled = placeStack(
    [
      { box: { x: 0.1, y: 0.804, w: 0.15, h: 0.072 }, lines: 2 },
      { box: { x: 0.1, y: 0.875, w: 0.13, h: 0.055 }, lines: 2 },
    ],
    cardRows,
  );
  t(
    'the counted lines split a two-line title from the two-line sentence under it',
    near(titled[0], [0.1, 0.8, 0.15, 0.035]) && near(titled[1], [0.1, 0.845, 0.13, 0.035]),
    JSON.stringify(titled),
  );

  const dropRows = [inkLine(0.622, 0.425, 0.023, 0.024), inkLine(0.548, 0.479, 0.087, 0.016), inkLine(0.548, 0.498, 0.086, 0.016), inkLine(0.546, 0.517, 0.106, 0.015)];
  t(
    'a square icon beside the words is never one of their lines',
    near(placeStack([{ box: { x: 0.55, y: 0.435, w: 0.159, h: 0.096 }, lines: 3 }], dropRows)[0], [0.546, 0.479, 0.106, 0.053]),
  );
  t('no ink near an estimate places nothing', placeStack([{ box: { x: 0.1, y: 0.1, w: 0.2, h: 0.02 }, lines: 1 }], contactRows)[0] === null);

  // Marks that overlap in a chain — a word a little lower than the one before it,
  // then the next line — must not chain into one row.
  const chained = placeStack(
    [
      { box: { x: 0.1, y: 0.1, w: 0.65, h: 0.05 }, lines: 1 },
      { box: { x: 0.1, y: 0.145, w: 0.3, h: 0.04 }, lines: 1 },
    ],
    [
      { x: 0.1, y: 0.1, w: 0.3, h: 0.04 },
      { x: 0.45, y: 0.12, w: 0.3, h: 0.04 },
      { x: 0.1, y: 0.14, w: 0.3, h: 0.04 },
    ],
  );
  t(
    'rows join on centres, so overlapping marks do not chain two lines into one row',
    near(chained[0], [0.1, 0.1, 0.65, 0.06]) && near(chained[1], [0.1, 0.14, 0.3, 0.04]),
    JSON.stringify(chained),
  );

  // Five features whose estimates drift across the row: the first too far left,
  // the last too far right, the middle ones reaching into their neighbours.
  const stripColumns = [0.137, 0.319, 0.432, 0.617, 0.779];
  const stripWidths = [0.113, 0.06, 0.151, 0.122, 0.079];
  const stripInk = stripColumns.flatMap((x, index) => [
    { x, y: 0.785, w: stripWidths[index]!, h: 0.01 },
    { x: x + 0.005, y: 0.8, w: stripWidths[index]! - 0.01, h: 0.01 },
  ]);
  const drifting = [0.089, 0.289, 0.476, 0.676, 0.87].map((x, index) => ({
    kind: 'feature' as const,
    blocks: [1],
    box: { x, y: 0.772, w: [0.128, 0.092, 0.173, 0.134, 0.096][index]!, h: 0.053 },
    lines: 2,
    group: 'features',
  }));
  const strip = mergeElementBoxes(drifting, [{ x: 0.13, y: 0.739, w: 0.73, h: 0.072 }], stripInk);
  t(
    'a row of features whose estimates drift takes its measured columns in order',
    stripColumns.every((x, index) => near(strip[index], [x, 0.785, stripWidths[index]!, 0.025])),
    JSON.stringify(strip),
  );
  const contactDrift = mergeElementBoxes(
    drifting.slice(3, 5).map((candidate) => ({ ...candidate, group: 'contact' })),
    [{ x: 0.13, y: 0.739, w: 0.73, h: 0.072 }],
    stripInk,
  );
  t('a contact strip is not snapped to columns', !near(contactDrift[0], [0.617, 0.785, 0.122, 0.025]), JSON.stringify(contactDrift[0]));

  const bar = [{ x: 0, y: 0.87, w: 0.8, h: 0.08 }];
  const barBoxes = mergeElementBoxes(
    [
      { kind: 'cta', blocks: [1], box: { x: 0.05, y: 0.905, w: 0.25, h: 0.02 }, lines: 1 },
      { kind: 'phone', blocks: [1], box: { x: 0.05, y: 0.93, w: 0.2, h: 0.02 }, lines: 1 },
      { kind: 'address', blocks: [1], box: { x: 0.05, y: 0.955, w: 0.15, h: 0.02 }, lines: 1 },
    ],
    bar,
    contactRows,
  );
  t('a block shared by a stack is placed through its ink', near(barBoxes[1], [0.05, 0.905, 0.2, 0.015]), JSON.stringify(barBoxes));

  const featureBlock = [{ x: 0.05, y: 0.55, w: 0.25, h: 0.04 }];
  const featureInk = [
    { x: 0.05, y: 0.55, w: 0.04, h: 0.04 },
    { x: 0.12, y: 0.555, w: 0.17, h: 0.013 },
    { x: 0.12, y: 0.575, w: 0.06, h: 0.013 },
  ];
  t(
    "an element alone in its block takes the words in its estimate's columns, not the icon beside them",
    near(
      mergeElementBoxes([{ kind: 'feature', blocks: [1], box: { x: 0.115, y: 0.55, w: 0.18, h: 0.045 }, lines: 2 }], featureBlock, featureInk)[0],
      [0.12, 0.555, 0.17, 0.033],
    ),
  );

  // ===========================================================================
  section('reader: stable ids across re-reads');
  // ===========================================================================
  const readingOf = (elements: Array<[string, TemplateElement['kind'], string | null, [number, number, number, number]]>): TemplateElementsDoc => ({
    version: 1,
    width: 736,
    height: 920,
    model: 'gpt-5.4',
    elements: elements.map(([id, kind, text, box]) => el(id, kind, text, box, kind === 'photo' || kind === 'logo' ? { description: 'a picture' } : {})),
  });
  const firstReading = readingOf([
    ['e1', 'headline', 'CARE BEYOND TREATMENT', [0.06, 0.16, 0.37, 0.25]],
    ['e2', 'feature', 'Personalized Care', [0.17, 0.557, 0.12, 0.035]],
    ['e3', 'feature', 'Advanced Technology', [0.17, 0.645, 0.11, 0.039]],
    ['e4', 'phone', '+91 80907 20161', [0.04, 0.909, 0.21, 0.013]],
    ['e5', 'photo', null, [0.36, 0.14, 0.64, 0.86]],
  ]);
  const idsOf = (doc: TemplateElementsDoc) => doc.elements.map((element) => `${element.id}:${element.text ?? element.kind}`).join(',');

  const unstabilised = stabilizeElementIds(null, firstReading);
  t('no previous reading keeps the new ids and records its high-water mark', idsOf(unstabilised) === idsOf(firstReading) && unstabilised.lastId === 5);
  t('…and a reading that already records it is returned as it is', stabilizeElementIds(null, unstabilised) === unstabilised);
  t('a document without lastId still parses; its high-water mark is its highest id', parseTemplateElements(firstReading) !== null && firstReading.lastId === undefined && elementIdHighWater(firstReading) === 5);
  t('an identical re-read keeps every id', idsOf(stabilizeElementIds(firstReading, firstReading)) === idsOf(firstReading));

  const renumbered = stabilizeElementIds(
    firstReading,
    readingOf([
      ['e1', 'photo', null, [0.35, 0.15, 0.65, 0.85]],
      ['e2', 'headline', 'CARE BEYOND TREATMENT.', [0.06, 0.16, 0.37, 0.24]],
      ['e3', 'feature', 'Advanced Technology', [0.17, 0.557, 0.12, 0.035]],
      ['e4', 'feature', 'Personalized Care', [0.17, 0.645, 0.11, 0.039]],
      ['e5', 'phone', '+91 80907 20161', [0.041, 0.905, 0.21, 0.016]],
    ]),
  );
  t(
    'a renumbered re-read gets the previous ids back, following the words, in the new order',
    idsOf(renumbered) === 'e5:photo,e1:CARE BEYOND TREATMENT.,e3:Advanced Technology,e2:Personalized Care,e4:+91 80907 20161',
    idsOf(renumbered),
  );

  const oneRemoved = stabilizeElementIds(firstReading, readingOf(firstReading.elements.filter((element) => element.id !== 'e3').map((element, index) => [`e${index + 1}`, element.kind, element.text, [element.box.x, element.box.y, element.box.w, element.box.h]])));
  t('a removed element takes its id with it; the rest keep theirs', idsOf(oneRemoved) === 'e1:CARE BEYOND TREATMENT,e2:Personalized Care,e4:+91 80907 20161,e5:photo', idsOf(oneRemoved));

  const oneAdded = stabilizeElementIds(
    firstReading,
    readingOf([
      ...firstReading.elements.slice(0, 4).map((element): [string, TemplateElement['kind'], string | null, [number, number, number, number]] => [element.id, element.kind, element.text, [element.box.x, element.box.y, element.box.w, element.box.h]]),
      ['e5', 'cta', 'Book an Appointment Today', [0.05, 0.887, 0.25, 0.013]],
      ['e6', 'photo', null, [0.36, 0.14, 0.64, 0.86]],
    ]),
  );
  t('a new element gets a fresh id after the highest previous one', idsOf(oneAdded) === 'e1:CARE BEYOND TREATMENT,e2:Personalized Care,e3:Advanced Technology,e4:+91 80907 20161,e6:Book an Appointment Today,e5:photo', idsOf(oneAdded));

  const kindChanged = stabilizeElementIds(
    firstReading,
    readingOf(firstReading.elements.map((element): [string, TemplateElement['kind'], string | null, [number, number, number, number]] => [element.id, element.id === 'e2' ? 'text' : element.kind, element.text, [element.box.x, element.box.y, element.box.w, element.box.h]])),
  );
  t('an element whose kind changed is a new element with a fresh id', idsOf(kindChanged) === 'e1:CARE BEYOND TREATMENT,e6:Personalized Care,e3:Advanced Technology,e4:+91 80907 20161,e5:photo', idsOf(kindChanged));
  t('stabilised readings still parse (ids unique)', [renumbered, oneRemoved, oneAdded, kindChanged].every((doc) => parseTemplateElements(doc) !== null));
  t('every stabilised reading records the high-water mark', [renumbered, oneRemoved, oneAdded, kindChanged].map((doc) => doc.lastId).join() === '5,5,6,6');

  // Remove the element with the highest id, then add one: across two re-reads the id is never reused.
  type Row = [string, TemplateElement['kind'], string | null, [number, number, number, number]];
  const rowOf = (element: TemplateElement, id = element.id): Row => [id, element.kind, element.text, [element.box.x, element.box.y, element.box.w, element.box.h]];
  const withoutPhoto = stabilizeElementIds(firstReading, readingOf(firstReading.elements.filter((element) => element.id !== 'e5').map((element, index) => rowOf(element, `e${index + 1}`))));
  t('re-read 1 drops e5 (the highest id) but remembers it was used', idsOf(withoutPhoto) === 'e1:CARE BEYOND TREATMENT,e2:Personalized Care,e3:Advanced Technology,e4:+91 80907 20161' && withoutPhoto.lastId === 5);
  const withCta = stabilizeElementIds(withoutPhoto, readingOf([...withoutPhoto.elements.map((element) => rowOf(element)), ['e5', 'cta', 'Book an Appointment Today', [0.05, 0.887, 0.25, 0.013]]]));
  t('re-read 2 numbers a new element after the high-water mark, never reusing e5', idsOf(withCta).endsWith('e6:Book an Appointment Today') && !withCta.elements.some((element) => element.id === 'e5') && withCta.lastId === 6, idsOf(withCta));
  t('…and the mark survives storage', parseTemplateElements(JSON.parse(JSON.stringify(withCta)))?.lastId === 6);
  const stalePhotoDay: DayPosterElementsDoc = { version: 1, templateId: TEMPLATE_ID, values: [{ id: 'e5', text: null, removed: true, source: 'template', kind: 'photo' }] };
  t('a day still holding the retired e5 is not applied to any element', reconcileDayElements(withCta, stalePhotoDay, TEMPLATE_ID).values.every((entry) => entry.id !== 'e5'));

  // ===========================================================================
  section('clone prompt');
  // ===========================================================================
  t('position: top left', describeBoxPosition({ x: 0.05, y: 0.1, w: 0.3, h: 0.1 }) === 'top left');
  t('position: centre', describeBoxPosition({ x: 0.4, y: 0.45, w: 0.2, h: 0.1 }) === 'centre');
  t('position: middle right', describeBoxPosition({ x: 0.7, y: 0.45, w: 0.2, h: 0.1 }) === 'middle right');
  t('position: bottom centre', describeBoxPosition({ x: 0.37, y: 0.88, w: 0.3, h: 0.05 }) === 'bottom centre');
  t('position: a full-width bar is across its band', describeBoxPosition({ x: 0, y: 0.9, w: 1, h: 0.1 }) === 'across the bottom');
  t('code draws name, tagline, phone and website, never the logo', ['brandName', 'tagline', 'phone', 'website'].every((kind) => isCodeDrawnIdentity(kind as TemplateElement['kind'])) && !isCodeDrawnIdentity('logo') && !isCodeDrawnIdentity('address'));

  const ai = buildClonePrompt({ resolved, brandColors: null, identity: 'ai', orientation: 'vertical 4:5' });
  t('asks for an exact recreation', ai.startsWith('Recreate the attached poster exactly.'));
  t('names the output frame', ai.includes('vertical 4:5'));
  t('replace names old and new text with position', ai.includes('Headline (top left): replace "CARE BEYOND TREATMENT" with "AUTOMATE BEYOND ROUTINE".'));
  t('remove erases and closes the space', ai.includes('Feature 2 (middle left): erase "Advanced Technology" and close the space naturally.'), ai.split('\n').find((line) => line.includes('Feature 2')) ?? '');
  t('unbound identity is erased', ai.includes('erase "Dr. HARI SHANKAR SINGH"') && ai.includes('erase "Reg No. 30435"'));
  t('photo with a prompt uses it and its description', ai.includes('Photo 1 (centre, doctor in a white coat talking to a patient): replace this photograph with a new one of a nurse using a tablet. This is a new photo shoot, not a retouch: re-cast every person with a clearly different person (a different gender or a clearly different age, a different face, hairstyle and clothing), so nobody from the original is recognisable, even in a small cut-out portrait.'), ai.split('\n').find((line) => line.includes('Photo 1')) ?? '');
  t('logo is cleared for compositing, its area left empty', ai.includes("Logo (top right, kidney symbol): remove this logo mark completely and leave its area as clean, empty background matching its surroundings; the client's logo is placed there afterwards."));
  t('kept elements are not listed', !ai.includes('Personalized Care') && !ai.includes('Expert urology care'));
  t('identity ai: exact phone, website, name and tagline are given', ai.includes('with "6381780846"') && ai.includes('with "sirahdigital.in"') && ai.includes('with "Sirah healthcare agents"') && ai.includes('with "Automate your healthcare business"'));
  t('without brand colours every colour is kept', ai.includes('keep every colour exactly as in the original') && !ai.includes('recolour'));
  t('always forbids additions and asks for exact spelling', ai.includes('Do not add any new text, logos, badges, QR codes or watermarks. Spell every provided text exactly as written.'));
  const listed = ai.split('\n').filter((line) => /^\d+\. /.test(line));
  const expectedCount = resolved.filter((item) => item.action.type !== 'keep').length;
  t('one numbered line per non-keep element', listed.length === expectedCount && ai.includes(`Change only these ${expectedCount} things:`), `${listed.length} vs ${expectedCount}`);
  t('the numbered lines run 1..N', listed.every((line, index) => line.startsWith(`${index + 1}. `)));

  const code = buildClonePrompt({ resolved, brandColors: null, identity: 'code', orientation: 'vertical 4:5' });
  t('identity code: phone is erased, space kept', code.includes('Phone (bottom left): erase "+91 80907 20161" and leave its space empty, keeping any bar, button or shape behind it.'), code.split('\n').find((line) => line.includes('Phone')) ?? '');
  t('identity code: brand values are not in the prompt', !code.includes('6381780846') && !code.includes('sirahdigital.in') && !code.includes('Sirah healthcare agents'));
  t('identity code: content replacements are unchanged', code.includes('replace "CARE BEYOND TREATMENT" with "AUTOMATE BEYOND ROUTINE"'));

  const noPrompt = buildClonePrompt({ resolved: resolveDayElements(DOC, dayDoc, BRAND, null), brandColors: null, identity: 'ai', orientation: 'vertical 4:5' });
  t('photo without a prompt suits the headline and never reuses people', noPrompt.includes('replace this photograph with a new realistic one suited to the headline "AUTOMATE BEYOND ROUTINE". This is a new photo shoot, not a retouch'));
  t('a replaced photo keeps no old logos, signs or words', noPrompt.includes('Keep no logo, sign or printed words from the old photograph.'));
  t('erasing takes orphaned icons, labels and dividers with it', noPrompt.includes('An icon, bullet, label or divider that only served an erased element goes with it.'));
  t('an emptied bar, pill, card or badge is removed or closed up', noPrompt.includes('If a bar, pill, card, button or badge is left with nothing in it, remove that shape as well'));
  t('logo areas stay empty when a logo is composited', noPrompt.includes("The space left for the client's logo stays clean and empty: no text, shape or picture may move into it."));
  t('replaced text stays inside its area', noPrompt.includes('stays inside the area of the text it replaces'));

  const colours = [
    { hex: '#1F6FEB', role: 'primary' },
    { hex: '#F0A81E', role: 'accent' },
  ];
  const branded = buildClonePrompt({ resolved, brandColors: colours, identity: 'ai', orientation: 'vertical 4:5' });
  t('brand colours recolour to the palette', branded.includes('primary #1F6FEB, accent #F0A81E') && !branded.includes('keep every colour exactly'));
  t('brand colours keep photographs natural and text readable', branded.includes('Keep photographs natural and every text clearly readable'));
  t('an empty palette keeps colours', buildClonePrompt({ resolved, brandColors: [], identity: 'ai', orientation: 'x' }).includes('keep every colour exactly as in the original'));

  const bareLogo = buildClonePrompt({ resolved: bareResolved, brandColors: null, identity: 'ai', orientation: 'x' });
  t('no brand logo: the logo is removed completely', bareLogo.includes('Logo (top right, kidney symbol): remove this logo completely and leave clean background.'));
  t('no brand phone: the phone is erased', bareLogo.includes('Phone (bottom left): erase "+91 80907 20161" together with its icon, such as a map pin, phone or globe symbol, and close the space naturally.'));
  const hiddenPrompt = buildClonePrompt({ resolved: hiddenResolved, brandColors: null, identity: 'ai', orientation: 'x' });
  t('a removed photo is erased', hiddenPrompt.includes('Photo 1 (centre, doctor in a white coat talking to a patient): erase this photograph'));

  const allKeep = resolveDayElements(
    { ...DOC, elements: DOC.elements.filter((element) => ['headline', 'subheadline', 'feature', 'cta'].includes(element.kind)) },
    cloneTemplateElements(DOC, TEMPLATE_ID),
    BRAND,
    null,
  );
  const keepPrompt = buildClonePrompt({ resolved: allKeep, brandColors: null, identity: 'ai', orientation: 'x' });
  t('nothing to change lists nothing', keepPrompt.includes('Change nothing') && !/^\d+\. /m.test(keepPrompt));

  const twenty: TemplateElementsDoc = {
    ...DOC,
    elements: Array.from({ length: 20 }, (_, index) =>
      el(`e${index + 1}`, index === 0 ? 'photo' : index % 5 === 0 ? 'phone' : 'feature', index === 0 ? null : `Template feature text number ${index}`, [0.05, index / 21, 0.4, 0.04], {
        description: index === 0 ? 'two doctors reviewing a scan on a monitor' : null,
      }),
    ),
  };
  const twentyDay: DayPosterElementsDoc = {
    ...cloneTemplateElements(twenty, TEMPLATE_ID),
    values: cloneTemplateElements(twenty, TEMPLATE_ID).values.map((entry, index) =>
      index % 3 === 0 ? { ...entry, removed: true } : entry.text ? { ...entry, text: `New automated feature line ${index}`, source: 'ai' as const } : entry,
    ),
  };
  const twentyPrompt = buildClonePrompt({
    resolved: resolveDayElements(twenty, twentyDay, BRAND, null),
    brandColors: [
      { hex: '#1F6FEB', role: 'primary' },
      { hex: '#0D2447', role: 'secondary' },
      { hex: '#F0A81E', role: 'accent' },
      { hex: '#F6F7F9', role: 'background' },
    ],
    identity: 'ai',
    orientation: 'vertical 4:5',
  });
  t('twenty changed elements stay under 4000 characters', twentyPrompt.length < 4000, `${twentyPrompt.length} chars`);

  // ===========================================================================
  section('phase 0 fix: identity fallback bindings');
  // ===========================================================================
  /** The urology template as the spike read it: no brand name, no tagline, a doctor's name and credentials. */
  const DOCTOR: TemplateElementsDoc = {
    version: 1,
    width: 736,
    height: 920,
    model: 'gpt-5.4',
    elements: [
      el('e1', 'logo', null, [0.62, 0.023, 0.109, 0.081], { description: 'kidney mark' }),
      el('e2', 'credential', 'CONSULTANT', [0.758, 0.041, 0.177, 0.025]),
      el('e3', 'credential', 'UROLOGIST & ANDROLOGIST', [0.714, 0.066, 0.268, 0.03]),
      el('e4', 'headline', 'CARE BEYOND TREATMENT', [0.054, 0.157, 0.391, 0.252]),
      el('e5', 'photo', null, [0.374, 0.151, 0.626, 0.805], { description: 'doctor talking to a patient' }),
      el('e6', 'cta', 'Book an Appointment Today', [0.039, 0.893, 0.294, 0.024], { group: 'contact' }),
      el('e7', 'phone', '+91 80907 20161', [0.036, 0.918, 0.199, 0.029], { group: 'contact' }),
      el('e8', 'address', 'Peerzadiguda', [0.057, 0.947, 0.164, 0.0182], { group: 'contact' }),
      el('e9', 'credential', 'Reg No. 30435', [0.368, 0.892, 0.123, 0.022]),
      el('e10', 'photo', null, [0.808, 0.8, 0.192, 0.2], { description: 'cut-out portrait of a doctor' }),
      el('e11', 'personName', 'Dr. HARI SHANKAR SINGH', [0.365, 0.918, 0.4176, 0.036]),
    ],
  };
  const doctorBindings = templateBindings(DOCTOR);
  t('no brandName: the first person name binds to the company name', doctorBindings.get('e11') === 'companyName');
  t('no tagline: the first credential binds to the tagline', doctorBindings.get('e2') === 'tagline');
  t('later credentials stay unbound', !doctorBindings.has('e3') && !doctorBindings.has('e9') && !isBoundElement(DOCTOR, 'e9'));
  t('bound kinds keep their own field', doctorBindings.get('e7') === 'phone' && doctorBindings.get('e1') === 'logo');
  t('a template with its own brand name and tagline binds no person or credential', !templateBindings(DOC).has('e13') && !templateBindings(DOC).has('e2') && !templateBindings(DOC).has('e12'));
  const doctorDay = cloneTemplateElements(DOCTOR, TEMPLATE_ID);
  t('fallback-bound elements are shown with no text', value(doctorDay, 'e11')?.removed === false && value(doctorDay, 'e11')?.text === null && value(doctorDay, 'e2')?.removed === false);
  t('other unbound identity stays hidden', ['e3', 'e8', 'e9'].every((id) => value(doctorDay, id)?.removed === true));
  const doctorResolved = resolveDayElements(DOCTOR, doctorDay, BRAND, null);
  t('the person name prints the company name', same(actionOf(doctorResolved, 'e11'), { type: 'replace', text: 'Sirah healthcare agents' }));
  t('the credential prints the tagline', same(actionOf(doctorResolved, 'e2'), { type: 'replace', text: 'Automate your healthcare business' }));
  t('the other credentials are erased', same(actionOf(doctorResolved, 'e3'), { type: 'remove' }) && same(actionOf(doctorResolved, 'e9'), { type: 'remove' }));
  t('no tagline in Brand Canvas: the credential is hidden', same(actionOf(resolveDayElements(DOCTOR, doctorDay, { ...BRAND, tagline: null }, null), 'e2'), { type: 'remove' }));
  const doctorPrompt = buildClonePrompt({ resolved: doctorResolved, brandColors: null, identity: 'ai', orientation: 'vertical 4:5' });
  t('the prompt puts the company name in the doctor bar', doctorPrompt.includes('Person name (bottom centre): replace "Dr. HARI SHANKAR SINGH" with "Sirah healthcare agents".'));
  t('the old business identity is never an instruction value', !/with "(Dr\. HARI|Reg No|\+91 80907|Peerzadiguda|UROLOGIST)/.test(doctorPrompt));

  // ===========================================================================
  section('phase 0 fix: business name in the template words');
  // ===========================================================================
  t('replaces a whole phrase, case-insensitively', replaceBusinessName('Choose UROCARE clinic today.', ['Urocare Clinic'], 'Sirah Dental') === 'Choose Sirah Dental today.');
  t('never inside a longer word', replaceBusinessName('UrocareClinics and Urocare Clinical', ['Urocare Clinic'], 'X') === 'UrocareClinics and Urocare Clinical');
  t('the longest name wins', replaceBusinessName('Urocare Clinic and Urocare', ['Urocare', 'Urocare Clinic'], 'X') === 'X and X');
  t('names with regex characters are literal', replaceBusinessName('Visit A+ Care (Dental) now', ['A+ Care (Dental)'], 'Sirah') === 'Visit Sirah now');
  t('spacing inside the name is flexible', replaceBusinessName('Urocare   Clinic', ['Urocare Clinic'], 'X') === 'X');
  const named: TemplateElementsDoc = {
    ...DOC,
    elements: [...DOC.elements, el('e18', 'text', 'Choose Urocare Clinic.', [0.05, 0.6, 0.2, 0.03])],
  };
  const namedDay = cloneTemplateElements(named, TEMPLATE_ID, { businessName: 'Sirah healthcare agents' });
  t('a clone swaps the template business name in content words', value(namedDay, 'e18')?.text === 'Choose Sirah healthcare agents.' && value(namedDay, 'e18')?.source === 'template');
  t('without a business name the words are the template’s', value(cloneTemplateElements(named, TEMPLATE_ID), 'e18')?.text === 'Choose Urocare Clinic.');
  t('reconcile clones fresh with the swap', value(reconcileDayElements(named, null, TEMPLATE_ID, { businessName: 'Sirah' }), 'e18')?.text === 'Choose Sirah.');

  // ===========================================================================
  section('phase 0 fix: orphaned contact labels');
  // ===========================================================================
  const LABELS: TemplateElementsDoc = {
    version: 1,
    width: 1000,
    height: 1000,
    model: 'm',
    elements: [
      el('e1', 'headline', 'Headline', [0.05, 0.1, 0.5, 0.1]),
      el('e2', 'text', 'Call us on', [0.08, 0.82, 0.11, 0.03], { group: 'contact' }),
      el('e3', 'phone', '+220 7222772', [0.2, 0.82, 0.25, 0.03], { group: 'contact' }),
      el('e4', 'text', 'Visit us at:', [0.55, 0.82, 0.12, 0.03]),
      el('e5', 'address', 'Opposite Wulingkama Junction', [0.68, 0.82, 0.3, 0.03], { group: 'contact' }),
      el('e6', 'cta', 'Book an Appointment Today', [0.05, 0.9, 0.3, 0.02]),
      el('e7', 'website', 'www.edc.gm', [0.05, 0.925, 0.3, 0.02]),
    ],
  };
  const targets = contactLabelTargets(LABELS);
  t('a short label on the line of a detail introduces it', targets.get('e2') === 'e3');
  t('a colon label introduces the detail beside it', targets.get('e4') === 'e5');
  t('a call to action above a detail is not a label', !targets.has('e6') && !targets.has('e1'));
  const labelDay = cloneTemplateElements(LABELS, TEMPLATE_ID);
  const labelResolved = resolveDayElements(LABELS, labelDay, BRAND, null);
  t('the label of an erased address goes with it', same(actionOf(labelResolved, 'e4'), { type: 'remove' }) && same(actionOf(labelResolved, 'e5'), { type: 'remove' }));
  t('the label of a shown phone stays', same(actionOf(labelResolved, 'e2'), { type: 'keep' }));
  t('no phone in Brand Canvas: "Call us on" goes too', same(actionOf(resolveDayElements(LABELS, labelDay, { ...BRAND, phone: null }, null), 'e2'), { type: 'remove' }));
  const adminLabel = set(labelDay, 'e4', { text: 'Find us online:', source: 'admin' });
  t('a label an admin wrote is kept', same(actionOf(resolveDayElements(LABELS, adminLabel, BRAND, null), 'e4'), { type: 'replace', text: 'Find us online:' }));
  const aiLabel = set(labelDay, 'e4', { text: 'Find Us Here:', source: 'ai' });
  t('a rewritten label is still removed with its detail', same(actionOf(resolveDayElements(LABELS, aiLabel, BRAND, null), 'e4'), { type: 'remove' }));

  // ===========================================================================
  section('phase 0 fix: wide logo badge');
  // ===========================================================================
  const WIDE: TemplateElementsDoc = {
    ...DOCTOR,
    elements: [el('e1', 'logo', null, [0.6, 0.02, 0.38, 0.08], { description: 'kidney mark with CONSULTANT UROLOGIST lettering in a pill' }), ...DOCTOR.elements.slice(3)],
  };
  t('a logo box over twice as wide as tall is a badge', isLogoLockupBox(WIDE.elements[0]!.box, WIDE) && !isLogoLockupBox(DOCTOR.elements[0]!.box, DOCTOR));
  t('the threshold is measured in pixels, not fractions', !isLogoLockupBox({ x: 0, y: 0, w: 0.4, h: 0.1 }, { width: 500, height: 1000 }) && isLogoLockupBox({ x: 0, y: 0, w: 0.4, h: 0.1 }, { width: 1000, height: 1000 }));
  const wideDay = cloneTemplateElements(WIDE, TEMPLATE_ID);
  t('a badge with a mark-only client logo gets the company name', same(actionOf(resolveDayElements(WIDE, wideDay, BRAND, null), 'e1'), { type: 'logo', name: 'Sirah healthcare agents' }));
  t('a client logo that spells the name gets none', same(actionOf(resolveDayElements(WIDE, wideDay, { ...BRAND, logoIncludesName: true }, null), 'e1'), { type: 'logo' }));
  const wideWithName: TemplateElementsDoc = { ...WIDE, elements: [...WIDE.elements, el('e30', 'brandName', 'Urocare', [0.6, 0.11, 0.2, 0.03])] };
  t('a template printing its own brand name beside the badge gets none', same(actionOf(resolveDayElements(wideWithName, cloneTemplateElements(wideWithName, TEMPLATE_ID), BRAND, null), 'e1'), { type: 'logo' }));
  t('a square logo gets none', same(actionOf(doctorResolved, 'e1'), { type: 'logo' }));
  const widePrompt = buildClonePrompt({ resolved: resolveDayElements(WIDE, wideDay, BRAND, null), brandColors: null, identity: 'ai', orientation: 'vertical 4:5' });
  t('the prompt keeps the badge, leaves a square for the mark and writes the name', widePrompt.includes('keeping the badge or pill shape behind it') && widePrompt.includes('leave a square as tall as the badge as clean, empty background') && widePrompt.includes('Write "Sirah healthcare agents" in the rest of the badge'));
  t('lockup mark box: the left square, never wider than the badge', same(lockupMarkBox({ left: 240, top: 10, width: 152, height: 40 }), { left: 240, top: 10, width: 40, height: 40 }) && same(lockupMarkBox({ left: 0, top: 0, width: 20, height: 40 }), { left: 0, top: 0, width: 20, height: 40 }));

  // ===========================================================================
  section('phase 0 fix: colours, people, photos, corrections');
  // ===========================================================================
  const palette = [
    { hex: '#1F6FEB', role: 'primary' },
    { hex: '#0D2447', role: 'secondary' },
    { hex: '#F0A81E', role: 'accent' },
    { hex: '#F6F7F9', role: 'background' },
    { hex: '#222222', role: 'Neutral text' },
    { hex: 'blue', role: 'accent' },
  ];
  t('only accent roles are recoloured', same(cloneAccentColors(palette).map((color) => color.role), ['primary', 'secondary', 'accent']));
  t('no colours at all is an empty palette', cloneAccentColors(null).length === 0 && cloneAccentColors([{ hex: '#FFFFFF', role: 'background' }]).length === 0);
  const recoloured = buildClonePrompt({ resolved, brandColors: palette, identity: 'ai', orientation: 'vertical 4:5' });
  t('a background colour never reaches the prompt', !recoloured.includes('#F6F7F9') && !recoloured.includes('#222222') && recoloured.includes('primary #1F6FEB, secondary #0D2447, accent #F0A81E'));
  t('recolouring keeps every area’s lightness', recoloured.includes('Keep the lightness of every area: dark areas and backgrounds stay dark, light ones stay light.'));
  t('only background colours keep the template colours', buildClonePrompt({ resolved, brandColors: [{ hex: '#F6F7F9', role: 'background' }], identity: 'ai', orientation: 'x' }).includes('keep every colour exactly as in the original'));
  t('the image prompt describes the main photo; the inset gets a subject suited to the headline', ai.includes('Photo 2 (bottom right, portrait of a doctor with arms crossed): replace this photograph with a new realistic one suited to the headline "AUTOMATE BEYOND ROUTINE". This is a new photo shoot, not a retouch'), ai.split('\n').find((line) => line.includes('Photo 2')) ?? '');
  t('every photo line forbids the same person, even a small cut-out', ai.split('\n').filter((line) => line.includes('replace this photograph')).every((line) => line.includes('so nobody from the original is recognisable, even in a small cut-out portrait') && line.includes('a different gender or a clearly different age')));
  const corrected = buildClonePrompt({ resolved, brandColors: null, identity: 'ai', orientation: 'x', correction: '  The previous version was rejected in review for: logo too small.  ' });
  t('a review correction comes last', corrected.endsWith('The previous version was rejected in review for: logo too small.'));
  t('no correction adds nothing', buildClonePrompt({ resolved, brandColors: null, identity: 'ai', orientation: 'x', correction: '  ' }) === buildClonePrompt({ resolved, brandColors: null, identity: 'ai', orientation: 'x' }));

  // ===========================================================================
  section('clone output size');
  // ===========================================================================
  const sized = (w: number | null, h: number | null) => cloneSizeFor(w, h);
  t('4:5 → 1280x1600 (measured)', sized(736, 920)?.size === '1280x1600' && sized(736, 920)?.aspectLabel === '4:5' && sized(736, 920)?.orientation === 'vertical 4:5');
  t('735×919 snaps to 4:5', sized(735, 919)?.size === '1280x1600');
  t('2:3 → 1024x1536 (measured)', sized(736, 1104)?.size === '1024x1536' && sized(736, 1104)?.aspectLabel === '2:3');
  t('9:16 → 1008x1792', sized(900, 1600)?.size === '1008x1792');
  t('square → 1440x1440', sized(1080, 1080)?.size === '1440x1440' && sized(1080, 1080)?.orientation === 'square 1:1');
  t('landscape 16:9 → 1792x1008', sized(1920, 1080)?.size === '1792x1008' && sized(1920, 1080)?.orientation === 'horizontal 16:9');
  const odd = [sized(700, 1000), sized(1200, 628), sized(1000, 3000), sized(3000, 1000), sized(640, 1380)];
  t(
    'every size: sides multiples of 16, 1.5–2.1 MP, within 1:3–3:1',
    odd.every((entry) => entry !== null && entry.width % 16 === 0 && entry.height % 16 === 0 && entry.width * entry.height >= 1_500_000 && entry.width * entry.height <= 2_100_000 && entry.width / entry.height <= 3 && entry.width / entry.height >= 1 / 3),
    JSON.stringify(odd.map((entry) => entry?.size)),
  );
  t('an unnamed shape keeps its ratio closely', Math.abs(sized(700, 1000)!.width / sized(700, 1000)!.height - 0.7) < 0.01 && sized(700, 1000)!.aspectLabel === '0.70:1');
  t('beyond 1:3 or unmeasured: no size', sized(1000, 3100) === null && sized(0, 100) === null && sized(null, 100) === null && sized(Number.NaN, 10) === null);

  // ===========================================================================
  section('text check: verdict');
  // ===========================================================================
  const expected = expectedTexts(resolved, DOC);
  t('expected covers replace and keep words only', same(expected.map((item) => item.elementId), ['e3', 'e4', 'e6', 'e9', 'e10', 'e14', 'e15', 'e16']), expected.map((item) => item.elementId).join(','));
  t('normalisation folds case, whitespace, quotes and dashes', normalizeCheckText('  Let’s  GO –\nnow ') === "let's go - now");

  const places: Array<string | null> = expected.map((item) => item.expected);
  places[0] = 'automate  beyond\nROUTINE'; // case and whitespace only
  places[1] = 'Expert urology care'; // cut at a line break; the blocks hold the rest
  places[4] = '6381780864'; // wrong digits
  places[6] = null; // nothing legible
  const verdict = judgeCloneText({
    expected,
    read: {
      places,
      blocks: ['AUTOMATE BEYOND ROUTINE', 'Expert urology care', 'with compassion.', 'Advanced Technology', 'Dr. HARI SHANKAR SINGH, M.B.B.S'],
    },
    resolved,
    templateDoc: DOC,
    model: 'gpt-4o',
    now: new Date('2026-09-17T10:00:00Z'),
  });
  const item = (id: string) => verdict.items.find((entry) => entry.elementId === id);
  t('case and whitespace differences match', item('e3')?.match === true);
  t('a split read matches through joined blocks', item('e4')?.match === true && item('e4')?.found === 'Expert urology care with compassion.');
  t('wrong digits do not match and report what was read', item('e10')?.match === false && item('e10')?.found === '6381780864');
  t('nothing legible does not match', item('e15')?.match === false && item('e15')?.found === null);
  t('an exact leftover of a removed element is reported', verdict.leftovers.includes('Advanced Technology'));
  t('a long leftover inside a longer block is reported', verdict.leftovers.includes('Dr. HARI SHANKAR SINGH'));
  t('the old headline is not a leftover when gone', !verdict.leftovers.includes('CARE BEYOND TREATMENT'));
  t('ok is false with differences; the issue count adds both', verdict.ok === false && textCheckIssueCount(verdict) === 2 + verdict.leftovers.length);
  t('checkedAt and model are recorded', verdict.checkedAt === '2026-09-17T10:00:00.000Z' && verdict.model === 'gpt-4o');

  const clean = judgeCloneText({ expected, read: { places: expected.map((entry) => entry.expected), blocks: [] }, resolved, templateDoc: DOC, model: 'm' });
  t('everything matching and no leftovers is ok', clean.ok && textCheckIssueCount(clean) === 0);
  const contained = resolveDayElements(DOC, set(day, 'e3', { text: 'CARE BEYOND TREATMENT, EVERY DAY' }), BRAND, null);
  const containedVerdict = judgeCloneText({
    expected: expectedTexts(contained, DOC),
    read: { places: [], blocks: ['CARE BEYOND TREATMENT, EVERY DAY'] },
    resolved: contained,
    templateDoc: DOC,
    model: 'm',
  });
  t('old words inside the new words are not a leftover', !containedVerdict.leftovers.includes('CARE BEYOND TREATMENT'));

  // ===========================================================================
  section('text check: one bounded request');
  // ===========================================================================
  t('the text check gives up well before a generation claim goes stale', TEXT_CHECK_TIMEOUT_MS <= 120_000 && TEXT_CHECK_TIMEOUT_MS * 3 < STALE_GENERATION_MS);
  process.env.OPENAI_API_KEY = 'sk-check-template-elements-fake';
  process.env.OPENAI_MAX_ATTEMPTS = '3';
  {
    const schema = { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } };
    // A request that never answers: aborted by the per-request timeout, once.
    fetchCalls = 0;
    fetchHandler = (init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      });
    const started = Date.now();
    let timedOut: unknown = null;
    try {
      await generateStructured({ label: 'bounded', systemPrompt: 's', userPrompt: 'u', schema, schemaName: 'bounded', timeoutMs: 150, maxAttempts: 1 });
    } catch (error) {
      timedOut = error;
    }
    const elapsed = Date.now() - started;
    t('timeoutMs ends a request that never answers; maxAttempts 1 makes exactly one request', timedOut instanceof LlmError && timedOut.kind === 'transport' && fetchCalls === 1 && elapsed < 5_000, `${fetchCalls} requests in ${elapsed} ms`);

    // A retryable server error: the text check still makes one request, no SDK or own retry.
    fetchCalls = 0;
    fetchHandler = async () => new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status: 500, headers: { 'content-type': 'application/json' } });
    const poster = await sharp({ create: { width: 64, height: 80, channels: 3, background: '#ffffff' } }).png().toBuffer();
    let checkError: unknown = null;
    try {
      await checkCloneText({ bytes: poster, mimeType: 'image/png', resolved: resolveDayElements(DOC, day, BRAND, null), templateDoc: DOC });
    } catch (error) {
      checkError = error;
    }
    t('the clone text check makes one request and does not retry a 500', checkError instanceof LlmError && fetchCalls === 1, `${fetchCalls} requests`);

    // A normal answer still works through the same path.
    fetchCalls = 0;
    fetchHandler = async () =>
      new Response(
        JSON.stringify({
          id: 'x',
          object: 'chat.completion',
          created: 0,
          model: 'fake',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ places: [], blocks: ['CARE BEYOND TREATMENT'] }), refusal: null } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const answered = await checkCloneText({ bytes: poster, mimeType: 'image/png', resolved: resolveDayElements(DOC, day, BRAND, null), templateDoc: DOC });
    t('…and a normal answer is judged as before', fetchCalls === 1 && answered.items.length > 0);
    fetchHandler = async () => {
      throw new Error('network disabled by check:template-elements');
    };
  }

  // ===========================================================================
  section('identity compositing');
  // ===========================================================================
  t('pixel box scales and rounds', same(toPixelBox({ x: 0.1, y: 0.2, w: 0.5, h: 0.25 }, 1280, 1600), { left: 128, top: 320, width: 640, height: 400 }));
  t('pixel box stays inside the image', same(toPixelBox({ x: 0.99, y: 0.99, w: 0.5, h: 0.5 }, 100, 100), { left: 99, top: 99, width: 1, height: 1 }));
  t('text on the left is set flush left', identityTextAlign({ x: 0.05, y: 0.9, w: 0.2, h: 0.03 }) === 'start');
  t('text on the right edge is set flush right', identityTextAlign({ x: 0.7, y: 0.9, w: 0.25, h: 0.03 }) === 'end');
  t('text in the middle is centred', identityTextAlign({ x: 0.35, y: 0.9, w: 0.3, h: 0.03 }) === 'center');
  t('dark ink on a light ground', inkFor({ r: 245, g: 190, b: 60 }) === '#0B0B0D');
  t('light ink on a dark ground', inkFor({ r: 20, g: 60, b: 90 }) === '#FFFFFF');
  t('a hint forces the ink', inkFor({ r: 255, g: 255, b: 255 }, 'light') === '#FFFFFF');

  const logoBytes = await sharp({ create: { width: 200, height: 100, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
  const logo: ResolvedStudioLogo = { background: 'ORIGINAL', processing: 'as-uploaded', bytes: logoBytes, mimeType: 'image/png', isSvg: false, width: 200, height: 100, inkLuminance: null };
  const raw = await sharp({ create: { width: 400, height: 500, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const logoOnly = resolveDayElements(DOC, day, BRAND, null).filter((entry) => entry.element.id === 'e1' || entry.element.id === 'e10');
  const composed = await composeCloneIdentity(raw, { resolved: logoOnly, logo, drawIdentityText: false });
  const pixel = async (x: number, y: number) => {
    const { data } = await sharp(composed).extract({ left: x, top: y, width: 1, height: 1 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return [data[0], data[1], data[2]];
  };
  // e1 box 0.65,0.03,0.08,0.07 on 400x500 → left 260, top 15, 32x35; a 2:1 logo fits 28x14 centred.
  t('the logo lands in the centre of its box', same(await pixel(276, 32), [255, 0, 0]), JSON.stringify(await pixel(276, 32)));
  t('the logo keeps its aspect ratio (no red above it)', same(await pixel(276, 18), [255, 255, 255]));
  t('nothing is drawn outside logo boxes without identity text', same(await pixel(40, 460), [255, 255, 255]));
  const meta = await sharp(composed).metadata();
  t('the composite is a PNG of the raw size', meta.format === 'png' && meta.width === 400 && meta.height === 500);

  // A wide badge: the logo goes into its left square, and nothing into the rest.
  const badgeDoc: TemplateElementsDoc = { ...DOC, width: 400, height: 500, elements: [el('e1', 'logo', null, [0.6, 0.02, 0.38, 0.08], { description: 'badge' })] };
  const badgeResolved = resolveDayElements(badgeDoc, cloneTemplateElements(badgeDoc, TEMPLATE_ID), BRAND, null);
  const badge = await composeCloneIdentity(raw, { resolved: badgeResolved, logo, drawIdentityText: false });
  const badgePixel = async (x: number, y: number) => {
    const { data } = await sharp(badge).extract({ left: x, top: y, width: 1, height: 1 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return [data[0], data[1], data[2]];
  };
  // Box 240,10 152x40 → square 40x40 at 240,10; a 2:1 logo fits 36x18 centred at 242..278, 21..39.
  t('a badge logo is composited into its left square', same(await badgePixel(258, 30), [255, 0, 0]), JSON.stringify(await badgePixel(258, 30)));
  t('…and the rest of the badge is left for the written name', same(await badgePixel(330, 30), [255, 255, 255]));

  // Text the model let run into a logo box: the logo goes into the part it left clean.
  t('longest run: first on a tie, null when none', same(longestRun([true, true, false, true, true]), [0, 2]) && same(longestRun([false, true, true, true]), [1, 4]) && longestRun([false, false]) === null);
  const boxPixels = (paint: (x: number, y: number) => number) => {
    const width = 100;
    const height = 50;
    const data = Buffer.alloc(width * height * 3, 255);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) data.fill(paint(x, y), (y * width + x) * 3, (y * width + x) * 3 + 3);
    return { data, width, height, channels: 3 };
  };
  // A 20px-tall word stem in columns 80–89, a thin diagonal outline across the left, a 1px top rule.
  const withText = boxPixels((x, y) => ((x >= 80 && x < 90 && y >= 15 && y < 35) || Math.abs(y - (x - 5)) < 1 || y === 0 ? 20 : 255));
  t('a logo box with words run into it: the clean part before the words, below the rule; a thin outline is not ink', same(clearPartFromPixels(withText), { left: 0, top: 1, width: 80, height: 49 }), JSON.stringify(clearPartFromPixels(withText)));
  t('a clean box is used whole', same(clearPartFromPixels(boxPixels(() => 255)), { left: 0, top: 0, width: 100, height: 50 }));
  let noise = 1;
  const patterned = boxPixels(() => ((noise = (noise * 48271) % 2147483647) % 2 === 0 ? 30 : 230));
  t('a box over a photograph or pattern is used whole', same(clearPartFromPixels(patterned), { left: 0, top: 0, width: 100, height: 50 }));
  t('a clean part under half the box is not used', same(clearPartFromPixels(boxPixels((x) => (x >= 40 && x < 60 ? 20 : 255))), { left: 0, top: 0, width: 100, height: 50 }));
  // Composite: 400x500 white raw with a dark word at the right of logo box e1 (260..292 x 15..50).
  const intruded = await sharp(raw).composite([{ input: await sharp({ create: { width: 8, height: 20, channels: 3, background: '#101010' } }).png().toBuffer(), left: 286, top: 22 }]).png().toBuffer();
  const moved = await composeCloneIdentity(intruded, { resolved: logoOnly, logo, drawIdentityText: false });
  const movedPixel = async (x: number, y: number) => {
    const { data } = await sharp(moved).extract({ left: x, top: y, width: 1, height: 1 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return [data[0], data[1], data[2]];
  };
  t('the logo moves left of words that run into its box, and never covers them', same(await movedPixel(272, 32), [255, 0, 0]) && same(await movedPixel(289, 30), [16, 16, 16]), JSON.stringify([await movedPixel(272, 32), await movedPixel(289, 30)]));

  console.log(`\n${bad === 0 ? 'All checks passed.' : `${bad} check(s) FAILED.`}`);
  if (bad > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
