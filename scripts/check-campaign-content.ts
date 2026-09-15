/**
 * Fixture suite for campaign content generation rules — strategy, day
 * assignment, chunking, prompts and validation.
 *
 * Pure: no database, no network, no model. The database half is
 * `check-campaign-content-db.ts`.
 *
 * Run: npm run check:campaign-content
 */
import {
  buildContentHistory,
  buildContentSchema,
  buildContentSystemPrompt,
  buildContentUserPrompt,
  chunkDays,
  CONTENT_CHUNK_DAYS,
  normalizeForComparison,
  selectTargetDays,
  validateGeneratedChunk,
  type ContentBrief,
  type RequestedDay,
} from '@/lib/campaign/content-plan';
import {
  DEFAULT_CONTENT_STRATEGY,
  formatContentStrategyText,
  isContentTypeKey,
  parseContentStrategy,
  parseContentStrategyText,
  pillarKeys,
  planContentTypes,
  resolveContentStrategy,
  slugifyContentType,
  SUGGESTED_TEMPLATE_TYPES,
} from '@/lib/campaign/content-strategy';

let bad = 0;
const t = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) bad += 1;
};

// ===========================================================================
console.log('\n--- content strategy -----------------------------------------');
// ===========================================================================

t('default strategy parses as a strategy', parseContentStrategy(DEFAULT_CONTENT_STRATEGY) !== null);
t('default keys are slugs of their labels (editor round trip keeps keys)', DEFAULT_CONTENT_STRATEGY.pillars.every((pillar) => pillar.key === slugifyContentType(pillar.label)));
t('default strategy names no industry', !/dental|clinic|tooth|teeth|real estate|property|construction/i.test(JSON.stringify(DEFAULT_CONTENT_STRATEGY)));
t('null vertical strategy falls back to the default', resolveContentStrategy(null).source === 'default');
t('unreadable vertical strategy falls back to the default', resolveContentStrategy({ pillars: 'nope' }).source === 'default');
{
  const dental = { pillars: [
    { key: 'preventive-care', label: 'Preventive care', weight: 3, guidance: 'Habits that prevent problems.', promotional: false },
    { key: 'myth-vs-fact', label: 'Myth vs fact', weight: 2, guidance: '', promotional: false },
    { key: 'book-a-visit', label: 'Book a visit', weight: 1, guidance: 'Invite a booking.', promotional: true },
  ] };
  const resolved = resolveContentStrategy(dental);
  t('a vertical supplies its own pillars', resolved.source === 'vertical' && pillarKeys(resolved.strategy).join() === 'preventive-care,myth-vs-fact,book-a-visit');
}
t('duplicate pillar keys are refused', parseContentStrategy({ pillars: [{ key: 'a', label: 'A', weight: 1 }, { key: 'a', label: 'A2', weight: 1 }] }) === null);
t('an all-promotional strategy is refused', parseContentStrategy({ pillars: [{ key: 'sale', label: 'Sale', weight: 1, promotional: true }] }) === null);
t('content type keys are lowercase hyphenated', isContentTypeKey('myth-vs-fact') && !isContentTypeKey('Myth vs fact') && !isContentTypeKey('-x'));

{
  const text = formatContentStrategyText(DEFAULT_CONTENT_STRATEGY);
  const parsed = parseContentStrategyText(text);
  t(
    'editor text round-trips the default strategy exactly',
    parsed.strategy !== null && JSON.stringify(parsed.strategy) === JSON.stringify(parseContentStrategy(DEFAULT_CONTENT_STRATEGY)),
    parsed.errors.join('; '),
  );
}
{
  const parsed = parseContentStrategyText('# comment\nPreventive care | 3 | Habits that prevent problems\n\nBook a visit | 1 | Invite a booking | promotional');
  t('editor text: comments and blanks ignored, promotional flag read', parsed.strategy?.pillars.length === 2 && parsed.strategy.pillars[1]?.promotional === true && parsed.strategy.pillars[0]?.key === 'preventive-care');
}
{
  const parsed = parseContentStrategyText('Tips | lots | x\nTips | 2 | y');
  t('editor text: a bad weight is reported with its line', parsed.strategy === null && parsed.errors[0]?.startsWith('Line 1') === true, parsed.errors.join('; '));
}

