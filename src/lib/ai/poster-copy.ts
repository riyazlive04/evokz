import { generateStructured } from '@/lib/ai/openai';
import { POSTER_COPY_RULES, POSTER_SCHEMA } from '@/lib/ai/poster-prompt';
import { prisma } from '@/lib/prisma';
import type { LayoutCopyShape } from '@/lib/types/layout-spec';
import { parseBrandGuideline, type BrandGuideline } from '@/lib/types/brand';
import {
  coercePosterCopy,
  describePosterCopyGap,
  parsePosterCopy,
  type PosterCopy,
} from '@/lib/types/poster';

/**
 * Single-day poster-copy backfill.
 *
 * `calendar-generator` writes poster copy for every day it seeds, so this stage is
 * a repair path, not the main one. It exists for two cases:
 *
 *   1. Rows seeded before the poster layer existed, whose `posterCopy` is null.
 *   2. Rows whose poster block came back unrepairable from the batch call.
 *
 * Called from the pipeline immediately before rendering, so a client mid-campaign
 * starts getting text-bearing creatives without anyone re-seeding their calendar.
 */

// Deliberately says nothing about the client's industry: naming construction and
// real estate here pulled headlines for every other vertical toward property
// language. The actual vertical reaches the model through the user prompt's
// `Industry:` line, which keeps this prefix constant and therefore cacheable.
const SYSTEM_PROMPT = `You are the Content Director for Evokz ACE, writing the text layer for one client poster.

The poster is a background photograph with a typographic layer composited on top: a logo lockup, a stacked all-caps headline, a short body paragraph, a row of icon features, a call-to-action button, and a contact bar. You are writing only that text layer. You are not writing a caption and not describing the photograph.

Which of those a given poster actually draws depends on the template the day is laid out in, and you will be told. Every field is required whether or not it is drawn.

${POSTER_COPY_RULES}`;

/**
 * Returns the row's poster copy, generating and persisting it when absent.
 *
 * Throws only when the model cannot produce usable copy at all. That is the right
 * behaviour here: without poster copy there is nothing to typeset, and the
 * pipeline's `FAILED` state with a readable reason beats delivering a photograph
 * with no text on it — the exact defect this whole layer exists to fix.
 */
export async function ensurePosterCopy(
  calendarId: string,
  /**
   * The layout this day will be drawn in, when the caller knows it.
   *
   * Omitted by the backfill paths that have no layout in hand. Supplying it is
   * what makes the copy fit the template rather than the template absorb
   * whatever copy arrived: a three-column feature strip asked for four items
   * reads as a mistake, and an eyebrow written for a layout with no eyebrow slot
   * is tokens spent on words nobody sees.
   */
  shape?: LayoutCopyShape,
): Promise<PosterCopy> {
  const entry = await prisma.contentCalendar.findUnique({
    where: { id: calendarId },
    select: {
      id: true,
      dayNumber: true,
      theme: true,
      caption: true,
      imagePrompt: true,
      posterCopy: true,
      client: {
        select: {
          id: true,
          companyName: true,
          brandGuideline: true,
          category: { select: { name: true } },
        },
      },
    },
  });

  if (!entry) throw new Error(`Calendar entry ${calendarId} does not exist`);

  const existing = parsePosterCopy(entry.posterCopy);
  if (existing) return existing;

  const guideline = parseBrandGuideline(entry.client.brandGuideline);

  const generated = await generateStructured<unknown>({
    label: `poster-copy:${entry.client.companyName}:day ${entry.dayNumber}`,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: [
      `Company: ${entry.client.companyName}`,
      `Industry: ${entry.client.category.name}`,
      describeBrandVoice(guideline),
      '',
      /*
       * Omitted entirely — line and separator — when the day has no theme, which
       * is every day imported from a sheet since the importer dropped that
       * column. Interpolating a null would put the literal text "null" in front
       * of the model as the day's angle.
       *
       * This degrades onto a stronger signal rather than a weaker one. A theme
       * was 2-5 words; the caption below is a paragraph on the same day's subject
       * in the same voice, and the prompt already frames it as the thing the
       * poster copy must agree with. Do not "restore" this line.
       */
      ...(entry.theme ? [`The day's content angle: ${entry.theme}`, ''] : []),
      // The caption and photo brief already exist for this day, so the poster copy
      // is anchored to them rather than invented independently — otherwise the
      // headline can contradict the photograph it is typeset over.
      `The caption being sent with this creative (for tone and subject, do not copy it): ${entry.caption}`,
      '',
      `The background photograph is: ${entry.imagePrompt}`,
      '',
      // The layout's own demands, when the caller knows them. This is what stops
      // a three-card feature strip being handed four items, and an eyebrow being
      // written for a template that has nowhere to draw one.
      ...(shape ? [describeLayoutFit(shape), ''] : []),
      'Write the poster text layer for this day.',
    ].join('\n'),
    schema: POSTER_SCHEMA as unknown as Record<string, unknown>,
    schemaName: 'poster_copy',
    // Lower than the calendar's 0.9: this is a single repair, and there are no
    // sibling days in the same call to diverge from.
    temperature: 0.7,
    bill: { clientId: entry.client.id, calendarId: entry.id, operation: 'poster-copy' },
  });

  const copy = coercePosterCopy(generated);
  if (!copy) {
    // Names the missing part. The previous message listed all three, so an
    // operator — and whoever they ask — could not tell which one to chase, and
    // finding out meant replaying the call by hand.
    throw new Error(
      `Poster copy for day ${entry.dayNumber} could not be used: ` +
        describePosterCopyGap(generated),
    );
  }

  await prisma.contentCalendar.update({
    where: { id: calendarId },
    data: { posterCopy: copy },
  });

  return copy;
}

