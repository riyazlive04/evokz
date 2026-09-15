import { z } from 'zod';

/**
 * Content strategy — which kinds of content a campaign calendar is made of.
 *
 * A strategy is a list of weighted **pillars** ("Educational", "Myth vs fact",
 * "Promotional"…). It belongs to the vertical (`Category.contentStrategy`), so no
 * industry's categories live in application code: a Dental vertical can carry
 * "Preventive care" and a Real Estate vertical "Neighbourhood guide". A vertical
 * without one uses `DEFAULT_CONTENT_STRATEGY`, which is deliberately
 * industry-neutral. A pillar's key is always `slugifyContentType(label)`, so a
 * strategy survives a round trip through the editor's text format unchanged.
 *
 * The strategy decides *how many* days of each kind a campaign gets and *which*
 * day gets which kind — deterministically, in `planContentTypes` — so balance
 * does not depend on a model remembering a ratio across 365 days. The model
 * writes the content for the kind it is given.
 *
 * Pure: no database, no network.
 */

/** A pillar key is the stored `contentType`: lowercase words joined by hyphens. */
export const CONTENT_TYPE_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const CONTENT_TYPE_KEY_MAX = 40;

export function isContentTypeKey(value: string): boolean {
  return value.length <= CONTENT_TYPE_KEY_MAX && CONTENT_TYPE_KEY_PATTERN.test(value);
}

export interface ContentPillar {
  key: string;
  label: string;
  /** Relative share of the campaign's days, 1–20. */
  weight: number;
  /** What a day of this kind should do, for the model. */
  guidance: string;
  /** Promotional pillars are never scheduled on two consecutive days. */
  promotional: boolean;
}

export interface ContentStrategy {
  pillars: ContentPillar[];
}

const pillarSchema = z.object({
  key: z.string().refine(isContentTypeKey, 'must be lowercase words joined by hyphens'),
  label: z.string().trim().min(1).max(60),
  weight: z.number().int().min(1).max(20),
  guidance: z.string().trim().max(400).default(''),
  promotional: z.boolean().default(false),
});

const strategySchema = z
  .object({ pillars: z.array(pillarSchema).min(1).max(20) })
  .refine((value) => new Set(value.pillars.map((pillar) => pillar.key)).size === value.pillars.length, {
    message: 'pillar keys must be unique',
  })
  .refine((value) => value.pillars.some((pillar) => !pillar.promotional), {
    message: 'at least one pillar must be non-promotional',
  });

/**
 * Industry-neutral default. Nothing here names an industry; every pillar makes
 * sense for a clinic, a builder or a shop. No pillar asks for testimonials,
 * prices or statistics — the model has no source for any of them.
 */
export const DEFAULT_CONTENT_STRATEGY: ContentStrategy = {
  pillars: [
    { key: 'educational', label: 'Educational', weight: 3, promotional: false, guidance: 'Explain one useful idea from the business’s field in plain language.' },
    { key: 'practical-tips', label: 'Practical tips', weight: 3, promotional: false, guidance: 'Give specific, actionable advice the audience can use today.' },
    { key: 'myth-vs-fact', label: 'Myth vs fact', weight: 2, promotional: false, guidance: 'Correct one common misconception, stating the myth and the fact clearly.' },
    { key: 'common-questions', label: 'Common questions', weight: 2, promotional: false, guidance: 'Answer one question customers commonly ask, briefly and honestly.' },
    { key: 'awareness', label: 'Awareness', weight: 2, promotional: false, guidance: 'Raise awareness of an issue relevant to the field, without invented statistics.' },
    { key: 'service-spotlight', label: 'Service spotlight', weight: 2, promotional: false, guidance: 'Introduce one service or offering and who it helps, without prices.' },
    { key: 'engagement', label: 'Engagement', weight: 2, promotional: false, guidance: 'Invite replies with a relatable question, quick poll or everyday scenario.' },
    { key: 'trust-values', label: 'Trust & values', weight: 1, promotional: false, guidance: 'Show how the business works or what it values, without fabricated reviews or quotes.' },
    { key: 'seasonal', label: 'Seasonal', weight: 1, promotional: false, guidance: 'Tie the field to the time of year, only where the connection is broadly true.' },
    { key: 'promotional', label: 'Promotional', weight: 1, promotional: true, guidance: 'Ask the audience to book, visit or enquire, without inventing discounts, prices or deadlines.' },
  ],
};

