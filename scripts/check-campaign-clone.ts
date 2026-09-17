/**
 * Fixture suite for clone mode's campaign rules: the clone-into-queue planner
 * (src/lib/campaign/clone-queue.ts) and the element editor's pure helpers
 * (src/lib/campaign/clone-editor.ts) — edit validation, the rewrite length
 * window and its clamp.
 *
 * Pure: no database, no network, no provider. The database-backed half is
 * `check-campaign-clone-db.ts`.
 *
 * Run: npm run check:campaign-clone
 */
import { applyElementEdits, clampRewrite, rewriteLengthBounds } from '@/lib/campaign/clone-editor';
import { planCloneQueue, type CloneQueueDay } from '@/lib/campaign/clone-queue';
import { CampaignDomainError } from '@/lib/campaign/service';
import { cloneTemplateElements, type TemplateElement, type TemplateElementsDoc } from '@/lib/types/template-elements';

let bad = 0;
const t = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) bad += 1;
};
const section = (title: string) => console.log(`\n--- ${title} ${'-'.repeat(Math.max(0, 58 - title.length))}`);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ===========================================================================
section('clone into queue: planner');
// ===========================================================================
const days = (spec: string): CloneQueueDay[] =>
  // "e" eligible, "A"/"B"/"C"/"-" a day that keeps that template (or none).
  [...spec].map((char, index) => ({
    id: `d${index + 1}`,
    dayNumber: index + 1,
    templateId: char === 'e' || char === '-' ? null : char,
    eligible: char === 'e',
  }));
const templatesOf = (spec: string, templates: string[]) => {
  const plan = new Map(planCloneQueue(days(spec), templates).map((entry) => [entry.dayNumber, entry.templateId]));
  return [...spec].map((char, index) => (char === 'e' ? (plan.get(index + 1) ?? '?') : char)).join('');
};

t('templates cycle in upload order across the days', templatesOf('eeeeeee', ['A', 'B', 'C']) === 'ABCABCA');
t('cycling is by position, so a partly filled campaign gets what it would have had', templatesOf('-e-e-e', ['A', 'B', 'C']) === '-B-A-C', templatesOf('-e-e-e', ['A', 'B', 'C']));
t('a day that keeps its template is never reassigned', planCloneQueue(days('eAe'), ['A', 'B']).every((entry) => entry.dayNumber !== 2));
t('no repeat of the day before', templatesOf('Ae', ['A', 'B']) === 'AB');
t('no repeat of a kept day after', templatesOf('eB', ['A', 'B']) === 'AB' && templatesOf('eA', ['A', 'B']) === 'BA');
t('squeezed between two kept templates, it differs from the day before at least', templatesOf('AeB', ['A', 'B']) === 'ABB');
t('three templates never repeat a neighbour', templatesOf('AeB', ['A', 'B', 'C']) === 'ACB');
t('one template repeats, necessarily', templatesOf('eeee', ['A']) === 'AAAA');
t('no templates, no assignments', planCloneQueue(days('eee'), []).length === 0);
t('days are planned in day order whatever the input order', same(planCloneQueue([...days('eee')].reverse(), ['A', 'B', 'C']).map((entry) => entry.templateId), ['A', 'B', 'C']));
{
  // Property: with at least three templates, no assigned day matches either neighbour.
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let violations = 0;
  for (let run = 0; run < 300; run += 1) {
    const count = 3 + Math.floor(random() * 3);
    const templates = ['A', 'B', 'C', 'D', 'E'].slice(0, count);
    const spec = Array.from({ length: 5 + Math.floor(random() * 25) }, () => (random() < 0.6 ? 'e' : random() < 0.2 ? '-' : templates[Math.floor(random() * count)]!)).join('');
    const result = templatesOf(spec, templates);
    for (let index = 0; index < result.length; index += 1) {
      if (spec[index] !== 'e') continue;
      if (result[index] === result[index - 1] || result[index] === result[index + 1]) violations += 1;
    }
  }
  t('property: three or more templates never put the same template on consecutive days', violations === 0, `${violations} violations`);
  let twoViolations = 0;
  for (let run = 0; run < 300; run += 1) {
    const spec = Array.from({ length: 5 + Math.floor(random() * 25) }, () => 'e').join('');
    const result = templatesOf(spec, ['A', 'B']);
    for (let index = 1; index < result.length; index += 1) if (result[index] === result[index - 1]) twoViolations += 1;
  }
  t('property: two templates alternate on fully empty campaigns', twoViolations === 0);
}

