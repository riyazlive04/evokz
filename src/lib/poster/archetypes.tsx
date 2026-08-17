import { withAlpha } from '@/lib/poster/color';
import { heaviestWeight } from '@/lib/poster/fonts';
import {
  coverFitFocused,
  type ImageDimensions,
} from '@/lib/poster/image-info';
import {
  AVERAGE_CAP_ADVANCE,
  droppedSlots,
  type PosterMetrics,
} from '@/lib/poster/metrics';
import {
  AccentRule,
  BodyCopy,
  ContactBar,
  Eyebrow,
  FeatureList,
  FeatureStrip,
  FLEX_ALIGN,
  Headline,
  LogoLock,
  groundFor,
  groundForFill,
  type Ground,
} from '@/lib/poster/slots';
import {
  describeArchetype,
  type PosterArchetype,
  type PosterPhoto,
  type PosterSpec,
} from '@/lib/types/poster';

/**
 * The layout archetypes from §5 of docs/creative-style-spec.md, plus the two
 * adaptations that keep non-portrait presets from producing a broken poster.
 *
 * Each archetype is responsible for exactly three things: where the photo sits,
 * which ground each slot lands on, and the shape that separates them. All type
 * and spacing decisions live in `slots.tsx` and `metrics.ts`, so a change to the
 * headline treatment lands in all of them at once.
 *
 * Curves and diagonals are drawn as inline SVG paths rather than CSS. Satori has
 * no `clip-path`, and the rotated-overflow-hidden-div trick that substitutes for
 * it is imprecise at the canvas edges — a path gives the exact geometry and
 * rasterises identically at every output size.
 */

export interface ArchetypeProps {
  spec: PosterSpec;
  metrics: PosterMetrics;
  logoDimensions: ImageDimensions | null;
  /**
   * Mean luminance of the logo's ink, 0–1, or null when unmeasured. Only
   * `LogoLock` reads it, but it rides here with `logoDimensions` because every
   * layout already forwards these props wholesale.
   */
  logoInkLuminance: number | null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Fails the build when a base is added without a `case` below.
 *
 * Worth the two lines: `noImplicitReturns` is off and `renderArchetype` infers
 * its return type, so a missing branch used to compile cleanly and hand satori an
 * `undefined` tree — a blank poster at runtime, on a delivery path with no tests.
 */
function unreachableBase(base: never): never {
  throw new Error(`No layout is wired for base "${String(base)}"`);
}

/**
 * Composes the poster tree for `spec.archetype` at `metrics.mode`.
 *
 * Switches on the archetype's *base* rather than its id, so a variant costs a
 * catalogue entry rather than a ninth branch: a mirrored composition is the same
 * geometry read the other way round, and each component reads its own descriptor
 * to find out which way that is.
 */
export function renderArchetype(props: ArchetypeProps): React.ReactElement {
  if (props.metrics.mode === 'letterbox') return <LetterboxLayout {...props} />;
  if (props.metrics.mode === 'wide') return <WideLayout {...props} />;

  // Bound to a local so the `default` branch narrows to `never`. Re-reading the
  // catalogue inside the switch would hand `unreachableBase` the full union and
  // defeat the check.
  const { base } = describeArchetype(props.spec.archetype);

  switch (base) {
    case 'scrim':
      return <ScrimOverlay {...props} />;
    case 'diagonal':
      return <DiagonalSplit {...props} />;
    case 'bands':
      return <StackedBands {...props} />;
    case 'curve':
      return <CurvedSplit {...props} />;
    case 'editorial':
      return <LightEditorial {...props} />;
    case 'spotlight':
      return <SpotlightCentre {...props} />;
    case 'corner':
      return <CornerInset {...props} />;
    case 'inverted':
      return <InvertedBand {...props} />;
    default:
      return unreachableBase(base);
  }
}

/**
 * Whether an archetype's copy sits on the dark ground or the light one.
 *
 * Reads the catalogue rather than restating the answer. This used to be an `||`
 * chain listing four ids, which the compiler could not check: adding a dark
 * layout and forgetting to extend it produced a correct poster in `tall` mode and
 * a silently inverted one on square and landscape presets only, since this is
 * consulted by `WideLayout` alone while the tall archetypes each state their own
 * ground inline.
 */
export function archetypeGroundIsDark(archetype: PosterArchetype): boolean {
  return describeArchetype(archetype).groundIsDark;
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

interface Region {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The photo, cover-fitted into a region and clipped to it.
 *
 * The inner `<img>` is absolutely positioned at a computed offset instead of
 * using `objectFit: 'cover'`, so the archetype's `photoFocus` bias is honoured —
 * `cover` always centres.
 */
function PhotoLayer({
  photo,
  region,
  focusX,
  focusY,
}: {
  photo: PosterPhoto;
  region: Region;
  focusX: number;
  focusY: number;
}) {
  const fit = coverFitFocused(
    { width: photo.width, height: photo.height },
    { width: region.width, height: region.height },
    focusX,
    focusY,
  );

  return (
    <div
      style={{
        display: 'flex',
        position: 'absolute',
        left: region.left,
        top: region.top,
        width: region.width,
        height: region.height,
        overflow: 'hidden',
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={photo.dataUri}
        alt=""
        width={fit.width}
        height={fit.height}
        style={{
          position: 'absolute',
          left: fit.left,
          top: fit.top,
          width: fit.width,
          height: fit.height,
        }}
      />
    </div>
  );
}

/**
 * Slots 1–5: the logo lock through the body paragraph. Repeated by every
 * archetype, always in this order (§2 — slots may be omitted, never reordered).
 */
function CopyStack({
  spec,
  metrics,
  ground,
  logoDimensions,
  logoInkLuminance,
  columnWidth,
}: ArchetypeProps & { ground: Ground; columnWidth: number }) {
  const { copy, theme, identity } = spec;
  const { align } = describeArchetype(spec.archetype);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: columnWidth,
        alignItems: FLEX_ALIGN[align],
      }}
    >
      <LogoLock
        metrics={metrics}
        theme={theme}
        ground={ground}
        align={align}
        identity={identity}
        logoDimensions={logoDimensions}
        logoInkLuminance={logoInkLuminance}
        availableWidth={columnWidth}
      />

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          marginTop: metrics.s(34),
          alignItems: FLEX_ALIGN[align],
        }}
      >
        {copy.eyebrow ? (
          <div style={{ display: 'flex', marginBottom: metrics.s(12) }}>
            <Eyebrow
              metrics={metrics}
              theme={theme}
              ground={ground}
              align={align}
              text={copy.eyebrow}
            />
          </div>
        ) : null}

        <Headline
          metrics={metrics}
          theme={theme}
          ground={ground}
          align={align}
          lines={copy.headlineLines}
          accentLineIndex={copy.accentLineIndex}
          trailingPeriod={copy.headlinePeriod}
          availableWidth={columnWidth}
        />

        <AccentRule metrics={metrics} theme={theme} ground={ground} align={align} />

        <BodyCopy
          metrics={metrics}
          theme={theme}
          ground={ground}
          align={align}
          text={copy.body}
          maxWidth={Math.min(metrics.body.maxWidth, columnWidth)}
        />
      </div>
    </div>
  );
}

