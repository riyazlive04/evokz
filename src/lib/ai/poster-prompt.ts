import { describeVerticalImagery } from '@/lib/ai/vertical-vocabulary';
import { POSTER_ICONS } from '@/lib/types/poster';

/**
 * The poster-copy contract, shared by the two stages that produce it.
 *
 * `calendar-generator` writes poster copy for every day at seed time;
 * `poster-copy` backfills a single day whose block was unusable or predates the
 * poster layer. Both must ask for exactly the same thing — if the rules diverge,
 * a backfilled day renders subtly differently from its neighbours and the drift is
 * invisible until someone scrolls a month of creatives side by side.
 */

/**
 * JSON Schema for one poster's slot content.
 *
 * Carries no `minItems`/`maxItems`: OpenAI's Structured Outputs reject both under
 * `strict: true`, so array lengths are requested in prose and repaired afterwards
 * by `coercePosterCopy`. Every property appears in `required` and
 * `additionalProperties` is false at each level, as strict mode demands — which is
 * also why `eyebrow` is an empty-string-to-omit rather than a nullable field.
 */
export const POSTER_SCHEMA = {
  type: 'object',
  properties: {
    headlineLines: { type: 'array', items: { type: 'string' } },
    accentLineIndex: { type: 'integer' },
    eyebrow: { type: 'string' },
    body: { type: 'string' },
    features: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          icon: { type: 'string', enum: [...POSTER_ICONS] },
          label: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['icon', 'label', 'body'],
        additionalProperties: false,
      },
    },
    callLabel: { type: 'string' },
    websiteLabel: { type: 'string' },
    ctaLabel: { type: 'string' },
    headlinePeriod: { type: 'boolean' },
  },
  required: [
    'headlineLines',
    'accentLineIndex',
    'eyebrow',
    'body',
    'features',
    'callLabel',
    'websiteLabel',
    'ctaLabel',
    'headlinePeriod',
  ],
  additionalProperties: false,
} as const;

/**
 * Prose rules for the poster slots. Derived from §2 and §6 of
 * docs/creative-style-spec.md.
 */
export const POSTER_COPY_RULES = `### poster rules

- headlineLines: 2 to 4 lines, each 1-3 words, 24 characters maximum per line. Rendered ALL CAPS. You choose the line breaks — they are a design decision, so break for rhythm and balance, not because a line ran out of room. 3-7 words total across all lines. A benefit or an identity, never a sentence.
- accentLineIndex: which line (0-based) takes the brand accent colour. Exactly one. Pick the line carrying the most meaning, usually the second.
- eyebrow: an optional short all-caps kicker above the headline, 40 characters maximum. Use an empty string to omit it, and omit it more often than not.
- body: 12-30 words, sentence case, one or two short clauses. It sets to 3-5 narrow lines.
- features: 3 items (4 only when they are genuinely parallel). Each has an icon chosen from the fixed list below, a label of 1-3 words as a noun phrase, and a body of one short sentence under 90 characters. Labels must be grammatically parallel to each other.
- callLabel / websiteLabel: short all-caps imperatives for the contact bar, e.g. "CALL US TODAY", "VISIT OUR WEBSITE", "TALK TO OUR TEAM".
- ctaLabel: the words inside the poster's button. Two to four words, an instruction rather than a description: "BOOK A SITE VISIT", "GET YOUR FREE QUOTE", "START INVESTING NOW". At most 24 characters — it is set inside a button, not across a bar. Make it follow from the day's subject, so a campaign's ask varies across the month instead of repeating one line for a year.
- headlinePeriod: true to end the final headline line with a full stop. A deliberate stylistic tic — use it on roughly a third of the days.
- Available icon names (use these exact strings): ${POSTER_ICONS.join(', ')}.

Write no phone number, no URL and no company name into any poster field; those are injected from the client record. Make no factual claims about pricing, discounts, awards, statistics, years in business, or project counts — you have no source for any of them.`;

/**
 * How the background photograph must be briefed. The photo is a background with a
 * mandated empty region, never the finished creative.
 *
 * Parameterised by vertical because the subject and lighting lines are the only
 * industry-specific part of the brief; everything else is layout physics that
 * holds for any client. It was a constant, which meant every vertical inherited a
 * construction shot list.
 */
export function buildImagePromptRules(
  categoryName: string | null | undefined,
): string {
  return `### imagePrompt rules

- Describe one specific photographic scene: subject, composition, lighting, colour treatment, mood.
- Push the subject to one side and explicitly reserve a low-detail area — open sky, deep shadow, plain wall — for the text to sit on. Say so in the prompt, e.g. "subject to the right, clear open sky filling the upper left".
${describeVerticalImagery(categoryName)}
- NEVER request embedded text, words, letters, numbers, signage, logos or watermarks. Image models render these badly, and every readable element is composited afterwards as real type.`;
}
