import { z } from 'zod';

/**
 * Shape of `ContentCalendar.posterCopy` (Prisma `Json?`) and the styling the
 * poster renderer resolves alongside it.
 *
 * Three distinct shapes live here, and the distinction matters:
 *
 *   PosterCopy  — what the LLM writes. Slot *content* only, no styling.
 *   PosterTheme — what the brand tokenizer implies. Styling only, no content.
 *
 * The third shape, the geometry, lives in `src/lib/types/layout-spec.ts` and is
 * extracted from an operator's uploaded reference template rather than declared
 * here. Keeping the three apart is what lets one day's copy render in any
 * template, and one client's theme apply to all 365 days.
 *
 * See docs/creative-style-spec.md for where each field lands on the canvas.
 */

// ---------------------------------------------------------------------------
// Layout vocabulary
// ---------------------------------------------------------------------------

/** Where the copy stack sits within its column. Mirrored by `LayoutAlign`. */
export type CopyAlign = 'start' | 'center' | 'end';

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b);
}

/**
 * The smallest step above 1 that is coprime with `size`, so repeatedly adding it
 * visits every index before repeating.
 *
 * Computed rather than written down. A hardcoded literal `2` is correct only for
 * an odd-length list — at six, `gcd(2, 6) === 2` and the walk silently visits
 * three entries forever, with no error and nothing to catch it. The list here is
 * a vertical's approved template layouts, so its length changes whenever an
 * operator approves or withdraws one.
 */
export function coprimeStride(size: number): number {
  for (let candidate = 2; candidate < size; candidate += 1) {
    if (greatestCommonDivisor(candidate, size) === 1) return candidate;
  }
  // Sizes 1 and 2 have no candidate in range; stepping by 1 is a full cycle.
  return 1;
}

/**
 * Picks an element of `items` for a campaign day, cycling through all of them.
 *
 * Deliberately *not* random: re-rendering day 47 after a failure must produce the
 * same layout it would have produced the first time, or an operator comparing a
 * retry against the original sees a spurious difference.
 */
export function pickForDay<T>(dayNumber: number, items: readonly T[]): T | null {
  const size = items.length;
  if (size === 0) return null;
  const index = ((dayNumber - 1) * coprimeStride(size)) % size;
  return items[((index % size) + size) % size]!;
}

/**
 * The monoline icon vocabulary. Closed set, because the LLM picks from it by
 * name and an unrecognised name would leave a hole in the feature block —
 * `resolveIcon` falls back rather than throwing, but a fallback icon that
 * contradicts its label is worse than a constrained choice.
 *
 * Drawn from the recurring set observed across all 12 references (§2).
 */
export const POSTER_ICONS = [
  'hardHat',
  'building',
  'skyline',
  'shieldCheck',
  'stopwatch',
  'blueprint',
  'people',
  'award',
  'handshake',
  'truck',
  'houseInHand',
  'locationPin',
  'star',
  'chart',
  'leaf',
  'key',
] as const;

export type PosterIcon = (typeof POSTER_ICONS)[number];

export const posterIconSchema = z.enum(POSTER_ICONS);

// ---------------------------------------------------------------------------
// PosterCopy — the LLM's output
// ---------------------------------------------------------------------------

export const posterFeatureSchema = z.object({
  icon: posterIconSchema,
  /** 1–3 words, noun phrase. Rendered in caps. */
  label: z.string().trim().min(1).max(28),
  /** One short sentence. Wraps to 2–3 lines at feature-block width. */
  body: z.string().trim().min(1).max(90),
});

export type PosterFeature = z.infer<typeof posterFeatureSchema>;

