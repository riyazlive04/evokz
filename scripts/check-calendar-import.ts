/**
 * Fixture suite for the calendar importer's strict template-name resolution.
 *
 * The rule this covers is unforgiving by design — an unrecognised template name
 * rejects the whole import — so the *messages* are as load-bearing as the
 * matching. Every existing operator sheet fails on its first import after this
 * change, and these checks pin the two sentences that explain why.
 *
 * No network, no database: `calendar-parse` is isomorphic and takes its template
 * catalogue as a parameter, which is what makes it testable here at all.
 *
 * Run: npm run check:import
 */
import { parseCalendarImport, buildCalendarImportTemplate } from '@/lib/calendar-parse';
import { usesFallbackImagery, verticalImageryFor } from '@/lib/ai/vertical-vocabulary';

const TEMPLATES = [
  { id: 't1', label: 'Grand Opening Split' },
  { id: 't2', label: 'Banded Detail' },
];
const opts = { maxDay: 30, templates: TEMPLATES };
let bad = 0;
const t = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) bad++;
};

const HEAD = 'day,template name,caption,hashtags,image prompt';
const CAP = 'A caption long enough to pass the ten character minimum easily.';
const PROMPT = 'A wide establishing photograph with clear negative space upper left.';

// 1. happy path, exact name
let p = parseCalendarImport(`${HEAD}\n1,Grand Opening Split,${CAP},#a,${PROMPT}`, opts);
t('exact name resolves', p.rows[0]?.templateId === 't1', JSON.stringify(p.rows[0]?.issues));

// 2. case + spacing insensitive
p = parseCalendarImport(`${HEAD}\n1,  grand   opening   split ,${CAP},#a,${PROMPT}`, opts);
t('case/spacing insensitive', p.rows[0]?.templateId === 't1', JSON.stringify(p.rows[0]?.issues));

// 3. unknown name rejected, lists valid names
p = parseCalendarImport(`${HEAD}\n1,Nope,${CAP},#a,${PROMPT}`, opts);
t('unknown name rejected',
  p.rows[0]?.templateId === null && !!p.rows[0]?.issues.some(i => i.includes('Grand Opening Split')),
  JSON.stringify(p.rows[0]?.issues));

// 4. blank name rejected
p = parseCalendarImport(`${HEAD}\n1,,${CAP},#a,${PROMPT}`, opts);
t('blank name rejected', p.rows[0]?.issues.some(i => i.includes('required')) === true,
  JSON.stringify(p.rows[0]?.issues));

// 5. legacy sheet: theme column ignored, template name reported missing
p = parseCalendarImport(`day,theme,caption,hashtags,image prompt\n1,Angle,${CAP},#a,${PROMPT}`, opts);
t('legacy theme sheet is a fatal missing-column', (p.error ?? '').includes('template name'), p.error ?? '');
p = parseCalendarImport(`day,theme,template name,caption,hashtags,image prompt\n1,Angle,Banded Detail,${CAP},#a,${PROMPT}`, opts);
t('theme lands in ignoredColumns', p.ignoredColumns.includes('theme'), JSON.stringify(p.ignoredColumns));

// 6. legacy `layout` column now means template name
p = parseCalendarImport(`day,layout,caption,hashtags,image prompt\n1,scrim,${CAP},#a,${PROMPT}`, opts);
t('legacy layout=scrim fails loudly by name',
  p.rows[0]?.issues.some(i => i.includes('"scrim"')) === true, JSON.stringify(p.rows[0]?.issues));

// 7. empty catalogue
p = parseCalendarImport(`${HEAD}\n1,Anything,${CAP},#a,${PROMPT}`, { maxDay: 30, templates: [] });
t('empty catalogue explains itself',
  p.rows[0]?.issues.some(i => i.includes('no approved template')) === true, JSON.stringify(p.rows[0]?.issues));

// 8. the downloadable CSV round-trips
const csv = buildCalendarImportTemplate(TEMPLATES, 'Restaurants and cafes', 30);
const rt = parseCalendarImport(csv, opts);
t('generated CSV imports cleanly',
  rt.rows.length > 0 && rt.rows.every(r => r.issues.length === 0 && r.templateId !== null),
  JSON.stringify(rt.rows.map(r => r.issues)));
t('generated CSV varies the template across rows',
  new Set(rt.rows.map(r => r.templateId)).size === 2);

