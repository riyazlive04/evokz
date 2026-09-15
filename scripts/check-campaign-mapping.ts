/**
 * Fixture suite for campaign template mapping (src/lib/campaign/template-mapping.ts).
 *
 * Pure: no database, no network, no provider. The database-backed half is
 * `check-campaign-mapping-db.ts`.
 *
 * Run: npm run check:campaign-mapping
 */
import {
  aspectFit,
  contentFit,
  dayMappingState,
  describeAspect,
  diagnoseUnmapped,
  expandManualAssignment,
  fingerprintOf,
  isAutoCompatible,
  needsAction,
  planAutoMap,
  summarizeMapping,
  templateBlocker,
  type AutoMapPlan,
  type MappingDay,
  type MappingTarget,
  type MappingTemplate,
} from '@/lib/campaign/template-mapping';

let bad = 0;
const t = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) bad += 1;
};
const section = (title: string) => console.log(`\n--- ${title} ${'-'.repeat(Math.max(0, 58 - title.length))}`);

const V = 'vertical-a';
const PORTRAIT = 9 / 16;
const target = (overrides: Partial<MappingTarget> = {}): MappingTarget => ({
  categoryId: V,
  mode: 'AUTO',
  aspect: PORTRAIT,
  aspectLabel: '9:16',
  contentTypeLabels: { educational: 'Educational', promo: 'Promotional', 'myth-vs-fact': 'Myth vs fact' },
  ...overrides,
});
const tpl = (id: string, overrides: Partial<MappingTemplate> = {}): MappingTemplate => ({
  id,
  label: id.toUpperCase(),
  categoryId: V,
  isActive: true,
  approved: true,
  aspect: PORTRAIT,
  contentTypes: [],
  ...overrides,
});
const days = (count: number, typeFor: (n: number) => string | null = () => 'educational', overrides: Record<number, Partial<MappingDay>> = {}): MappingDay[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `day-${i + 1}`,
    dayNumber: i + 1,
    contentType: typeFor(i + 1),
    posterTemplateId: null,
    suggestedTemplateId: null,
    ...overrides[i + 1],
  }));
const pick = (plan: AutoMapPlan) => plan.entries.map((entry) => entry.templateId);
/** The days as they would be after an apply: suggestions written, mode AUTO. */
const applied = (input: MappingDay[], plan: AutoMapPlan): MappingDay[] =>
  input.map((day) => ({ ...day, suggestedTemplateId: plan.entries.find((entry) => entry.dayId === day.id)!.suggestedTemplateId }));

// ===========================================================================
section('compatibility rules');
// ===========================================================================
t('same shape within 2% matches (1080×1918 vs 9:16)', aspectFit(1080 / 1918, PORTRAIT) === 'match');
t('square template does not fit a 9:16 campaign', aspectFit(1, PORTRAIT) === 'mismatch');
t('an unmeasured template fits (it renders at the preset)', aspectFit(0, PORTRAIT) === 'unmeasured');
t('untagged template suits any content type', contentFit([], 'educational') === 'generic');
t('tagged template suits its own type', contentFit(['educational'], 'educational') === 'specific');
t('tagged template does not suit another type', contentFit(['promo'], 'educational') === 'mismatch');
t('inactive template is blocked', templateBlocker(tpl('a', { isActive: false }), target()) === 'inactive');
t('unapproved template is blocked', templateBlocker(tpl('a', { approved: false }), target()) === 'unapproved');
t('a template from another vertical is blocked first', templateBlocker(tpl('a', { categoryId: 'other', isActive: false }), target()) === 'wrong-vertical');
t('describeAspect names common shapes', describeAspect(PORTRAIT) === '9:16' && describeAspect(1) === '1:1' && describeAspect(0.8) === '4:5' && describeAspect(0) === 'unmeasured');
t('isAutoCompatible needs every rule', isAutoCompatible(tpl('a'), days(1)[0]!, target()) && !isAutoCompatible(tpl('a', { aspect: 1 }), days(1)[0]!, target()));

// ===========================================================================
section('deterministic auto map');
// ===========================================================================
{
  const templates = [tpl('t1'), tpl('t2'), tpl('t3')];
  const input = days(12);
  const first = planAutoMap({ days: input, templates, target: target() });
  const second = planAutoMap({ days: input, templates, target: target() });
  t('identical inputs give an identical plan', JSON.stringify(first) === JSON.stringify(second));
  const shuffled = planAutoMap({ days: [...input].reverse(), templates, target: target() });
  t('day input order does not matter', JSON.stringify(pick(shuffled)) === JSON.stringify(pick(first)));
  t('every day mapped as new', first.counts.new === 12 && first.counts.unmapped === 0);
  t('round robin in upload order: t1 t2 t3 t1 …', pick(first).join(',') === 't1,t2,t3,t1,t2,t3,t1,t2,t3,t1,t2,t3', pick(first).join(','));
  t('no template on two consecutive days', pick(first).every((id, i, all) => i === 0 || id !== all[i - 1]));
  t('fingerprint is stable for the same plan', first.fingerprint === second.fingerprint);
  t('fingerprint hash is stable across runs', fingerprintOf('abc') === fingerprintOf('abc') && fingerprintOf('abc') !== fingerprintOf('abd'));

  const reapplied = planAutoMap({ days: applied(input, first), templates, target: target() });
  t('running Auto Map again after applying changes nothing', reapplied.counts.keep === 12 && reapplied.counts.changes === 0, JSON.stringify(reapplied.counts));
  t('…and its fingerprint differs from the first (no writes left)', reapplied.fingerprint !== first.fingerprint);
}