/** Root canvas element. Every archetype starts here. */
function Canvas({
  metrics,
  background,
  children,
}: {
  metrics: PosterMetrics;
  background: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        width: metrics.width,
        height: metrics.height,
        backgroundColor: background,
        overflow: 'hidden',
      }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A — Scrim overlay (refs 1, 6, 9, 10)
// ---------------------------------------------------------------------------

/**
 * Full-bleed photo under a directional scrim, all copy on the scrim, feature strip
 * low, full-bleed contact bar.
 *
 * The scrim is a three-stop gradient rather than a flat overlay: a uniform wash
 * dark enough for the headline would also flatten the photo everywhere, and the
 * point of this archetype is that the photo stays fully visible on the side with
 * no copy on it.
 */
function ScrimOverlay({ spec, metrics, logoDimensions, logoInkLuminance }: ArchetypeProps) {
  const { theme, copy, identity } = spec;
  const ground = groundFor(theme, true);
  const columnWidth = Math.min(metrics.copyWidth, metrics.width * 0.68);
  const { photoFocus: focus, flipped, align } = describeArchetype(spec.archetype);

  return (
    <Canvas metrics={metrics} background={theme.darkNeutral}>
      <PhotoLayer
        photo={spec.photo}
        region={{ left: 0, top: 0, width: metrics.width, height: metrics.height }}
        focusX={focus.x}
        focusY={focus.y}
      />

      {/* Directional scrim: opaque over the copy, clear over the subject.
          The stops are placed against where the copy actually lands rather than
          spread evenly. Projected onto a 145° axis, the headline's far corner sits at
          roughly 36% of the gradient, so full opacity is held to there and then
          dropped hard — an even ramp leaves ~0.8 opacity across the mid-right and
          blacks out the one window this archetype reserves for the photo. */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: metrics.width,
          height: metrics.height,
          // Mirroring a CSS gradient about the vertical axis is `360 - angle`, so
          // the stops keep their distances and only the side they fall on moves.
          backgroundImage: `linear-gradient(${flipped ? 215 : 145}deg, ${withAlpha(
            theme.darkNeutral,
            0.97,
          )} 0%, ${withAlpha(theme.darkNeutral, 0.94)} 36%, ${withAlpha(
            theme.darkNeutral,
            0.28,
          )} 54%, ${withAlpha(theme.darkNeutral, 0)} 70%)`,
        }}
      />
      {/* Bottom anchor so the feature strip never lands on a bright patch.
          Confined to the lower third: extending it further up stacked with the
          directional scrim above and blacked out the mid-right of the frame, which is
          exactly where this archetype is supposed to leave the photo visible. */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: metrics.height * 0.7,
          width: metrics.width,
          height: metrics.height * 0.3,
          backgroundImage: `linear-gradient(180deg, ${withAlpha(
            theme.darkNeutral,
            0,
          )} 0%, ${withAlpha(theme.darkNeutral, 0.82)} 45%, ${withAlpha(
            theme.darkNeutral,
            0.95,
          )} 100%)`,
        }}
      />

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
          width: metrics.width,
          height: metrics.height,
          justifyContent: 'space-between',
        }}
      >
        {/* `justifyContent` rather than `alignItems`: this is a flex row, and the
            copy column carries an explicit width so it will not stretch. */}
        <div
          style={{
            display: 'flex',
            padding: metrics.margin,
            justifyContent: FLEX_ALIGN[align],
          }}
        >
          <CopyStack
            spec={spec}
            metrics={metrics}
            logoDimensions={logoDimensions}
            logoInkLuminance={logoInkLuminance}
            ground={ground}
            columnWidth={columnWidth}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              display: 'flex',
              paddingLeft: metrics.margin,
              paddingRight: metrics.margin,
              paddingBottom: metrics.s(40),
            }}
          >
            <FeatureStrip
              metrics={metrics}
              theme={theme}
              ground={ground}
              features={copy.features}
              width={metrics.width - metrics.margin * 2}
            />
          </div>
          <ContactBar
            metrics={metrics}
            theme={theme}
            identity={identity}
            copy={copy}
            variant="accent"
          />
        </div>
      </div>
    </Canvas>
  );
}

// ---------------------------------------------------------------------------
// B — Diagonal split (refs 2, 13)
// ---------------------------------------------------------------------------

/**
 * Solid dark panel left, photo right, a single straight diagonal between them.
 * The feature block sits in an accent-filled rounded shape overlapping the
 * boundary, as in ref 2.
 */