// The worked example must be written in the caller's industry. This is the bug
// `vertical-vocabulary.ts` fixed for photo briefs, reappearing in the sheet: a
// cafe downloading a template full of construction copy reads as broken.
t('sample image prompt uses the vertical vocabulary, not construction',
  /espresso|plated dish|chef|latte|dining room|oven|ingredients/i.test(csv) &&
    !/construction site|tower crane|high-visibility|drainage/i.test(csv),
  csv.split(String.fromCharCode(13,10))[1]?.slice(0, 140));

// ---------------------------------------------------------------------------
// Every vertical's downloaded sheet, not just the one that was being tested
// ---------------------------------------------------------------------------
//
// The vocabulary lookup was an exact match on names nobody types. Production
// held "Contructions" (sic), "Medicals", "Interiors" and "Automation and
// Software"; five of seven verticals fell through to generic imagery, in the
// module written to stop exactly that. These names are the real ones plus the
// content library's canonical spellings, so a rename in either direction is
// caught here rather than by a client receiving the wrong photograph.
const VERTICALS = [
  'Automation and Software', 'Contructions', 'Interiors', 'Medicals',
  'Real estate', 'Restaurants and cafes', 'Heavy Construction', 'Interior Design',
  'Healthcare & Dental Clinics', 'Fitness & Gyms', 'Education & Coaching',
  'Beauty Salon', 'Automotive Sales & Service', 'Legal & Financial Services',
];

// Not an industry — a neutral brief is the right answer, so it is listed as an
// expected fallback rather than left to look like an oversight.
const EXPECTED_FALLBACK = new Set(['Individuals']);

console.log('');
for (const vertical of [...VERTICALS, ...EXPECTED_FALLBACK]) {
  const shouldFallBack = EXPECTED_FALLBACK.has(vertical);
  t(`${vertical}: ${shouldFallBack ? 'neutral brief' : 'has its own imagery'}`,
    usesFallbackImagery(vertical) === shouldFallBack);

  const sheet = buildCalendarImportTemplate(TEMPLATES, vertical, 30);
  const parsed = parseCalendarImport(sheet, opts);

  t(`${vertical}: downloaded sheet imports cleanly`,
    parsed.error === null && parsed.rows.length > 0 &&
      parsed.rows.every((r) => r.issues.length === 0 && r.templateId !== null),
    parsed.error ?? JSON.stringify(parsed.rows.map((r) => r.issues)));

  // The worked example has to carry this vertical's own nouns, or the sheet is
  // teaching the wrong photograph.
  const firstSubject = verticalImageryFor(vertical).subjects.split(',')[0]!.trim();
  t(`${vertical}: sample prompt uses its own subject vocabulary`,
    sheet.includes(firstSubject), firstSubject);
}

// ---------------------------------------------------------------------------
// A template added later must reach the sheet
// ---------------------------------------------------------------------------
//
// The sheet used to be a fixed pair of example days, so a vertical with five
// approved layouts named two of them and the rest appeared nowhere — the file
// that exists to teach an operator the names silently omitted most of them.
console.log('');
for (const count of [1, 2, 3, 5, 12]) {
  const many = Array.from({ length: count }, (_, i) => ({ id: `t${i}`, label: `Layout ${i + 1}` }));
  const sheet = buildCalendarImportTemplate(many, 'Medicals', 30);
  const missing = many.filter((tpl) => !sheet.includes(tpl.label)).map((tpl) => tpl.label);

  t(`${count} approved template(s): every one appears in the sheet`,
    missing.length === 0, `missing: ${missing.join(', ')}`);

  const parsed = parseCalendarImport(sheet, { maxDay: 30, templates: many });
  t(`${count} approved template(s): the sheet still imports cleanly`,
    parsed.error === null && parsed.rows.length > 0 &&
      parsed.rows.every((r) => r.issues.length === 0 && r.templateId !== null),
    parsed.error ?? JSON.stringify(parsed.rows.flatMap((r) => r.issues)));
}

// A short plan must not emit day numbers it will then reject on import. This is
// the collision that makes "every template appears" a bounded promise.
{
  const many = Array.from({ length: 17 }, (_, i) => ({ id: `t${i}`, label: `Med-${i + 1}` }));
  const sheet = buildCalendarImportTemplate(many, 'Medicals', 7);
  const parsed = parseCalendarImport(sheet, { maxDay: 7, templates: many });
  t('17 templates on a 7-day plan: sheet is capped and still imports',
    parsed.rows.length === 7 && parsed.rows.every((r) => r.issues.length === 0),
    `${parsed.rows.length} rows, issues: ${JSON.stringify(parsed.rows.flatMap((r) => r.issues))}`);
}

process.exitCode = bad ? 1 : 0;
console.log(bad ? `\n${bad} failed` : '\nall import checks passed');
