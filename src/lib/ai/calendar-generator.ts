import { z } from 'zod';

import { generateStructured } from '@/lib/ai/openai';
import {
  buildImagePromptRules,
  POSTER_COPY_RULES,
  POSTER_SCHEMA,
} from '@/lib/ai/poster-prompt';
import { normalizeHashtags } from '@/lib/calendar-parse';
import { intEnv } from '@/lib/env';
import { prisma } from '@/lib/prisma';
import { getAppTimeZone, nthDeliveryDate } from '@/lib/time';
import { parseBrandGuideline, type BrandGuideline } from '@/lib/types/brand';
import { coercePosterCopy } from '@/lib/types/poster';

/**
 * Content calendar generator — the stage that populates `ContentCalendar`.
 *
 * Without this, the dispatch engine and creative pipeline have nothing to
 * deliver: they consume calendar rows but nothing else creates them.
 *
 * Generation is chunked and run **sequentially**. Two reasons: a single request
 * for 365 days would blow past `max_tokens`, and concurrent requests cannot read
 * a prompt cache entry that a sibling request is still writing — so the
 * per-client brand prefix would be re-billed on every batch instead of once.
 */

/**
 * Built per vertical rather than held as a constant: the photo brief embedded in
 * it names industry-specific subjects. Still stable for the whole run of one
 * client, which is what the prompt cache needs.
 */
function buildSystemPromptHeader(categoryName: string): string {
  return `You are the Content Director for Evokz ACE, producing a daily social media calendar for one client.

Each day becomes a **designed poster**, not a bare photograph. The delivered creative is a background photograph with a typographic layer composited on top of it: a logo lockup, a stacked all-caps headline, a short body paragraph, a row of icon features, and a contact bar. You write both the photograph brief and the text that goes on it.

For each requested day produce:
- theme: a 2-5 word content angle. Every theme in the campaign must be distinct.
- caption: a ready-to-post WhatsApp/social caption of 40-90 words in the client's brand voice. Open with a hook, close with one clear call to action. This is the message body, NOT text that appears on the image. Never mention that it was AI-generated.
- hashtags: 5-8 space-separated tags, each starting with "#", mixing broad and niche reach. No commas.
- imagePrompt: a single-paragraph text-to-image prompt (50-90 words) for the BACKGROUND PHOTOGRAPH only.
- poster: the text that will be typeset onto that photograph.

${buildImagePromptRules(categoryName)}

${POSTER_COPY_RULES}

Hard rules:
- Return exactly one entry per requested day number, using the day numbers given.
- Vary subject, composition and headline structure across consecutive days. Do not restate one idea with different wording.`;
}

