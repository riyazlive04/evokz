import { REFERENCE_HEIGHT, REFERENCE_WIDTH } from '@/lib/types/poster';

/**
 * The poster design system, resolved to pixels for one output canvas.
 *
 * Every measurement in docs/creative-style-spec.md is stated against a 940×1568
 * reference. This module is the single place that converts them, so a slot
 * component never does arithmetic on a raw spec number and no magic pixel value
 * appears in an archetype.
 */

// ---------------------------------------------------------------------------
// Canvas mode
// ---------------------------------------------------------------------------

/**
 * How much of the slot skeleton a canvas can actually carry.
 *
 * The five archetypes are portrait compositions — the spec's whole vertical stack
 * assumes a tall canvas. But `IMAGE_SIZE_PRESETS` offers square, landscape and
 * letterbox shapes (all flagged `offBrand`), and an operator may legitimately
 * pick one. Rather than emit a poster with slots running off the bottom edge,
 * the renderer switches composition:
 *
 *   tall      — the archetype as designed, full vertical stack
 *   wide      — copy confined to a left column, photo right, features listed
 *   letterbox — logo + headline + contact only; body and features are dropped
 *
 * Thresholds are on the aspect ratio (width / height).
 */
export type CanvasMode = 'tall' | 'wide' | 'letterbox';

const WIDE_ABOVE_ASPECT = 0.82;
const LETTERBOX_ABOVE_ASPECT = 2.2;

/**
 * Reference height the letterbox row is fitted against.
 *
 * Letterbox keeps only the logo lockup, headline and contact bar, arranged
 * side by side, so it does not need the full 1568 px stack. It does still need
 * room for the tallest cell — the logo box, 180 reference px — plus its own
 * vertical margins. 320 leaves comfortable headroom for both.
 *
 * Sized empirically against the shortest preset in the catalogue
 * (`linkedin-banner`, 1128×191): scale resolves to 0.597, giving a 107 px logo
 * box and 13 px margins inside 191 px. `desktop-ultrawide` (3440×1440) is
 * unaffected — width still binds there.
 */
const LETTERBOX_REFERENCE_HEIGHT = 320;

export function resolveCanvasMode(width: number, height: number): CanvasMode {
  const aspect = width / height;
  if (aspect > LETTERBOX_ABOVE_ASPECT) return 'letterbox';
  if (aspect > WIDE_ABOVE_ASPECT) return 'wide';
  return 'tall';
}

/**
 * Slots a mode cannot fit, for the caller to log.
 *
 * Silent truncation is the failure worth guarding against here: a letterbox
 * poster that quietly omits the feature block looks intentional, and nobody
 * discovers the preset was a bad choice.
 */