/** Voice and palette lines only — the layout is the renderer's business. */
function describeBrandVoice(guideline: BrandGuideline): string {
  const vibe = guideline.typography?.vibeClassification;
  const lines = [
    vibe ? `Brand voice / vibe: ${vibe}` : 'Brand voice: professional and direct.',
  ];

  if (guideline.layoutDirectives.length > 0) {
    lines.push(`Brand directives: ${guideline.layoutDirectives.join('; ')}`);
  }

  return lines.join('\n');
}

/**
 * Tells the model what the chosen layout can actually show.
 *
 * Steered through the prompt rather than the schema because `POSTER_SCHEMA` runs
 * under OpenAI Structured Outputs, where every property must stay required — an
 * eyebrow field cannot be made conditional. The renderer already drops content
 * for slots a spec omits, so the win here is the feature count and not wasting
 * the model's attention on slots that will never be drawn.
 */
function describeLayoutFit(shape: LayoutCopyShape): string {
  const notes: string[] = [
    'This day is laid out in a specific template. Fit the copy to it:',
  ];

  if (!shape.hasFeatures) {
    notes.push(
      '- features: this layout has no feature block. Still supply 3 — they are required — but keep them short; they will not be shown.',
    );
  } else if (shape.featureBodies) {
    notes.push(
      `- features: exactly ${shape.featureCount} items. The layout has room for ` +
        `${shape.featureCount} and reads as a mistake with more.`,
    );
    /*
     * A narrow feature column is the same fault as a narrow headline column two
     * branches below, and it went unreported for far longer. Under about a third
     * of the poster's width the icon, the gap and the padding have taken most of
     * the column, and a full sentence sets at the fitter's floor or stacks a word
     * per line. Measured: a quarter-width column on a 1080 canvas left 52px for
     * the words.
     */
    if (shape.featureWidthShare < 0.34) {
      notes.push(
        `  The feature block is only ${Math.round(shape.featureWidthShare * 100)}% of the ` +
          'poster width, so each item is a narrow column. Keep every label to one or ' +
          'two words, keep each body under 40 characters, and avoid long words — ' +
          'nothing can wrap a word wider than the column.',
      );
    }
  } else {
    // The card row shows the label and nothing else, so the body is written,
    // stored, and never drawn — `posterFeatureSchema.body` is `.min(1)`, so it
    // cannot be omitted. Asking for a short one keeps the tokens honest and
    // leaves the copy usable if the template is later swapped for one that does
    // draw bodies.
    notes.push(
      `- features: exactly ${shape.featureCount} items, and this layout draws only ` +
        'the labels — no sentence is shown. Make each label carry the whole idea in ' +
        'one or two words, and keep the body to a short sentence; it is stored but ' +
        'not displayed.',
    );
  }

  notes.push(
    shape.hasEyebrow
      ? '- eyebrow: this layout shows one. A short all-caps kicker is worth writing.'
      : '- eyebrow: this layout has no eyebrow. Send an empty string.',
  );

  /*
   * Phrased as "still required, still worth writing, simply not drawn", exactly
   * like the body note below and for the reason recorded there: told plainly
   * that a slot is absent, gpt-4o sends an empty string, and an empty string
   * fails `coercePosterCopy`'s repair for a field it cannot invent.
   *
   * `ctaLabel` is the milder case — its repair falls back to a default rather
   * than failing the day — but a poster carrying "LEARN MORE" because the prompt
   * implied the field was optional is a worse poster than one carrying the ask
   * the model would have written.
   */
  notes.push(
    shape.hasCta
      ? '- ctaLabel: this layout draws a button. Write the instruction that belongs ' +
        'on it for this day — two to four words, at most 28 characters including ' +
        'spaces. One character over and it is discarded for a generic fallback, so ' +
        'count it.'
      : '- ctaLabel: this layout has no button, but the field is still required. ' +
        'Write a short instruction anyway — it is stored, and is used if this day ' +
        'is later laid out in a template that draws one.',
  );

  if (!shape.hasBody) {
    /*
     * "This layout has no body paragraph" on its own reads as permission to skip
     * it, and gpt-4o duly returned `body: ""` — which `coercePosterCopy` treats
     * as unusable, failing the whole day. Six of seven live Medicals templates
     * have no body slot, so that phrasing broke every one of them.
     *
     * Phrased like the label-only feature bodies above: still required, still
     * worth writing, simply not drawn here.
     */
    notes.push(
      '- body: this layout does not draw the body paragraph, but it is still ' +
        'required. Write one short sentence — it is stored, and is used if this ' +
        'day is later laid out in a template that shows it.',
    );
  }

  /*
   * The template's own line count, when it was measured.
   *
   * `headlineEmphasis` is indexed by line, so writing a different number of
   * lines from the template's silently flattens the headline: a reference
   * measured at three lines — accent, accent, heavy — handed two takes `accent`
   * for both, and every line comes out the same colour. Seen on a live poster,
   * where a headline designed around one emphasised line rendered as four
   * identical blue ones.
   */
  if (shape.headlineLineCount > 0) {
    notes.push(
      `- headline: write exactly ${shape.headlineLineCount} line(s). This template sets its ` +
        `headline over ${shape.headlineLineCount}, and the emphasis on each line is measured ` +
        'from it — a different count loses the contrast between them.',
    );
  }

  /*
   * Line length, scaled to the column rather than judged against one threshold.
   *
   * This used to fire only below 45% and then ask for 12 characters, which left
   * everything between "narrow" and "full width" unadvised: a 60% column holds
   * about eight capitals at headline size, and a 22-character line written for it
   * wrapped to two visual lines apiece — the headline the copy stage authored as
   * two lines rendered as four.
   *
   * `HEADLINE_CAPS_PER_COLUMN` is derived in reference space rather than measured
   * here, because this module has no `PosterMetrics` — see the constant.
   */
  const budget = headlineCharBudget(shape.headlineWidthShare);
  if (shape.headlineWidthShare < 0.85) {
    notes.push(
      `- headline: the headline column is ${Math.round(shape.headlineWidthShare * 100)}% of the ` +
        `poster width. Keep every line to ${budget} characters or fewer — past that the ` +
        'line wraps, which undoes the line breaks you chose.',
    );
  }

  return notes.join('\n');
}

