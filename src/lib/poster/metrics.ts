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

/**
 * Widest reference frame the design will be fitted against.
 *
 * Past this the derived reference height is so short that a headline block
 * authored at 300 reference px is taller than the frame containing it. Clamping
 * means an extreme canvas is typeset at 4:1 proportions and simply has slack at
 * the sides, rather than resolving a scale that overflows the rows.
 */
const MAX_REFERENCE_ASPECT = 4;

/**
 * How closely a canvas must match the template's own aspect before the design is
 * re-proportioned to it. Wide enough to absorb `clampEven`'s rounding.
 */
const ASPECT_MATCH_TOLERANCE = 0.02;

/**
 * Ceiling on the reference-to-output multiplier.
 *
 * A canvas whose short edge is very large relative to `REFERENCE_WIDTH` would
 * otherwise set every measurement several times over — see the note in
 * `resolveMetrics`. Two is a 1880px-wide poster at reference proportions, past
 * which nothing gains from scaling further.
 */
const MAX_SCALE = 2;

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
  cta: {
    height: number;
    paddingX: number;
    label: number;
    tracking: number;
    radius: number;
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
export function resolveMetrics(
  width: number,
  height: number,
  /**
   * The aspect the layout being drawn was authored at, from the spec's measured
   * `aspect`. Zero, or absent, means unknown.
   */
  referenceAspect = 0,
): PosterMetrics {
  // Advisory only — see `resolveCanvasMode`. Nothing below branches on it.
  const mode = resolveCanvasMode(width, height);

  /*
   * The reference frame follows the template's own shape — but only when the
   * canvas actually has that shape.
   *
   * `REFERENCE_HEIGHT` was pinned at 1568 on both axes, which was right while
   * every poster was 9:16 and silently wrong the moment one was not: a 1080×1080
   * canvas resolved `min(1080/940, 1080/1568)` = 0.689, so a square poster was
   * typeset at the size a 648px-wide poster would get. Type, margins and the
   * accent rule all came out around a third too small on a canvas with room to
   * spare — a poster that renders, looks deliberate, and does not resemble the
   * template it was read from.
   *
   * Re-proportioning the reference to the canvas fixes that, and would be
   * actively dangerous applied unconditionally. The design is a vertical stack,
   * and how much height it *needs* is a property of its rows, not of the frame:
   * a four-row editorial spec genuinely wants ~1568 units at 940 wide. Fitting
   * that stack to a 1080×566 letterbox reference resolves 1.149 rather than
   * 0.361, the rows overflow far enough to drive a width negative, and resvg
   * panics in Rust — which aborts the Node process outright rather than
   * throwing, taking a whole dispatch sweep with it.
   *
   * So the re-proportioning is gated on the one case where it is known safe: the
   * canvas matching the aspect the layout was read from, which is what
   * `resolvePosterCanvas` arranges for every spec that has a measured one. There
   * the stack's content was authored for exactly these proportions. Everywhere
   * else — a v1 spec with no measured aspect, a fixture rendered at a deliberately
   * hostile preset — the original conservative fit applies unchanged.
   *
   * Verified by `npm run check:layouts`, which renders each fixture at
   * `desktop-ultrawide` for exactly this reason.
   */
  const matchesReference =
    referenceAspect > 0 &&
    Number.isFinite(referenceAspect) &&
    Math.abs(width / height - referenceAspect) <= ASPECT_MATCH_TOLERANCE;

  const referenceHeight = matchesReference
    ? clamp(
        REFERENCE_WIDTH / referenceAspect,
        REFERENCE_WIDTH / MAX_REFERENCE_ASPECT,
        REFERENCE_HEIGHT,
      )
    : REFERENCE_HEIGHT;

  /*
   * MAX_SCALE is a backstop on the matched path, where the two ratios agree and
   * the `min` therefore protects nothing. A genuinely ultrawide template would
   * otherwise resolve 3.66 and set every measurement at more than triple size.
   * It never binds on the unmatched path — no preset in the catalogue reaches it
   * through the height term.
   */
  const scale = Math.min(width / REFERENCE_WIDTH, height / referenceHeight, MAX_SCALE);

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

    cta: {
      height: s(96),
      paddingX: s(46),
      label: s(28),
      tracking: s(28) * 0.08,
      // The `rounded` corner. `pill` resolves to half the button's height at
      // render, and `square` to zero — neither needs a number here.
      radius: s(14),
    },

    slack: Math.max(0, height - referenceHeight * scale),
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

export interface HeadlineFit {
  size: number;
  /** True when `nowrap` had to be given up for the lines to fit. */
  wrap: boolean;
}

/** Satori does the real shaping, so a 4% margin is kept on top of the estimate. */
const SAFETY = 0.96;

/**
 * Sizes the headline so it cannot be cut off, and says whether it had to wrap.
 *
 * Satori will not auto-fit text, and `Headline` sets every line `nowrap` so the
 * copy stage's hand-authored breaks survive. That pair is only safe while the
 * type is small enough to fit: a `nowrap` line inside `Row`'s `overflow: hidden`
 * is sliced mid-glyph, silently, and the poster still looks deliberate. Shipped
 * that way — a 16-character headline in a 40% column lost 56% of itself.
 *
 * So there are two levers, used in order. Shrink first, because re-wrapping a
 * headline someone wrote as three lines stops it looking designed. Wrap only
 * when shrinking alone would take the type below the point where it still reads
 * as a headline.
 *
 * When it does wrap, the fit is computed against the longest **word**, not the
 * longest line. Wrapping cannot save a single word wider than its column, so a
 * word is the real constraint once line breaks stop being fixed — and no floor
 * applies there, because small type is always better than a cut word.
 *
 * `AVERAGE_CAP_ADVANCE` is the mean advance width of a heavy-grotesque capital
 * relative to its point size. It is measured from real output rather than assumed:
 * "COMMERCIAL" set at 98.8 px in Archivo Black rasterises to ~740 px, giving
 * 740 / (10 × 98.8) ≈ 0.75. An earlier 0.58 — a mixed-case figure — let headlines
 * run right up to the margin, and clipped them outright wherever the container had
 * `overflow: hidden`.
 */
export function fitHeadline(
  metrics: PosterMetrics,
  lines: string[],
  availableWidth: number,
  /**
   * The height the headline must also fit, in pixels. Omitted on the grid path,
   * where there is nothing to fit into — a row hugs its content and the bands
   * below it move down.
   *
   * **A plate cannot do that.** Its boxes are a photograph of a composition and
   * its neighbours cannot move, so a headline that grows downward runs over the
   * eyebrow, the feature list and whatever the artwork put there. Seen on a live
   * plate: a five-word headline in a narrow region wrapped to five lines and
   * buried both. Fitting width alone is only half an answer wherever the
   * surroundings are fixed.
   */
  availableHeight?: number,
): HeadlineFit {
  const base = headlineSize(metrics, lines.length);
  const longestLine = lines.reduce((max, line) => Math.max(max, line.length), 0);
  if (longestLine === 0) return { size: base, wrap: false };

  const room = availableWidth * SAFETY;
  const widthAt = (size: number, chars: number) => chars * size * AVERAGE_CAP_ADVANCE;

  /*
   * The height ceiling, applied to whatever the width logic settles on.
   *
   * Wrapping is what makes this necessary rather than merely tidy: shrinking
   * keeps the line count and costs height proportionally, but wrapping *adds*
   * lines, so the block can grow taller precisely when the type got smaller.
   * Estimated against the wrapped line count rather than the authored one for
   * the same reason.
   */
  const capToHeight = (size: number, lineCount: number): number => {
    if (!availableHeight || availableHeight <= 0 || lineCount <= 0) return size;
    const tallest = availableHeight / (lineCount * metrics.headline.lineHeight);
    return Math.min(size, tallest);
  };

  if (widthAt(base, longestLine) <= room) {
    return { size: capToHeight(base, lines.length), wrap: false };
  }

  // Below 55% the headline stops dominating and the composition reads as a
  // body-copy block, so that is where shrinking stops and wrapping takes over.
  const fitted = room / (longestLine * AVERAGE_CAP_ADVANCE);
  if (fitted >= base * 0.55) return { size: capToHeight(fitted, lines.length), wrap: false };

  const longestWord = lines.reduce(
    (max, line) =>
      line.split(/\s+/).reduce((lineMax, word) => Math.max(lineMax, word.length), max),
    0,
  );
  // `longestWord` is at most `longestLine`, so this is never smaller than the
  // size rejected above — wrapping buys back the room that shrinking could not.
  const wrappedSize = Math.min(base, room / (Math.max(longestWord, 1) * AVERAGE_CAP_ADVANCE));

  /*
   * How many lines the wrap will actually produce, approximated from the total
   * character count against the room one line holds. Rough, and it only has to
   * be: it is the difference between capping against the two lines somebody
   * wrote and the five the renderer is about to draw.
   */
  const charsPerLine = Math.max(1, Math.floor(room / (wrappedSize * AVERAGE_CAP_ADVANCE)));
  const totalChars = lines.reduce((sum, line) => sum + line.length + 1, 0);
  const wrappedLines = Math.max(lines.length, Math.ceil(totalChars / charsPerLine));

  return { size: capToHeight(wrappedSize, wrappedLines), wrap: true };
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