const CALENDAR_SCHEMA = {
  type: 'object',
  properties: {
    days: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          dayNumber: { type: 'integer' },
          theme: { type: 'string' },
          caption: { type: 'string' },
          hashtags: { type: 'string' },
          imagePrompt: { type: 'string' },
          poster: POSTER_SCHEMA,
        },
        required: [
          'dayNumber',
          'theme',
          'caption',
          'hashtags',
          'imagePrompt',
          'poster',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['days'],
  additionalProperties: false,
} as const;

/** Re-validated defensively: structured outputs guarantee shape, not sanity. */
const generatedDaySchema = z.object({
  dayNumber: z.number().int().positive(),
  theme: z.string().trim().min(1),
  caption: z.string().trim().min(1),
  hashtags: z.string().trim(),
  imagePrompt: z.string().trim().min(1),
  // Left unvalidated here and narrowed by `coercePosterCopy` instead: a poster
  // block that fails validation must not discard an otherwise good day, since the
  // caption and image prompt are still deliverable and the poster copy can be
  // backfilled by `ensurePosterCopy` later.
  poster: z.unknown().optional(),
});

type GeneratedDay = z.infer<typeof generatedDaySchema>;

export interface GenerateCalendarOptions {
  /** Cap how many missing days to generate in this run. */
  limit?: number;
  /** Days per request. Smaller batches are more reliable; default 10. */
  batchSize?: number;
}

export interface GenerateCalendarResult {
  clientId: string;
  companyName: string;
  totalDays: number;
  alreadyPresent: number;
  requested: number;
  inserted: number;
  batches: number;
  /** Days still missing after this run (when `limit` capped the work). */
  remaining: number;
}

export async function generateContentCalendar(
  clientId: string,
  options: GenerateCalendarOptions = {},
): Promise<GenerateCalendarResult> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      companyName: true,
      whatsappNumber: true,
      startDate: true,
      deliveryDays: true,
      brandGuideline: true,
      plan: { select: { name: true, durationDays: true } },
      category: { select: { name: true } },
    },
  });
  if (!client) throw new Error(`Client ${clientId} does not exist`);

  const totalDays = client.plan.durationDays;
  if (totalDays < 1) {
    throw new Error(`Plan "${client.plan.name}" has an invalid durationDays`);
  }

  const existing = await prisma.contentCalendar.findMany({
    where: { clientId },
    select: { dayNumber: true },
  });
  const present = new Set(existing.map((row) => row.dayNumber));

  const missing: number[] = [];
  for (let day = 1; day <= totalDays; day += 1) {
    if (!present.has(day)) missing.push(day);
  }

  const limit = Math.max(0, options.limit ?? missing.length);
  const target = missing.slice(0, limit);

  if (target.length === 0) {
    return {
      clientId,
      companyName: client.companyName,
      totalDays,
      alreadyPresent: present.size,
      requested: 0,
      inserted: 0,
      batches: 0,
      remaining: missing.length,
    };
  }

  const batchSize = Math.max(1, Math.min(options.batchSize ?? intEnv('CALENDAR_BATCH_SIZE', 10), 25));
  const guideline = parseBrandGuideline(client.brandGuideline);

  // Stable per-client prefix — cached, so batch 2..N read it instead of
  // re-billing. Nothing day-specific may appear here.
  const systemPrompt = [
    buildSystemPromptHeader(client.category.name),
    '',
    '--- CLIENT BRIEF ---',
    `Company: ${client.companyName}`,
    `Industry: ${client.category.name}`,
    `Campaign length: ${totalDays} days`,
    describeBrand(guideline),
  ].join('\n');

  const timeZone = getAppTimeZone();

  const collected = new Map<number, GeneratedDay>();
  let batches = 0;

  for (let offset = 0; offset < target.length; offset += batchSize) {
    const chunk = target.slice(offset, offset + batchSize);
    batches += 1;

    const result = await generateStructured<{ days?: unknown[] }>({
      label: `calendar:${client.companyName}:days ${chunk[0]}-${chunk[chunk.length - 1]}`,
      bill: { clientId, operation: 'calendar' },
      systemPrompt,
      userPrompt: [
        `Produce calendar entries for these day numbers: ${chunk.join(', ')}.`,
        `These are days ${chunk[0]}–${chunk[chunk.length - 1]} of a ${totalDays}-day campaign.`,
        collected.size > 0
          ? `Themes already used earlier in this campaign — do not repeat or paraphrase them: ${[
              ...collected.values(),
            ]
              .map((day) => day.theme)
              .join('; ')}`
          : null,
      ]
        .filter((line): line is string => line !== null)
        .join('\n'),
      schema: CALENDAR_SCHEMA as unknown as Record<string, unknown>,
      schemaName: 'content_calendar_batch',
      // Creative copy: lift variance so consecutive days don't converge on one
      // template. The already-used-themes list in the prompt does the rest.
      temperature: 0.9,
    });

    const requestedInChunk = new Set(chunk);

    for (const candidate of result.days ?? []) {
      const parsed = generatedDaySchema.safeParse(candidate);
      if (!parsed.success) continue;
      // Ignore days we did not ask for, and any duplicate the model emits.
      if (!requestedInChunk.has(parsed.data.dayNumber)) continue;
      if (collected.has(parsed.data.dayNumber)) continue;
      collected.set(parsed.data.dayNumber, parsed.data);
    }

    const missedInChunk = chunk.filter((day) => !collected.has(day));
    if (missedInChunk.length > 0) {
      console.warn(
        `[ace:calendar] ${client.companyName}: model omitted day(s) ${missedInChunk.join(', ')} — they stay unseeded and can be generated on a later run.`,
      );
    }
  }

  if (collected.size === 0) {
    throw new Error('The model produced no usable calendar entries.');
  }

  const rows = [...collected.values()]
    .sort((a, b) => a.dayNumber - b.dayNumber)
    .map((day) => ({
      clientId,
      dayNumber: day.dayNumber,
      // Day 1 lands on the campaign start date. Calendar-day arithmetic, so a
      // DST transition mid-campaign cannot shift a row into the adjacent day.
      // Day 1 lands on the campaign start date, and subsequent days on the
      // client's accepted weekdays only — so a restricted 30-day plan still
      // yields 30 rows, just spread over more calendar days. Calendar-day
      // arithmetic throughout, so a DST transition mid-campaign cannot shift a
      // row into the adjacent local day.
      scheduledDate: nthDeliveryDate(
        client.startDate,
        day.dayNumber,
        client.deliveryDays,
        timeZone,
      ),
      theme: day.theme,
      caption: day.caption,
      hashtags: normalizeHashtags(day.hashtags),
      imagePrompt: day.imagePrompt,
      // Null when the poster block was unrepairable. The day still seeds and
      // still delivers; `ensurePosterCopy` fills the gap on first render rather
      // than re-billing a whole batch for one bad slot set.
      posterCopy: coercePosterCopy(day.poster) ?? undefined,
    }));

  const withoutPoster = rows.filter((row) => row.posterCopy === undefined).length;
  if (withoutPoster > 0) {
    console.warn(
      `[ace:calendar] ${client.companyName}: ${withoutPoster} of ${rows.length} day(s) ` +
        'produced unusable poster copy and will be backfilled at render time.',
    );
  }

  // skipDuplicates leans on @@unique([clientId, dayNumber]) so a concurrent run
  // cannot produce a constraint failure or a double-seeded day.
  const created = await prisma.contentCalendar.createMany({
    data: rows,
    skipDuplicates: true,
  });

  return {
    clientId,
    companyName: client.companyName,
    totalDays,
    alreadyPresent: present.size,
    requested: target.length,
    inserted: created.count,
    batches,
    remaining: missing.length - created.count,
  };
}

/** Renders the extracted guideline into brief lines for the system prefix. */
function describeBrand(guideline: BrandGuideline): string {
  const lines: string[] = [];

  if (guideline.typography) {
    lines.push(
      `Brand voice / vibe: ${guideline.typography.vibeClassification ?? 'not specified'}`,
      `Typography: ${guideline.typography.headingFont} (headings), ${guideline.typography.bodyFont} (body)`,
    );
  }

  if (guideline.colors.length > 0) {
    lines.push(
      `Palette: ${guideline.colors.map((color) => `${color.hex} (${color.role})`).join(', ')}`,
      'Every imagePrompt must keep the visual treatment consistent with this palette.',
    );
  }

  if (guideline.layoutDirectives.length > 0) {
    lines.push('Layout directives:');
    lines.push(...guideline.layoutDirectives.map((directive) => `- ${directive}`));
  }

  if (lines.length === 0) {
    return 'Brand tokens: not yet extracted. Use a clean, professional treatment appropriate to the industry.';
  }

  return lines.join('\n');
}
