import type { CampaignContentStatus } from '@prisma/client';
import { z } from 'zod';

import { buildImagePromptRules } from '@/lib/ai/poster-prompt';
import { normalizeHashtags } from '@/lib/calendar-parse';
import {
  isSuggestedTemplateType,
  SUGGESTED_TEMPLATE_TYPES,
  type ContentStrategy,
} from '@/lib/campaign/content-strategy';

/**
 * Campaign content generation — the pure half.
 *
 * Which days a request targets, how they are chunked, what the model is asked
 * and in what shape, and how its answer is validated before anything is
 * written. No database and no network, so every rule here is pinned by
 * `npm run check:campaign-content`. `content-generation.ts` applies it to rows.
 */

/** Days per model request. One failed request costs one chunk, not a campaign. */
export const CONTENT_CHUNK_DAYS = 30;

/**
 * `missing` writes only empty slots and is safe to repeat. `overwrite` replaces
 * existing content and must be asked for explicitly.
 */
export type ContentGenerationMode = 'missing' | 'overwrite';

/** The part of a campaign day generation reads. */
export interface ContentSlot {
  id: string;
  dayNumber: number;
  scheduledDate: Date;
  contentStatus: CampaignContentStatus | null;
  contentRevision: number;
  updatedAt: Date;
  contentType: string | null;
  theme: string | null;
  headline: string | null;
  cta: string | null;
}

/** Empty slots. A campaign day with no status predates Phase 2 and is empty too. */
export function isEmptySlot(slot: Pick<ContentSlot, 'contentStatus'>): boolean {
  return slot.contentStatus === null || slot.contentStatus === 'NOT_GENERATED';
}

/** The days a request writes, in day order. */
export function selectTargetDays<T extends Pick<ContentSlot, 'dayNumber' | 'contentStatus'>>(
  slots: readonly T[],
  range: { fromDay: number; toDay: number; mode: ContentGenerationMode },
): T[] {
  return slots
    .filter((slot) => slot.dayNumber >= range.fromDay && slot.dayNumber <= range.toDay)
    .filter((slot) => range.mode === 'overwrite' || isEmptySlot(slot))
    .sort((a, b) => a.dayNumber - b.dayNumber);
}