function DiagonalSplit({ spec, metrics, logoDimensions, logoInkLuminance }: ArchetypeProps) {
  const { theme, copy, identity } = spec;
  const ground = groundFor(theme, true);
  const panelGround = groundForFill(theme, theme.accent);

  const W = metrics.width;
  const H = metrics.height;
  // Diagonal runs from 60% of the width at the top to 44% at the bottom — about
  // 15° off vertical, inside the spec's 12–18° band.
  const topEdge = W * 0.6;
  const bottomEdge = W * 0.44;
  const columnWidth = bottomEdge - metrics.margin * 1.6;

  const panelWidth = W * 0.56;
  const panelHeight = H * 0.34;

  const { photoFocus: focus, flipped, align } = describeArchetype(spec.archetype);

  /*
   * The most coupled of the mirrors: the panel is anchored to a side four ways at
   * once — the path's origin, the rounded corner, the asymmetric padding, and
   * which edge it hangs from.
   *
   * `mx` does the reflection arithmetic inside the path template rather than
   * relying on an SVG or CSS `transform`. Neither is used anywhere in this
   * codebase and neither is proven against satori, whereas the arithmetic is the
   * route every existing path already takes. Non-flipped, `mx` is the identity, so
   * the original geometry is reproduced exactly rather than recomputed.
   */
  const mx = (x: number) => (flipped ? W - x : x);

  return (
    <Canvas metrics={metrics} background={theme.darkNeutral}>
      <PhotoLayer
        photo={spec.photo}
        region={{ left: flipped ? 0 : W * 0.4, top: 0, width: W * 0.6, height: H }}
        focusX={focus.x}
        focusY={focus.y}
      />

      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        style={{ position: 'absolute', left: 0, top: 0 }}
      >
        <path
          d={`M${mx(0)} 0 L${mx(topEdge)} 0 L${mx(bottomEdge)} ${H} L${mx(0)} ${H} Z`}
          fill={theme.darkNeutral}
        />
      </svg>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
          width: W,
          height: H,
          justifyContent: 'space-between',
        }}
      >
        <div
          style={{
            display: 'flex',
            padding: metrics.margin,
            justifyContent: FLEX_ALIGN[align],
          }}
        >
          <CopyStack
            spec={spec}
            metrics={metrics}
            logoDimensions={logoDimensions}
            logoInkLuminance={logoInkLuminance}
            ground={ground}
            columnWidth={columnWidth}
          />
        </div>

        {/* The panel carries an explicit width, so `alignItems` is what moves it to
            the other edge — `stretch` would leave it pinned left. */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: FLEX_ALIGN[align],
          }}
        >
          {/* Accent panel overlapping the diagonal, rounded on its outer corner —
              which is the corner facing the canvas centre, so it swaps with the
              panel. The padding is asymmetric for the same reason: the margin side
              is whichever one meets the canvas edge. */}
          <div
            style={{
              display: 'flex',
              width: panelWidth,
              minHeight: panelHeight,
              backgroundColor: theme.accent,
              ...(flipped
                ? { borderTopLeftRadius: metrics.s(70) }
                : { borderTopRightRadius: metrics.s(70) }),
              paddingLeft: flipped ? metrics.s(28) : metrics.margin,
              paddingRight: flipped ? metrics.margin : metrics.s(28),
              paddingTop: metrics.s(30),
              paddingBottom: metrics.s(30),
              alignItems: 'center',
            }}
          >
            <FeatureList
              metrics={metrics}
              theme={theme}
              ground={panelGround}
              align={align}
              features={copy.features}
              width={panelWidth - metrics.margin - metrics.s(28)}
            />
          </div>
          <ContactBar
            metrics={metrics}
            theme={theme}
            identity={identity}
            copy={copy}
            variant="accent"
          />
        </div>
      </div>
    </Canvas>
  );
}

// ---------------------------------------------------------------------------
// C — Stacked bands (refs 3, 5, 7)
// ---------------------------------------------------------------------------

/**
 * Copy on a light field, photo in a horizontal band, feature strip in a dark
 * band, contact bar below. Three hard horizontal edges and no overlap — the only
 * archetype that needs no absolute positioning for its structure.
 */
