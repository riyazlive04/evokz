import { bestTextOn, hexToRgb, relativeLuminance, withAlpha } from '@/lib/poster/color';
import { heaviestWeight, lightestWeight } from '@/lib/poster/fonts';
import { PosterIconGlyph } from '@/lib/poster/icons';
import { containFit, type ImageDimensions } from '@/lib/poster/image-info';
import {
  AVERAGE_CAP_ADVANCE,
  fittedHeadlineSize,
  type PosterMetrics,
} from '@/lib/poster/metrics';
import type {
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
}

// ---------------------------------------------------------------------------
// 1. Logo lock
// ---------------------------------------------------------------------------

export interface LogoLockProps extends SlotBase {
  identity: PosterIdentity;
  /** Intrinsic size of `identity.logoDataUri`, required to lay the img out. */
  logoDimensions: ImageDimensions | null;
  /**
   * Width the lockup must fit inside — the archetype's copy column, which in the
   * `diagonal` layout is under half the canvas. Required rather than optional
   * because the wordmark is sized against it, and defaulting to the full canvas
   * width would let a long company name run off the panel.
   */
  availableWidth: number;
}


/**
 * The client's logo, or a generated wordmark lockup when none is on file.
 *
 * The boxed "LOGO HERE" placeholder in 7 of the 12 references is a stock-template
 * artifact, not a design element — reproducing it would ship a placeholder to a
 * paying client. The fallback is the *other* form the references use: a monoline
 * skyline mark beside the company name.
 */
export function LogoLock({
  metrics,
  theme,
  ground,
  identity,
  logoDimensions,
  availableWidth,
}: LogoLockProps) {
  const tagline = identity.brandTagline?.trim();

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
      }}
    >
      {tagline}
    </div>
  ) : null;

  if (identity.logoDataUri && logoDimensions) {
    const box = containFit(logoDimensions, {
      width: metrics.logo.boxWidth,
      height: metrics.logo.boxHeight * 0.62,
    });

    return (
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={identity.logoDataUri}
          alt=""
          width={box.width}
          height={box.height}
          style={{ width: box.width, height: box.height, objectFit: 'contain' }}
        />
        {taglineNode}
      </div>
    );
  }

  // Sized to fit rather than truncated. An ellipsised company name ("EVOKZ PR…")
  // is a visible defect on a creative going to that company, whereas a wordmark set
  // a few points smaller reads as a deliberate lockup.
  const iconSize = metrics.logo.wordmark * 1.5;
  const textRoom = availableWidth - iconSize - metrics.s(14);
  const nameLength = Math.max(1, identity.companyName.length);
  const predicted = nameLength * metrics.logo.wordmark * AVERAGE_CAP_ADVANCE;
  const wordmarkSize =
    predicted <= textRoom
      ? metrics.logo.wordmark
      : Math.max(
          textRoom / (nameLength * AVERAGE_CAP_ADVANCE),
          // Below 55% the wordmark stops holding the top of the poster; a name that
          // long is better handled by uploading a logo.
          metrics.logo.wordmark * 0.55,
        );

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
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
      }}
    >
      {text}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3. Headline
// ---------------------------------------------------------------------------

export interface HeadlineProps extends SlotBase {
  lines: string[];
  accentLineIndex: number;
  trailingPeriod: boolean;
  /** Column the headline must fit inside. */
  availableWidth: number;
}

/**
 * The dominant slot. One line takes the accent colour; the rest take the ground's
 * text colour (§2 — never two accent lines).
 *
 * Each line is its own element so that the 0.96 line-height applies between lines
 * without satori also applying it inside a wrapped line, and so the accent can be
 * scoped to exactly one of them. The authored line breaks are preserved: they are
 * a copywriting decision, and re-wrapping them would undo it.
 */
