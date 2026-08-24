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
const csv = buildCalendarImportTemplate(TEMPLATES);
const rt = parseCalendarImport(csv, opts);
t('generated CSV imports cleanly',
  rt.rows.length > 0 && rt.rows.every(r => r.issues.length === 0 && r.templateId !== null),
  JSON.stringify(rt.rows.map(r => r.issues)));
t('generated CSV varies the template across rows',
  new Set(rt.rows.map(r => r.templateId)).size === 2);

process.exitCode = bad ? 1 : 0;
console.log(bad ? `\n${bad} failed` : '\nall import checks passed');