function StackedBands({ spec, metrics, logoDimensions, logoInkLuminance }: ArchetypeProps) {
  const { theme, copy, identity } = spec;
  const ground = groundFor(theme, false);
  const darkGround = groundFor(theme, true);
  const columnWidth = metrics.copyWidth;
  const { photoFocus: focus, flipped } = describeArchetype(spec.archetype);

  const photoHeight = metrics.height * 0.3;

  /*
   * The two swappable bands.
   *
   * `flipped` here is a vertical swap, not the horizontal mirror it means
   * elsewhere: this composition is three full-width horizontal bands with no
   * left/right asymmetry to reflect, so its only other arrangement is leading
   * with the photograph instead of the copy. Both keep the dark feature band and
   * the contact bar pinned to the bottom, which is what makes the hard lower edge
   * this archetype is built around.
   */
  const photoBand = (
    <div
      style={{
        display: 'flex',
        position: 'relative',
        width: metrics.width,
        height: photoHeight,
        /*
         * The band that gives. Every other row in this composition is sized by
         * type it cannot reflow — the copy stack, the feature strip and the
         * contact bar all measure whatever their content measures — so when the
         * stack is taller than the canvas something has to absorb the
         * difference, and a photograph losing a slice of its frame is the only
         * loss that is not a defect. Without this the surplus fell off the
         * bottom edge and `Canvas`'s `overflow: hidden` silently ate the contact
         * bar: the poster still rendered, still looked deliberate, and shipped
         * with no phone number on it.
         *
         * The floor keeps the band reading as a band. Below roughly half its
         * intended depth the photograph stops being a horizontal establishing
         * shot and becomes a stripe, at which point the composition is broken
         * in a different way and the copy stage should be shortening the copy
         * instead.
         *
         * `PhotoLayer` inside is absolutely positioned and cover-fitted against
         * the *unshrunk* height, so a shrunk band crops further into the frame
         * rather than distorting it — the focus point stays where the archetype
         * put it and the extra crop comes off the bottom.
         */
        flexShrink: 1,
        minHeight: photoHeight * 0.45,
        overflow: 'hidden',
      }}
    >
      <PhotoLayer
        photo={spec.photo}
        region={{
          left: 0,
          top: 0,
          width: metrics.width,
          height: photoHeight,
        }}
        focusX={focus.x}
        focusY={focus.y}
      />
    </div>
  );

  const copyBand = (
    <div style={{ display: 'flex', flexShrink: 0, padding: metrics.margin }}>
      <CopyStack
        spec={spec}
        metrics={metrics}
        logoDimensions={logoDimensions}
        logoInkLuminance={logoInkLuminance}
        ground={ground}
        columnWidth={columnWidth}
      />
    </div>
  );

  return (
    <Canvas metrics={metrics} background={theme.lightNeutral}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: metrics.width,
          height: metrics.height,
          justifyContent: 'space-between',
        }}
      >
        {flipped ? photoBand : copyBand}

        {/*
         * `flexShrink: 1` so the shrink the photo band offers is actually
         * reachable. The bottom group is a content-sized column, and yoga will
         * only pass a shortfall down to a child that can give if the container
         * between them is itself shrinkable — left at the default the group held
         * its content height and the overflow reappeared below the canvas.
         */}
        <div style={{ display: 'flex', flexDirection: 'column', flexShrink: 1 }}>
          {flipped ? copyBand : photoBand}

          <div
            style={{
              display: 'flex',
              flexShrink: 0,
              width: metrics.width,
              backgroundColor: theme.darkNeutral,
              paddingLeft: metrics.margin,
              paddingRight: metrics.margin,
              paddingTop: metrics.s(34),
              paddingBottom: metrics.s(34),
            }}
          >
            <FeatureStrip
              metrics={metrics}
              theme={theme}
              ground={darkGround}
              features={copy.features}
              width={metrics.width - metrics.margin * 2}
            />
          </div>

          <ContactBar
            metrics={metrics}
            theme={theme}
            identity={identity}
            copy={copy}
            variant="accent"
          />
        </div>
      </div>
    </Canvas>
  );
}

// ---------------------------------------------------------------------------
// D — Curved split (ref 4)
// ---------------------------------------------------------------------------

/**
 * Light field with the photo upper-right, a dark curved sweep rising from the
 * bottom-left to carry the contact bar, feature list vertical on the left.
 *
 * The sweep is a single quadratic path. The contact bar renders transparent on top
 * of it — its own rectangular fill would square off the curve.
 */
function CurvedSplit({ spec, metrics, logoDimensions, logoInkLuminance }: ArchetypeProps) {
  const { theme, copy, identity } = spec;
  const ground = groundFor(theme, false);

  const W = metrics.width;
  const H = metrics.height;

  // The photo's left edge and the copy column must not overlap. The headline is the
  // widest element on the poster and sets in a heavy face, so any overlap puts caps
  // straight over the photo's brightest region — legible in a preview against a flat
  // placeholder, unreadable against a real sky.
  const photoLeft = W * 0.5;
  const columnWidth = Math.min(metrics.copyWidth, photoLeft - metrics.margin * 1.4);

  // Sweep crest at 78% height on the left, dipping to 86% on the right.
  //
  // Sized so the dark band is only a little taller than the contact bar it carries.
  // A deeper sweep looks dramatic empty but the bar is the only thing inside it, so
  // the extra height reads as dead space rather than as design.
  const sweepLeft = H * 0.78;
  const sweepRight = H * 0.86;
  const sweepControl = H * 0.75;

  const { photoFocus: focus, flipped, align } = describeArchetype(spec.archetype);

  /*
   * Mirroring this composition costs less than any of the others: the quadratic's
   * control point already sits at `W * 0.5`, so reflecting the curve about the
   * vertical axis is just swapping which end sits higher. Nothing is recomputed.
   *
   * The photo moves to the left half, and the fade that dissolved its left edge
   * has to dissolve its right one instead — same band, other side of the seam,
   * and the gradient runs the other way (`270deg` rather than `90deg`).
   */
  const photoLeftEdge = flipped ? 0 : photoLeft;
  const edgeFadeLeft = flipped ? photoLeft - W * 0.12 : photoLeft;
  const sweepStart = flipped ? sweepRight : sweepLeft;
  const sweepEnd = flipped ? sweepLeft : sweepRight;

  return (
    <Canvas metrics={metrics} background={theme.lightNeutral}>
      <PhotoLayer
        photo={spec.photo}
        region={{ left: photoLeftEdge, top: 0, width: W - photoLeft, height: H * 0.6 }}
        focusX={focus.x}
        focusY={focus.y}
      />

      {/* Soft fade so the photo's hard vertical edge dissolves into the field. */}
      <div
        style={{
          position: 'absolute',
          left: edgeFadeLeft,
          top: 0,
          width: W * 0.12,
          height: H * 0.6,
          backgroundImage: `linear-gradient(${flipped ? 270 : 90}deg, ${
            theme.lightNeutral
          } 0%, ${withAlpha(theme.lightNeutral, 0)} 100%)`,
        }}
      />
      {/* Bottom fade into the field above the sweep. */}
      <div
        style={{
          position: 'absolute',
          left: photoLeftEdge,
          top: H * 0.48,
          width: W - photoLeft,
          height: H * 0.12,
          backgroundImage: `linear-gradient(180deg, ${withAlpha(
            theme.lightNeutral,
            0,
          )} 0%, ${theme.lightNeutral} 100%)`,
        }}
      />

      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        style={{ position: 'absolute', left: 0, top: 0 }}
      >
        <path
          d={`M0 ${sweepStart} Q ${W * 0.5} ${sweepControl} ${W} ${sweepEnd} L${W} ${H} L0 ${H} Z`}
          fill={theme.darkNeutral}
        />
        {/* Accent hairline tracing the crest, as in ref 4. */}
        <path
          d={`M0 ${sweepStart} Q ${W * 0.5} ${sweepControl} ${W} ${sweepEnd}`}
          fill="none"
          stroke={theme.accent}
          strokeWidth={Math.max(2, metrics.s(5))}
        />
      </svg>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
          width: W,
          height: H,
          justifyContent: 'space-between',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            padding: metrics.margin,
            alignItems: FLEX_ALIGN[align],
          }}
        >
          <CopyStack
            spec={spec}
            metrics={metrics}
            logoDimensions={logoDimensions}
            logoInkLuminance={logoInkLuminance}
            ground={ground}
            columnWidth={columnWidth}
          />

          <div style={{ display: 'flex', marginTop: metrics.s(40) }}>
            <FeatureList
              metrics={metrics}
              theme={theme}
              ground={ground}
              align={align}
              features={copy.features}
              width={columnWidth}
            />
          </div>
        </div>

        <ContactBar
          metrics={metrics}
          theme={theme}
          identity={identity}
          copy={copy}
          variant="dark"
          transparent
        />
      </div>
    </Canvas>
  );
}

