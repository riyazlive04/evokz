import { bestTextOn, hexToRgb, relativeLuminance, withAlpha } from '@/lib/poster/color';
import { heaviestWeight, lightestWeight } from '@/lib/poster/fonts';
import { PosterIconGlyph } from '@/lib/poster/icons';
import { containFit, type ImageDimensions } from '@/lib/poster/image-info';
import {
  AVERAGE_CAP_ADVANCE,
  fitHeadline,
  type PosterMetrics,
} from '@/lib/poster/metrics';
import type { LayoutCtaShape, LayoutEmphasis } from '@/lib/types/layout-spec';
import type {
  CopyAlign,
  PosterCopy,
  PosterFeature,
  PosterIdentity,
  PosterTheme,
} from '@/lib/types/poster';

/**
 * The eight slots of the poster skeleton (§2 of docs/creative-style-spec.md).
 *
 * Every archetype composes from these rather than emitting its own type, so the
 * headline in a `scrim` poster is measurably the same headline as in an
 * `editorial` one. An archetype decides *where* a slot goes and *what ground* it
 * sits on; it never decides how the slot looks.
 *
 * Satori notes that shape this file:
 *   - Any element with more than one child needs an explicit `display: 'flex'`.
 *     Satori does not implement block layout, and an unset display silently
 *     collapses siblings on top of one another.
 *   - `gap` support is version-dependent, so spacing is done with margins.
 *   - `<img>` needs both `width` and `height`; it derives neither.
 */

// ---------------------------------------------------------------------------
// Ground — which colours apply on the surface a slot lands on
// ---------------------------------------------------------------------------

export interface Ground {
  isDark: boolean;
  /** Primary text colour. */
  text: string;
  /** Accent colour safe for *text* on this ground. */
  accentText: string;
  /** Accent colour for fills and rules on this ground. */
  accentFill: string;
  /** Body copy: primary text at 85% per §2. */
  muted: string;
  /** Hairline dividers: primary text at 25%. */
  hairline: string;
}

export function groundFor(theme: PosterTheme, isDark: boolean): Ground {
  const text = isDark ? theme.onDark : theme.onLight;
  return {
    isDark,
    text,
    accentText: isDark ? theme.accentOnDark : theme.accentOnLight,
    // Fills are large enough that the brand's stated accent is always correct;
    // only text needs the contrast-corrected variant.
    accentFill: theme.accent,
    muted: withAlpha(text, 0.85),
    hairline: withAlpha(text, 0.25),
  };
}

/**
 * Ground for a slot sitting on an arbitrary fill — the accent-coloured feature
 * panel in the `diagonal` archetype, for instance.
 *
 * `accentFill` deliberately becomes the *contrasting* colour rather than the brand
 * accent: accent-on-accent is invisible, so the icon circles and rule on an accent
 * panel have to be drawn in whatever reads against it.
 */
export function groundForFill(theme: PosterTheme, fill: string): Ground {
  const text = bestTextOn(fill);
  const isDark = relativeLuminance(hexToRgb(fill) ?? { r: 0, g: 0, b: 0 }) < 0.5;

  return {
    isDark,
    text,
    accentText: text,
    accentFill: text,
    muted: withAlpha(text, 0.82),
    hairline: withAlpha(text, 0.28),
  };
}

interface SlotBase {
  metrics: PosterMetrics;
  theme: PosterTheme;
  ground: Ground;
  /**
   * Which edge of its column the slot hangs from. Defaults to `start`, so every
   * layout that does not ask renders exactly as it did before this existed.
   *
   * Needed because the whole file was written start-aligned: a mirrored
   * composition puts the copy column on the other side of the canvas, and copy
   * still ragged-right against a photo it now sits left of reads as a mistake
   * rather than a variant.
   */
  align?: CopyAlign;
}

/** Flexbox equivalent of a `CopyAlign`, for `alignItems` / `alignSelf`. */
export const FLEX_ALIGN: Record<CopyAlign, 'flex-start' | 'center' | 'flex-end'> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
};

/** Text equivalent of a `CopyAlign`, for a slot whose content wraps. */
const TEXT_ALIGN: Record<CopyAlign, 'left' | 'center' | 'right'> = {
  start: 'left',
  center: 'center',
  end: 'right',
};

// ---------------------------------------------------------------------------
// 1. Logo lock
// ---------------------------------------------------------------------------

export interface LogoLockProps extends SlotBase {
  identity: PosterIdentity;
  /** Intrinsic size of `identity.logoDataUri`, required to lay the img out. */
  logoDimensions: ImageDimensions | null;
  /**
   * Mean luminance of the logo's ink, 0–1, or null when it could not be
   * measured. Null keeps the plate off — an unknown logo is left exactly as it
   * rendered before this existed.
   */
  logoInkLuminance: number | null;
  /**
   * Width the lockup must fit inside — the archetype's copy column, which in the
   * `diagonal` layout is under half the canvas. Required rather than optional
   * because the wordmark is sized against it, and defaulting to the full canvas
   * width would let a long company name run off the panel.
   */
  availableWidth: number;
}


