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
import type { BrandGuideline } from '@/lib/types/brand';
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
 * Picks the dark ground. Prefers a genuinely dark brand colour so the panel
 * reads as the client's own, but rejects anything above 0.12 luminance — the
 * spec's headline contrast target of 7:1 is unreachable on a mid-tone, and a
 * "dark" panel that isn't dark makes every archetype look washed out.
 */
function pickDarkNeutral(candidates: Candidate[], family: AccentFamily): string {
  const dark = candidates
    .filter((candidate) => candidate.luminance <= 0.12)
    .sort((a, b) => a.luminance - b.luminance);

  const branded = dark.find((candidate) => candidate.saturation >= 0.15);
  if (branded) return branded.hex;
  if (dark[0]) return dark[0].hex;

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

  const accent = pickAccent(candidates) ?? HOUSE_THEME.accent;
  const family = classifyFamily(accent);
  const darkNeutral = pickDarkNeutral(candidates, family);
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
