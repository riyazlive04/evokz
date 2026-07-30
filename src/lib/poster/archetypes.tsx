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
  Headline,
  LogoLock,
  groundFor,
  groundForFill,
  type Ground,
} from '@/lib/poster/slots';
import type { PosterArchetype, PosterPhoto, PosterSpec } from '@/lib/types/poster';

/**
 * The five layout archetypes from §5 of docs/creative-style-spec.md, plus the two
 * adaptations that keep non-portrait presets from producing a broken poster.
 *
 * Each archetype is responsible for exactly three things: where the photo sits,
 * which ground each slot lands on, and the shape that separates them. All type
 * and spacing decisions live in `slots.tsx` and `metrics.ts`, so a change to the
 * headline treatment lands in all five at once.
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
}

/**
 * Where each archetype needs the photo's subject, in source-space 0–1
 * coordinates. Straight from the "photo requirement" note on each archetype
 * in §5 — a centre crop would discard the negative space the copy occupies.
 */
const PHOTO_FOCUS: Record<PosterArchetype, { x: number; y: number }> = {
  scrim: { x: 0.72, y: 0.58 }, // subject right/lower, sky upper-left
  diagonal: { x: 0.68, y: 0.5 }, // subject right of centre
  bands: { x: 0.5, y: 0.5 }, // wide establishing shot, subject centred
  curve: { x: 0.72, y: 0.34 }, // subject upper-right, clean lower-left
  editorial: { x: 0.7, y: 0.46 }, // subject right, high-key
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Composes the poster tree for `spec.archetype` at `metrics.mode`. */
export function renderArchetype(props: ArchetypeProps) {
  if (props.metrics.mode === 'letterbox') return <LetterboxLayout {...props} />;
  if (props.metrics.mode === 'wide') return <WideLayout {...props} />;

  switch (props.spec.archetype) {
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
  }
}

/** Whether an archetype's copy sits on the dark ground or the light one. */
export function archetypeGroundIsDark(archetype: PosterArchetype): boolean {
  return archetype === 'scrim' || archetype === 'diagonal';
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
 * using `objectFit: 'cover'`, so the focal bias in `PHOTO_FOCUS` is honoured —
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
  columnWidth,
}: ArchetypeProps & { ground: Ground; columnWidth: number }) {
  const { copy, theme, identity } = spec;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: columnWidth }}>
      <LogoLock
        metrics={metrics}
        theme={theme}
        ground={ground}
        identity={identity}
        logoDimensions={logoDimensions}
        availableWidth={columnWidth}
      />

      <div style={{ display: 'flex', flexDirection: 'column', marginTop: metrics.s(34) }}>
        {copy.eyebrow ? (
          <div style={{ display: 'flex', marginBottom: metrics.s(12) }}>
            <Eyebrow
              metrics={metrics}
              theme={theme}
              ground={ground}
              text={copy.eyebrow}
            />
          </div>
        ) : null}

        <Headline
          metrics={metrics}
          theme={theme}
          ground={ground}
          lines={copy.headlineLines}
          accentLineIndex={copy.accentLineIndex}
          trailingPeriod={copy.headlinePeriod}
          availableWidth={columnWidth}
        />

        <AccentRule metrics={metrics} theme={theme} ground={ground} />

        <BodyCopy
          metrics={metrics}
          theme={theme}
          ground={ground}
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
function ScrimOverlay({ spec, metrics, logoDimensions }: ArchetypeProps) {
  const { theme, copy, identity } = spec;
  const ground = groundFor(theme, true);
  const columnWidth = Math.min(metrics.copyWidth, metrics.width * 0.68);
  const focus = PHOTO_FOCUS.scrim;

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
          backgroundImage: `linear-gradient(145deg, ${withAlpha(
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
        <div style={{ display: 'flex', padding: metrics.margin }}>
          <CopyStack
            spec={spec}
            metrics={metrics}
            logoDimensions={logoDimensions}
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
function DiagonalSplit({ spec, metrics, logoDimensions }: ArchetypeProps) {
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

  return (
    <Canvas metrics={metrics} background={theme.darkNeutral}>
      <PhotoLayer
        photo={spec.photo}
        region={{ left: W * 0.4, top: 0, width: W * 0.6, height: H }}
        focusX={PHOTO_FOCUS.diagonal.x}
        focusY={PHOTO_FOCUS.diagonal.y}
      />

      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        style={{ position: 'absolute', left: 0, top: 0 }}
      >
        <path
          d={`M0 0 L${topEdge} 0 L${bottomEdge} ${H} L0 ${H} Z`}
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
        <div style={{ display: 'flex', padding: metrics.margin }}>
          <CopyStack
            spec={spec}
            metrics={metrics}
            logoDimensions={logoDimensions}
            ground={ground}
            columnWidth={columnWidth}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {/* Accent panel overlapping the diagonal, rounded on its outer corner. */}
          <div
            style={{
              display: 'flex',
              width: panelWidth,
              minHeight: panelHeight,
              backgroundColor: theme.accent,
              borderTopRightRadius: metrics.s(70),
              paddingLeft: metrics.margin,
              paddingRight: metrics.s(28),
              paddingTop: metrics.s(30),
              paddingBottom: metrics.s(30),
              alignItems: 'center',
            }}
          >
            <FeatureList
              metrics={metrics}
              theme={theme}
              ground={panelGround}
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
function StackedBands({ spec, metrics, logoDimensions }: ArchetypeProps) {
  const { theme, copy, identity } = spec;
  const ground = groundFor(theme, false);
  const darkGround = groundFor(theme, true);
  const columnWidth = metrics.copyWidth;

  const photoHeight = metrics.height * 0.3;

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
        <div style={{ display: 'flex', padding: metrics.margin }}>
          <CopyStack
            spec={spec}
            metrics={metrics}
            logoDimensions={logoDimensions}
            ground={ground}
            columnWidth={columnWidth}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
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
              focusX={PHOTO_FOCUS.bands.x}
              focusY={PHOTO_FOCUS.bands.y}
            />
          </div>

          <div
            style={{
              display: 'flex',
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
function CurvedSplit({ spec, metrics, logoDimensions }: ArchetypeProps) {
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

  return (
    <Canvas metrics={metrics} background={theme.lightNeutral}>
      <PhotoLayer
        photo={spec.photo}
        region={{ left: photoLeft, top: 0, width: W - photoLeft, height: H * 0.6 }}
        focusX={PHOTO_FOCUS.curve.x}
        focusY={PHOTO_FOCUS.curve.y}
      />

      {/* Soft left fade so the photo's hard left edge dissolves into the field. */}
      <div
        style={{
          position: 'absolute',
          left: photoLeft,
          top: 0,
          width: W * 0.12,
          height: H * 0.6,
          backgroundImage: `linear-gradient(90deg, ${theme.lightNeutral} 0%, ${withAlpha(
            theme.lightNeutral,
            0,
          )} 100%)`,
        }}
      />
      {/* Bottom fade into the field above the sweep. */}
      <div
        style={{
          position: 'absolute',
          left: photoLeft,
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
          d={`M0 ${sweepLeft} Q ${W * 0.5} ${sweepControl} ${W} ${sweepRight} L${W} ${H} L0 ${H} Z`}
          fill={theme.darkNeutral}
        />
        {/* Accent hairline tracing the crest, as in ref 4. */}
        <path
          d={`M0 ${sweepLeft} Q ${W * 0.5} ${sweepControl} ${W} ${sweepRight}`}
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
        <div style={{ display: 'flex', flexDirection: 'column', padding: metrics.margin }}>
          <CopyStack
            spec={spec}
            metrics={metrics}
            logoDimensions={logoDimensions}
            ground={ground}
            columnWidth={columnWidth}
          />

          <div style={{ display: 'flex', marginTop: metrics.s(40) }}>
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
function LightEditorial({ spec, metrics, logoDimensions }: ArchetypeProps) {
  const { theme, copy, identity } = spec;
  const ground = groundFor(theme, false);

  const W = metrics.width;
  const H = metrics.height;

  // Same constraint as the `curve` archetype: the copy column stops where the photo
  // starts. The dissolve gradients soften the boundary but do not make caps set over
  // a bright sky readable.
  const photoLeft = W * 0.48;
  const columnWidth = Math.min(metrics.copyWidth, photoLeft - metrics.margin * 1.3);

  const photoRegion: Region = {
    left: photoLeft,
    top: H * 0.12,
    width: W - photoLeft,
    height: H * 0.6,
  };

  return (
    <Canvas metrics={metrics} background={theme.lightNeutral}>
      <PhotoLayer
        photo={spec.photo}
        region={photoRegion}
        focusX={PHOTO_FOCUS.editorial.x}
        focusY={PHOTO_FOCUS.editorial.y}
      />

      {/* Left dissolve — carries the boundary against the copy column. */}
      <div
        style={{
          position: 'absolute',
          left: photoRegion.left,
          top: photoRegion.top,
          width: W * 0.14,
          height: photoRegion.height,
          backgroundImage: `linear-gradient(90deg, ${theme.lightNeutral} 0%, ${withAlpha(
            theme.lightNeutral,
            0,
          )} 100%)`,
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
        <div style={{ display: 'flex', padding: metrics.margin }}>
          <CopyStack
            spec={spec}
            metrics={metrics}
            logoDimensions={logoDimensions}
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
function WideLayout({ spec, metrics, logoDimensions }: ArchetypeProps) {
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
        focusX={PHOTO_FOCUS[spec.archetype].x}
        focusY={PHOTO_FOCUS[spec.archetype].y}
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
function LetterboxLayout({ spec, metrics, logoDimensions }: ArchetypeProps) {
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
        focusX={PHOTO_FOCUS[spec.archetype].x}
        focusY={PHOTO_FOCUS[spec.archetype].y}
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