/**
 * Whether a logo of this mean ink luminance is legible on `background`.
 *
 * WCAG 1.4.11 puts non-text content — which a logo is — at 3:1, rather than the
 * 4.5:1 the body copy is held to. Measured against the theme's own dark neutral
 * instead of a hardcoded threshold, so a brand whose dark surface is charcoal
 * rather than near-black gets the plate only when it actually needs one.
 *
 * Unmeasured luminance returns true: the logo is left alone, which is how every
 * logo rendered before the plate existed.
 */
function logoReadsOn(inkLuminance: number | null, background: string): boolean {
  if (inkLuminance === null) return true;

  const rgb = hexToRgb(background);
  if (!rgb) return true;

  const groundLuminance = relativeLuminance(rgb);
  const lighter = Math.max(inkLuminance, groundLuminance);
  const darker = Math.min(inkLuminance, groundLuminance);

  return (lighter + 0.05) / (darker + 0.05) >= 3;
}

/**
 * Largest size at which `name` still fits `room`, down to a floor.
 *
 * Sized to fit rather than truncated. An ellipsised company name ("EVOKZ PR…")
 * is a visible defect on a creative going to that company, whereas a wordmark set
 * a few points smaller reads as a deliberate lockup. Below 55% it stops holding
 * its place in the lockup; a name that long is better served by a logo.
 */
function fitCompanyName(name: string, room: number, base: number): number {
  return fitToRoom(name.length, room, base);
}

/**
 * Largest size at which `length` characters still fit `room`, down to 55%.
 *
 * The shared form of the "set it smaller rather than clip it" rule that the
 * wordmark, the headline (`fittedHeadlineSize`) and the contact bar all need.
 * `AVERAGE_CAP_ADVANCE` is measured from real output — see its definition — and
 * the 55% floor is where type stops holding its place in a lockup and starts
 * looking like a different slot.
 */
function fitToRoom(length: number, room: number, base: number): number {
  const characters = Math.max(1, length);
  if (room <= 0) return base * 0.55;
  const predicted = characters * base * AVERAGE_CAP_ADVANCE;
  if (predicted <= room) return base;
  return Math.max(room / (characters * AVERAGE_CAP_ADVANCE), base * 0.55);
}

/**
 * Size at which a *wrapping* block still fits `room`.
 *
 * The difference from `fitToRoom` is which measurement constrains it. That one
 * fits an unbroken line — a phone number, a wordmark — so its whole length is
 * the constraint. A paragraph re-flows, so its length is irrelevant and the
 * binding constraint is its longest single word: wrapping cannot save a word
 * wider than the column, and nothing else has to fit on one line. `fitHeadline`
 * makes the same distinction for the same reason.
 *
 * Measuring a paragraph with `fitToRoom` would shrink it to the floor on sight —
 * a 90-character body in a 160px column predicts 1,550px and collapses, when in
 * truth it wraps to seven comfortable lines.
 *
 * **Feature labels wrap too, and measuring one as a line is a regression.**
 * "TAILORED SOLUTIONS" sets over two lines in every reference that has it; fitted
 * as though it had to hold one, it shrank from 27.6px to 21.1px in a full-width
 * band that had room for it all along.
 */
function fitWrapped(text: string, room: number, base: number): number {
  const longestWord = text
    .split(/\s+/)
    .reduce((max, word) => Math.max(max, word.length), 0);
  return fitToRoom(longestWord, room, base);
}

/**
 * Least width worth giving a feature's text beside its icon.
 *
 * Below this the icon and the gap have eaten so much of the column that the
 * words stack one per line, and the block stops reading as a labelled feature
 * and starts reading as a broken one. Measured: a 25% column on a 1080 canvas
 * leaves 52px here — about four characters — and a 20% column leaves a negative
 * number. `FeatureList` stacks the icon above the text rather than beside it
 * once it drops under this, which hands the text the whole column back.
 */
const MIN_FEATURE_TEXT_WIDTH = 200;

/**
 * The client's logo, or a generated wordmark lockup when none is on file.
 *
 * The boxed "LOGO HERE" placeholder in 7 of the 12 references is a stock-template
 * artifact, not a design element — reproducing it would ship a placeholder to a
 * paying client. The fallback is the *other* form the references use: a monoline
 * skyline mark beside the company name.
 *
 * With a logo on file the name is set beneath it, because a logo is not reliably
 * a wordmark: an icon-only mark used to replace the name outright and left the
 * creative with the company named nowhere on it — not here, not in the contact
 * bar. `identity.logoIncludesName` is how a client whose logo genuinely does
 * spell out the name suppresses the second reading.
 */
