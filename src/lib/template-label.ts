import { z } from 'zod';

/**
 * Naming rules for a vertical's reference templates.
 *
 * A template's label stopped being a caption when the calendar importer started
 * choosing layouts by name: it is now a key an operator types into a spreadsheet
 * three hundred times, so it has to be unique within its vertical, stable, and
 * forgiving about the ways a human types the same name twice.
 *
 * Deliberately free of Prisma, matching `src/lib/template-limits.ts`. The
 * importer's parser is isomorphic and runs in the browser, and it needs
 * `normalizeTemplateLabel` to match a typed name against the catalogue it was
 * handed — a module that reached for the database could not be imported there.
 */

/**
 * Ceiling on a label.
 *
 * The uploader has always sliced filenames to this, so it is the length every
 * existing label already respects. Long enough for "Grand opening, split hero
 * with detail band" and short enough to stay readable in a spreadsheet column.
 */
export const TEMPLATE_LABEL_MAX = 120;

export const templateLabelSchema = z
  .string()
  .trim()
  .min(1, 'Template name is required')
  .max(TEMPLATE_LABEL_MAX, `Template name is longer than ${TEMPLATE_LABEL_MAX} characters`);

/**
 * The form two labels are compared in.
 *
 * Case and internal spacing are exactly the differences a person does not intend:
 * "Grand Opening" typed into a sheet is the same template as "grand opening" in
 * the console, and a double space between words is a typo rather than a second
 * template. The stored label keeps its original case — this is only ever the
 * comparison key.
 *
 * NOT the same normalisation as `normalizeHeader` in calendar-parse.ts, which
 * strips every non-alphanumeric character. That is right for matching a column
 * heading against a fixed vocabulary and wrong here: it would fold "Promo-2" and
 * "Promo 2" into one name, and those are two templates an operator deliberately
 * made distinct.
 */
export function normalizeTemplateLabel(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * First free name in the `base`, `base-2`, `base-3` series.
 *
 * Used on upload, where the base is a filename and a re-upload of the same file
 * is the common case rather than the exception. Suffixing beats rejecting: the
 * bytes are already in Drive by the time this runs, and refusing the row over a
 * name collision would lose the operator's upload to something they can rename in
 * two seconds.
 *
 * The cap is `MAX_TEMPLATES_PER_CATEGORY` — a vertical cannot hold more templates
 * than that, so a higher suffix is unreachable by construction. Past it, fall back
 * to something that cannot collide at all rather than looping.
 */
export function dedupeTemplateLabel(
  base: string,
  takenNormalized: ReadonlySet<string>,
  uniqueSuffix = '',
): string {
  const trimmed = base.trim().slice(0, TEMPLATE_LABEL_MAX) || 'Untitled';
  if (!takenNormalized.has(normalizeTemplateLabel(trimmed))) return trimmed;

  for (let n = 2; n <= 101; n += 1) {
    const candidate = `${trimmed}-${n}`;
    if (!takenNormalized.has(normalizeTemplateLabel(candidate))) return candidate;
  }

  return `${trimmed} (${uniqueSuffix || 'dup'})`;
}