export const posterCopySchema = z.object({
  /**
   * 2–4 lines, each 1–3 words, rendered ALL CAPS. Never a wrapped paragraph —
   * the line breaks are a design decision the copywriter makes, not something
   * the renderer computes.
   */
  headlineLines: z.array(z.string().trim().min(1).max(24)).min(2).max(4),
  /**
   * Which headline line takes the accent colour. Exactly one, per §2 — the
   * references never accent two lines. Clamped at render time so an
   * out-of-range index can't drop the accent entirely.
   */
  accentLineIndex: z.number().int().min(0),
  /** Letterspaced caps eyebrow above the headline. Empty string = omit. */
  eyebrow: z.string().trim().max(40).default(''),
  /** 3–5 short lines once wrapped at ~34 characters. */
  body: z.string().trim().min(1).max(240),
  // Spec calls for 3–4 (§2). Two is accepted because both feature arrangements
  // lay out any count correctly, and a two-feature poster is a far better
  // outcome than discarding the day's copy over a count the renderer can handle.
  features: z.array(posterFeatureSchema).min(2).max(4),
  /** Contact-bar imperatives, e.g. "CALL US TODAY" / "VISIT OUR WEBSITE". */
  callLabel: z.string().trim().min(1).max(28).default('CALL US TODAY'),
  websiteLabel: z.string().trim().min(1).max(28).default('VISIT OUR WEBSITE'),
  /** The trailing-full-stop tic seen in 5/12 references. */
  headlinePeriod: z.boolean().default(false),
});

export type PosterCopy = z.infer<typeof posterCopySchema>;

/**
 * Narrows the untrusted `posterCopy` Json column.
 *
 * Returns null rather than a stub on failure: a poster with invented copy is
 * worse than one the pipeline refuses to render, because it would be delivered
 * to a paying client's WhatsApp before anyone noticed.
 */
export function parsePosterCopy(raw: unknown): PosterCopy | null {
  if (raw === null || raw === undefined) return null;
  const source = typeof raw === 'string' ? safeJsonParse(raw) : raw;
  const result = posterCopySchema.safeParse(source);
  return result.success ? result.data : null;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Reshapes a nearly-valid LLM response into `PosterCopy` before validating.
 *
 * OpenAI's Structured Outputs guarantee the *shape* of a response but ignore
 * `minItems`/`maxItems` — those keywords are rejected outright under `strict: true`,
 * so array lengths can only be requested in the prompt, and the model does
 * sometimes return five features or a single headline line.
 *
 * Straight `safeParse` would discard the whole day's copy over that, forcing a
 * re-bill for something mechanically fixable. So lengths are trimmed, over-long
 * strings are cut at a word boundary, and a one-line headline is split into two.
 * Anything that cannot be repaired without inventing content — no headline at all,
 * fewer than two features — still returns null, because a poster with fabricated
 * copy would be delivered to a paying client before anyone noticed.
 */
export function coercePosterCopy(raw: unknown): PosterCopy | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const source = raw as Record<string, unknown>;

  const headlineLines = asStringArray(source.headlineLines)
    .map((line) => truncateWords(line, 24))
    .filter((line) => line.length > 0)
    .slice(0, 4);

  // A single long line is split at its midpoint word boundary rather than
  // rejected: the model has produced usable copy and only missed the line-break
  // instruction, which is a layout decision we can make.
  const lines = headlineLines.length === 1 ? splitInTwo(headlineLines[0]!) : headlineLines;
  if (lines.length < 2) return null;

  const features = asObjectArray(source.features)
    .map((feature) => ({
      icon: POSTER_ICONS.includes(feature.icon as PosterIcon)
        ? (feature.icon as PosterIcon)
        : 'shieldCheck',
      label: truncateWords(asString(feature.label), 28),
      body: truncateWords(asString(feature.body), 90),
    }))
    .filter((feature) => feature.label.length > 0 && feature.body.length > 0)
    .slice(0, 4);

  if (features.length < 2) return null;

  const body = truncateWords(asString(source.body), 240);
  if (!body) return null;

  const candidate = {
    headlineLines: lines,
    accentLineIndex: clampIndex(source.accentLineIndex, lines.length),
    eyebrow: truncateWords(asString(source.eyebrow), 40),
    body,
    features,
    callLabel: truncateWords(asString(source.callLabel), 28) || 'CALL US TODAY',
    websiteLabel:
      truncateWords(asString(source.websiteLabel), 28) || 'VISIT OUR WEBSITE',
    headlinePeriod: source.headlinePeriod === true,
  };

  const result = posterCopySchema.safeParse(candidate);
  return result.success ? result.data : null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(asString) : [];
}

function asObjectArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null,
  );
}

/** Clamps into range, defaulting to the second line — the accent line in 8/12. */
function clampIndex(value: unknown, length: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return Math.min(1, length - 1);
  }
  return Math.min(Math.max(Math.trunc(value), 0), Math.max(0, length - 1));
}

/** Cuts at the last word boundary inside `max`, never mid-word. */
function truncateWords(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut).trim();
}

/** Splits a phrase into two balanced lines at a word boundary. */
function splitInTwo(value: string): string[] {
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length < 2) return [value];
  const pivot = Math.ceil(words.length / 2);
  return [words.slice(0, pivot).join(' '), words.slice(pivot).join(' ')];
}

// ---------------------------------------------------------------------------
// PosterTheme — resolved styling
// ---------------------------------------------------------------------------

/**
 * Warm accents (gold → amber → orange → orange-red) pair with black or navy.
 * Cool accents (blue) pair with navy and let the photo carry the warmth. The
 * references never mix the two families in one poster, so the family is a
 * single decision made once per client.
 */
export type AccentFamily = 'warm' | 'cool';

export interface PosterTheme {
  /** Panel/scrim ground. Near-black or deep navy. */
  darkNeutral: string;
  /** Light-field ground for the `bands`, `curve` and `editorial` archetypes. */
  lightNeutral: string;
  /**
   * The single saturated accent, as the brand states it. Correct for *fills* —
   * the contact bar, icon badges, the accent rule on a light ground — where the
   * shape is large enough that its own contrast is all that matters.
   */
  accent: string;
  /**
   * The accent lightened until it clears 4.5:1 against `darkNeutral`. Use for
   * accent *text* on a dark ground.
   *
   * Not cosmetic: a cool-family brand accent like `#1546A0` on a `#0B1E3D` navy
   * panel is around 1.6:1 — an accented headline line would be nearly invisible.
   * The references dodge this by only ever putting cool accents on light fields,
   * but the renderer has to survive any archetype paired with any brand.
   */
  accentOnDark: string;
  /** The accent darkened until it clears 4.5:1 against `lightNeutral`. */
  accentOnLight: string;
  /**
   * Text colour for use *on* an accent fill — dark on amber, white on deep blue.
   * Precomputed because the contact bar fills with the accent and getting this
   * wrong makes the phone number unreadable.
   */
  onAccent: string;
  /** Body/headline colour on `darkNeutral`. */
  onDark: string;
  /** Body/headline colour on `lightNeutral`. */
  onLight: string;
  family: AccentFamily;
  headingFont: PosterFontChoice;
  bodyFont: PosterFontChoice;
}

/**
 * A font the renderer can actually load, already mapped from the tokenizer's
 * free-text family name to a face we have bytes for.
 */
export interface PosterFontChoice {
  /** Family name registered with satori, e.g. "Archivo Black". */
  family: string;
  /** Google Fonts static file slug used to fetch the TTF. */
  weights: number[];
}

// ---------------------------------------------------------------------------
// PosterSpec — the fully resolved render input
// ---------------------------------------------------------------------------

export interface PosterIdentity {
  companyName: string;
  /** Logo bytes as a data URI, or null to fall back to a wordmark lockup. */
  logoDataUri: string | null;
  /**
   * The logo is a wordmark that already spells out `companyName`, so the lockup
   * must not print it a second time underneath.
   *
   * Only consulted when there is a logo — the no-logo lockup is the company name.
   */
  logoIncludesName: boolean;
  brandTagline: string | null;
  /** Display-formatted, e.g. "+91 98765 43210". */
  phone: string;
  /** Bare host form, e.g. "www.example.com". */
  website: string | null;
}

export interface PosterPhoto {
  /** JPEG/PNG bytes as a data URI. Satori has no network access at render. */
  dataUri: string;
  width: number;
  height: number;
}

/**
 * Reference canvas the style spec's pixel values are measured against. Slot
 * components multiply by `spec.width / REFERENCE_WIDTH` so the same numbers
 * hold at any output size.
 */
export const REFERENCE_WIDTH = 940;
export const REFERENCE_HEIGHT = 1568;