export function LogoLock({
  metrics,
  theme,
  ground,
  align = 'start',
  identity,
  logoDimensions,
  logoInkLuminance,
  availableWidth,
}: LogoLockProps) {
  const tagline = identity.brandTagline?.trim();

  /*
   * Sits between the logo and the tagline, at roughly three quarters the size the
   * standalone wordmark would use: it is identifying the mark above it rather than
   * being the mark, and set at full wordmark size it competes with the logo it is
   * supposed to caption.
   */
  const nameSize = fitCompanyName(
    identity.companyName,
    availableWidth,
    metrics.logo.wordmark * 0.72,
  );

  const nameNode = identity.logoIncludesName ? null : (
    <div
      style={{
        marginTop: metrics.s(12),
        fontFamily: theme.headingFont.family,
        fontSize: nameSize,
        fontWeight: heaviestWeight(theme.headingFont),
        letterSpacing: nameSize * 0.02,
        textTransform: 'uppercase',
        color: ground.text,
        textAlign: TEXT_ALIGN[align],
        whiteSpace: 'nowrap',
      }}
    >
      {identity.companyName}
    </div>
  );

  const taglineNode = tagline ? (
    <div
      style={{
        marginTop: metrics.s(10),
        fontFamily: theme.bodyFont.family,
        fontSize: metrics.eyebrow.size,
        fontWeight: lightestWeight(theme.bodyFont),
        letterSpacing: metrics.eyebrow.tracking,
        textTransform: 'uppercase',
        color: withAlpha(ground.text, 0.6),
        textAlign: TEXT_ALIGN[align],
      }}
    >
      {tagline}
    </div>
  ) : null;

  if (identity.logoDataUri && logoDimensions) {
    /*
     * A logo whose background has been keyed out has nothing behind it, so on a
     * dark archetype dark ink lands on near-black and disappears. That is the
     * mirror image of the bug background removal fixes — before, a white slab sat
     * on the dark ground; without a plate, the mark would simply not be there.
     *
     * So the plate is conditional on both halves of the problem being present:
     * a dark ground, and ink too dark to read on it. A light or mid-tone logo
     * needs nothing, and a null luminance (SVG, or bytes we could not measure)
     * renders exactly as it did before this existed.
     */
    const needsPlate = ground.isDark && !logoReadsOn(logoInkLuminance, theme.darkNeutral);

    const padding = needsPlate ? metrics.s(14) : 0;

    // The bounds shrink by the padding so the lockup occupies the same footprint
    // either way — a plate must not push the eyebrow and headline down the page.
    const box = containFit(logoDimensions, {
      width: metrics.logo.boxWidth - padding * 2,
      height: metrics.logo.boxHeight * 0.62 - padding * 2,
    });

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: FLEX_ALIGN[align],
        }}
      >
        <div
          style={{
            display: 'flex',
            // Without this the plate stretches to the full copy column: this sits
            // inside a `flex-direction: column` parent, whose default
            // `align-items: stretch` would size it to the headline's width rather
            // than the logo's.
            alignSelf: FLEX_ALIGN[align],
            padding,
            borderRadius: needsPlate ? metrics.s(10) : 0,
            // Not pure white: the theme's light neutral is the same surface the
            // light archetypes use, so a brand that has tuned it stays consistent
            // across the set. Slightly translucent so it reads as a plate laid on
            // the poster rather than a hole punched through it.
            backgroundColor: needsPlate ? withAlpha(theme.lightNeutral, 0.94) : 'transparent',
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={identity.logoDataUri}
            alt=""
            width={box.width}
            height={box.height}
            style={{ width: box.width, height: box.height, objectFit: 'contain' }}
          />
        </div>
        {nameNode}
        {taglineNode}
      </div>
    );
  }

  const iconSize = metrics.logo.wordmark * 1.5;
  const textRoom = availableWidth - iconSize - metrics.s(14);
  const wordmarkSize = fitCompanyName(
    identity.companyName,
    textRoom,
    metrics.logo.wordmark,
  );

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', alignItems: FLEX_ALIGN[align] }}
    >
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
        <PosterIconGlyph
          name="skyline"
          size={iconSize}
          color={ground.accentFill}
          strokeWidth={1.5}
        />
        <div
          style={{
            marginLeft: metrics.s(14),
            fontFamily: theme.headingFont.family,
            fontSize: wordmarkSize,
            fontWeight: heaviestWeight(theme.headingFont),
            letterSpacing: wordmarkSize * 0.02,
            textTransform: 'uppercase',
            color: ground.text,
            whiteSpace: 'nowrap',
          }}
        >
          {identity.companyName}
        </div>
      </div>
      {taglineNode}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2. Eyebrow
// ---------------------------------------------------------------------------

