import {
  accentScore,
  bestTextOn,
  contrastRatio,
  ensureContrast,
  hexToRgb,
  isNeutral,
  relativeLuminance,
  rgbToHsl,
} from '@/lib/poster/color';
import type { BrandColorSource, BrandGuideline } from '@/lib/types/brand';
import type { AccentFamily, PosterFontChoice, PosterTheme } from '@/lib/types/poster';

/**
 * Turns a client's extracted brand tokens into a render-ready `PosterTheme`.
 *
 * The brand tokenizer emits a loose bag of hexes with free-text role labels
 * ("primary", "brand blue", "cta") and free-text font names. None of that is
 * directly renderable, and none of it is trustworthy: roles are frequently
 * mislabelled, palettes arrive with five near-identical blues or with nothing
 * but greys, and font names may be faces we have no bytes for.
 *
 * So role labels are treated as a *hint* and the actual assignment is made by
 * measurement (saturation, lightness, contrast). A palette that yields nothing
 * usable degrades to the vertical's house theme rather than rendering an
 * unreadable poster.
 *
 * See §3 and §4 of docs/creative-style-spec.md.
 */

// ---------------------------------------------------------------------------
// House fallbacks
// ---------------------------------------------------------------------------

/**
 * Used when a client has no extracted palette at all. Chosen to sit in the
 * middle of the observed reference set: near-black ground, amber accent — the
 * single most common combination across the 12 (refs 1, 2, 10).
 */
const HOUSE_THEME = {
  darkNeutral: '#0E1116',
  lightNeutral: '#F6F7F9',
  accent: '#F0A81E',
} as const;

/** Deep navy alternative, for cool-family brands (refs 4, 7, 9, 11, 12). */
const HOUSE_NAVY = '#0D2447';

/**
 * Hue bands for family classification, in degrees.
 *
 * Warm covers red-orange through yellow (0–70). Cool covers cyan through violet
 * (170–280). Anything between — the greens — is rare in this vertical and is
 * treated as cool, since green accents behave like blue ones: they need a light
 * ground to read.
 */
const WARM_MAX_HUE = 70;
const WARM_MIN_HUE = 340; // wraps past red

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

/**
 * Faces the renderer can fetch, keyed by the lowercase family name. The value
 * is what gets registered with satori.
 *
 * Restricted to Google Fonts because the loader pulls TTFs from `fonts.gstatic.com`
 * at render time — a face outside this table has no bytes available, so the
 * tokenizer's suggestion is mapped onto the nearest one it does have.
 */
const HEADING_FACES: Record<string, PosterFontChoice> = {
  // Wide heavy grotesques — refs 1, 3, 4, 5, 7, 8, 11, 12
  'archivo black': { family: 'Archivo Black', weights: [400] },
  inter: { family: 'Inter', weights: [700, 900] },
  roboto: { family: 'Roboto', weights: [700, 900] },
  montserrat: { family: 'Montserrat', weights: [700, 900] },
  poppins: { family: 'Poppins', weights: [700, 900] },
  // Condensed heavy — refs 6, 9, 10, 13
  anton: { family: 'Anton', weights: [400] },
  oswald: { family: 'Oswald', weights: [700] },
  'archivo narrow': { family: 'Archivo Narrow', weights: [700] },
  'barlow condensed': { family: 'Barlow Condensed', weights: [700] },
};

const BODY_FACES: Record<string, PosterFontChoice> = {
  inter: { family: 'Inter', weights: [400, 700] },
  roboto: { family: 'Roboto', weights: [400, 700] },
  'open sans': { family: 'Open Sans', weights: [400, 700] },
  lato: { family: 'Lato', weights: [400, 700] },
  'source sans 3': { family: 'Source Sans 3', weights: [400, 700] },
  archivo: { family: 'Archivo', weights: [400, 700] },
  montserrat: { family: 'Montserrat', weights: [400, 700] },
  poppins: { family: 'Poppins', weights: [400, 700] },
};