// ===========================================================================
section('content type compatibility');
// ===========================================================================
{
  const templates = [tpl('generic'), tpl('edu', { contentTypes: ['educational'] }), tpl('promo', { contentTypes: ['promo'] })];
  const input = days(6, (n) => (n % 3 === 0 ? 'promo' : 'educational'));
  const plan = planAutoMap({ days: input, templates, target: target() });
  const byDay = new Map(plan.entries.map((entry) => [entry.dayNumber, entry.templateId]));
  t('a promo day gets the promo-tagged template', byDay.get(3) === 'promo' && byDay.get(6) === 'promo');
  t('the promo template never lands on an educational day', plan.entries.every((entry) => entry.templateId !== 'promo' || input[entry.dayNumber - 1]!.contentType === 'promo'));
  t('educational days prefer the educational-tagged template, avoiding repeats with the generic one', byDay.get(1) === 'edu' && byDay.get(2) === 'generic' && byDay.get(4) === 'edu', JSON.stringify([...byDay]));

  const futureVertical = target({ categoryId: V, contentTypeLabels: { 'neighbourhood-guide': 'Neighbourhood guide', 'open-house': 'Open house' } });
  const realEstate = planAutoMap({
    days: days(2, (n) => (n === 1 ? 'neighbourhood-guide' : 'open-house')),
    templates: [tpl('guide', { contentTypes: ['neighbourhood-guide'] }), tpl('open', { contentTypes: ['open-house'] })],
    target: futureVertical,
  });
  t('works for any vertical\'s own content-type keys', pick(realEstate).join() === 'guide,open');
}

// ===========================================================================
section('aspect ratio compatibility');
// ===========================================================================
{
  const templates = [tpl('square', { aspect: 1 }), tpl('unmeasured', { aspect: 0 }), tpl('portrait')];
  const plan = planAutoMap({ days: days(4), templates, target: target() });
  t('a 1:1 template is never auto-assigned to a 9:16 campaign', plan.entries.every((entry) => entry.templateId !== 'square'));
  t('a measured match ranks before an unmeasured template', pick(plan)[0] === 'portrait' && pick(plan)[1] === 'unmeasured');
  const onlySquare = planAutoMap({ days: days(2), templates: [tpl('square', { aspect: 1 })], target: target() });
  t('no compatible shape → unmapped with a useful reason', onlySquare.counts.unmapped === 2 && /draws 9:16 posters \(available: 1:1\)/.test(onlySquare.entries[0]!.unmappedReason?.detail ?? ''), onlySquare.entries[0]!.unmappedReason?.detail);
}

// ===========================================================================
section('inactive and unapproved templates are excluded');
// ===========================================================================
{
  const plan = planAutoMap({ days: days(6), templates: [tpl('off', { isActive: false }), tpl('draft', { approved: false }), tpl('ok')], target: target() });
  t('only the active, approved template is used', plan.entries.every((entry) => entry.templateId === 'ok'));
  t('a lone compatible template repeats and says so (not unmapped)', plan.counts.unmapped === 0 && plan.entries.slice(1).every((entry) => entry.repeatsPreviousDay) && !plan.entries[0]!.repeatsPreviousDay);
  const none = planAutoMap({ days: days(2), templates: [tpl('off', { isActive: false }), tpl('draft', { approved: false })], target: target() });
  t('none active and approved → unmapped, reason names it', none.counts.unmapped === 2 && /both active and approved/.test(none.entries[0]!.unmappedReason?.detail ?? ''));
  const empty = planAutoMap({ days: days(1), templates: [], target: target() });
  t('a vertical with no templates → unmapped, reason names it', empty.counts.unmapped === 1 && /no templates yet/.test(empty.entries[0]!.unmappedReason?.detail ?? ''));
  const wrongType = diagnoseUnmapped(days(1, () => 'myth-vs-fact')[0]!, [tpl('edu', { contentTypes: ['educational'] })], target());
  t('no template for the content type → reason names the type', /suits Myth vs fact/.test(wrongType?.detail ?? ''), wrongType?.detail);
  t('diagnoseUnmapped is null when a template fits', diagnoseUnmapped(days(1)[0]!, [tpl('ok')], target()) === null);
}