export function Eyebrow({
  metrics,
  theme,
  ground,
  align = 'start',
  text,
}: SlotBase & { text: string }) {
  return (
    <div
      style={{
        fontFamily: theme.bodyFont.family,
        fontSize: metrics.eyebrow.size,
        fontWeight: 500,
        letterSpacing: metrics.eyebrow.tracking,
        textTransform: 'uppercase',
        color: withAlpha(ground.text, 0.65),
        textAlign: TEXT_ALIGN[align],
      }}
    >
      {text}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3. Headline
// ---------------------------------------------------------------------------

/**
 * Terminal punctuation the copy stage may already have written.
 *
 * `trailingPeriod` asks for a full stop, and appending one unconditionally gave
 * "MODERN CARE FOR YOU.." on a live poster — twice, on two different verticals,
 * because the copy model ends a headline with a stop often enough that this was
 * never going to stay theoretical. The request is "end this headline with a
 * stop", and a headline that already ends with one is already satisfied.
 *
 * Question and exclamation marks count: "WHY WAIT?." is the same defect wearing
 * different punctuation. An ellipsis is included for the same reason — the copy
 * stage writes them, and "coming soon..." must not become "coming soon....".
 */
const ENDS_SENTENCE = /[.!?…]\s*$/;

export interface HeadlineProps extends SlotBase {
  lines: string[];
  accentLineIndex: number;
  trailingPeriod: boolean;
  /**
   * How each line is set, from the template's own spec, indexed by line.
   *
   * **Empty means "the template was never measured for this"**, and the whole
   * array falls back to `accentLineIndex` — one accent-coloured line, every line
   * at the heaviest weight, which is what this component did before emphasis
   * existed and therefore what every stored v1 spec means. A non-empty array
   * overrides it completely.
   */
  emphasis: LayoutEmphasis[];
  /** Whether the template sets its headline in capitals. */
  textCase: 'upper' | 'sentence';
  /** Column the headline must fit inside. */
  availableWidth: number;
}

/**
 * The dominant slot.
 *
 * Each line is its own element so that the 0.96 line-height applies between lines
 * without satori also applying it inside a wrapped line, and so emphasis can be
 * scoped to exactly one of them. The authored line breaks are preserved: they are
 * a copywriting decision, and re-wrapping them would undo it.
 *
 * **Emphasis is weight *and* colour, taken from the template.** The original
 * rule — every line heaviest, one line accent-coloured — described the twelve
 * editorial references it was written from and nothing else. A great many
 * banner references set two light lines against one heavy one in the same
 * colour, and drawing that as three heavy lines with a coloured middle is the
 * most visible way a generated headline stops looking like its reference.
 */
export function Headline({
  metrics,
  theme,
  ground,
  align = 'start',
  lines,
  accentLineIndex,
  emphasis,
  textCase,
  trailingPeriod,
  availableWidth,
}: HeadlineProps) {
  const { size, wrap } = fitHeadline(metrics, lines, availableWidth);
  // Clamped rather than trusted: `accentLineIndex` comes from a Json column, and
  // an out-of-range value would leave the poster with no accent at all.
  const accentIndex = Math.min(Math.max(accentLineIndex, 0), lines.length - 1);
  const lastIndex = lines.length - 1;

  /*
   * The spec's pattern wins where it exists; otherwise the legacy one is
   * synthesised from `accentLineIndex`, so a v1 spec renders byte-identically.
   *
   * A pattern shorter than the headline is normal rather than an error: the copy
   * stage writes 2-4 lines knowing nothing about which template the day landed
   * in. An unmeasured line is `plain`, and `plain` in a measured pattern is a
   * genuinely lighter line — which is the whole point of the field.
   */
  const measured = emphasis.length > 0;
  const emphasisFor = (index: number): LayoutEmphasis =>
    measured
      ? (emphasis[index] ?? 'plain')
      : index === accentIndex
        ? 'accent'
        : 'heavy';

  return (
    /*
     * Aligned on the container rather than with `textAlign`: while every line is
     * `nowrap` each shrinks to its own content, and the flex alignment is what
     * decides which edge the ragged side falls on.
     *
     * Wrapping breaks that. A wrapped line is as wide as the room it was given,
     * not as wide as its glyphs, so the container has nothing left to align and
     * `textAlign` has to place the ragged edge instead.
     */
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: FLEX_ALIGN[align],
      }}
    >
      {lines.map((line, index) => {
        const mark = emphasisFor(index);
        return (
          <div
            key={index}
            style={{
              fontFamily: theme.headingFont.family,
              fontSize: size,
              /*
               * A `plain` line is set at the family's lightest available weight
               * rather than merely one step down, because the contrast is the
               * point: the references pair a genuinely light line against a
               * genuinely heavy one. `lightestWeight` falls back to the only
               * weight a single-weight face has (Archivo Black, Anton), where
               * the distinction simply does not render — correct, since those
               * faces have no light cut to set it in.
               */
              fontWeight:
                mark === 'plain'
                  ? lightestWeight(theme.headingFont)
                  : heaviestWeight(theme.headingFont),
              lineHeight: metrics.headline.lineHeight,
              letterSpacing: size * -0.01,
              ...(textCase === 'upper' ? { textTransform: 'uppercase' as const } : {}),
              color: mark === 'accent' ? ground.accentText : ground.text,
              ...(wrap
                ? { maxWidth: availableWidth, textAlign: TEXT_ALIGN[align] }
                : { whiteSpace: 'nowrap' as const }),
            }}
          >
            {index === lastIndex && trailingPeriod && !ENDS_SENTENCE.test(line)
              ? `${line}.`
              : line}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3b. CTA button
// ---------------------------------------------------------------------------

export interface CtaButtonProps extends SlotBase {
  label: string;
  shape: LayoutCtaShape;
  /** Column the button must fit inside. */
  availableWidth: number;
}

/**
 * A filled button carrying one imperative.
 *
 * Distinct from `ContactBar`, which is a full-bleed strip of phone number and
 * website. This is the mark a banner is built around: type on the left, a cut-out
 * figure on the right, and a coloured pill saying what to do next.
 *
 * **Painted in the brand accent, not the reference's colour.** The three
 * references this was built from carry a red, a blue and an orange button, and
 * all three become the client's own accent — the same rule that turns a
 * template's orange footer into `accent` and lets one spec serve every tenant.
 *
 * Hugs its label rather than filling the column (`alignSelf` on the cross axis),
 * because a button stretched to the width of its cell stops reading as a button.
 */
export function CtaButton({
  metrics,
  theme,
  ground,
  align = 'start',
  label,
  shape,
  availableWidth,
}: CtaButtonProps) {
  const text = label.toUpperCase();

  /*
   * Set down when the label is long or the column narrow, exactly as the contact
   * bar's cells are. Both edges are `nowrap` — a wrapped CTA is two half
   * sentences in a coloured box — so shrinking the type is the only way the
   * button can respond to a column it does not fit.
   */
  const room = Math.max(1, availableWidth - metrics.cta.paddingX * 2);
  const natural = metrics.cta.label;
  const size = Math.min(
    natural,
    Math.max(natural * 0.62, room / Math.max(1, text.length * AVERAGE_CAP_ADVANCE)),
  );

  const height = Math.max(metrics.cta.height * (size / natural), metrics.cta.height * 0.7);

  const radius =
    shape === 'pill' ? height / 2 : shape === 'rounded' ? metrics.cta.radius : 0;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        alignSelf: FLEX_ALIGN[align],
        minHeight: height,
        paddingLeft: metrics.cta.paddingX,
        paddingRight: metrics.cta.paddingX,
        borderRadius: radius,
        backgroundColor: ground.accentFill,
        /*
         * Resolved against the fill the button actually paints, not against the
         * ground it sits on.
         *
         * `ground.accentFill` is the brand accent on a normal surface and the
         * *contrasting* colour on an accent-filled row — see `groundForFill`,
         * where accent-on-accent is deliberately collapsed. Measuring the label
         * against whichever of the two it turned out to be is what keeps the
         * button readable in both cases; `theme.onAccent` would be right only in
         * the first.
         */
        color: bestTextOn(ground.accentFill),
        fontFamily: theme.bodyFont.family,
        fontSize: size,
        fontWeight: heaviestWeight(theme.bodyFont),
        letterSpacing: size * 0.08,
        whiteSpace: 'nowrap',
      }}
    >
      {text}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4. Accent rule
// ---------------------------------------------------------------------------

/**
 * The 120×6 bar above the body copy. Present in 11 of 12 references and, per §2,
 * carrying most of the "designed" signal — omitting it makes an otherwise correct
 * poster read as an unstyled text dump.
 */
export function AccentRule({ metrics, ground }: SlotBase) {
  return (
    <div
      style={{
        width: metrics.accentRule.width,
        height: metrics.accentRule.height,
        marginTop: metrics.accentRule.marginTop,
        marginBottom: metrics.accentRule.marginBottom,
        backgroundColor: ground.accentFill,
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// 5. Body paragraph
// ---------------------------------------------------------------------------

export function BodyCopy({
  metrics,
  theme,
  ground,
  align = 'start',
  text,
  maxWidth,
}: SlotBase & { text: string; maxWidth?: number }) {
  return (
    <div
      style={{
        fontFamily: theme.bodyFont.family,
        fontSize: metrics.body.size,
        fontWeight: lightestWeight(theme.bodyFont),
        lineHeight: metrics.body.lineHeight,
        color: ground.muted,
        // Capped measure is what produces the spec's 3–5 short lines; letting it
        // run the full column width gives 2 long ones and loses the look.
        maxWidth: maxWidth ?? metrics.body.maxWidth,
        // Unlike the headline this genuinely wraps, so the ragged edge is inside
        // the block and only `textAlign` can move it.
        textAlign: TEXT_ALIGN[align],
      }}
    >
      {text}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 6a. Feature block — vertical list
// ---------------------------------------------------------------------------

export interface FeatureBlockProps extends SlotBase {
  features: PosterFeature[];
  /** Total width the block may occupy. */
  width: number;
  /**
   * Draw the sentence under each label.
   *
   * False for the label-only card rows a lot of reference posters use — an icon,
   * one or two words, nothing else. The copy is still written and stored either
   * way: `posterFeatureSchema.body` is `.min(1)`, so asking the copy stage for an
   * empty body would fail validation and take the whole day's copy with it. The
   * omission belongs here, at the point of drawing.
   */
  showBody?: boolean;
}

/** Icon in a circle, label right, two lines of body beneath. 6/12 references. */
export function FeatureList({
  metrics,
  theme,
  ground,
  align = 'start',
  features,
  width,
  showBody = true,
}: FeatureBlockProps) {
  /*
   * Icon beside the text, or above it.
   *
   * Beside is the reference arrangement and stays the default. But the icon
   * badge and its gap take a fixed ~108px whatever the column is, so in a narrow
   * one they consume most of it: a 25% column on a 1080 canvas leaves 52px for
   * the words — "We / create / customized / plans / for / your / needs." one word
   * per line — and a 20% column leaves less than nothing, which yoga renders as
   * a collapsed block.
   *
   * Stacking hands that 108px back to the text. It is the arrangement
   * `FeatureStrip` already uses, so a narrow list column and a wide strip column
   * end up reading as the same component rather than as two.
   */
  const besideWidth = width - metrics.feature.iconBox - metrics.feature.gap;
  const stack = besideWidth < metrics.s(MIN_FEATURE_TEXT_WIDTH);

  // Floored, never negative: a column too narrow even to stack in still has to
  // produce a block satori can lay out.
  const textWidth = Math.max(metrics.s(60), stack ? width : besideWidth);

  /*
   * Type fitted to the column it actually landed in.
   *
   * Every size here used to be a fixed multiple of the canvas, which is right
   * for the full-width bands these were written against and wrong for a column:
   * the block cannot reflow to fit, so a narrow one clipped or stacked instead.
   * Measured against the widest word across all the features rather than per
   * feature, so the three rows stay optically matched — one card set two points
   * smaller than its neighbours reads as a mistake.
   */
  const labelSize = features.reduce(
    (min, f) => Math.min(min, fitWrapped(f.label, textWidth, metrics.feature.label)),
    metrics.feature.label,
  );
  const bodySize = features.reduce(
    (min, f) => Math.min(min, fitWrapped(f.body, textWidth, metrics.feature.body)),
    metrics.feature.body,
  );

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width,
        alignItems: FLEX_ALIGN[align],
      }}
    >
      {features.map((feature, index) => (
        /*
         * The divider follows the icon, not the block's alignment.
         *
         * A row is icon-left / text-right whichever way the poster is aligned —
         * that pairing comes from the reference set and mirroring it would put the
         * icon in the middle of the frame. So the 120px hairline stays on the
         * icon's side, and only a genuinely centred composition centres it.
         * Aligning it to `end` was measured on a mirrored render and left the rule
         * stranded at the far edge, visibly detached from the row it divides.
         */
        <div
          key={index}
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: align === 'center' ? 'center' : 'flex-start',
          }}
        >
          {index > 0 && (
            <div
              style={{
                width: metrics.s(120),
                height: 1,
                marginTop: metrics.feature.rowGap * 0.6,
                marginBottom: metrics.feature.rowGap * 0.6,
                backgroundColor: ground.hairline,
              }}
            />
          )}
          <div
            style={{
              display: 'flex',
              flexDirection: stack ? 'column' : 'row',
              alignItems: stack
                ? align === 'center'
                  ? 'center'
                  : 'flex-start'
                : 'center',
            }}
          >
            <IconBadge
              metrics={metrics}
              ground={ground}
              icon={feature.icon}
              filled={false}
            />
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                ...(stack
                  ? { marginTop: metrics.s(10) }
                  : { marginLeft: metrics.feature.gap }),
                width: textWidth,
              }}
            >
              <div
                style={{
                  fontFamily: theme.bodyFont.family,
                  fontSize: labelSize,
                  fontWeight: heaviestWeight(theme.bodyFont),
                  letterSpacing: labelSize * 0.02,
                  textTransform: 'uppercase',
                  color: ground.text,
                }}
              >
                {feature.label}
              </div>
              {showBody && (
                <div
                  style={{
                    marginTop: metrics.s(4),
                    fontFamily: theme.bodyFont.family,
                    fontSize: bodySize,
                    fontWeight: lightestWeight(theme.bodyFont),
                    lineHeight: 1.45,
                    color: withAlpha(ground.text, 0.75),
                  }}
                >
                  {feature.body}
                </div>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 6b. Feature block — horizontal strip
// ---------------------------------------------------------------------------

/** Columns inside a contrasting band, icon centred above centred text. 6/12. */
export function FeatureStrip({
  metrics,
  theme,
  ground,
  features,
  width,
  showBody = true,
}: FeatureBlockProps) {
  const columnWidth = width / features.length;

  /*
   * Same fitting as `FeatureList`, for the same reason.
   *
   * A strip divides its band by the number of features, so four cards in a
   * half-width band leave each one about 120px — narrower than the list column
   * that made this necessary. The strip already stacks its icon, so there is no
   * arrangement to switch; only the type has to give.
   *
   * Measured across every card, so the row stays optically matched.
   */
  const textWidth = Math.max(metrics.s(60), columnWidth - metrics.s(33));
  const labelSize = features.reduce(
    (min, f) => Math.min(min, fitWrapped(f.label, textWidth, metrics.feature.label)),
    metrics.feature.label,
  );
  const bodySize = features.reduce(
    (min, f) => Math.min(min, fitWrapped(f.body, textWidth, metrics.feature.body)),
    metrics.feature.body,
  );

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        width,
        alignItems: 'flex-start',
      }}
    >
      {features.map((feature, index) => (
        <div
          key={index}
          style={{
            display: 'flex',
            flexDirection: 'row',
            width: columnWidth,
          }}
        >
          {index > 0 && (
            <div
              style={{
                width: 1,
                alignSelf: 'stretch',
                marginRight: metrics.s(18),
                backgroundColor: ground.hairline,
              }}
            />
          )}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              width: columnWidth - (index > 0 ? metrics.s(19) : 0) - metrics.s(14),
            }}
          >
            <IconBadge
              metrics={metrics}
              ground={ground}
              icon={feature.icon}
              filled={false}
            />
            <div
              style={{
                marginTop: metrics.s(14),
                fontFamily: theme.bodyFont.family,
                fontSize: labelSize,
                fontWeight: heaviestWeight(theme.bodyFont),
                letterSpacing: labelSize * 0.02,
                textTransform: 'uppercase',
                textAlign: 'center',
                color: ground.text,
              }}
            >
              {feature.label}
            </div>
            {showBody && (
              <div
                style={{
                  marginTop: metrics.s(6),
                  fontFamily: theme.bodyFont.family,
                  fontSize: bodySize,
                  fontWeight: lightestWeight(theme.bodyFont),
                  lineHeight: 1.4,
                  textAlign: 'center',
                  color: withAlpha(ground.text, 0.72),
                }}
              >
                {feature.body}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/** The circled monoline icon used by both feature arrangements. */
function IconBadge({
  metrics,
  ground,
  icon,
  filled,
}: {
  metrics: PosterMetrics;
  ground: Ground;
  icon: PosterFeature['icon'];
  filled: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        width: metrics.feature.iconBox,
        height: metrics.feature.iconBox,
        borderRadius: metrics.feature.iconBox,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        ...(filled
          ? { backgroundColor: ground.accentFill }
          : {
              border: `${Math.max(1, metrics.s(1.5))}px solid ${ground.accentFill}`,
            }),
      }}
    >
      <PosterIconGlyph
        name={icon}
        size={metrics.feature.iconGlyph}
        color={filled ? '#FFFFFF' : ground.accentFill}
        strokeWidth={1.7}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 8. Contact bar
// ---------------------------------------------------------------------------

export interface ContactBarProps {
  metrics: PosterMetrics;
  theme: PosterTheme;
  identity: PosterIdentity;
  copy: PosterCopy;
  /**
   * `accent` fills with the brand accent and uses `onAccent` text; `dark` fills
   * with the dark neutral and accents the values. Per §2 this bar must not match
   * the panel above it — it is the poster's hard bottom edge — so the archetype
   * chooses the variant that contrasts with whatever it put above.
   */
  variant: 'accent' | 'dark';
  /** Stack the two cells vertically instead of side by side. 4/12 references. */
  stacked?: boolean;
  /**
   * Which edge the stacked cells hang from. Ignored when `stacked` is false —
   * the side-by-side form is centred and has no ragged edge to move.
   */
  align?: CopyAlign;
  /**
   * Skip the background fill and inherit whatever is behind.
   *
   * Needed by the `curve` archetype, where the bar sits inside an SVG sweep: its
   * own rectangular fill would paint over the curve that defines the layout.
   * Colours still resolve as the `dark` variant, since the sweep is dark.
   */
  transparent?: boolean;
  /**
   * Overrides the full-canvas width.
   *
   * Defaults to `metrics.width` because every hand-written archetype puts this
   * bar across the whole poster — it is the composition's hard bottom edge. A
   * layout spec may instead place it in one column of a split row, and a bar
   * that laid itself out at canvas width inside a half-width cell would run its
   * second cell off the edge.
   */
  width?: number;
}

export function ContactBar({
  metrics,
  theme,
  identity,
  copy,
  variant,
  stacked = false,
  transparent = false,
  align = 'start',
  width,
}: ContactBarProps) {
  const onAccent = variant === 'accent';
  const background = onAccent ? theme.accent : theme.darkNeutral;
  const labelColor = onAccent
    ? withAlpha(theme.onAccent, 0.8)
    : withAlpha(theme.onDark, 0.7);
  const valueColor = onAccent ? theme.onAccent : theme.accentOnDark;
  const badgeColor = onAccent ? theme.onAccent : theme.accent;
  const dividerColor = onAccent
    ? withAlpha(theme.onAccent, 0.4)
    : withAlpha(theme.onDark, 0.3);

  const barWidth = width ?? metrics.width;

  const cells = [
    { icon: 'phone' as const, label: copy.callLabel, value: identity.phone },
    identity.website
      ? { icon: 'globe' as const, label: copy.websiteLabel, value: identity.website }
      : null,
  ].filter((cell): cell is { icon: 'phone' | 'globe'; label: string; value: string } =>
    cell !== null,
  );

  /*
   * Type sized to the room each cell actually has.
   *
   * Both lines are `nowrap` — a wrapped phone number is unreadable and a wrapped
   * URL invites a mis-dial — so the only way they can respond to a narrow cell
   * is to set smaller. Without this, a long label beside a long domain simply
   * ran off the right edge of the poster: `flex: 1` gave each cell half the bar
   * and nothing stopped the text overflowing it. Visible on the 9:16 preset,
   * which is the delivery default, and worse under a layout spec that puts the
   * bar in a column rather than across the canvas.
   *
   * Measured against the widest cell content rather than per cell, so the two
   * halves stay optically matched — a bar whose phone number is set two points
   * larger than its website reads as a mistake.
   */
  const cellRoom =
    barWidth / Math.max(1, cells.length) -
    metrics.margin -
    metrics.contact.badge -
    metrics.s(46);

  const longestLabel = cells.reduce((max, cell) => Math.max(max, cell.label.length), 1);
  const longestValue = cells.reduce((max, cell) => Math.max(max, cell.value.length), 1);

  const labelSize = fitToRoom(longestLabel, cellRoom, metrics.contact.label);
  const valueSize = fitToRoom(longestValue, cellRoom, metrics.contact.value);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: stacked ? 'column' : 'row',
        width: width ?? metrics.width,
        minHeight: stacked ? metrics.contact.height * 1.15 : metrics.contact.height,
        ...(transparent ? {} : { backgroundColor: background }),
        alignItems: stacked ? FLEX_ALIGN[align] : 'center',
        justifyContent: 'center',
        paddingLeft: metrics.margin,
        paddingRight: metrics.margin,
        paddingTop: metrics.s(18),
        paddingBottom: metrics.s(18),
      }}
    >
      {cells.map((cell, index) => (
        <div
          key={cell.icon}
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            ...(stacked
              ? {
                  width: '100%',
                  marginTop: index > 0 ? metrics.s(14) : 0,
                  // The cell spans the bar, so the parent's `alignItems` has
                  // nothing to move — the badge and its text are positioned on the
                  // cell's own main axis instead.
                  justifyContent: FLEX_ALIGN[align],
                }
              : { flex: 1 }),
          }}
        >
          {index > 0 && !stacked && (
            <div
              style={{
                width: 1,
                height: metrics.contact.badge * 0.85,
                marginRight: metrics.s(26),
                backgroundColor: dividerColor,
              }}
            />
          )}
          <ContactBadge
            metrics={metrics}
            icon={cell.icon}
            color={badgeColor}
            glyphColor={background}
          />
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              marginLeft: metrics.s(20),
              minWidth: 0,
            }}
          >
            <div
              style={{
                fontFamily: theme.bodyFont.family,
                fontSize: labelSize,
                fontWeight: heaviestWeight(theme.bodyFont),
                letterSpacing: metrics.contact.tracking,
                whiteSpace: 'nowrap',
                textTransform: 'uppercase',
                color: labelColor,
              }}
            >
              {cell.label}
            </div>
            <div
              style={{
                fontFamily: theme.bodyFont.family,
                fontSize: valueSize,
                fontWeight: heaviestWeight(theme.bodyFont),
                lineHeight: 1.2,
                color: valueColor,
                whiteSpace: 'nowrap',
              }}
            >
              {cell.value}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Filled circular badge for the contact bar.
 *
 * Phone and globe are drawn here rather than pulled from `POSTER_ICONS`: those are
 * the copy stage's vocabulary for feature rows, and the contact glyphs are fixed
 * furniture the LLM must not be able to choose.
 */
function ContactBadge({
  metrics,
  icon,
  color,
  glyphColor,
}: {
  metrics: PosterMetrics;
  icon: 'phone' | 'globe';
  color: string;
  glyphColor: string;
}) {
  const size = metrics.contact.badge;
  const glyph = metrics.contact.badgeGlyph;

  return (
    <div
      style={{
        display: 'flex',
        width: size,
        height: size,
        borderRadius: size,
        backgroundColor: color,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <svg
        width={glyph}
        height={glyph}
        viewBox="0 0 24 24"
        fill="none"
        stroke={glyphColor}
        strokeWidth={1.9}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {icon === 'phone' ? (
          <path d="M6.2 3.4h3.1l1.6 4-2 1.4a11.4 11.4 0 0 0 5.3 5.3l1.4-2 4 1.6v3.1a1.8 1.8 0 0 1-1.9 1.8A16.2 16.2 0 0 1 4.4 5.3a1.8 1.8 0 0 1 1.8-1.9z" />
        ) : (
          [
            <circle key="o" cx={12} cy={12} r={8.6} />,
            <line key="v" x1={3.4} y1={12} x2={20.6} y2={12} />,
            <path key="m" d="M12 3.4a13 13 0 0 1 0 17.2" />,
            <path key="m2" d="M12 3.4a13 13 0 0 0 0 17.2" />,
          ]
        )}
      </svg>
    </div>
  );
}