const DEFAULT_HEADING: PosterFontChoice = { family: 'Archivo Black', weights: [400] };
const DEFAULT_BODY: PosterFontChoice = { family: 'Inter', weights: [400, 700] };

/**
 * Maps a free-text family name onto a loadable face.
 *
 * Exact match first, then substring both ways — the tokenizer often returns
 * decorated names like "Montserrat ExtraBold" or "Inter (variable)" that no
 * exact lookup would catch. Serif and slab suggestions fall through to the
 * default grotesque deliberately: none of the 12 references use a serif, and
 * honouring a mistaken serif extraction would break the house look more visibly
 * than ignoring it.
 */
function resolveFace(
  requested: string | null | undefined,
  table: Record<string, PosterFontChoice>,
  fallback: PosterFontChoice,
): PosterFontChoice {
  if (!requested) return fallback;
  const needle = requested.trim().toLowerCase();
  if (!needle) return fallback;

  const exact = table[needle];
  if (exact) return exact;

  for (const [name, choice] of Object.entries(table)) {
    if (needle.includes(name) || name.includes(needle)) return choice;
  }

  return fallback;
}

// ---------------------------------------------------------------------------
// Palette resolution
// ---------------------------------------------------------------------------

interface Candidate {
  hex: string;
  role: string;
  score: number;
  luminance: number;
  saturation: number;
  /**
   * Absent on every palette the tokenizer guessed. Present only when the colour
   * was measured off the client's own site, which is what licenses the theme to
   * trust the role label instead of re-deriving it.
   */
  source: BrandColorSource | undefined;
  confidence: number;
}

function toCandidates(guideline: BrandGuideline): Candidate[] {
  const seen = new Set<string>();
  const candidates: Candidate[] = [];

  for (const color of guideline.colors) {
    const rgb = hexToRgb(color.hex);
    if (!rgb) continue;

    const key = color.hex.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    candidates.push({
      hex: color.hex,
      role: color.role.trim().toLowerCase(),
      score: accentScore(color.hex),
      luminance: relativeLuminance(rgb),
      saturation: rgbToHsl(rgb).s,
      source: color.source,
      confidence: color.confidence ?? 0,
    });
  }

  return candidates;
}

function classifyFamily(hex: string): AccentFamily {
  const rgb = hexToRgb(hex);
  if (!rgb) return 'warm';
  const { h } = rgbToHsl(rgb);
  return h <= WARM_MAX_HUE || h >= WARM_MIN_HUE ? 'warm' : 'cool';
}

/**
 * Picks the accent.
 *
 * Role labels get a modest thumb on the scale rather than the final say: a hex
 * labelled "accent" that is actually a grey should not beat an unlabelled
 * saturated orange. Weighting rather than filtering also means a palette whose
 * every label is wrong still resolves sensibly.
 */
function pickAccent(candidates: Candidate[]): string | null {
  const scored = candidates
    .filter((candidate) => !isNeutral(candidate.hex))
    .map((candidate) => {
      const labelBonus = /accent|primary|brand|cta|highlight/.test(candidate.role)
        ? 0.15
        : 0;
      const labelPenalty = /background|surface|neutral|text|body/.test(candidate.role)
        ? 0.3
        : 0;
      return { ...candidate, weighted: candidate.score + labelBonus - labelPenalty };
    })
    .sort((a, b) => b.weighted - a.weighted);

  return scored[0]?.hex ?? null;
}

/**
 * Saturation floor for a measured palette.
 *
 * `isNeutral`'s 0.18 is tuned for guessed palettes, where a low-saturation hex
 * is usually the model reaching for "professional grey" rather than reporting a
 * brand colour. A measured `--brand-primary` at 0.12 is a real decision someone
 * made, and rejecting it would drop the client straight back to house amber.
 *
 * Deliberately a local constant rather than a change to `isNeutral`: that helper
 * is shared with the legacy path, which must keep behaving exactly as it does.
 */
const MEASURED_MIN_SATURATION = 0.1;