/** A strategy from a stored value, or null when it is absent or unreadable. */
export function parseContentStrategy(value: unknown): ContentStrategy | null {
  const parsed = strategySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The strategy a vertical's campaigns use, and where it came from. */
export function resolveContentStrategy(value: unknown): {
  strategy: ContentStrategy;
  source: 'vertical' | 'default';
} {
  const strategy = parseContentStrategy(value);
  return strategy ? { strategy, source: 'vertical' } : { strategy: DEFAULT_CONTENT_STRATEGY, source: 'default' };
}

export function pillarKeys(strategy: ContentStrategy): string[] {
  return strategy.pillars.map((pillar) => pillar.key);
}

// ---------------------------------------------------------------------------
// Editor text format
// ---------------------------------------------------------------------------

/**
 * One pillar per line: `Label | weight | guidance`, with an optional fourth
 * field `promotional`. The key is derived from the label. Blank lines and lines
 * starting with `#` are ignored.
 */
export function formatContentStrategyText(strategy: ContentStrategy): string {
  return strategy.pillars
    .map((pillar) =>
      [pillar.label, String(pillar.weight), pillar.guidance, ...(pillar.promotional ? ['promotional'] : [])].join(' | '),
    )
    .join('\n');
}

export function slugifyContentType(label: string): string {
  return label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, CONTENT_TYPE_KEY_MAX)
    .replace(/-+$/g, '');
}

export function parseContentStrategyText(
  text: string,
): { strategy: ContentStrategy; errors: [] } | { strategy: null; errors: string[] } {
  const errors: string[] = [];
  const pillars: ContentPillar[] = [];

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const fields = line.split('|').map((field) => field.trim());
    const [label = '', weightText = '', guidance = '', flag = ''] = fields;
    const where = `Line ${index + 1}`;

    const key = slugifyContentType(label);
    const weight = Number(weightText);
    if (!label || !key) {
      errors.push(`${where}: a label containing at least one letter or number (a–z, 0–9) is required.`);
      return;
    }
    if (!Number.isInteger(weight) || weight < 1 || weight > 20) {
      errors.push(`${where}: weight must be a whole number from 1 to 20.`);
      return;
    }
    if (fields.length > 4 || (flag && flag.toLowerCase() !== 'promotional')) {
      errors.push(`${where}: expected "Label | weight | guidance", optionally followed by "| promotional".`);
      return;
    }
    if (pillars.some((pillar) => pillar.key === key)) {
      errors.push(`${where}: "${label}" duplicates an earlier pillar.`);
      return;
    }
    pillars.push({ key, label, weight, guidance, promotional: flag.toLowerCase() === 'promotional' });
  });

  if (errors.length > 0) return { strategy: null, errors };

  const parsed = strategySchema.safeParse({ pillars });
  if (!parsed.success) {
    return { strategy: null, errors: parsed.error.issues.map((issue) => issue.message) };
  }
  return { strategy: parsed.data, errors: [] };
}

// ---------------------------------------------------------------------------
// Day assignment
// ---------------------------------------------------------------------------

/**
 * The content type of every day of a campaign, index 0 being day 1.
 *
 * Smooth weighted round-robin: each pillar receives its weight's share of the
 * days, spread as evenly as possible, and the same input always yields the same
 * sequence — so "day 127 is a myth-busting day" is stable across retries, chunks
 * and range regenerations. A promotional pillar is never placed on the day after
 * another promotional day.
 */
export function planContentTypes(strategy: ContentStrategy, totalDays: number): string[] {
  const pillars = strategy.pillars;
  const totalWeight = pillars.reduce((sum, pillar) => sum + pillar.weight, 0);
  const current = pillars.map(() => 0);
  const plan: string[] = [];

  for (let day = 0; day < totalDays; day += 1) {
    pillars.forEach((pillar, index) => {
      current[index]! += pillar.weight;
    });

    const previousPromotional =
      day > 0 && pillars.find((pillar) => pillar.key === plan[day - 1])?.promotional === true;

    let chosen = -1;
    pillars.forEach((pillar, index) => {
      if (previousPromotional && pillar.promotional) return;
      if (chosen === -1 || current[index]! > current[chosen]!) chosen = index;
    });

    current[chosen]! -= totalWeight;
    plan.push(pillars[chosen]!.key);
  }

  return plan;
}

// ---------------------------------------------------------------------------
// Suggested template types
// ---------------------------------------------------------------------------

/**
 * Industry-neutral layout genres the generator may suggest for a day. A hint for
 * the future template mapper (`ContentCalendar.suggestedTemplateType`), never a
 * template id.
 */
export const SUGGESTED_TEMPLATE_TYPES = {
  'headline-photo': 'Headline over a photograph',
  'tips-list': 'Numbered tips or checklist',
  'myth-fact': 'Myth versus fact',
  question: 'Question or poll',
  quote: 'Statement card',
  spotlight: 'Service or topic spotlight',
  'call-to-action': 'Call-to-action card',
  'step-by-step': 'Step-by-step process',
} as const;

export type SuggestedTemplateType = keyof typeof SUGGESTED_TEMPLATE_TYPES;

export function isSuggestedTemplateType(value: string): value is SuggestedTemplateType {
  return Object.prototype.hasOwnProperty.call(SUGGESTED_TEMPLATE_TYPES, value);
}
