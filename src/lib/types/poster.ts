import { z } from 'zod';

/**
 * Shape of `ContentCalendar.posterCopy` (Prisma `Json?`) plus the resolved
 * render input the archetypes consume.
 *
 * Three distinct shapes live here, and the distinction matters:
 *
 *   PosterCopy  — what the LLM writes. Slot *content* only, no styling.
 *   PosterTheme — what the brand tokenizer implies. Styling only, no content.
 *   PosterSpec  — the two joined with the tenant's identity and the photo.
 *                 Fully resolved; an archetype reads it and nothing else.
 *
 * Keeping copy and theme apart is what lets one day's copy render in any
 * archetype, and one client's theme apply to all 365 days.
 *
 * See docs/creative-style-spec.md for where each field lands on the canvas.
 */

// ---------------------------------------------------------------------------
// Archetypes
// ---------------------------------------------------------------------------

/**
 * Every layout a poster can be rendered in — the compositions in §5 of the style
 * spec, plus variants of them.
 *
 * `ARCHETYPE_CATALOGUE` below describes each one; this array exists separately
 * only to give the union its members and to fix the cycle order that
 * `archetypeForDay` walks.
 */
export const POSTER_ARCHETYPES = [
  // The eight base compositions, in style-spec order.
  'scrim', // A — full-bleed photo, dark gradient scrim over the copy side
  'diagonal', // B — solid panel left, photo right, straight diagonal boundary
  'bands', // C — three stacked horizontal bands with hard edges
  'curve', // D — light field with a dark curved sweep rising from bottom-left
  'editorial', // E — high-key light field, photo dissolving into it
  'spotlight', // F — full-bleed photo under an even wash, copy vertically centred
  'corner', // G — light field, photo inset upper-right, stacked contact bar
  'inverted', // H — photo band on top, copy below it on the dark ground
  // Variants. Listed after the bases rather than beside them so the stride walk
  // in `pickForDay` alternates between the two groups instead of showing a
  // composition and its own flip on consecutive days.
  'scrim-mirror',
  'diagonal-mirror',
  'curve-mirror',
  'editorial-mirror',
  'corner-mirror',
  'spotlight-centred',
  'bands-photo-top',
] as const;

export type PosterArchetype = (typeof POSTER_ARCHETYPES)[number];

export const posterArchetypeSchema = z.enum(POSTER_ARCHETYPES);

export type PosterPhotoShape = 'portrait' | 'landscape';

/**
 * The layout components that actually draw a poster.
 *
 * Distinct from `POSTER_ARCHETYPES` because several archetypes can share one
 * component, differing only in the props the catalogue hands it — a mirrored
 * composition is the same geometry read the other way round, not a second
 * implementation of it.
 */
export const ARCHETYPE_BASES = [
  'scrim',
  'diagonal',
  'bands',
  'curve',
  'editorial',
  'spotlight',
  'corner',
  'inverted',
] as const;

export type ArchetypeBase = (typeof ARCHETYPE_BASES)[number];

/** Where the copy stack sits within its column. */
export type CopyAlign = 'start' | 'center' | 'end';

/**
 * Everything the renderer, the preview grid and the operator's layout picker
 * need to know about one archetype.
 *
 * One object rather than four parallel lookups. These facts used to live in
 * `PHOTO_FOCUS` and `archetypeGroundIsDark` (src/lib/poster/archetypes.tsx),
 * `ARCHETYPE_PHOTO_SHAPE` here, and `ARCHETYPE_NOTES` in the preview page — and
 * only two of those were `Record<PosterArchetype, …>`. `archetypeGroundIsDark`
 * in particular was an `||` chain, so adding a dark layout and forgetting to
 * extend it produced a correct poster in portrait and a silently inverted one on
 * square and landscape presets, which is the shape of bug nobody finds.
 *
 * A `Record` keyed by the archetype union makes every addition a compile error
 * until it is described in full.
 */