// ---------------------------------------------------------------------------
// E — Light editorial (refs 8, 11, 12)
// ---------------------------------------------------------------------------

/**
 * High-key light field with the photo dissolving into it — no hard boundary
 * anywhere. The most premium of the five, and the most dependent on the photo
 * actually being bright: the dissolve is gradients of `lightNeutral` over the
 * photo's edges, which only reads as a fade if the photo is light there.
 */
function LightEditorial({ spec, metrics, logoDimensions, logoInkLuminance }: ArchetypeProps) {
  const { theme, copy, identity } = spec;
  const ground = groundFor(theme, false);

  const W = metrics.width;
  const H = metrics.height;

  // Same constraint as the `curve` archetype: the copy column stops where the photo
  // starts. The dissolve gradients soften the boundary but do not make caps set over
  // a bright sky readable.
  const photoLeft = W * 0.48;
  const columnWidth = Math.min(metrics.copyWidth, photoLeft - metrics.margin * 1.3);

  const { photoFocus: focus, flipped, align } = describeArchetype(spec.archetype);

  /*
   * Everything here already derives from `photoRegion`, so mirroring is a single
   * change of origin: the region moves to the left half and the three dissolves
   * follow it. Only the seam dissolve needs its direction reversed — the top and
   * bottom ones run on the vertical axis, which a horizontal mirror leaves alone.
   */
  const photoRegion: Region = {
    left: flipped ? 0 : photoLeft,
    top: H * 0.12,
    width: W - photoLeft,
    height: H * 0.6,
  };

  const seamFadeLeft = flipped
    ? photoRegion.left + photoRegion.width - W * 0.14
    : photoRegion.left;

  return (
    <Canvas metrics={metrics} background={theme.lightNeutral}>
      <PhotoLayer
        photo={spec.photo}
        region={photoRegion}
        focusX={focus.x}
        focusY={focus.y}
      />

      {/* Seam dissolve — carries the boundary against the copy column. */}
      <div
        style={{
          position: 'absolute',
          left: seamFadeLeft,
          top: photoRegion.top,
          width: W * 0.14,
          height: photoRegion.height,
          backgroundImage: `linear-gradient(${flipped ? 270 : 90}deg, ${
            theme.lightNeutral
          } 0%, ${withAlpha(theme.lightNeutral, 0)} 100%)`,
        }}
      />
      {/* Top and bottom dissolves. */}
      <div
        style={{
          position: 'absolute',
          left: photoRegion.left,
          top: photoRegion.top,
          width: photoRegion.width,
          height: H * 0.1,
          backgroundImage: `linear-gradient(180deg, ${theme.lightNeutral} 0%, ${withAlpha(
            theme.lightNeutral,
            0,
          )} 100%)`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: photoRegion.left,
          top: photoRegion.top + photoRegion.height - H * 0.14,
          width: photoRegion.width,
          height: H * 0.14,
          backgroundImage: `linear-gradient(180deg, ${withAlpha(
            theme.lightNeutral,
            0,
          )} 0%, ${theme.lightNeutral} 100%)`,
        }}
      />

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
          width: W,
          height: H,
          justifyContent: 'space-between',
        }}
      >
        <div
          style={{
            display: 'flex',
            padding: metrics.margin,
            justifyContent: FLEX_ALIGN[align],
          }}
        >
          <CopyStack
            spec={spec}
            metrics={metrics}
            logoDimensions={logoDimensions}
            logoInkLuminance={logoInkLuminance}
            ground={ground}
            columnWidth={columnWidth}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              display: 'flex',
              paddingLeft: metrics.margin,
              paddingRight: metrics.margin,
              paddingBottom: metrics.s(44),
            }}
          >
            <FeatureStrip
              metrics={metrics}
              theme={theme}
              ground={ground}
              features={copy.features}
              width={W - metrics.margin * 2}
            />
          </div>
          <ContactBar
            metrics={metrics}
            theme={theme}
            identity={identity}
            copy={copy}
            variant="dark"
          />
        </div>
      </div>
    </Canvas>
  );
}

// ---------------------------------------------------------------------------
// F — Spotlight centre
// ---------------------------------------------------------------------------