// ===========================================================================
section('manual mappings are never touched');
// ===========================================================================
{
  const templates = [tpl('t1'), tpl('t2'), tpl('t3')];
  const input = days(6, () => 'educational', { 2: { posterTemplateId: 't3' }, 5: { posterTemplateId: 't1', suggestedTemplateId: 't2' } });
  const plan = planAutoMap({ days: input, templates, target: target() });
  const manual = plan.entries.filter((entry) => entry.outcome === 'manual');
  t('manual days reported as manual', manual.map((entry) => entry.dayNumber).join() === '2,5');
  t('manual days are never written', manual.every((entry) => !entry.writesSuggestion && !entry.effectiveChanges && entry.templateId === input[entry.dayNumber - 1]!.posterTemplateId));
  t('neighbours avoid the manual template (day 1 and 3 ≠ t3)', plan.entries[0]!.templateId !== 't3' && plan.entries[2]!.templateId !== 't3', pick(plan).join());

  const rebalance = planAutoMap({ days: applied(input, plan), templates: [tpl('t4'), ...templates], target: target(), scope: 'rebalance' });
  t('rebalance re-picks AUTO days but still never a manual one', rebalance.entries.filter((entry) => entry.outcome === 'manual').length === 2 && rebalance.entries.every((entry) => entry.outcome !== 'manual' || !entry.writesSuggestion));
  t('rebalance can introduce a new template', rebalance.entries.some((entry) => entry.templateId === 't4'));
}

// ===========================================================================
section('mixed mode: auto → manual change → auto again');
// ===========================================================================
{
  const templates = [tpl('t1'), tpl('t2'), tpl('t3')];
  const start = days(9);
  const first = planAutoMap({ days: start, templates, target: target() });
  const afterAuto = applied(start, first);
  // The operator overrides day 4 with t1 (the auto choice was t1 → choose t3 instead).
  const afterManual = afterAuto.map((day) => (day.dayNumber === 4 ? { ...day, posterTemplateId: 't3' } : day));
  const second = planAutoMap({ days: afterManual, templates, target: target() });
  t('day 4 stays MANUAL t3', second.entries[3]!.outcome === 'manual' && second.entries[3]!.templateId === 't3');
  t('valid AUTO days are kept, nothing rewritten', second.counts.keep === 8 && second.counts.changes === 0, JSON.stringify(second.counts));
  const state = dayMappingState(afterManual[3]!, new Map(templates.map((x) => [x.id, x])), target());
  t('day 4 is marked as a manual override of an auto mapping', state.source === 'MANUAL' && state.overridesAuto);
}

// ===========================================================================
section('template deactivation');
// ===========================================================================
{
  const templates = [tpl('t1', { isActive: false }), tpl('t2'), tpl('t3')];
  const input = days(4, () => 'educational', { 1: { posterTemplateId: 't1' }, 2: { suggestedTemplateId: 't1' }, 3: { suggestedTemplateId: 't3' } });
  const byId = new Map(templates.map((x) => [x.id, x]));
  const manualState = dayMappingState(input[0]!, byId, target());
  t('a manual day on an inactive template: "Template inactive — action required"', manualState.issues[0]?.title === 'Template inactive — action required' && needsAction(manualState));
  t('…it is still assigned (not silently replaced)', manualState.templateId === 't1');

  const plan = planAutoMap({ days: input, templates, target: target() });
  t('Auto Map leaves the manual day on it, reports the conflict and suggests a replacement', plan.entries[0]!.outcome === 'manual' && plan.entries[0]!.conflict?.code === 'template-inactive' && plan.entries[0]!.replacementTemplateId === 't2' && !plan.entries[0]!.writesSuggestion);
  t('an AUTO day on it is replaced in the preview, with the reason', plan.entries[1]!.outcome === 'replace' && plan.entries[1]!.conflict?.code === 'template-inactive' && plan.entries[1]!.templateId !== 't1');
  t('a valid AUTO day is kept', plan.entries[2]!.outcome === 'keep');

  const noAlternative = planAutoMap({ days: days(1, () => 'educational', { 1: { suggestedTemplateId: 't1' } }), templates: [tpl('t1', { isActive: false })], target: target() });
  t('an AUTO day with no replacement becomes unmapped rather than keeping an inactive template', noAlternative.entries[0]!.outcome === 'unmapped' && noAlternative.entries[0]!.suggestedTemplateId === null && noAlternative.entries[0]!.conflict?.code === 'template-inactive');

  const unapproved = dayMappingState(days(1, () => 'educational', { 1: { posterTemplateId: 'd' } })[0]!, new Map([['d', tpl('d', { approved: false })]]), target());
  t('an unapproved assigned template needs action too', unapproved.issues[0]?.code === 'template-unapproved' && needsAction(unapproved));
  const shaped = dayMappingState(days(1, () => 'educational', { 1: { posterTemplateId: 's' } })[0]!, new Map([['s', tpl('s', { aspect: 1 })]]), target());
  t('a manual different-shape choice is a warning, not an action', shaped.issues[0]?.code === 'aspect-mismatch' && !needsAction(shaped));
}

