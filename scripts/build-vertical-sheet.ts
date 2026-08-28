/**
 * Writes an import sheet shaped by what each template actually draws.
 *
 * The console's own download is one shape for a whole vertical: every row gets
 * every column, whatever the template on that row does with them. That is fine
 * as a teaching aid and wrong as a working sheet — an operator filling it in has
 * no way to know that Con-SM-6 draws no features at all, that Med-SM-17 draws
 * three where Med-SM-15 draws four, or that six of the nine Constructions
 * designs put a call to action above the number and the rest do not. They find
 * out from the poster.
 *
 * So this reads the contract off each template — the `data-slot` names in the
 * file are the list of fields it puts on a poster — and writes a row carrying
 * exactly those. Fields a template does not draw are marked, not left blank, so
 * the difference between "nothing goes here" and "I have not filled this in yet"
 * is visible.
 *
 * **It writes placeholders, not copy.** A generator cannot write a client's
 * marketing, and pretending otherwise produces a sheet that looks finished and
 * is not — the failure `sampleRowsFor` was rewritten to avoid. What it
 * guarantees is the *shape*: the right columns, the right number of features,
 * and a CTA wherever the design has one.
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.json scripts/build-vertical-sheet.ts \
 *        --out sheet.csv med-sm-15 med-sm-16 …
 */
import { writeFile } from 'node:fs/promises';

import {
  CONTENT_COLUMN_LABELS,
  POSTER_COLUMN_LABELS,
} from '@/lib/calendar-parse';
import {
  copyNeedsOf,
  HTML_TEMPLATE_SLUGS,
  loadHtmlTemplate,
  type HtmlTemplateSlug,
} from '@/lib/poster/html/template';

/**
 * What goes in a cell the template has no slot for.
 *
 * Not blank. A blank cell in a sheet means "not filled in yet", and an operator
 * who cannot tell that apart from "this design has no eyebrow" will either
 * write something that never appears or leave something out that should have.
 */
const NOT_DRAWN = '—';

/** RFC-4180 quoting, matching `csvCell` in calendar-parse.ts. */
function cell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const outAt = argv.indexOf('--out');
  const out = outAt >= 0 ? argv[outAt + 1] : null;
  const daysAt = argv.indexOf('--days');
  const days = daysAt >= 0 ? Number.parseInt(argv[daysAt + 1] ?? '', 10) : Number.NaN;
  const consumed = new Set([outAt, outAt + 1, daysAt, daysAt + 1]);
  const slugs = argv.filter((_, i) => !consumed.has(i));

  const all = (slugs.length > 0 ? slugs : [...HTML_TEMPLATE_SLUGS]) as HtmlTemplateSlug[];
  /*
   * Capped to the plan's length when one is given.
   *
   * A vertical can hold more templates than a client's plan has days, and the
   * importer rejects a row past the duration — nine rows against a seven-day
   * plan is two rows refused at the last step, after the operator has filled
   * them in. `--days` is the plan duration, so the sheet is the right length
   * before anyone types into it.
   */
  const wanted = Number.isFinite(days) && days > 0 ? all.slice(0, days) : all;
  if (wanted.length < all.length) {
    console.log(`  (${all.length - wanted.length} template(s) left out to fit a ${days}-day plan)`);
  }
  const unknown = all.filter((slug) => !HTML_TEMPLATE_SLUGS.includes(slug));
  if (unknown.length > 0) {
    console.error(`Not a registered template: ${unknown.join(', ')}`);
    process.exit(1);
  }

  const header = [...Object.values(CONTENT_COLUMN_LABELS), ...POSTER_COLUMN_LABELS];
  const lines: string[] = [header.map(cell).join(',')];

  for (const [index, slug] of wanted.entries()) {
    const template = await loadHtmlTemplate(slug);
    const needs = copyNeedsOf(template);
    const label = template.manifest.label;
    const day = String(index + 1);

    const subject = template.manifest.photos.some((photo) => photo.kind === 'subject');
    const imagePrompt = subject
      ? 'FILL: one person, standing, full body, plain background — this design cuts the figure out'
      : 'FILL: the photograph, described as a scene. No text, letters or logos in frame.';

    // Exactly as many features as the design draws, and no rows for a design
    // that draws none.
    const features: string[] = [];
    for (let slot = 1; slot <= 4; slot += 1) {
      if (slot <= needs.features) {
        features.push('FILL: icon', `FILL: label ${slot}`, `FILL: body ${slot}`);
      } else {
        features.push(NOT_DRAWN, NOT_DRAWN, NOT_DRAWN);
      }
    }

    lines.push(
      [
        day,
        label,
        'FILL: the WhatsApp caption for this day.',
        'FILL: #hashtags #for #this #day',
        imagePrompt,
        NOT_DRAWN,
        'FILL: TWO TO FOUR | SHORT LINES | SEPARATED BY BARS',
        '2',
        needs.eyebrow ? 'FILL: eyebrow' : NOT_DRAWN,
        needs.body ? 'FILL: the paragraph under the headline.' : NOT_DRAWN,
        ...features,
        needs.ctaLabel ? 'FILL: the call to action' : NOT_DRAWN,
        needs.callLabel ? 'FILL: word before the number' : NOT_DRAWN,
        needs.websiteLabel ? 'FILL: word before the website' : NOT_DRAWN,
        'no',
      ].map(cell).join(','),
    );

    const drawn = [
      `${needs.features} feature(s)`,
      needs.eyebrow ? 'eyebrow' : null,
      needs.body ? 'body' : null,
      needs.ctaLabel ? 'cta' : null,
      needs.callLabel ? 'call label' : null,
      needs.websiteLabel ? 'website label' : null,
      needs.logo ? 'logo' : 'NO LOGO',
    ].filter(Boolean);
    console.log(`  ${label.padEnd(10)} ${drawn.join(', ')}`);
  }

  const csv = lines.join('\r\n');
  if (out) {
    await writeFile(out, `﻿${csv}`, 'utf8');
    console.log(`\n${wanted.length} row(s) written to ${out}`);
  } else {
    console.log(`\n${csv}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