/**
 * Full-bleed photo under an *even* wash, copy centred down the frame.
 *
 * §3 lists three photo-legibility treatments; this is the third — global
 * darkening (2/12) — and it was the only one no archetype used. It differs from
 * `scrim` in kind, not degree: `scrim` keeps one side of the photo untouched and
 * pays for it by anchoring copy to the corner, whereas here the whole image is
 * dimmed evenly so the copy is free to sit anywhere. That buys the one thing the
 * other seven cannot do — a vertically centred column — which is most of why a
 * feed of these stops looking like a single template.
 *
 * The wash is a hair stronger at top and bottom so the logo and the feature list
 * stay legible over a bright sky or a pale foreground, but the mid-frame stays at
 * a flat 0.62 rather than ramping, which is what keeps it reading as one tone.
 */
function SpotlightCentre({ spec, metrics, logoDimensions, logoInkLuminance }: ArchetypeProps) {
  const { theme, copy, identity } = spec;
  const ground = groundFor(theme, true);
  const columnWidth = Math.min(metrics.copyWidth, metrics.width * 0.78);
  // No `flipped` branch: the photo is full-bleed and the wash is symmetric about
  // the vertical axis, so a mirror of this composition is indistinguishable from
  // the original. Alignment is its only variant axis, which is what
  // `spotlight-centred` uses.
  const { photoFocus: focus, align } = describeArchetype(spec.archetype);

  return (
    <Canvas metrics={metrics} background={theme.darkNeutral}>
      <PhotoLayer
        photo={spec.photo}
        region={{ left: 0, top: 0, width: metrics.width, height: metrics.height }}
        focusX={focus.x}
        focusY={focus.y}
      />

      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: metrics.width,
          height: metrics.height,
          backgroundImage: `linear-gradient(180deg, ${withAlpha(
            theme.darkNeutral,
            0.78,
          )} 0%, ${withAlpha(theme.darkNeutral, 0.62)} 26%, ${withAlpha(
            theme.darkNeutral,
            0.62,
          )} 68%, ${withAlpha(theme.darkNeutral, 0.88)} 100%)`,
        }}
      />

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
          width: metrics.width,
          height: metrics.height,
        }}
      >
        {/* Copy and features are centred as ONE block, not pinned to opposite
            ends. Splitting them — copy centred, features bottom-anchored — opens
            a dead band across the middle of the frame that reads as a rendering
            fault rather than as space. flex:1 lets the pair absorb whatever the
            headline's line count leaves over. */}
        <div
          style={{
            display: 'flex',
            flex: 1,
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: FLEX_ALIGN[align],
            paddingLeft: metrics.margin,
            paddingRight: metrics.margin,
            paddingTop: metrics.margin,
          }}
        >
          <CopyStack
            spec={spec}
            metrics={metrics}
            logoDimensions={logoDimensions}
            logoInkLuminance={logoInkLuminance}
            ground={ground}
            columnWidth={columnWidth}
          />

          <div style={{ display: 'flex', marginTop: metrics.s(52) }}>
            <FeatureList
              metrics={metrics}
              theme={theme}
              ground={ground}
              align={align}
              features={copy.features}
              width={Math.min(metrics.width - metrics.margin * 2, metrics.width * 0.74)}
            />
          </div>
        </div>

        <ContactBar
          metrics={metrics}
          theme={theme}
          identity={identity}
          copy={copy}
          variant="accent"
        />
      </div>
    </Canvas>
  );
}

// ---------------------------------------------------------------------------
// G — Corner inset
// ---------------------------------------------------------------------------

/**
 * Light field, photo inset into the upper right, copy beside and below it,
 * contact details stacked rather than side by side.
 *
 * The stacked contact bar is the point. §2 records it as the form 4 of the 12
 * references use, `slots.tsx` has implemented it since the beginning, and no
 * archetype had ever asked for it — so a quarter of the reference set's bottom
 * edge simply never appeared in output. Pairing it with an inset photo (every
 * other light archetype bleeds the photo off an edge) gives a composition whose
 * silhouette differs from the rest at a glance, which is what "another template"
 * has to mean to be worth adding.
 */
function CornerInset({ spec, metrics, logoDimensions, logoInkLuminance }: ArchetypeProps) {
  const { theme, copy, identity } = spec;
  const ground = groundFor(theme, false);
  const { photoFocus: focus, flipped, align } = describeArchetype(spec.archetype);

  const W = metrics.width;
  const H = metrics.height;

  // Bleeds off the right edge but is inset top and bottom, so the corner reads as
  // deliberate rather than as a photo that failed to reach the edge.
  //
  // The height is the load-bearing number. At the 0.3 this started on, the panel
  // sat high on the right and left roughly a third of the frame empty below it —
  // a void, not negative space. Running it to 0.66 gives the right column
  // something to do for as long as the left column is talking.
  const photoLeft = W * 0.5;
  const photoTop = H * 0.08;
  const photoHeight = H * 0.68;

  const columnWidth = Math.min(metrics.copyWidth, photoLeft - metrics.margin * 1.6);

  // Rectangles only, so mirroring is one change of origin shared by the inset and
  // the hairline beneath it. The panel bleeds off whichever edge it now sits on.
  const insetLeft = flipped ? 0 : photoLeft;

  return (
    <Canvas metrics={metrics} background={theme.lightNeutral}>
      <PhotoLayer
        photo={spec.photo}
        region={{
          left: insetLeft,
          top: photoTop,
          width: W - photoLeft,
          height: photoHeight,
        }}
        focusX={focus.x}
        focusY={focus.y}
      />

      {/* A single accent hairline under the photo ties the inset to the field it
          floats on. Without it the panel reads as a paste-up. */}
      <div
        style={{
          position: 'absolute',
          left: insetLeft,
          top: photoTop + photoHeight,
          width: W - photoLeft,
          height: Math.max(2, metrics.s(5)),
          backgroundColor: theme.accent,
        }}
      />

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
          width: W,
          height: H,
        }}
      >
        {/* Copy and features share the left column and are centred as one block
            against the photo panel opposite. Bottom-anchoring the features
            instead — the obvious `space-between` — leaves the left half empty
            from the body paragraph down, which on a portrait canvas is a third of
            the poster showing nothing. */}
        <div
          style={{
            display: 'flex',
            flex: 1,
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: FLEX_ALIGN[align],
            paddingLeft: metrics.margin,
            paddingRight: metrics.margin,
            paddingTop: metrics.margin,
          }}
        >
          <CopyStack
            spec={spec}
            metrics={metrics}
            logoDimensions={logoDimensions}
            logoInkLuminance={logoInkLuminance}
            ground={ground}
            columnWidth={columnWidth}
          />

          <div style={{ display: 'flex', marginTop: metrics.s(48) }}>
            <FeatureList
              metrics={metrics}
              theme={theme}
              ground={ground}
              align={align}
              features={copy.features}
              width={columnWidth}
            />
          </div>
        </div>

        {/* The stacked bar is the only one with a ragged edge of its own, so it
            follows the copy rather than staying pinned left under it. */}
        <ContactBar
          metrics={metrics}
          theme={theme}
          identity={identity}
          copy={copy}
          variant="dark"
          stacked
          align={align}
        />
      </div>
    </Canvas>
  );
}