// ===========================================================================
console.log('\n--- day assignment -------------------------------------------');
// ===========================================================================

{
  const plan = planContentTypes(DEFAULT_CONTENT_STRATEGY, 365);
  const totalWeight = DEFAULT_CONTENT_STRATEGY.pillars.reduce((sum, pillar) => sum + pillar.weight, 0);
  const counts = new Map<string, number>();
  plan.forEach((key) => counts.set(key, (counts.get(key) ?? 0) + 1));
  t('365 days assigned', plan.length === 365);
  t(
    'each pillar gets its weighted share (within 1 day)',
    DEFAULT_CONTENT_STRATEGY.pillars.every((pillar) => Math.abs((counts.get(pillar.key) ?? 0) - (365 * pillar.weight) / totalWeight) <= 1),
    JSON.stringify(Object.fromEntries(counts)),
  );
  const promotional = new Set(DEFAULT_CONTENT_STRATEGY.pillars.filter((pillar) => pillar.promotional).map((pillar) => pillar.key));
  t('promotional days are never consecutive', plan.every((key, index) => index === 0 || !(promotional.has(key) && promotional.has(plan[index - 1]!))));
  t('promotional share stays at its weight (~5%)', (counts.get('promotional') ?? 0) <= Math.ceil(365 / totalWeight) + 1);
  t('assignment is deterministic', JSON.stringify(plan) === JSON.stringify(planContentTypes(DEFAULT_CONTENT_STRATEGY, 365)));
  t('a range sees the same days as the whole campaign', JSON.stringify(planContentTypes(DEFAULT_CONTENT_STRATEGY, 130).slice(100)) === JSON.stringify(plan.slice(100, 130)));
  let longestRun = 1;
  let run = 1;
  plan.forEach((key, index) => {
    run = index > 0 && key === plan[index - 1] ? run + 1 : 1;
    longestRun = Math.max(longestRun, run);
  });
  t('no content type repeats on consecutive days', longestRun === 1, String(longestRun));
}
{
  const heavyPromo = { pillars: [
    { key: 'sale', label: 'Sale', weight: 10, guidance: '', promotional: true },
    { key: 'tips', label: 'Tips', weight: 1, guidance: '', promotional: false },
  ] };
  const plan = planContentTypes(heavyPromo, 60);
  t('even a promotion-heavy strategy never schedules two promotional days in a row', plan.every((key, index) => index === 0 || !(key === 'sale' && plan[index - 1] === 'sale')));
}

// ===========================================================================
console.log('\n--- targets and chunks ---------------------------------------');
// ===========================================================================

const slot = (dayNumber: number, contentStatus: 'NOT_GENERATED' | 'READY' | 'NEEDS_REVIEW' | null = 'NOT_GENERATED') => ({ dayNumber, contentStatus });
{
  const slots = Array.from({ length: 365 }, (_, index) => slot(index + 1));
  const chunks = chunkDays(selectTargetDays(slots, { fromDay: 1, toDay: 365, mode: 'missing' }));
  t('365 days → 13 chunks of at most 30', chunks.length === 13 && chunks.every((chunk) => chunk.length <= CONTENT_CHUNK_DAYS), String(chunks.length));
  t('chunk 1 is days 1–30, chunk 13 is days 361–365', chunks[0]![0]!.dayNumber === 1 && chunks[0]!.at(-1)!.dayNumber === 30 && chunks[12]![0]!.dayNumber === 361 && chunks[12]!.length === 5);
}
{
  const slots = Array.from({ length: 60 }, (_, index) => slot(index + 1, index < 30 ? 'READY' : 'NOT_GENERATED'));
  t('missing mode skips written days', selectTargetDays(slots, { fromDay: 1, toDay: 60, mode: 'missing' })[0]?.dayNumber === 31);
  t('missing mode over a written range targets nothing', selectTargetDays(slots, { fromDay: 1, toDay: 30, mode: 'missing' }).length === 0);
  t('overwrite mode targets the whole range', selectTargetDays(slots, { fromDay: 1, toDay: 30, mode: 'overwrite' }).length === 30);
  t('NEEDS_REVIEW days are not "missing"', selectTargetDays([slot(1, 'NEEDS_REVIEW')], { fromDay: 1, toDay: 1, mode: 'missing' }).length === 0);
  t('a day with no status is empty', selectTargetDays([slot(1, null)], { fromDay: 1, toDay: 1, mode: 'missing' }).length === 1);
  t('range 91–120 selects exactly those days', selectTargetDays(Array.from({ length: 365 }, (_, i) => slot(i + 1)), { fromDay: 91, toDay: 120, mode: 'missing' }).map((s) => s.dayNumber).join() === Array.from({ length: 30 }, (_, i) => i + 91).join());
}