// ===========================================================================
section('element edits: validation');
// ===========================================================================
const el = (id: string, kind: TemplateElement['kind'], text: string | null, y: number): TemplateElement => ({
  id,
  kind,
  text,
  box: { x: 0.05, y, w: 0.4, h: 0.04 },
  group: null,
  description: kind === 'photo' || kind === 'logo' ? 'picture' : null,
});
const DOC: TemplateElementsDoc = {
  version: 1,
  width: 1080,
  height: 1350,
  model: 'm',
  elements: [
    el('e1', 'logo', null, 0.02),
    el('e2', 'headline', 'Care you can see', 0.1),
    el('e3', 'photo', null, 0.3),
    el('e4', 'feature', 'Painless check-ups', 0.6),
    el('e5', 'phone', '+1 555 0100', 0.8),
    el('e6', 'address', '12 Old Road', 0.85),
    el('e7', 'personName', 'Dr. Old Name', 0.9),
  ],
};
const TEMPLATE_ID = '03c6d26a-5752-4acc-8b84-f6952346a6c9';
const fresh = cloneTemplateElements(DOC, TEMPLATE_ID);
const refused = (name: string, work: () => unknown, pattern: RegExp) => {
  try {
    work();
    t(name, false, 'accepted');
  } catch (error) {
    t(name, error instanceof CampaignDomainError && error.code === 'invalid-input' && pattern.test(error.message), error instanceof Error ? error.message : String(error));
  }
};
refused('an id that is not an element is refused', () => applyElementEdits(DOC, fresh, [{ id: 'e99', text: 'x' }]), /not an element/);
refused('an element listed twice is refused', () => applyElementEdits(DOC, fresh, [{ id: 'e2', text: 'a' }, { id: 'e2', removed: true }]), /twice/);
refused('words on a photo are refused', () => applyElementEdits(DOC, fresh, [{ id: 'e3', text: 'a nurse' }]), /photograph/);
refused('words on the logo are refused', () => applyElementEdits(DOC, fresh, [{ id: 'e1', text: 'Acme' }]), /logo/);
refused('words on a Brand Canvas phone are refused', () => applyElementEdits(DOC, fresh, [{ id: 'e5', text: '999' }]), /Brand Canvas/);
refused('words on a person name bound to the company name are refused', () => applyElementEdits(DOC, fresh, [{ id: 'e7', text: 'Dr. New' }]), /Brand Canvas/);
{
  const next = applyElementEdits(DOC, fresh, [
    { id: 'e2', text: '  New \n  headline  ' },
    { id: 'e4', removed: true },
    { id: 'e5', text: null, removed: true },
    { id: 'e3', text: '' },
    { id: 'e6', text: 'x'.repeat(400), removed: false },
  ]);
  const value = (id: string) => next.values.find((entry) => entry.id === id)!;
  t('words are trimmed and whitespace collapsed, marked as the admin’s', value('e2').text === 'New headline' && value('e2').source === 'admin');
  t('removal toggles without touching words', value('e4').removed && value('e4').text === 'Painless check-ups' && value('e4').source === 'template');
  t('a bound element may be hidden, never given words', value('e5').removed && value('e5').text === null);
  t('an empty text on a photo is accepted as no change', value('e3').text === null && !value('e3').removed);
  t('unbound identity takes the admin’s words, capped at 300 characters', value('e6').text?.length === 300 && !value('e6').removed);
  t('the input document is not mutated', fresh.values.find((entry) => entry.id === 'e2')!.text === 'Care you can see');
  const unchanged = applyElementEdits(DOC, fresh, [{ id: 'e2', text: 'Care you can see' }]);
  t('the same words keep their source', same(unchanged, fresh));
  const cleared = applyElementEdits(DOC, fresh, [{ id: 'e2', text: '   ' }]);
  t('blank words clear the text', cleared.values.find((entry) => entry.id === 'e2')!.text === null);
  t('an AI rewrite is marked as the AI’s', applyElementEdits(DOC, fresh, [{ id: 'e2', text: 'Smiles made simple' }], 'ai').values.find((entry) => entry.id === 'e2')!.source === 'ai');
}

// ===========================================================================
section('rewrite: length window and clamp');
// ===========================================================================
t('±20% of the template text, rounded inward', same(rewriteLengthBounds('Painless check-ups'), { minLength: 15, maxLength: 21 }));
t('a one-word text still has a window', same(rewriteLengthBounds('Go'), { minLength: 2, maxLength: 2 }) && same(rewriteLengthBounds(' '), { minLength: 1, maxLength: 1 }));
const item = { templateText: 'Painless check-ups', ...rewriteLengthBounds('Painless check-ups') };
t('a rewrite inside the window is kept, whitespace collapsed', clampRewrite('  Gentle   dental exams ', item) === 'Gentle dental exams');
t('too long: cut at the last word boundary that fits', clampRewrite('Gentle exams for every family member', item) === 'Gentle exams for', String(clampRewrite('Gentle exams for every family member', item)));
t('too long with no usable boundary: cut hard at the limit', clampRewrite('Supercalifragilisticexpialidocious', { templateText: 'Painless check-ups', minLength: 15, maxLength: 21 }) === 'Supercalifragilistice');
t('too short: refused, the space would be left empty', clampRewrite('Exams', item) === null);
t('empty: refused', clampRewrite('   ', item) === null);
const wide = { templateText: 'Book an appointment with us today', minLength: 10, maxLength: 60 };
t('an invented web address is refused', clampRewrite('Book online at www.smiles.com today', wide) === null);
t('an invented email is refused', clampRewrite('Write to hello@smiles.io for a visit', wide) === null);
t('an invented phone number is refused', clampRewrite('Call 080 4000 1234 to book a visit', wide) === null);
t('an invented price or discount is refused', clampRewrite('Book now and get 20% off today', wide) === null && clampRewrite('Check-ups from ₹499 this month', wide) === null);
t('a figure the template already had is allowed', clampRewrite('Now 30% off every cleaning', { templateText: 'Get 20% off all cleanings', minLength: 10, maxLength: 40 }) === 'Now 30% off every cleaning');

console.log(`\n${bad === 0 ? 'All campaign clone checks passed.' : `${bad} check(s) FAILED.`}`);
process.exit(bad === 0 ? 0 : 1);