/**
 * How accent-like the extractor's `primary` must be before it is taken on trust.
 *
 * A brand whose primary is near-black or near-white — common for wordmark-led
 * identities — is well evidenced but unusable as a headline accent, so those
 * fall through to ranking instead.
 */
const MEASURED_MIN_ACCENT_SCORE = 0.25;

/**
 * Picks the accent from a palette that was measured rather than guessed.
 *
 * Two things change versus `pickAccent`. The saturation floor drops, and the
 * role label is trusted — with provenance, "primary" was assigned by measuring
 * where the colour appeared on the site, not by a model's say-so, so it is
 * evidence rather than a hint.
 *
 * Returns null when nothing qualifies so the caller can fall through to the
 * legacy picker; a provenanced palette of pure greys should still land on a
 * readable house theme rather than forcing a grey accent.
 */
function pickMeasuredAccent(candidates: Candidate[]): string | null {
  const chromatic = candidates.filter(
    (candidate) => candidate.saturation >= MEASURED_MIN_SATURATION,
  );
  if (chromatic.length === 0) return null;

  const labelled = chromatic.filter((candidate) =>
    /^(?:primary|accent)$/.test(candidate.role),
  );
  const pool = labelled.length > 0 ? labelled : chromatic;

  // The extractor already ranked the whole palette by evidence, and `primary` is
  // what that ranking settled on. Re-deriving it here from colour geometry alone
  // throws that away and turns near-ties into coin flips — a site's green and
  // blue can score within a thousandth of each other while only one of them is
  // the colour the brand leads with.
  const primary = pool.find((candidate) => candidate.role === 'primary');
  if (primary && primary.score >= MEASURED_MIN_ACCENT_SCORE) return primary.hex;

  // Confidence modulates rather than decides. Ranking on it alone hands the
  // accent to whichever colour was most confidently *identified*, which is not
  // the same question as which colour can carry a headline: a site's stock
  // grey-blue gets declared far more explicitly than the green it actually
  // paints its buttons with. `accentScore` measures the latter.
  const weigh = (candidate: Candidate): number =>
    candidate.score * (0.5 + candidate.confidence / 2);

  const ranked = [...pool].sort((a, b) => weigh(b) - weigh(a));

  return ranked[0]?.hex ?? null;
}

/**
 * Picks the dark ground. Prefers a genuinely dark brand colour so the panel
 * reads as the client's own, but rejects anything above 0.12 luminance — the
 * spec's headline contrast target of 7:1 is unreachable on a mid-tone, and a
 * "dark" panel that isn't dark makes every archetype look washed out.
 *
 * `neutralFallback` forces the achromatic near-black when the palette supplies
 * no dark of its own. Measured palettes use it so the ground stays neutral and
 * the brand colour is the only chromatic element on the poster — otherwise a
 * green brand would inherit the navy alternative, since `classifyFamily` puts
 * greens in the cool band, and the poster would carry a colour the client
 * never chose.
 */
function pickDarkNeutral(
  candidates: Candidate[],
  family: AccentFamily,
  neutralFallback = false,
): string {
  const dark = candidates
    .filter((candidate) => candidate.luminance <= 0.12)
    .sort((a, b) => a.luminance - b.luminance);

  const branded = dark.find((candidate) => candidate.saturation >= 0.15);
  if (branded) return branded.hex;
  if (dark[0]) return dark[0].hex;

  if (neutralFallback) return HOUSE_THEME.darkNeutral;

  // Nothing dark in the palette: cool brands get navy, warm brands near-black,
  // matching how the reference set pairs grounds with accent families.
  return family === 'cool' ? HOUSE_NAVY : HOUSE_THEME.darkNeutral;
}