export function droppedSlots(mode: CanvasMode): string[] {
  switch (mode) {
    case 'letterbox':
      return ['body paragraph', 'feature block', 'eyebrow'];
    case 'wide':
      return [];
    case 'tall':
      return [];
  }
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface PosterMetrics {
  width: number;
  height: number;
  mode: CanvasMode;
  /** Reference-to-output multiplier. */
  scale: number;
  /** Converts a reference-space value to output pixels. */
  s: (referenceValue: number) => number;

  margin: number;
  /** Width available to the copy column. */
  copyWidth: number;

  logo: { boxWidth: number; boxHeight: number; wordmark: number; gap: number };
  eyebrow: { size: number; tracking: number };
  headline: { size: number; lineHeight: number; tracking: number };
  accentRule: { width: number; height: number; marginTop: number; marginBottom: number };
  body: { size: number; lineHeight: number; maxWidth: number };
  feature: {
    iconBox: number;
    iconGlyph: number;
    label: number;
    body: number;
    gap: number;
    rowGap: number;
  };
  contact: {
    height: number;
    badge: number;
    badgeGlyph: number;
    label: number;
    value: number;
    tracking: number;
  };
  /**
   * Vertical space left over after the reference design is scaled to fit. A tall,
   * narrow canvas (9:20 phone wallpaper) has a lot; archetypes hand it to
   * `justify-content: space-between` so the stack breathes instead of clustering
   * at the top.
   */
  slack: number;
}

/**
 * Resolves metrics for a canvas.
 *
 * Scale is the *smaller* of the two axis ratios, never just the width ratio: on a
 * 1440×3120 phone canvas, scaling by width alone would make the design 3418 px
 * tall and push the contact bar off a 3120 px poster.
 */
export function resolveMetrics(width: number, height: number): PosterMetrics {
  const mode = resolveCanvasMode(width, height);

  // In wide and letterbox modes the copy occupies part of the width, so the
  // design is fitted against that column rather than the whole canvas.
  const designWidth =
    mode === 'tall' ? width : mode === 'wide' ? width * 0.52 : width * 0.62;

  const scale = Math.min(
    designWidth / REFERENCE_WIDTH,
    // Letterbox lays its slots out in a ROW rather than a vertical stack, so it
    // is fitted against a much shorter reference — but height never stops
    // constraining entirely. It used to be Number.POSITIVE_INFINITY here, which
    // meant a 1128×191 LinkedIn banner scaled purely off its width: the logo box
    // alone came out 134 px tall in a 191 px canvas, the row overflowed, and
    // resvg panicked on the resulting non-positive geometry — taking the whole
    // Node process down, uncatchably, because it is a Rust panic and not a JS
    // throw. See LETTERBOX_REFERENCE_HEIGHT.
    height / (mode === 'letterbox' ? LETTERBOX_REFERENCE_HEIGHT : REFERENCE_HEIGHT),
  );

  const s = (referenceValue: number): number =>
    Math.round(referenceValue * scale * 100) / 100;

  // The spec's 48 px reference margin reads as too tight below ~5% of width on
  // small canvases and too loose above it on huge ones, so it is clamped.
  //
  // The clamp is against the SHORT edge in letterbox mode. Basing it on width
  // there put a 39 px floor on both vertical margins of a 191 px canvas — 41% of
  // the available height gone before a single element was placed. Every other
  // mode keeps the width basis, so no existing preset shifts.
  const marginBasis = mode === 'letterbox' ? Math.min(width, height) : width;
  const margin = clamp(s(48), marginBasis * 0.035, marginBasis * 0.07);

  const copyWidth =
    mode === 'tall'
      ? width - margin * 2
      : mode === 'wide'
        ? width * 0.52 - margin * 1.5
        : width * 0.62 - margin * 1.5;

  return {
    width,
    height,
    mode,
    scale,
    s,
    margin,
    copyWidth,

    logo: {
      boxWidth: s(235),
      boxHeight: s(180),
      wordmark: s(37),
      gap: s(18),
    },
    eyebrow: {
      size: s(14),
      tracking: s(14) * 0.18,
    },
    headline: {
      // Overwritten per poster by `headlineSize`; this is the 3-line case.
      size: s(86),
      lineHeight: 0.96,
      tracking: s(86) * -0.01,
    },
    accentRule: {
      width: s(120),
      height: Math.max(2, s(6)),
      marginTop: s(30),
      marginBottom: s(32),
    },
    body: {
      size: s(28),
      lineHeight: 1.55,
      // ~34 characters at this size, per §2.
      maxWidth: Math.min(s(480), copyWidth),
    },
    feature: {
      iconBox: s(72),
      iconGlyph: s(38),
      label: s(24),
      body: s(20),
      gap: s(22),
      rowGap: s(26),
    },
    contact: {
      height: s(160),
      badge: s(76),
      badgeGlyph: s(38),
      label: s(22),
      value: s(34),
      tracking: s(22) * 0.06,
    },

    slack: Math.max(0, height - REFERENCE_HEIGHT * scale),
  };
}

/**
 * Headline size for a given line count.
 *
 * The spec pins the *block* height (300–380 reference px) rather than the type
 * size, so a 4-line headline must set smaller than a 2-line one or it swallows
 * the body copy's space.
 */
export function headlineSize(metrics: PosterMetrics, lineCount: number): number {
  const referenceSize = lineCount >= 4 ? 76 : lineCount === 3 ? 86 : 96;
  return metrics.s(referenceSize);
}

/**
 * Shrinks the headline further when a line is long enough to overflow the copy
 * column.
 *
 * Satori will not auto-fit text: an over-wide line wraps, and a headline whose
 * hand-authored line breaks are re-wrapped by the renderer stops looking
 * designed. The copy stage caps line length at 24 characters, but a 24-character
 * line in a condensed face at 96 px still exceeds a narrow column, so the size is
 * reduced until the longest line is predicted to fit.
 *
 * `AVERAGE_CAP_ADVANCE` is the mean advance width of a heavy-grotesque capital
 * relative to its point size. It is measured from real output rather than assumed:
 * "COMMERCIAL" set at 98.8 px in Archivo Black rasterises to ~740 px, giving
 * 740 / (10 × 98.8) ≈ 0.75. An earlier 0.58 — a mixed-case figure — let headlines
 * run right up to the margin, and clipped them outright wherever the container had
 * `overflow: hidden`. Satori does the real shaping, so a 4% safety margin is kept
 * on top.
 */
export function fittedHeadlineSize(
  metrics: PosterMetrics,
  lines: string[],
  availableWidth: number,
): number {
  const base = headlineSize(metrics, lines.length);
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
  if (longest === 0) return base;

  const SAFETY = 0.96;
  const predicted = longest * base * AVERAGE_CAP_ADVANCE;
  if (predicted <= availableWidth * SAFETY) return base;

  const fitted = (availableWidth * SAFETY) / (longest * AVERAGE_CAP_ADVANCE);
  // Never below 55% of the intended size — past that the headline stops
  // dominating and the composition reads as a body-copy block.
  return Math.max(fitted, base * 0.55);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Mean advance width of a heavy-grotesque capital, as a fraction of point size.
 *
 * Shared by every caps-setting slot that has to predict its own width — the
 * headline, the wordmark lockup, the letterbox banner line. Exported so those
 * estimates cannot drift apart.
 */
export const AVERAGE_CAP_ADVANCE = 0.75;