// ---------------------------------------------------------------------------
// H — Inverted band
// ---------------------------------------------------------------------------

/**
 * Photo band across the top, all copy below it on the dark ground.
 *
 * The inverse of `bands`, and the only archetype where the photo is the first
 * thing read rather than something the copy sits on or beside. On a phone feed
 * that reordering is more noticeable than any amount of gradient work.
 *
 * The band is deliberately 30% rather than the half the name suggests: the full
 * slot stack is not negotiable — `droppedSlots` reports omissions by canvas mode,
 * not by archetype, so a layout that quietly dropped the feature block to buy
 * height would be truncation nobody could see. 30% is what leaves room for a
 * worst-case four-line headline plus the strip and the bar.
 */
function InvertedBand({ spec, metrics, logoDimensions, logoInkLuminance }: ArchetypeProps) {
  const { theme, copy, identity } = spec;
  const ground = groundFor(theme, true);
  const focus = describeArchetype(spec.archetype).photoFocus;

  const photoHeight = metrics.height * 0.3;

  return (
    <Canvas metrics={metrics} background={theme.darkNeutral}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: metrics.width,
          height: metrics.height,
        }}
      >
        <div
          style={{
            display: 'flex',
            position: 'relative',
            width: metrics.width,
            height: photoHeight,
            overflow: 'hidden',
          }}
        >
          <PhotoLayer
            photo={spec.photo}
            region={{
              left: 0,
              top: 0,
              width: metrics.width,
              height: photoHeight,
            }}
            focusX={focus.x}
            focusY={focus.y}
          />
        </div>

        {/* Accent hairline on the seam. The band's lower edge is the poster's one
            hard horizontal, and leaving it unmarked lets a dark photo bleed into
            the dark ground until the structure disappears. */}
        <div
          style={{
            display: 'flex',
            width: metrics.width,
            height: Math.max(2, metrics.s(6)),
            backgroundColor: theme.accent,
          }}
        />

        <div
          style={{
            display: 'flex',
            flex: 1,
            flexDirection: 'column',
            justifyContent: 'center',
            paddingLeft: metrics.margin,
            paddingRight: metrics.margin,
            paddingTop: metrics.s(40),
          }}
        >
          <CopyStack
            spec={spec}
            metrics={metrics}
            logoDimensions={logoDimensions}
            logoInkLuminance={logoInkLuminance}
            ground={ground}
            columnWidth={metrics.copyWidth}
          />
        </div>

        <div
          style={{
            display: 'flex',
            paddingLeft: metrics.margin,
            paddingRight: metrics.margin,
            paddingBottom: metrics.s(40),
          }}
        >
          <FeatureStrip
            metrics={metrics}
            theme={theme}
            ground={ground}
            features={copy.features}
            width={metrics.width - metrics.margin * 2}
          />
        </div>

        <ContactBar
          metrics={metrics}
          theme={theme}
          identity={identity}
          copy={copy}
          variant="accent"
        />
      </div>
    </Canvas>
  );
}

// ---------------------------------------------------------------------------
// Wide adaptation — square and landscape presets
// ---------------------------------------------------------------------------

/**
 * Copy column left, photo right, feature list under the copy, contact bar
 * full-width.
 *
 * One layout serves all five archetypes in this mode; only the ground follows the
 * archetype (dark for `scrim`/`diagonal`, light for the rest). The five distinct
 * compositions are portrait structures — reproducing a "stacked bands" or a
 * "curved sweep" on a 16:9 canvas gives a band a few pixels tall, which is worse
 * than an honest single adaptation.
 */
