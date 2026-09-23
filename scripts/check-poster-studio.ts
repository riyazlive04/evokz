/**
 * Fixture suite for the Poster Studio additions: Mix (base + element reference)
 * — the edit request carrying two images and the prompt that names them — the
 * festival list and its prompt treatment, and the bulk sheet: parser, CSV
 * reader, template round-trip and per-row settings.
 *
 * Pure: no database, no Drive, no provider. Every request the OpenAI SDK makes
 * goes to a local fetch stub that records the multipart body and answers with a
 * one-pixel PNG.
 *
 * Run: npm run check:poster-studio
 */
import { buildEditPrompt, buildGeneratePrompt, buildMixPrompt, buildVariationPrompt } from '@/lib/ai/studio-prompts';
import { findStudioFestival, STUDIO_FESTIVALS } from '@/lib/poster-studio/festivals';

let bad = 0;
const t = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) bad += 1;
};
const section = (title: string) => console.log(`\n--- ${title} ${'-'.repeat(Math.max(0, 58 - title.length))}`);

/** 1x1 transparent PNG. */
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

interface SeenRequest {
  url: string;
  fields: Array<{ name: string; filename: string | null; type: string | null }>;
}
const seen: SeenRequest[] = [];

// Installed before any client is constructed: the SDK captures `fetch` then.
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String((input as Request).url);
  const fields: SeenRequest['fields'] = [];
  if (init?.body instanceof FormData) {
    for (const [name, value] of init.body.entries()) {
      fields.push(
        typeof value === 'string'
          ? { name, filename: null, type: null }
          : { name, filename: (value as File).name, type: value.type },
      );
    }
  }
  seen.push({ url, fields });
  return new Response(
    JSON.stringify({
      created: 0,
      data: [{ b64_json: PIXEL_PNG.toString('base64') }],
      output_format: 'png',
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30, input_tokens_details: { image_tokens: 4, text_tokens: 6 } },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}) as typeof fetch;