/**
 * Capitals that fit one headline line before it *wraps*.
 *
 * The threshold that matters is wrapping, not shrinking, and the two are far
 * apart. `fitHeadline` sets a long line smaller — down to 55% of base — and only
 * wraps once even that will not fit. A line set slightly small still reads as
 * one deliberate line; a wrapped one destroys the line breaks the copywriter
 * chose, which is the whole defect this note exists to prevent. Budgeting to the
 * no-shrink point instead would demand about seven characters in a 60% column
 * and produce telegraphese for no gain.
 *
 * Derived in the reference frame rather than the output canvas, which is the
 * only option here — this runs in the copy stage, long before a canvas exists.
 * Both scale together so the ratio holds: `REFERENCE_WIDTH` 940, the 48px canvas
 * margin each side, `SAFETY` 0.96, a 3-line headline at 86px, the 0.55 shrink
 * floor, and `AVERAGE_CAP_ADVANCE` 0.75 — the measured advance of a
 * heavy-grotesque capital, see metrics.ts.
 *
 * Lands at ~23 for a full-width column, which is the schema's own 24-character
 * cap arrived at independently — a good sign the arithmetic is right.
 *
 * Floored at 6: below that the advice stops being actionable, and a column that
 * tight is a layout problem rather than a copy one.
 */
function headlineCharBudget(widthShare: number): number {
  const columnPx = Math.max(0, widthShare * 940 - 96);
  return Math.max(6, Math.round((columnPx * 0.96) / (0.55 * 86 * 0.75)));
}