function WideLayout({ spec, metrics, logoDimensions, logoInkLuminance }: ArchetypeProps) {
  const { theme, copy, identity } = spec;
  const isDark = archetypeGroundIsDark(spec.archetype);
  const ground = groundFor(theme, isDark);

  const W = metrics.width;
  const H = metrics.height;
  const columnWidth = metrics.copyWidth;
  const photoLeft = W * 0.52;

  return (
    <Canvas metrics={metrics} background={isDark ? theme.darkNeutral : theme.lightNeutral}>
      <PhotoLayer
        photo={spec.photo}
        region={{ left: photoLeft, top: 0, width: W - photoLeft, height: H }}
        focusX={describeArchetype(spec.archetype).photoFocus.x}
        focusY={describeArchetype(spec.archetype).photoFocus.y}
      />

      {/* Dissolve the photo's left edge into the copy field. */}
      <div
        style={{
          position: 'absolute',
          left: photoLeft,
          top: 0,
          width: W * 0.1,
          height: H,
          backgroundImage: `linear-gradient(90deg, ${
            isDark ? theme.darkNeutral : theme.lightNeutral
          } 0%, ${withAlpha(isDark ? theme.darkNeutral : theme.lightNeutral, 0)} 100%)`,
        }}
      />

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
          width: W,
          height: H,
          justifyContent: 'space-between',
        }}
      >
        {/* Centred rather than top-aligned: a square or landscape canvas is far
            shorter than the copy column needs, so anchoring to the top leaves a tall
            void between the features and the contact bar. */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            flex: 1,
            justifyContent: 'center',
            padding: metrics.margin,
          }}
        >
          <CopyStack
            spec={spec}
            metrics={metrics}
            logoDimensions={logoDimensions}
            logoInkLuminance={logoInkLuminance}
            ground={ground}
            columnWidth={columnWidth}
          />
          <div style={{ display: 'flex', marginTop: metrics.s(34) }}>
            <FeatureList
              metrics={metrics}
              theme={theme}
              ground={ground}
              features={copy.features}
              width={columnWidth}
            />
          </div>
        </div>

        <ContactBar
          metrics={metrics}
          theme={theme}
          identity={identity}
          copy={copy}
          variant={isDark ? 'accent' : 'dark'}
        />
      </div>
    </Canvas>
  );
}

// ---------------------------------------------------------------------------
// Letterbox adaptation — banner and ultrawide presets
// ---------------------------------------------------------------------------

/**
 * Logo, headline and contact details on one horizontal line over the photo.
 *
 * The body paragraph, feature block and eyebrow are dropped: at a 5.9:1 aspect
 * there is no vertical room for them at legible sizes. `droppedSlots` names them
 * so the renderer can log the loss — a banner that silently omits half the
 * skeleton looks deliberate, and nobody learns the preset was a poor fit.
 */
function LetterboxLayout({ spec, metrics, logoDimensions, logoInkLuminance }: ArchetypeProps) {
  const { theme, copy, identity } = spec;
  const ground = groundFor(theme, true);

  const W = metrics.width;
  const H = metrics.height;

  // Horizontal budget, apportioned out of the width *inside* the margins. Splitting
  // the full canvas width instead — cells summing to 92% plus two gutters — overran
  // it once the container's own padding was added, and every cell clipped.
  const inner = W - metrics.margin * 2;
  const gutter = inner * 0.03;
  const logoCell = inner * 0.26;
  const headlineCell = inner * 0.42;
  const contactCell = inner * 0.26;

  const headlineText = copy.headlineLines.join(' ');
  const letterboxHeadlineSize = Math.min(
    metrics.s(96),
    (headlineCell * 0.96) / (Math.max(1, headlineText.length) * AVERAGE_CAP_ADVANCE),
  );

  return (
    <Canvas metrics={metrics} background={theme.darkNeutral}>
      <PhotoLayer
        photo={spec.photo}
        region={{ left: 0, top: 0, width: W, height: H }}
        focusX={describeArchetype(spec.archetype).photoFocus.x}
        focusY={describeArchetype(spec.archetype).photoFocus.y}
      />
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: W,
          height: H,
          backgroundImage: `linear-gradient(90deg, ${withAlpha(
            theme.darkNeutral,
            0.95,
          )} 0%, ${withAlpha(theme.darkNeutral, 0.8)} 55%, ${withAlpha(
            theme.darkNeutral,
            0.25,
          )} 100%)`,
        }}
      />

      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          position: 'relative',
          width: W,
          height: H,
          alignItems: 'center',
          paddingLeft: metrics.margin,
          paddingRight: metrics.margin,
        }}
      >
        {/* Three fixed-width cells rather than flex:1 in the middle.
            The headline is the only element whose width is not knowable in advance,
            so giving it the leftovers means its overflow lands on top of the contact
            details. Explicit budgets plus `overflow: hidden` keep the cells apart. */}
        <div style={{ display: 'flex', width: logoCell, flexShrink: 0, overflow: 'hidden' }}>
          <LogoLock
            metrics={metrics}
            theme={theme}
            ground={ground}
            identity={identity}
            logoDimensions={logoDimensions}
            logoInkLuminance={logoInkLuminance}
            availableWidth={logoCell}
          />
        </div>

        <div
          style={{
            display: 'flex',
            width: headlineCell,
            flexShrink: 0,
            marginLeft: gutter,
            marginRight: gutter,
            alignItems: 'center',
            overflow: 'hidden',
          }}
        >
          {/* Set directly rather than through `Headline`: this is one line in the
              neutral colour, not a stack with an accented member. Accenting a
              single-line headline would put the entire slot in the accent, which §2
              never does. No minimum size is enforced — on a 5.9:1 banner, small type
              is the correct answer. */}
          <div
            style={{
              fontFamily: theme.headingFont.family,
              fontSize: letterboxHeadlineSize,
              fontWeight: heaviestWeight(theme.headingFont),
              lineHeight: 1,
              letterSpacing: letterboxHeadlineSize * -0.01,
              textTransform: 'uppercase',
              color: ground.text,
              whiteSpace: 'nowrap',
            }}
          >
            {headlineText}
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            width: contactCell,
            flexShrink: 0,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              fontFamily: theme.bodyFont.family,
              fontSize: metrics.contact.value * 0.9,
              fontWeight: 700,
              color: theme.accentOnDark,
              whiteSpace: 'nowrap',
            }}
          >
            {identity.phone}
          </div>
          {identity.website ? (
            <div
              style={{
                marginTop: metrics.s(6),
                fontFamily: theme.bodyFont.family,
                fontSize: metrics.contact.label,
                fontWeight: 500,
                color: withAlpha(theme.onDark, 0.75),
                whiteSpace: 'nowrap',
              }}
            >
              {identity.website}
            </div>
          ) : null}
        </div>
      </div>
    </Canvas>
  );
}

/** Re-exported so the renderer can log what a mode could not carry. */
export { droppedSlots };