// ===========================================================================
console.log('\n--- validation -----------------------------------------------');
// ===========================================================================

const keys = pillarKeys(DEFAULT_CONTENT_STRATEGY);
const requested: RequestedDay[] = [
  { dayNumber: 31, dateLabel: 'Sat 31 Oct 2026', contentType: 'educational' },
  { dayNumber: 32, dateLabel: 'Sun 1 Nov 2026', contentType: 'practical-tips' },
  { dayNumber: 33, dateLabel: 'Mon 2 Nov 2026', contentType: 'myth-vs-fact' },
];
const entry = (dayNumber: number, over: Record<string, unknown> = {}) => ({
  dayNumber,
  topic: `Topic ${dayNumber}`,
  contentType: requested.find((day) => day.dayNumber === dayNumber)?.contentType ?? 'educational',
  headline: `Headline number ${dayNumber}`,
  supportingText: 'Supporting text that explains the headline in a sentence.',
  cta: `Action ${dayNumber}`,
  caption: 'A caption long enough to read like a caption.',
  hashtags: 'health, #care  #tips',
  imagePrompt: 'A calm photograph with space for text on the left.',
  suggestedTemplateType: 'tips-list',
  ...over,
});
const existing = [
  { dayNumber: 12, theme: 'Gum Health', headline: 'Healthy gums, happy life!', cta: 'Book now' },
  { dayNumber: 30, theme: 'Topic thirty', headline: 'Thirty', cta: 'Call us' },
  // The day being rewritten must not collide with its own old content.
  { dayNumber: 33, theme: 'Topic 33', headline: 'Headline number 33', cta: 'x' },
];
{
  const result = validateGeneratedChunk({ requested, output: [entry(31), entry(32), entry(33)], existing, contentTypeKeys: keys });
  t('three clean entries are accepted READY', result.accepted.length === 3 && result.accepted.every((day) => day.contentStatus === 'READY'), JSON.stringify(result.accepted.map((d) => d.contentIssues)));
  t('topic is written to the theme column', result.accepted[0]?.theme === 'Topic 31');
  t('hashtags are normalised', result.accepted[0]?.hashtags === '#health #care #tips', result.accepted[0]?.hashtags);
  t('a rewritten day is not compared with its old self', result.accepted[2]?.contentIssues.length === 0);
}
{
  const result = validateGeneratedChunk({
    requested,
    output: [entry(33), entry(31), entry(31, { topic: 'Other' }), entry(99), { dayNumber: 32 }],
    existing,
    contentTypeKeys: keys,
  });
  t('duplicate day numbers: the first is kept', result.accepted.filter((day) => day.dayNumber === 31).length === 1 && result.accepted.find((day) => day.dayNumber === 31)?.theme === 'Topic 31');
  t('duplicate day number is reported', result.rejected.some((reason) => reason.includes('Day 31 was returned more than once')));
  t('unrequested day is refused', result.rejected.some((reason) => reason.includes('Day 99 was not requested')));
  t('schema-invalid entry is refused', result.rejected.some((reason) => reason.startsWith('Entry 5')));
  t('day 32 is reported missing', result.missingDayNumbers.join() === '32');
  t('accepted days come back in day order', result.accepted.map((day) => day.dayNumber).join() === '31,33');
}
{
  const result = validateGeneratedChunk({
    requested,
    output: [
      entry(31, { topic: 'gum health', headline: 'Healthy Gums — Happy Life' }),
      entry(32),
      entry(33, { contentType: 'promotional', headline: 'HEADLINE number 32.' }),
    ],
    existing,
    contentTypeKeys: keys,
  });
  const issues = (day: number) => result.accepted.find((d) => d.dayNumber === day)?.contentIssues.join(' | ') ?? '';
  const status = (day: number) => result.accepted.find((d) => d.dayNumber === day)?.contentStatus;
  t('exact duplicate topic (case-insensitive) → NEEDS_REVIEW', issues(31).includes('Topic repeats day 12'), issues(31));
  t('exact duplicate headline (punctuation-insensitive) → NEEDS_REVIEW', issues(31).includes('Headline repeats day 12'), issues(31));
  t('duplicate headline within the chunk → NEEDS_REVIEW', issues(33).includes('Headline repeats day 32'), issues(33));
  t('an unplanned promotional day is flagged', issues(33).includes('instead of the planned "myth-vs-fact"'), issues(33));
  const ctaExisting = [{ dayNumber: 30, theme: 'Other', headline: 'Other', cta: 'Action 31' }];
  t('CTA identical to the previous day is flagged', validateGeneratedChunk({ requested, output: [entry(31)], existing: ctaExisting, contentTypeKeys: keys }).accepted[0]?.contentIssues.some((issue) => issue.includes('Call to action repeats day 30')) === true);
  t('flagged days are NEEDS_REVIEW, the clean day stays READY', status(31) === 'NEEDS_REVIEW' && status(33) === 'NEEDS_REVIEW' && status(32) === 'READY');
}
{
  const result = validateGeneratedChunk({ requested, output: [entry(31, { contentType: 'invented-type', suggestedTemplateType: 'nope' })], existing, contentTypeKeys: keys });
  t('unknown content type is replaced by the planned one and flagged', result.accepted[0]?.contentType === 'educational' && result.accepted[0].contentStatus === 'NEEDS_REVIEW');
  t('unknown template type is dropped', result.accepted[0]?.suggestedTemplateType === null);
}
t('normalisation ignores case, punctuation and spacing', normalizeForComparison('  Healthy GUMS — happy, life! ') === 'healthy gums happy life');

