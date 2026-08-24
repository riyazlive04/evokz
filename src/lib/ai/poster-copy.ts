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

The poster is a background photograph with a typographic layer composited on top: a logo lockup, a stacked all-caps headline, a short body paragraph, a row of icon features, and a contact bar. You are writing only that text layer. You are not writing a caption and not describing the photograph.

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

  // Below roughly a third of the canvas the headline column is narrow enough
  // that `fittedHeadlineSize` shrinks the type toward its floor, which reads as
  // a smaller headline rather than a designed one. Shorter lines avoid it.
  if (shape.headlineWidthShare < 0.45) {
    notes.push(
      `- headline: the headline column is only ${Math.round(shape.headlineWidthShare * 100)}% ` +
        'of the poster width. Keep every line to 12 characters or fewer, and prefer 3-4 short lines over 2 long ones.',
    );
  }

  return notes.join('\n');
}