export interface ArchetypeDescriptor {
  /** Which component draws it. */
  base: ArchetypeBase;
  /**
   * Read the base component's geometry the other way round.
   *
   * For the side-by-side compositions that is a mirror about the vertical axis —
   * the photo moves to the opposite half and the copy follows it. For `bands`,
   * whose structure is vertical and has no left/right asymmetry to mirror, it
   * swaps the band order instead. The axis of the flip follows the axis the
   * composition is built on.
   */
  flipped: boolean;
  /** Alignment handed to the shared slot layer. */
  align: CopyAlign;
  /** Short name for the operator's layout picker. */
  label: string;
  /** Fuller description for the preview grid, with style-spec references. */
  description: string;
  /**
   * Which photo aspect to request. The photo is a background asset with a
   * mandated empty region, so the wrong aspect cover-crops away the very
   * negative space the copy needs.
   */
  photoShape: PosterPhotoShape;
  /**
   * Where the photo's subject should sit, in source-space 0–1 coordinates.
   * Straight from the "photo requirement" note on each archetype in §5 of
   * docs/creative-style-spec.md — a centre crop would discard the negative space
   * the copy occupies.
   */
  photoFocus: { x: number; y: number };
  /** Whether the copy lands on the dark ground or the light one. */
  groundIsDark: boolean;
}

export const ARCHETYPE_CATALOGUE: Record<PosterArchetype, ArchetypeDescriptor> = {
  scrim: {
    base: 'scrim',
    flipped: false,
    align: 'start',
    label: 'A · Scrim overlay, copy left',
    description: 'Full-bleed photo under a directional scrim. Refs 1, 6, 9, 10.',
    photoShape: 'portrait',
    photoFocus: { x: 0.72, y: 0.58 }, // subject right/lower, sky upper-left
    groundIsDark: true,
  },
  diagonal: {
    base: 'diagonal',
    flipped: false,
    align: 'start',
    label: 'B · Diagonal split, panel left',
    description: 'Dark panel left, photo right, straight diagonal. Refs 2, 13.',
    photoShape: 'portrait',
    photoFocus: { x: 0.68, y: 0.5 }, // subject right of centre
    groundIsDark: true,
  },
  bands: {
    base: 'bands',
    flipped: false,
    align: 'start',
    label: 'C · Stacked bands, copy first',
    description: 'Three stacked bands with hard horizontal edges. Refs 3, 5, 7.',
    photoShape: 'landscape',
    photoFocus: { x: 0.5, y: 0.5 }, // wide establishing shot, subject centred
    groundIsDark: false,
  },
  curve: {
    base: 'curve',
    flipped: false,
    align: 'start',
    label: 'D · Curved sweep, copy left',
    description: 'Light field with a dark curved sweep rising from the left. Ref 4.',
    photoShape: 'landscape',
    photoFocus: { x: 0.72, y: 0.34 }, // subject upper-right, clean lower-left
    groundIsDark: false,
  },
  editorial: {
    base: 'editorial',
    flipped: false,
    align: 'start',
    label: 'E · Light editorial, copy left',
    description: 'High-key light field, photo dissolving in. Refs 8, 11, 12.',
    photoShape: 'portrait',
    photoFocus: { x: 0.7, y: 0.46 }, // subject right, high-key
    groundIsDark: false,
  },
  spotlight: {
    base: 'spotlight',
    flipped: false,
    align: 'start',
    label: 'F · Spotlight, copy left',
    description: 'Full-bleed photo under an even wash, copy vertically centred.',
    photoShape: 'portrait', // full-bleed, so it needs the canvas shape
    photoFocus: { x: 0.5, y: 0.42 }, // subject slightly above centre
    groundIsDark: true,
  },
  corner: {
    base: 'corner',
    flipped: false,
    align: 'start',
    label: 'G · Corner inset, photo right',
    description: 'Light field, photo inset upper-right, stacked contact bar.',
    photoShape: 'portrait', // tall inset panel down the right side
    photoFocus: { x: 0.55, y: 0.45 }, // inset panel, subject near its own centre
    groundIsDark: false,
  },
  inverted: {
    base: 'inverted',
    flipped: false,
    align: 'start',
    label: 'H · Inverted band, photo on top',
    description: 'Photo band on top, copy below it on the dark ground.',
    photoShape: 'landscape', // wide establishing band across the top
    photoFocus: { x: 0.5, y: 0.42 }, // horizon high
    groundIsDark: true,
  },

  // ---- Variants -----------------------------------------------------------
  //
  // Each reuses its base component's geometry read the other way round, so no
  // new shape is introduced and no new way for resvg to panic on one. The photo
  // focus is the base's mirrored about the vertical axis (`1 - x`), which keeps
  // the subject on the same side of the frame as the photo region it lands in.

  'scrim-mirror': {
    base: 'scrim',
    flipped: true,
    align: 'end',
    label: 'A · Scrim overlay, copy right',
    description: 'Scrim overlay mirrored — the scrim falls from the right.',
    photoShape: 'portrait',
    photoFocus: { x: 0.28, y: 0.58 },
    groundIsDark: true,
  },
  'diagonal-mirror': {
    base: 'diagonal',
    flipped: true,
    align: 'end',
    label: 'B · Diagonal split, panel right',
    description: 'Diagonal split mirrored — photo left, dark panel right.',
    photoShape: 'portrait',
    photoFocus: { x: 0.32, y: 0.5 },
    groundIsDark: true,
  },
  'curve-mirror': {
    base: 'curve',
    flipped: true,
    align: 'end',
    label: 'D · Curved sweep, copy right',
    description: 'Curved sweep mirrored — the crest rises from the right.',
    photoShape: 'landscape',
    photoFocus: { x: 0.28, y: 0.34 },
    groundIsDark: false,
  },
  'editorial-mirror': {
    base: 'editorial',
    flipped: true,
    align: 'end',
    label: 'E · Light editorial, copy right',
    description: 'Light editorial mirrored — photo left, copy right.',
    photoShape: 'portrait',
    photoFocus: { x: 0.3, y: 0.46 },
    groundIsDark: false,
  },
  'corner-mirror': {
    base: 'corner',
    flipped: true,
    align: 'end',
    label: 'G · Corner inset, photo left',
    description: 'Corner inset mirrored — photo upper-left, copy right.',
    photoShape: 'portrait',
    photoFocus: { x: 0.45, y: 0.45 },
    groundIsDark: false,
  },
  'spotlight-centred': {
    base: 'spotlight',
    flipped: false,
    align: 'center',
    // Mirroring a full-bleed composition under a symmetric wash is a visual
    // no-op, so alignment is this base's only real variant axis.
    label: 'F · Spotlight, copy centred',
    description: 'Full-bleed photo under an even wash, copy centred on both axes.',
    photoShape: 'portrait',
    photoFocus: { x: 0.5, y: 0.42 },
    groundIsDark: true,
  },
  'bands-photo-top': {
    base: 'bands',
    flipped: true,
    align: 'start',
    label: 'C · Stacked bands, photo first',
    description: 'Stacked bands with the photo band leading instead of the copy.',
    photoShape: 'landscape',
    photoFocus: { x: 0.5, y: 0.5 },
    groundIsDark: false,
  },
};