// ===========================================================================
console.log('\n--- request --------------------------------------------------');
// ===========================================================================

{
  const schema = JSON.stringify(buildContentSchema(keys));
  t('schema pins content type to the strategy keys', keys.every((key) => schema.includes(`"${key}"`)));
  t('schema pins template type to the catalogue', Object.keys(SUGGESTED_TEMPLATE_TYPES).every((key) => schema.includes(`"${key}"`)));
  t('schema requires every field (strict mode)', ['topic', 'headline', 'supportingText', 'cta', 'caption', 'hashtags', 'imagePrompt', 'suggestedTemplateType'].every((field) => schema.includes(`"${field}"`)) && schema.includes('"additionalProperties":false'));

  const brief: ContentBrief = {
    companyName: 'ABC Dental Clinic',
    verticalName: 'Dental',
    planName: '365-Day Scale',
    durationDays: 365,
    startDateLabel: '1 Oct 2026',
    deliveryDaysLabel: 'every day',
    brandTagline: 'Smiles that last',
    brandVoice: null,
    strategy: DEFAULT_CONTENT_STRATEGY,
  };
  const system = buildContentSystemPrompt(brief);
  t('system prompt carries business, vertical, duration and tagline', system.includes('ABC Dental Clinic') && system.includes('Industry: Dental') && system.includes('365 content days') && system.includes('Smiles that last'));
  t('system prompt forbids invented facts and testimonials', system.includes('invent no testimonials'));
  t('system prompt is content, not posters', system.includes('You do not design posters'));
  const user = buildContentUserPrompt(requested, buildContentHistory(existing, [31, 32, 33]));
  t('user prompt lists day, date and planned type', user.includes('31 · Sat 31 Oct 2026 · educational'));
  t('user prompt carries prior topics', user.includes('12: Gum Health'));
}
{
  const history = buildContentHistory(
    Array.from({ length: 200 }, (_, index) => ({ dayNumber: index + 1, theme: `T${index + 1}`, headline: `H${index + 1}`, cta: `C${index + 1}` })),
    [101, 102],
  );
  t('history excludes the chunk\'s own days', !history.topics.some((line) => line.startsWith('101:') || line.startsWith('102:')));
  t('history headlines are the nearest ones, both sides', history.headlines.length === 40 && history.headlines.some((line) => line.startsWith('100:')) && history.headlines.some((line) => line.startsWith('103:')));
}

console.log(`\n${bad === 0 ? 'All campaign content checks passed.' : `${bad} check(s) FAILED.`}`);
process.exit(bad === 0 ? 0 : 1);
