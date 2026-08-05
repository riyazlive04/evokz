import { generateStructured } from '@/lib/ai/openai';
import { POSTER_COPY_RULES, POSTER_SCHEMA } from '@/lib/ai/poster-prompt';
import { prisma } from '@/lib/prisma';
import { parseBrandGuideline, type BrandGuideline } from '@/lib/types/brand';
import { coercePosterCopy, parsePosterCopy, type PosterCopy } from '@/lib/types/poster';

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
export async function ensurePosterCopy(calendarId: string): Promise<PosterCopy> {
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
      `The day's content angle: ${entry.theme}`,
      '',
      // The caption and photo brief already exist for this day, so the poster copy
      // is anchored to them rather than invented independently — otherwise the
      // headline can contradict the photograph it is typeset over.
      `The caption being sent with this creative (for tone and subject, do not copy it): ${entry.caption}`,
      '',
      `The background photograph is: ${entry.imagePrompt}`,
      '',
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
    throw new Error(
      `Poster copy for day ${entry.dayNumber} could not be used: the model returned ` +
        'no usable headline, body or feature set.',
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