async function main() {
  // A fake key: the stub answers every request, nothing leaves the machine.
  process.env.OPENAI_API_KEY = 'sk-check-poster-studio';
  const { renderStudioImage } = await import('@/lib/ai/openai-images');

  section('Mix: two images on one edit request');
  const base = { bytes: PIXEL_PNG, mimeType: 'image/png' };
  const element = { bytes: PIXEL_PNG, mimeType: 'image/jpeg' };

  await renderStudioImage({ prompt: 'p', size: '1024x1024', image: base, extraImages: [element] });
  const mix = seen.at(-1)!;
  const mixImages = mix.fields.filter((field) => field.filename !== null && field.name.startsWith('image'));
  t('goes to the edit endpoint', mix.url.endsWith('/images/edits'), mix.url);
  t('sends two image parts', mixImages.length === 2, JSON.stringify(mix.fields));
  t('…base first, element reference second, each with its own type',
    mixImages[0]?.filename === 'input-1.png' && mixImages[1]?.filename === 'input-2.jpg' && mixImages[1]?.type === 'image/jpeg',
    JSON.stringify(mixImages));

  await renderStudioImage({ prompt: 'p', size: '1024x1024', image: base });
  const single = seen.at(-1)!;
  const singleImages = single.fields.filter((field) => field.filename !== null);
  t('an ordinary edit still sends exactly one image, named as before',
    singleImages.length === 1 && singleImages[0]?.name === 'image' && singleImages[0]?.filename === 'input.png',
    JSON.stringify(single.fields));

  await renderStudioImage({ prompt: 'p', size: '1024x1024', image: base, extraImages: [] });
  t('an empty extra list is the single-image request', seen.at(-1)!.fields.filter((field) => field.filename !== null).length === 1);

  await renderStudioImage({ prompt: 'p', size: '1024x1024', extraImages: [element] });
  t('extra images without a base are ignored: a plain generate', seen.at(-1)!.url.endsWith('/images/generations') && seen.at(-1)!.fields.length === 0);

  section('Mix prompt');
  const prompt = buildMixPrompt({
    instruction: '  Take the gold diya border from the reference.  ',
    aspectRatio: '9:16',
    textFree: false,
  });
  t('names image 1 as the base and image 2 as the element reference', /Image 1 is the BASE/.test(prompt) && /Image 2 is the ELEMENT REFERENCE/.test(prompt));
  t('carries the instruction, trimmed', prompt.includes('\nTake the gold diya border from the reference.\n'));
  t('rules out the reference’s layout, wording and branding', /Ignore everything else in image 2/.test(prompt) && /logos, brand or company names/.test(prompt));
  t('keeps the base where the instruction does not reach', /Keep image 1 as it is/.test(prompt));
  t('states the output frame', prompt.includes('vertical 9:16'));
  t('ends with the no-invented-branding rule, as every mode does', /No invented branding/.test(prompt.split('\n\n').at(-1) ?? ''));
  t('no identity band unless one will be composited', !/Identity band/.test(prompt));

  const banded = buildMixPrompt({ instruction: 'x', aspectRatio: '1:1', textFree: true, identityBandFraction: 0.15 });
  t('with an overlay: keeps the bottom 15% clear', /bottom 15%/.test(banded));
  t('text-free adds no new lettering', /Do not add any new text/.test(banded));
  t('differs from an edit prompt for the same instruction', banded !== buildEditPrompt({ instruction: 'x', aspectRatio: '1:1', textFree: true, identityBandFraction: 0.15 }));

  section('Festivals');
  const keys = STUDIO_FESTIVALS.map((festival) => festival.key);
  t('festival keys are unique', new Set(keys).size === keys.length);
  t('every festival has a label, a greeting and a style hint',
    STUDIO_FESTIVALS.every((festival) => festival.label && festival.greeting && festival.styleHint.length > 20));
  t('keys are url-safe slugs', keys.every((key) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(key)));
  t('an unknown or empty key is no festival', findStudioFestival('not-a-festival') === null && findStudioFestival('') === null && findStudioFestival(null) === null);
  const diwali = findStudioFestival('diwali')!;
  t('finds a festival by key', diwali?.label === 'Diwali / Deepavali');

  const plain = { brief: 'Dental check-up offer', aspectRatio: '9:16' as const, textFree: false, brand: null, hasReference: false };
  t('no festival leaves the Generate prompt exactly as before', buildGeneratePrompt(plain) === buildGeneratePrompt({ ...plain, festival: null }));
  const festive = buildGeneratePrompt({ ...plain, festival: diwali });
  t('Generate with a festival adds its treatment', /Festival theme: this poster is for Diwali/.test(festive) && festive.includes(diwali.styleHint));
  t('…allows only its exact greeting when there is text', festive.includes('"Happy Diwali", spelled exactly'));
  t('…keeps the no-invented-branding rule last', /No invented branding/.test(festive.split('\n\n').at(-1) ?? ''));
  const festiveTextFree = buildGeneratePrompt({ ...plain, textFree: true, festival: diwali });
  t('text-free: no greeting at all', /Do not write a festival greeting/.test(festiveTextFree) && !festiveTextFree.includes('"Happy Diwali"'));
  const festiveEdit = buildEditPrompt({ instruction: 'Brighten the photo', aspectRatio: '1:1', textFree: false, festival: diwali });
  t('Edit adds the festival as accents that keep the design', /also give the image a tasteful Diwali/.test(festiveEdit) && /Do not cover or replace its text/.test(festiveEdit));
  const festiveMix = buildMixPrompt({ instruction: 'Take the border', aspectRatio: '1:1', textFree: false, festival: diwali });
  t('Mix adds it the same way', /also give the image a tasteful Diwali/.test(festiveMix));
  const festiveVariation = buildVariationPrompt({ direction: 'Brighter', aspectRatio: '1:1', textFree: false, brand: null, approach: 0, festival: diwali });
  t('Variation builds it into the new design', /Festival theme: this poster is for Diwali/.test(festiveVariation));
  t('every festival prompt forbids drawn deities', [festive, festiveEdit, festiveMix, festiveVariation].every((text) => /no deities or religious figures/.test(text)));

  section('Bulk sheet');
  const { parseBatchTable, parseBatchSheet, parseCsv, parseDayNumber, matchFestival, buildBatchTemplate, MAX_BATCH_ROWS } = await import('@/lib/poster-studio/batch-sheet');
  const { effectiveItemSettings } = await import('@/lib/poster-studio/batch-service');

  const good = parseBatchTable([
    ['', '', ''],
    ['DAY', 'Image prompt:', 'Aspect Ratio', 'Occasion', 'Text-free', 'Quality'],
    ['1', 'A clinic poster', '', '', '', ''],
    ['', '', '', '', '', ''],
    ['Day 2', 'Line one\r\nline two', '4x5', 'Deepavali', 'yes', 'HIGH'],
    ['Diwali', 'Festive greeting', 'square', 'christmas', 'no', ''],
  ]);
  t('headers match by alias, whatever the case or punctuation', good.problems.length === 0 && good.rows.length === 3, JSON.stringify(good.problems));
  t('blank rows are skipped; positions count kept rows', good.rows.map((row) => row.position).join(',') === '1,2,3' && good.rows[1]!.sheetRow === 5);
  t('day numbers are read from "1" and "Day 2"; other labels have none', good.rows[0]!.dayNumber === 1 && good.rows[1]!.dayNumber === 2 && good.rows[2]!.dayNumber === null);
  t('per-row settings parse: 4x5, festival by alias, yes, HIGH', good.rows[1]!.aspectRatio === '4:5' && good.rows[1]!.festival === 'diwali' && good.rows[1]!.textFree === true && good.rows[1]!.quality === 'high');
  t('"square" is 1:1; "no" is text-free off; blank quality inherits', good.rows[2]!.aspectRatio === '1:1' && good.rows[2]!.textFree === false && good.rows[2]!.quality === null);
  t('line breaks inside a prompt are kept', good.rows[1]!.prompt === 'Line one\nline two');

  const badRows = parseBatchTable([
    ['Day', 'Prompt', 'Aspect ratio', 'Festival', 'Quality'],
    ['', 'No day here', '', '', ''],
    ['3', '', '', '', ''],
    ['4', 'Bad format', '5:7', '', ''],
    ['5', 'Bad festival', '', 'Halloween-ish', ''],
    ['6', 'Bad quality', '', '', 'ultra'],
    ['7', 'Fine', '', '', ''],
  ]);
  t('each bad row is left out with its sheet row number', badRows.rows.length === 1 && badRows.problems.map((problem) => problem.sheetRow).join(',') === '2,3,4,5,6', JSON.stringify(badRows.problems.map((problem) => problem.message)));
  t('…and says what is wrong', /Day is empty/.test(badRows.problems[0]!.message) && /Prompt is empty/.test(badRows.problems[1]!.message) && /"5:7"/.test(badRows.problems[2]!.message) && /festival list/.test(badRows.problems[3]!.message) && /Low, Medium or High/.test(badRows.problems[4]!.message));
  t('a sheet without Day and Prompt columns is refused', /Missing: "Day" and "Prompt"/.test(parseBatchTable([['Theme', 'Caption'], ['a', 'b']]).problems[0]?.message ?? ''));
  const tooMany = parseBatchTable([['Day', 'Prompt'], ...Array.from({ length: MAX_BATCH_ROWS + 5 }, (_, index) => [String(index + 1), `Prompt ${index}`])]);
  t(`at most ${MAX_BATCH_ROWS} rows; the rest are named`, tooMany.rows.length === MAX_BATCH_ROWS && /at most 200/.test(tooMany.problems[0]?.message ?? ''));
  t('day numbers: 0, negatives and words are not numbers', parseDayNumber('0') === null && parseDayNumber('-3') === null && parseDayNumber('twelve') === null && parseDayNumber(' day 12 ') === 12);
  t('festivals match by key, label or either name', matchFestival('eid-al-fitr') === 'eid-al-fitr' && matchFestival('Gudi Padwa') === 'ugadi' && matchFestival('BAKRID') === 'eid-al-adha' && matchFestival('Halloween') === null);

  const csv = parseCsv('﻿Day,Prompt\r\n1,"Hello, world"\r\n2,"She said ""hi""\nsecond line"\n');
  t('CSV: BOM, CRLF, quoted commas, doubled quotes and line breaks', csv.length === 3 && csv[1]![1] === 'Hello, world' && csv[2]![1] === 'She said "hi"\nsecond line' && csv[0]![0] === 'Day');
  const csvSheet = await parseBatchSheet(Buffer.from('Day,Prompt\n1,From a CSV file\n'), 'rows.CSV');
  t('a .csv upload parses', csvSheet.rows.length === 1 && csvSheet.rows[0]!.prompt === 'From a CSV file');
  t('other file types are refused', /xlsx file or a \.csv/.test((await parseBatchSheet(Buffer.from('x'), 'rows.pdf')).problems[0]?.message ?? ''));
  t('a broken .xlsx is refused politely', /could not be read as an Excel workbook/.test((await parseBatchSheet(Buffer.from('not a zip'), 'rows.xlsx')).problems[0]?.message ?? ''));

  const template = await buildBatchTemplate();
  const fromTemplate = await parseBatchSheet(template, 'template.xlsx');
  t('the downloadable template parses back to its three example rows', fromTemplate.problems.length === 0 && fromTemplate.rows.length === 3 && fromTemplate.rows[2]!.festival === 'diwali' && fromTemplate.rows[2]!.quality === 'medium' && fromTemplate.rows[0]!.dayNumber === 1, JSON.stringify(fromTemplate.problems));

  const batchDefaults = { aspectRatio: '1:1', festival: 'diwali', textFree: false, quality: 'high' };
  const inherit = effectiveItemSettings(batchDefaults, { aspectRatio: null, festival: null, textFree: null, quality: null });
  t('a row with no overrides takes the batch defaults', inherit.aspectRatio === '1:1' && inherit.festival === 'diwali' && inherit.quality === 'high' && !inherit.textFree);
  const explicit = effectiveItemSettings(batchDefaults, { aspectRatio: '9:16', festival: '', textFree: true, quality: '' });
  t('"" overrides a default with none: no festival, server-default quality', explicit.festival === null && explicit.quality === null && explicit.aspectRatio === '9:16' && explicit.textFree);
  t('an unknown stored value degrades safely', effectiveItemSettings(batchDefaults, { aspectRatio: '7:3', festival: 'nope', textFree: null, quality: 'ultra' }).aspectRatio === '9:16');

  console.log(`\n${bad === 0 ? 'All checks passed.' : `${bad} check(s) FAILED.`}`);
  if (bad > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