/** The descriptor for one archetype. */
export function describeArchetype(archetype: PosterArchetype): ArchetypeDescriptor {
  return ARCHETYPE_CATALOGUE[archetype];
}

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b);
}

/**
 * The smallest step above 1 that is coprime with `size`, so repeatedly adding it
 * visits every index before repeating.
 *
 * Computed rather than written down. The literal `2` that used to be hardcoded
 * for the archetype walk was correct only while there were five archetypes — at
 * six, `gcd(2, 6) === 2` and the walk silently visits three of them forever,
 * with no error and nothing to catch it.
 *
 * Exported because the same walk now runs over a second, runtime-length list:
 * the layouts an operator mapped a vertical's reference templates to.
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
 * The rotation used when nothing has chosen a layout: the eight base
 * compositions, never the variants.
 *
 * Deliberately narrower than `POSTER_ARCHETYPES`. A variant is a considered
 * choice — it exists because an operator looked at a reference template and said
 * "this one" — so it is reachable by mapping a template to it or by pinning it on
 * a row, but not by a client happening to land on day 11. That also keeps the
 * automatic path on the compositions the style spec was written against.
 */
const FALLBACK_ARCHETYPES: readonly PosterArchetype[] = POSTER_ARCHETYPES.filter(
  (archetype) => !ARCHETYPE_CATALOGUE[archetype].flipped &&
    ARCHETYPE_CATALOGUE[archetype].align === 'start',
);

/**
 * Deterministic archetype for a campaign day, when nothing else has chosen one.
 *
 * Stepping by a coprime of the set size cycles every archetype before repeating,
 * so a week never shows the same composition twice.
 *
 * Days that have already shipped are unaffected by any change here: the pipeline
 * writes the resolved choice back to `ContentCalendar.posterArchetype`, and that
 * stored value wins on every later render, so a retry still reproduces the poster
 * the client received.
 */
export function archetypeForDay(dayNumber: number): PosterArchetype {
  return pickForDay(dayNumber, FALLBACK_ARCHETYPES) ?? POSTER_ARCHETYPES[0]!;
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

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

export interface PosterSpec {
  archetype: PosterArchetype;
  copy: PosterCopy;
  theme: PosterTheme;
  identity: PosterIdentity;
  photo: PosterPhoto;
  /** Output canvas. 1080×1920 in production. */
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
