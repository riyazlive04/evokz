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
 * How far a canvas departs from the portrait frame layouts are authored in.
 *
 * **Advisory only.** It used to select between three compositions, because the
 * archetypes answered an off-brand canvas by re-laying their slots into a row. A
 * layout spec cannot do that — it is a stack of rows whatever the aspect — so
 * this now only tells the renderer whether to warn that a preset is squeezing
 * the poster. Nothing branches on it.
 *
 * Thresholds are on the aspect ratio (width / height).
 */
export type CanvasMode = 'tall' | 'wide' | 'letterbox';

const WIDE_ABOVE_ASPECT = 0.82;
const LETTERBOX_ABOVE_ASPECT = 2.2;

export function resolveCanvasMode(width: number, height: number): CanvasMode {
  const aspect = width / height;
  if (aspect > LETTERBOX_ABOVE_ASPECT) return 'letterbox';
  if (aspect > WIDE_ABOVE_ASPECT) return 'wide';
  return 'tall';
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
  // Advisory only — see `resolveCanvasMode`. Nothing below branches on it.
  const mode = resolveCanvasMode(width, height);

  /*
   * Always fitted against the full reference, on both axes.
   *
   * The mode used to change this: `wide` fitted the design to 52% of the width
   * and `letterbox` to 62% of it against a 320px reference height, because the
   * archetypes answered an off-brand canvas by switching to a component that
   * laid its slots out in a ROW. Nothing does that any more — a layout spec is a
   * vertical stack of rows at every aspect — so those factors stopped describing
   * anything and became actively dangerous.
   *
   * How dangerous: at 3440×1440 the letterbox branch resolved a scale of 2.27,
   * so every measurement was set at more than double size on a canvas 1440px
   * tall. The rows overflowed far enough to drive a width negative, and resvg
   * panicked in Rust — which aborts the Node process outright rather than
   * throwing, taking a whole dispatch sweep with it. Caught by
   * `npm run check:layouts`, which renders each fixture at `desktop-ultrawide`
   * for exactly this reason.
   */
  const scale = Math.min(width / REFERENCE_WIDTH, height / REFERENCE_HEIGHT);

  const s = (referenceValue: number): number =>
    Math.round(referenceValue * scale * 100) / 100;

  // The spec's 48 px reference margin reads as too tight below ~5% of width on
  // small canvases and too loose above it on huge ones, so it is clamped.
  //
  // Against the short edge, not the width. On a 3440×1440 canvas a width basis
  // puts a 120px floor on the vertical margins too, which is a tenth of the
  // height gone before a single element is placed.
  const marginBasis = Math.min(width, height);
  const margin = clamp(s(48), marginBasis * 0.035, marginBasis * 0.07);

  const copyWidth = width - margin * 2;

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