export function Headline({
  metrics,
  theme,
  ground,
  lines,
  accentLineIndex,
  trailingPeriod,
  availableWidth,
}: HeadlineProps) {
  const size = fittedHeadlineSize(metrics, lines, availableWidth);
  // Clamped rather than trusted: `accentLineIndex` comes from a Json column, and
  // an out-of-range value would leave the poster with no accent at all.
  const accentIndex = Math.min(Math.max(accentLineIndex, 0), lines.length - 1);
  const lastIndex = lines.length - 1;

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {lines.map((line, index) => (
        <div
          key={index}
          style={{
            fontFamily: theme.headingFont.family,
            fontSize: size,
            fontWeight: heaviestWeight(theme.headingFont),
            lineHeight: metrics.headline.lineHeight,
            letterSpacing: size * -0.01,
            textTransform: 'uppercase',
            color: index === accentIndex ? ground.accentText : ground.text,
            whiteSpace: 'nowrap',
          }}
        >
          {index === lastIndex && trailingPeriod ? `${line}.` : line}
        </div>
      ))}
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
}

/** Icon in a circle, label right, two lines of body beneath. 6/12 references. */
export function FeatureList({
  metrics,
  theme,
  ground,
  features,
  width,
}: FeatureBlockProps) {
  const textWidth = width - metrics.feature.iconBox - metrics.feature.gap;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width }}>
      {features.map((feature, index) => (
        <div key={index} style={{ display: 'flex', flexDirection: 'column' }}>
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
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
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
                marginLeft: metrics.feature.gap,
                width: textWidth,
              }}
            >
              <div
                style={{
                  fontFamily: theme.bodyFont.family,
                  fontSize: metrics.feature.label,
                  fontWeight: heaviestWeight(theme.bodyFont),
                  letterSpacing: metrics.feature.label * 0.02,
                  textTransform: 'uppercase',
                  color: ground.text,
                }}
              >
                {feature.label}
              </div>
              <div
                style={{
                  marginTop: metrics.s(4),
                  fontFamily: theme.bodyFont.family,
                  fontSize: metrics.feature.body,
                  fontWeight: lightestWeight(theme.bodyFont),
                  lineHeight: 1.45,
                  color: withAlpha(ground.text, 0.75),
                }}
              >
                {feature.body}
              </div>
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
}: FeatureBlockProps) {
  const columnWidth = width / features.length;

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
                fontSize: metrics.feature.label,
                fontWeight: heaviestWeight(theme.bodyFont),
                letterSpacing: metrics.feature.label * 0.02,
                textTransform: 'uppercase',
                textAlign: 'center',
                color: ground.text,
              }}
            >
              {feature.label}
            </div>
            <div
              style={{
                marginTop: metrics.s(6),
                fontFamily: theme.bodyFont.family,
                fontSize: metrics.feature.body,
                fontWeight: lightestWeight(theme.bodyFont),
                lineHeight: 1.4,
                textAlign: 'center',
                color: withAlpha(ground.text, 0.72),
              }}
            >
              {feature.body}
            </div>
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
   * Skip the background fill and inherit whatever is behind.
   *
   * Needed by the `curve` archetype, where the bar sits inside an SVG sweep: its
   * own rectangular fill would paint over the curve that defines the layout.
   * Colours still resolve as the `dark` variant, since the sweep is dark.
   */
  transparent?: boolean;
}

export function ContactBar({
  metrics,
  theme,
  identity,
  copy,
  variant,
  stacked = false,
  transparent = false,
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

  const cells = [
    { icon: 'phone' as const, label: copy.callLabel, value: identity.phone },
    identity.website
      ? { icon: 'globe' as const, label: copy.websiteLabel, value: identity.website }
      : null,
  ].filter((cell): cell is { icon: 'phone' | 'globe'; label: string; value: string } =>
    cell !== null,
  );

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: stacked ? 'column' : 'row',
        width: metrics.width,
        minHeight: stacked ? metrics.contact.height * 1.15 : metrics.contact.height,
        ...(transparent ? {} : { backgroundColor: background }),
        alignItems: stacked ? 'flex-start' : 'center',
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
              ? { width: '100%', marginTop: index > 0 ? metrics.s(14) : 0 }
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
                fontSize: metrics.contact.label,
                fontWeight: heaviestWeight(theme.bodyFont),
                letterSpacing: metrics.contact.tracking,
                textTransform: 'uppercase',
                color: labelColor,
              }}
            >
              {cell.label}
            </div>
            <div
              style={{
                fontFamily: theme.bodyFont.family,
                fontSize: metrics.contact.value,
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