/** Consecutive groups of at most `size` targets, in day order. */
export function chunkDays<T>(targets: readonly T[], size = CONTENT_CHUNK_DAYS): T[][] {
  const chunkSize = Math.max(1, Math.floor(size));
  const chunks: T[][] = [];
  for (let offset = 0; offset < targets.length; offset += chunkSize) {
    chunks.push(targets.slice(offset, offset + chunkSize));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * Everything the model is told about the campaign. Deliberately only these
 * fields: no Drive ids, URLs, phone numbers, logo locations or credentials can
 * reach a prompt because none of them is in this shape.
 */
export interface ContentBrief {
  companyName: string;
  verticalName: string;
  planName: string;
  durationDays: number;
  startDateLabel: string;
  deliveryDaysLabel: string;
  brandTagline: string | null;
  brandVoice: string | null;
  strategy: ContentStrategy;
}

export interface RequestedDay {
  dayNumber: number;
  /** e.g. "Wed 14 Oct 2026". */
  dateLabel: string;
  contentType: string;
}

export interface ContentHistory {
  /** Topics already used elsewhere in the campaign, as "day: topic". */
  topics: string[];
  /** Recent headlines, as "day: headline". */
  headlines: string[];
  /** Recent calls to action. */
  ctas: string[];
}

/** How much history a request carries. Topics are short, so all of them go. */
export const HISTORY_LIMITS = { topics: 400, headlines: 40, ctas: 12 } as const;

/**
 * What the rest of the campaign already says, for the model to steer away from.
 *
 * Every other written day's topic (the strongest guard against a year of
 * repeats), and the headlines and calls to action of the days *nearest* the
 * chunk — before or after it, so a range rewritten in the middle of a campaign
 * is told about both sides.
 */
export function buildContentHistory(
  slots: ReadonlyArray<Pick<ContentSlot, 'dayNumber' | 'theme' | 'headline' | 'cta'>>,
  chunkDayNumbers: readonly number[],
): ContentHistory {
  const inChunk = new Set(chunkDayNumbers);
  const middle = chunkDayNumbers.length > 0
    ? (Math.min(...chunkDayNumbers) + Math.max(...chunkDayNumbers)) / 2
    : 0;
  const others = slots.filter((slot) => !inChunk.has(slot.dayNumber));
  const nearest = [...others].sort(
    (a, b) => Math.abs(a.dayNumber - middle) - Math.abs(b.dayNumber - middle) || a.dayNumber - b.dayNumber,
  );
  const byDay = <T extends { dayNumber: number }>(rows: T[]) => rows.sort((a, b) => a.dayNumber - b.dayNumber);

  return {
    topics: byDay(others.filter((slot) => slot.theme?.trim()))
      .slice(0, HISTORY_LIMITS.topics)
      .map((slot) => `${slot.dayNumber}: ${slot.theme!.trim()}`),
    headlines: byDay(nearest.filter((slot) => slot.headline?.trim()).slice(0, HISTORY_LIMITS.headlines))
      .map((slot) => `${slot.dayNumber}: ${slot.headline!.trim()}`),
    ctas: [
      ...new Set(
        byDay(nearest.filter((slot) => slot.cta?.trim()).slice(0, HISTORY_LIMITS.ctas)).map((slot) => slot.cta!.trim()),
      ),
    ],
  };
}

/** Stable per campaign, so every chunk after the first reads it from the prompt cache. */
export function buildContentSystemPrompt(brief: ContentBrief): string {
  const pillars = brief.strategy.pillars
    .map((pillar) => `- ${pillar.key} (${pillar.label})${pillar.promotional ? ' [promotional]' : ''}: ${pillar.guidance || 'No extra guidance.'}`)
    .join('\n');
  const templateTypes = Object.entries(SUGGESTED_TEMPLATE_TYPES)
    .map(([key, label]) => `- ${key}: ${label}`)
    .join('\n');

  return `You are the content strategist for Evokz, planning a daily social media content calendar for one business. You write CONTENT for each day — the words and the photo brief. You do not design posters.

For each requested day return:
- dayNumber: exactly as requested.
- topic: a 2-6 word subject for the day. Every topic in the campaign must be distinct.
- contentType: exactly the content type given for that day.
- headline: 3-9 words, under 70 characters, a benefit or a hook rather than a sentence.
- supportingText: 12-35 words that deliver the headline's promise.
- cta: a 2-5 word call to action under 30 characters, following from the day's subject.
- caption: a 40-90 word social caption in the brand's voice. Open with a hook and close with the call to action.
- hashtags: 5-8 space-separated tags, each starting with "#". No commas.
- imagePrompt: a 40-80 word photo brief for the day's visual.
- suggestedTemplateType: the layout genre that best fits the day, from the list below.

Content types (the campaign strategy):
${pillars}

Suggested template types:
${templateTypes}

${buildImagePromptRules(brief.verticalName)}

Hard rules:
- Return exactly one entry per requested day, using the day numbers given, and no other days.
- Do not repeat or paraphrase a topic or headline listed as already used. Vary headline structure and calls to action from day to day.
- Make no factual claims about prices, discounts, offers, awards, statistics, years in business or customer counts, and invent no testimonials, reviews or quotes. You have no source for any of them.
- Mention a date, festival or season only where the connection is broadly true for the given date; never invent an event date.
- Write no phone number, URL or email address. Never mention AI.
- Write in English.

--- BUSINESS ---
Business: ${brief.companyName}
Industry: ${brief.verticalName}
Tagline: ${brief.brandTagline ?? 'none'}
Brand voice: ${brief.brandVoice ?? 'clear, warm and professional'}
Campaign: ${brief.planName}, ${brief.durationDays} content days from ${brief.startDateLabel}, delivered ${brief.deliveryDaysLabel}.`;
}

export function buildContentUserPrompt(days: readonly RequestedDay[], history: ContentHistory): string {
  const lines = [
    'Write content for these days (day number · date · content type):',
    ...days.map((day) => `${day.dayNumber} · ${day.dateLabel} · ${day.contentType}`),
  ];
  if (history.topics.length > 0) {
    lines.push('', `Topics already used — do not repeat or paraphrase: ${history.topics.join('; ')}`);
  }
  if (history.headlines.length > 0) {
    lines.push('', `Recent headlines — do not reuse: ${history.headlines.join('; ')}`);
  }
  if (history.ctas.length > 0) {
    lines.push('', `Recent calls to action — vary from these: ${history.ctas.join('; ')}`);
  }
  return lines.join('\n');
}

/** Strict JSON schema: every field required, content type and template type as enums. */
export function buildContentSchema(contentTypeKeys: readonly string[]): Record<string, unknown> {
  const text = { type: 'string' };
  return {
    type: 'object',
    properties: {
      days: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            dayNumber: { type: 'integer' },
            topic: text,
            contentType: { type: 'string', enum: [...contentTypeKeys] },
            headline: text,
            supportingText: text,
            cta: text,
            caption: text,
            hashtags: text,
            imagePrompt: text,
            suggestedTemplateType: { type: 'string', enum: Object.keys(SUGGESTED_TEMPLATE_TYPES) },
          },
          required: [
            'dayNumber',
            'topic',
            'contentType',
            'headline',
            'supportingText',
            'cta',
            'caption',
            'hashtags',
            'imagePrompt',
            'suggestedTemplateType',
          ],
          additionalProperties: false,
        },
      },
    },
    required: ['days'],
    additionalProperties: false,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Structured outputs guarantee shape, not sanity: re-checked field by field. */
const generatedDaySchema = z.object({
  dayNumber: z.number().int().positive(),
  topic: z.string().trim().min(1).max(200),
  contentType: z.string().trim().min(1),
  headline: z.string().trim().min(1).max(200),
  supportingText: z.string().trim().min(1).max(1000),
  cta: z.string().trim().min(1).max(80),
  caption: z.string().trim().min(1).max(4000),
  hashtags: z.string().trim().max(1000),
  imagePrompt: z.string().trim().min(1).max(4000),
  suggestedTemplateType: z.string().trim(),
});

/** Content ready to write to one day. Field names are the database's. */
export interface ValidatedDayContent {
  dayNumber: number;
  theme: string;
  contentType: string;
  headline: string;
  supportingText: string;
  cta: string;
  caption: string;
  hashtags: string;
  imagePrompt: string;
  suggestedTemplateType: string | null;
  contentStatus: 'READY' | 'NEEDS_REVIEW';
  /** Findings behind NEEDS_REVIEW. Empty when READY. */
  contentIssues: string[];
}

export interface ChunkValidation {
  accepted: ValidatedDayContent[];
  /** Entries thrown away, with why. */
  rejected: string[];
  /** Requested days with no usable entry — left untouched, retryable. */
  missingDayNumbers: number[];
}

/** Case, punctuation and spacing do not make a headline different. */
export function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const HEADLINE_SOFT_MAX = 80;
const CTA_SOFT_MAX = 40;

/**
 * Validates one chunk of model output against what was requested and what the
 * campaign already contains.
 *
 * Refused outright: entries that fail the schema, day numbers nobody asked for,
 * and repeated day numbers (the first wins). Accepted but flagged NEEDS_REVIEW:
 * an exact duplicate topic or headline (anywhere else in the campaign, or
 * earlier in this chunk), a content type other than the planned one, the same
 * call to action as the previous day, and an over-long headline or CTA.
 *
 * @param existing Content of every other campaign day. Days being rewritten by
 *   this chunk are compared against the new content, not their old selves.
 */
export function validateGeneratedChunk(input: {
  requested: readonly RequestedDay[];
  output: readonly unknown[];
  existing: ReadonlyArray<Pick<ContentSlot, 'dayNumber' | 'theme' | 'headline' | 'cta'>>;
  contentTypeKeys: readonly string[];
}): ChunkValidation {
  const requestedByDay = new Map(input.requested.map((day) => [day.dayNumber, day]));
  const rewriting = new Set(requestedByDay.keys());
  const keys = new Set(input.contentTypeKeys);

  const topics = new Map<string, number>();
  const headlines = new Map<string, number>();
  const ctaByDay = new Map<number, string>();
  for (const slot of input.existing) {
    if (rewriting.has(slot.dayNumber)) continue;
    if (slot.theme?.trim()) topics.set(normalizeForComparison(slot.theme), slot.dayNumber);
    if (slot.headline?.trim()) headlines.set(normalizeForComparison(slot.headline), slot.dayNumber);
    if (slot.cta?.trim()) ctaByDay.set(slot.dayNumber, normalizeForComparison(slot.cta));
  }

  const accepted: ValidatedDayContent[] = [];
  const rejected: string[] = [];
  const seen = new Set<number>();

  // Checked in day order, whatever order the model answered in, so "repeats the
  // previous day" and "first one wins" mean the same thing on every run. The
  // sort is stable: of two entries for one day, the earlier-returned one wins.
  const valid: Array<z.infer<typeof generatedDaySchema>> = [];
  input.output.forEach((candidate, index) => {
    const parsed = generatedDaySchema.safeParse(candidate);
    if (parsed.success) valid.push(parsed.data);
    else {
      const issue = parsed.error.issues[0];
      rejected.push(`Entry ${index + 1}: ${issue?.path.join('.') || 'entry'} ${issue?.message ?? 'is invalid'}.`);
    }
  });
  valid.sort((a, b) => a.dayNumber - b.dayNumber);

  for (const day of valid) {
    const planned = requestedByDay.get(day.dayNumber);
    if (!planned) {
      rejected.push(`Day ${day.dayNumber} was not requested.`);
      continue;
    }
    if (seen.has(day.dayNumber)) {
      rejected.push(`Day ${day.dayNumber} was returned more than once; the first entry was kept.`);
      continue;
    }
    seen.add(day.dayNumber);

    const issues: string[] = [];

    let contentType = day.contentType;
    if (!keys.has(contentType)) {
      issues.push(`Content type "${contentType}" is not in the strategy; set to the planned "${planned.contentType}".`);
      contentType = planned.contentType;
    } else if (contentType !== planned.contentType) {
      issues.push(`Written as "${contentType}" instead of the planned "${planned.contentType}".`);
    }

    const topicKey = normalizeForComparison(day.topic);
    const topicTwin = topics.get(topicKey);
    if (topicTwin !== undefined) issues.push(`Topic repeats day ${topicTwin}.`);
    else topics.set(topicKey, day.dayNumber);

    const headlineKey = normalizeForComparison(day.headline);
    const headlineTwin = headlines.get(headlineKey);
    if (headlineTwin !== undefined) issues.push(`Headline repeats day ${headlineTwin}.`);
    else headlines.set(headlineKey, day.dayNumber);

    const ctaKey = normalizeForComparison(day.cta);
    if (ctaByDay.get(day.dayNumber - 1) === ctaKey) issues.push(`Call to action repeats day ${day.dayNumber - 1}.`);
    ctaByDay.set(day.dayNumber, ctaKey);

    if (day.headline.length > HEADLINE_SOFT_MAX) issues.push(`Headline is longer than ${HEADLINE_SOFT_MAX} characters.`);
    if (day.cta.length > CTA_SOFT_MAX) issues.push(`Call to action is longer than ${CTA_SOFT_MAX} characters.`);

    accepted.push({
      dayNumber: day.dayNumber,
      theme: day.topic,
      contentType,
      headline: day.headline,
      supportingText: day.supportingText,
      cta: day.cta,
      caption: day.caption,
      hashtags: normalizeHashtags(day.hashtags),
      imagePrompt: day.imagePrompt,
      suggestedTemplateType: isSuggestedTemplateType(day.suggestedTemplateType) ? day.suggestedTemplateType : null,
      contentStatus: issues.length > 0 ? 'NEEDS_REVIEW' : 'READY',
      contentIssues: issues,
    });
  }

  return {
    accepted,
    rejected,
    missingDayNumbers: input.requested
      .map((day) => day.dayNumber)
      .filter((dayNumber) => !seen.has(dayNumber)),
  };
}