/** Picks the light ground. Must be near-white or text on it stops reading. */
function pickLightNeutral(candidates: Candidate[]): string {
  const light = candidates
    .filter((candidate) => candidate.luminance >= 0.78 && candidate.saturation <= 0.2)
    .sort((a, b) => b.luminance - a.luminance);

  return light[0]?.hex ?? HOUSE_THEME.lightNeutral;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Resolves a full theme. Never throws and never returns an unreadable pairing —
 * every colour that carries text is contrast-checked before it is returned.
 */
export function resolvePosterTheme(guideline: BrandGuideline): PosterTheme {
  const candidates = toCandidates(guideline);

  /**
   * Whether this palette was measured off the client's own site.
   *
   * Every record written before provenance existed leaves `source` undefined, so
   * this is false for them and each expression below collapses to exactly the
   * line it replaced. That is the whole safety property: existing clients keep
   * receiving byte-identical posters until someone re-extracts their colours.
   */
  const measured = candidates.some(
    (candidate) => candidate.source !== undefined && candidate.source !== 'llm',
  );

  const accent =
    (measured ? pickMeasuredAccent(candidates) : null) ??
    pickAccent(candidates) ??
    HOUSE_THEME.accent;
  const family = classifyFamily(accent);
  const darkNeutral = pickDarkNeutral(candidates, family, measured);
  const lightNeutral = pickLightNeutral(candidates);

  // Text on the grounds. Pure white on near-black is the reference look; the
  // computed variant only differs when a client's "dark" ground is unusually
  // light, in which case it correctly flips to dark text.
  const onDark = ensureContrast(bestTextOn(darkNeutral), darkNeutral, 7);
  const onLight = ensureContrast(bestTextOn(lightNeutral), lightNeutral, 7);

  return {
    darkNeutral,
    lightNeutral,
    accent,
    accentOnDark: ensureContrast(accent, darkNeutral, 4.5),
    accentOnLight: ensureContrast(accent, lightNeutral, 4.5),
    onAccent: bestTextOn(accent),
    onDark,
    onLight,
    family,
    headingFont: resolveFace(
      guideline.typography?.headingFont,
      HEADING_FACES,
      DEFAULT_HEADING,
    ),
    bodyFont: resolveFace(guideline.typography?.bodyFont, BODY_FACES, DEFAULT_BODY),
  };
}

/**
 * Every face the renderer must load for a theme, deduplicated.
 *
 * A theme whose heading and body resolve to the same family (both "Inter", say)
 * would otherwise register it twice and load the same weights twice; satori
 * tolerates that but the fetch is wasted.
 */
export function requiredFaces(theme: PosterTheme): PosterFontChoice[] {
  if (theme.headingFont.family !== theme.bodyFont.family) {
    return [theme.headingFont, theme.bodyFont];
  }

  return [
    {
      family: theme.headingFont.family,
      weights: [...new Set([...theme.headingFont.weights, ...theme.bodyFont.weights])].sort(
        (a, b) => a - b,
      ),
    },
  ];
}

/**
 * Diagnostic used by the preview page: which pairings in a resolved theme fall
 * short of the spec's targets, after correction.
 *
 * A non-empty result is not a render blocker — `ensureContrast` has already done
 * what it can — but it flags a brand whose palette genuinely cannot carry the
 * house look, which is an account conversation, not a bug.
 */
export function auditTheme(theme: PosterTheme): string[] {
  const warnings: string[] = [];

  const check = (
    label: string,
    foreground: string,
    background: string,
    target: number,
  ): void => {
    const ratio = contrastRatio(foreground, background);
    if (ratio < target) {
      warnings.push(
        `${label}: ${ratio.toFixed(2)}:1 against ${background} (target ${target}:1)`,
      );
    }
  };

  check('Headline on dark panel', theme.onDark, theme.darkNeutral, 7);
  check('Headline on light field', theme.onLight, theme.lightNeutral, 7);
  check('Accent text on dark panel', theme.accentOnDark, theme.darkNeutral, 4.5);
  check('Accent text on light field', theme.accentOnLight, theme.lightNeutral, 4.5);
  check('Contact bar text on accent fill', theme.onAccent, theme.accent, 4.5);

  return warnings;
}