// ===========================================================================
section('MANUAL mode campaigns');
// ===========================================================================
{
  const templates = [tpl('t1'), tpl('t2')];
  const input = days(3, () => 'educational', { 1: { suggestedTemplateId: 't1' } });
  const manualTarget = target({ mode: 'MANUAL' });
  const state = dayMappingState(input[0]!, new Map(templates.map((x) => [x.id, x])), manualTarget);
  t('a suggestion is not used under MANUAL', state.templateId === null && state.ignoredSuggestionId === 't1');
  const plan = planAutoMap({ days: input, templates, target: manualTarget });
  t('applying switches the campaign to AUTO', plan.switchesMode);
  t('the stored valid suggestion becomes a new mapping without a rewrite', plan.entries[0]!.outcome === 'new' && !plan.entries[0]!.writesSuggestion && plan.entries[0]!.effectiveChanges);
}

// ===========================================================================
section('manual and bulk assignment expansion');
// ===========================================================================
{
  const selection = expandManualAssignment({ kind: 'days', dayNumbers: [11, 2, 5, 8], templateId: 't4' }, 30);
  t('selected days → one template, in day order', selection.ok && selection.items.map((item) => `${item.dayNumber}:${item.templateId}`).join() === '2:t4,5:t4,8:t4,11:t4');
  const duplicate = expandManualAssignment({ kind: 'days', dayNumbers: [2, 5, 2], templateId: 't4' }, 30);
  t('a day listed twice is refused (one template per day)', !duplicate.ok && /Day 2 is listed twice/.test(duplicate.error));
  const outside = expandManualAssignment({ kind: 'days', dayNumbers: [31], templateId: 't4' }, 30);
  t('a day outside the campaign is refused', !outside.ok);
  const range = expandManualAssignment({ kind: 'range', fromDay: 1, toDay: 30, templateId: 't2' }, 30);
  t('days 1–30 → one template', range.ok && range.items.length === 30 && range.items.every((item) => item.templateId === 't2'));
  t('a reversed range is refused', !expandManualAssignment({ kind: 'range', fromDay: 9, toDay: 3, templateId: 't2' }, 30).ok);
  const pattern = expandManualAssignment({ kind: 'pattern', fromDay: 1, toDay: 7, templateIds: ['t1', 't2', 't3'] }, 30);
  t('repeat pattern T1 → 1, T2 → 2, T3 → 3, T1 → 4 …', pattern.ok && pattern.items.map((item) => item.templateId).join() === 't1,t2,t3,t1,t2,t3,t1');
  t('an empty pattern is refused', !expandManualAssignment({ kind: 'pattern', fromDay: 1, toDay: 3, templateIds: [] }, 30).ok);
  const clear = expandManualAssignment({ kind: 'days', dayNumbers: [3], templateId: null }, 30);
  t('clearing is an assignment of null', clear.ok && clear.items[0]!.templateId === null);
}

// ===========================================================================
section('summary');
// ===========================================================================
{
  const templates = [tpl('t1', { isActive: false }), tpl('t2'), tpl('sq', { aspect: 1, contentTypes: ['promo'] })];
  const byId = new Map(templates.map((x) => [x.id, x]));
  const input = days(5, (n) => (n === 5 ? 'myth-vs-fact' : 'educational'), { 1: { posterTemplateId: 't1' }, 2: { posterTemplateId: 't2', suggestedTemplateId: 'sq' }, 3: { suggestedTemplateId: 't2' } });
  const rows = input.map((day) => {
    const state = dayMappingState(day, byId, target());
    return { dayNumber: day.dayNumber, state, unmappedReason: state.templateId ? null : diagnoseUnmapped(day, templates, target()) };
  });
  const summary = summarizeMapping(rows);
  t('counts mapped, auto, manual, unmapped, overridden', summary.mapped === 3 && summary.manual === 2 && summary.auto === 1 && summary.unmapped === 2 && summary.overridden === 1, JSON.stringify(summary));
  t('attention lists the inactive template day only (days 4–5 can still be auto mapped)', summary.attention.map((row) => `${row.dayNumber}:${row.issue.code}`).join() === '1:template-inactive', JSON.stringify(summary.attention));
}

console.log(`\n${bad === 0 ? 'All campaign mapping checks passed.' : `${bad} check(s) FAILED.`}`);
process.exit(bad === 0 ? 0 : 1);
