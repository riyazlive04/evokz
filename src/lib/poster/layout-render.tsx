import { withAlpha } from '@/lib/poster/color';
import { fitHeadline, type PosterMetrics } from '@/lib/poster/metrics';
import {
  AccentRule,
  BodyCopy,
  ContactBar,
  CtaButton,
  Eyebrow,
  FeatureList,
  FeatureStrip,
  Headline,
  LogoLock,
  groundFor,
  groundForFill,
  type Ground,
} from '@/lib/poster/slots';
import type { ImageDimensions } from '@/lib/poster/image-info';
import type {
  LayoutAlign,
  LayoutCell,
  LayoutFill,
  LayoutPhotoKind,
  LayoutRow,
  LayoutSlot,
  PosterLayoutSpec,
} from '@/lib/types/layout-spec';
import type {
  CopyAlign,
  PosterCopy,
  PosterIdentity,
  PosterPhoto,
  PosterTheme,
} from '@/lib/types/poster';

/**
 * Draws a poster from a stored layout spec instead of a hand-written archetype.
 *
 * One interpreter serves every template an operator ever uploads, which is the
 * whole point: adding a composition used to mean adding a component to
 * `archetypes.tsx` and an entry to `ARCHETYPE_CATALOGUE`, so the fifteen layouts
 * in this system were fifteen deliberate engineering decisions. A spec is data,
 * so the hundredth template costs what the first one did.
 *
 * The interpreter stays deliberately thin. It decides geometry — which row, how
 * tall, which column, how wide, what ground — and hands every actual mark to the
 * same slot components in `slots.tsx` that the archetypes use. A headline
 * rendered from a spec is therefore measurably the same headline as one rendered
 * by `scrim`, which is what stops a vertical's posters drifting apart as its
 * template library grows.
 *
 * **The photo needs no build-time height here, and that is a real simplification
 * over the archetypes.** They precompute a cover-fit against a known region,
 * because their photo areas are expressed in canvas fractions. A spec's photo
 * cell sits in a row whose height is only settled after layout, so instead the
 * image fills its cell with `object-fit: cover` and lets satori resolve it. That
 * Copy laid over a photograph is expressed by putting both in one cell: the
 * photo becomes that cell's background under a scrim, rather than a stacked
 * sibling. Everywhere else a centre crop is correct rather than approximate,
 * because the copy sits beside the photograph rather than on it.
 */

export interface LayoutRenderProps {
  spec: PosterLayoutSpec;
  copy: PosterCopy;
  theme: PosterTheme;
  identity: PosterIdentity;
  /**
   * One per photo slot, in the order the slots appear. A short array reuses its
   * last entry rather than rendering a hole — the pipeline may legitimately
   * deliver fewer frames than the spec asks for when a diffusion call fails, and
   * a repeated photograph is a far better poster than a grey rectangle.
   */
  photos: PosterPhoto[];
  metrics: PosterMetrics;
  logoDimensions: ImageDimensions | null;
  logoInkLuminance: number | null;
}

const ALIGN: Record<LayoutAlign, CopyAlign> = {
  start: 'start',
  center: 'center',
  end: 'end',
};

const FLEX: Record<LayoutAlign, 'flex-start' | 'center' | 'flex-end'> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
};

/**
 * Slots that lay out their own full-bleed surface and must not be inset again.
 *
 * `ContactBar` applies the canvas margin itself, so a padded cell around it
 * would double the inset and break the alignment with every other poster in the
 * campaign. A photo is full-bleed by definition.
 */
const SELF_BLEEDING: ReadonlySet<LayoutSlot> = new Set<LayoutSlot>(['photo', 'contact']);

/**
 * Vertical rhythm between consecutive slots, in reference pixels.
 *
 * Lifted from `CopyStack` in archetypes.tsx rather than re-invented, so a spec
 * that happens to stack logo → eyebrow → headline → rule → body produces
 * spacing identical to the hand-written compositions. `accentRule` is absent
 * from the table because the component carries its own margins on both sides.
 */
function slotGap(previous: LayoutSlot, next: LayoutSlot): number {
  if (previous === 'accentRule' || next === 'accentRule') return 0;
  if (previous === 'logo') return 34;
  if (previous === 'eyebrow') return 12;
  if (next === 'features') return 34;
  return 24;
}


// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

/**
 * The marks a template uses to fill space, which the slot vocabulary has no way
 * to describe.
 *
 * A rebuilt poster comes out emptier than its reference and the photograph is
 * rarely the reason. Measured on the HealthFirst medical template: a faithful
 * spec, a correct render, and 60% of the canvas bare — because the panel behind
 * the service list, the shape behind the cut-out doctor and the curve over the
 * footer are all chrome, and chrome had no representation at all. Slots carry
 * content; these carry the surface it sits on.
 *
 * Drawn as inline SVG because satori rasterises it — the same route
 * `icons.tsx` takes — so a curve is a real curve rather than a border-radius
 * approximation of one.
 *
 * **Every colour comes from the theme, never from a stored hex.** The reference
 * being teal must not make a green client's poster teal, which is the rule
 * `LAYOUT_FILLS` exists to enforce and applies with equal force here.
 */

/**
 * A dome cut into the top of a filled band, so it meets the page on a curve.
 *
 * Painted as the *page* colour over the band's own fill rather than as the band
 * over the page, and that inversion is what makes it work at all. The canvas
 * clips overflow, so a shape hanging up into the row above would be sliced off
 * at the very boundary it exists to soften; masking downward from inside the
 * row has nothing to clip.
 *
 * **Explicit pixel dimensions, never percentages.** Satori resolves `<svg>` the
 * way `icons.tsx` uses it — numeric `width`/`height` against a `viewBox`. A
 * percentage-sized SVG with `preserveAspectRatio="none"` renders, and renders
 * its path as a filled rectangle: the first version of this drew a perfectly
 * straight edge and looked like the feature had simply not been wired up.
 *
 * The cap is a fixed height rather than a share of the band, so a slim footer
 * and a tall hero get the same sweep instead of the tall one getting a bulge.
 */
function BandCurveCap({
  pageColor,
  width,
  height,
}: {
  pageColor: string;
  width: number;
  height: number;
}) {
  // Everything above the dome, filled in the page's own colour. The control
  // point at -height puts the apex exactly on the band's top edge.
  const d = `M0 0 L${width} 0 L${width} ${height} Q ${width / 2} ${-height} 0 ${height} Z`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ position: 'absolute', left: 0, top: 0 }}
    >
      <path d={d} fill={pageColor} />
    </svg>
  );
}

/**
 * A large accent form anchored to the bottom of a cell, for a cut-out figure to
 * stand in front of.
 *
 * A `subject` photo is a person with their background removed. On bare canvas
 * they float, which is the single thing that makes a composite read as
 * unfinished — and nearly every reference that uses a cut-out puts a shape
 * behind them. This is the general case of that shape.
 *
 * Deliberately anchored below and oversized horizontally: a disc centred in the
 * cell would halo the figure's head, which looks like a mistake. Sitting low
 * behind their body is what the references actually do.
 */
/**
 * A rounded panel behind a cell's content.
 *
 * A plain rectangle rather than anything cleverer, because that is what
 * reference panels overwhelmingly are — the "OUR SERVICES" block on the
 * HealthFirst template, the offer card on a restaurant poster, the spec sheet on
 * a property listing. What makes them read as panels is the radius and the
 * hairline, not the shape.
 *
 * A `div` rather than SVG: satori draws rounded borders natively, and a real
 * border hairlines more crisply than a stroked rect scaled by
 * `preserveAspectRatio: none`, which would thin the edge on one axis.
 */
function CardSurface({
  color,
  borderColor,
  radius,
}: {
  color: string;
  borderColor: string;
  radius: number;
}) {
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        display: 'flex',
        backgroundColor: color,
        borderRadius: radius,
        border: `1px solid ${borderColor}`,
      }}
    />
  );
}

function SubjectBackdrop({ color, width }: { color: string; width: number }) {
  /*
   * Sized off the column's width and anchored to its floor, because the cell's
   * height is not knowable here — it is whatever the flex row settles on, and
   * satori needs a number before that is decided. A disc as wide as the column
   * is the right scale for a figure standing in it whatever the band's height
   * turns out to be.
   */
  const box = width;

  return (
    <svg
      width={box}
      height={box}
      viewBox={`0 0 ${box} ${box}`}
      style={{ position: 'absolute', left: 0, bottom: 0 }}
    >
      <ellipse
        cx={box * 0.55}
        cy={box * 0.86}
        rx={box * 0.62}
        ry={box * 0.52}
        fill={color}
      />
    </svg>
  );
}

function fillColor(fill: LayoutFill, theme: PosterTheme): string | undefined {
  switch (fill) {
    case 'light':
      return theme.lightNeutral;
    case 'dark':
      return theme.darkNeutral;
    case 'accent':
      return theme.accent;
    case 'inherit':
      // Undefined rather than 'transparent': satori paints nothing for an unset
      // background, and the canvas ground shows through.
      return undefined;
  }
}

/** The colours a slot must use to read on the surface it landed on. */
function groundForLayoutFill(
  fill: LayoutFill,
  theme: PosterTheme,
  canvasIsDark: boolean,
): Ground {
  switch (fill) {
    case 'light':
      return groundFor(theme, false);
    case 'dark':
      return groundFor(theme, true);
    case 'accent':
      // Accent-on-accent is invisible, so this resolves icons and rules to
      // whatever contrasts with the brand colour rather than to the colour
      // itself. See `groundForFill`.
      return groundForFill(theme, theme.accent);
    case 'inherit':
      return groundFor(theme, canvasIsDark);
  }
}

export function renderLayoutSpec(props: LayoutRenderProps): React.ReactElement {
  const { spec, theme, metrics } = props;
  const canvasIsDark = spec.ground === 'dark';

  // Assigned across the whole spec rather than per row, so the first photo slot
  // top-to-bottom always gets the first generated frame. That ordering is what
  // lets `resolveSpecPhotoRequests` ask for the right aspect per slot.
  let photoCursor = 0;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        width: metrics.width,
        height: metrics.height,
        backgroundColor: canvasIsDark ? theme.darkNeutral : theme.lightNeutral,
        overflow: 'hidden',
      }}
    >
      {spec.rows.map((row, index) => {
        const element = (
          <Row
            key={index}
            row={row}
            props={props}
            canvasIsDark={canvasIsDark}
            photoIndexAt={() => photoCursor++}
          />
        );
        return element;
      })}
    </div>
  );
}

function Row({
  row,
  props,
  canvasIsDark,
  photoIndexAt,
}: {
  row: LayoutRow;
  props: LayoutRenderProps;
  canvasIsDark: boolean;
  photoIndexAt: () => number;
}) {
  const { metrics, theme } = props;

  /*
   * The three sizing modes, and the one invariant that matters.
   *
   * `hug` and `fixed` rows never shrink; the `flex` row does. Type cannot
   * reflow to fit a canvas, so if every row held its content height a headline
   * one line longer than the reference would push the contact bar past the
   * bottom edge, where the canvas's `overflow: hidden` would swallow it — a
   * poster that renders, looks deliberate, and carries no phone number. That
   * exact defect shipped in the hand-written `bands` archetype.
   *
   * `validateLayoutSpec` guarantees at least one flex row exists, so there is
   * always somewhere for the surplus to go.
   */
  const sizing =
    row.sizingMode === 'fixed'
      ? /*
         * `minHeight`, not `height` — "fixed" means *at least* this share.
         *
         * A hard height clips its own content. The extractor reads the cafe
         * reference's footer as 7% of the canvas, and 7% of a 9:16 poster is
         * 134px against a contact bar whose own minimum is 184px, so the bar
         * lost its bottom third to the row's `overflow: hidden`. Letting the row
         * grow costs nothing: the flex row above it gives up the difference,
         * which is the arrangement the whole sizing model is built on.
         */
        {
          minHeight: metrics.height * row.heightFraction,
          flexShrink: 0,
          flexGrow: 0,
        }
      : row.sizingMode === 'flex'
        ? {
            flexGrow: 1,
            flexShrink: 1,
            // A flex row that collapsed to nothing would leave the poster looking
            // like a layout bug rather than a tight fit. 12% is low enough to
            // absorb a genuinely long headline and high enough that whatever is
            // in the row is still legible as a band.
            minHeight: metrics.height * 0.12,
          }
        : { flexShrink: 0, flexGrow: 0 };

  const totalWeight = row.cells.reduce((sum, cell) => sum + cell.weight, 0);

  /*
   * The cap masks the band rather than replacing it, so the row paints its fill
   * exactly as it always did and the curve is drawn over the top of it.
   */
  const bandColor = fillColor(row.fill, theme);
  const curved = row.edge === 'curveTop' && bandColor !== undefined;
  // The colour the band is meeting. The canvas ground, not the row above's own
  // fill: a curve between two filled bands is not a shape this expresses, and
  // guessing at the neighbour would be wrong more often than it was right.
  const pageColor = canvasIsDark ? theme.darkNeutral : theme.lightNeutral;
  const capHeight = metrics.s(70);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        width: metrics.width,
        alignItems: 'stretch',
        overflow: 'hidden',
        // The curve is absolutely positioned against this box.
        position: 'relative',
        ...sizing,
        ...(bandColor ? { backgroundColor: bandColor } : {}),
      }}
    >
      {row.cells.map((cell, index) => (
        <Cell
          key={index}
          cell={cell}
          width={(metrics.width * cell.weight) / totalWeight}
          rowFill={row.fill}
          rowIsHug={row.sizingMode === 'hug'}
          props={props}
          canvasIsDark={canvasIsDark}
          photoIndexAt={photoIndexAt}
        />
      ))}

      {/*
        * Last, so it paints over the cells and not just the row.
        *
        * A cell carries its own `fill`, and a band's cells are routinely filled
        * the same colour as the band — so a cap drawn before them was painted
        * straight over by the first cell that had a background, and the edge came
        * out perfectly straight with no sign anything had been attempted. It is a
        * mask, and a mask belongs on top.
        */}
      {curved && (
        <BandCurveCap pageColor={pageColor} width={metrics.width} height={capHeight} />
      )}
    </div>
  );
}

function Cell({
  cell,
  width,
  rowFill,
  rowIsHug,
  props,
  canvasIsDark,
  photoIndexAt,
}: {
  cell: LayoutCell;
  width: number;
  rowFill: LayoutFill;
  rowIsHug: boolean;
  props: LayoutRenderProps;
  canvasIsDark: boolean;
  photoIndexAt: () => number;
}) {
  const { metrics, theme } = props;

  // A cell's own fill wins; `inherit` falls through to the row's, and only then
  // to the canvas. This is what lets one dark band hold a light callout panel
  // without the spec having to restate the band's colour on every sibling.
  const effectiveFill = cell.fill === 'inherit' ? rowFill : cell.fill;
  const ground = groundForLayoutFill(effectiveFill, theme, canvasIsDark);

  /*
   * An overlay cell: a photograph behind, copy in front.
   *
   * The photo stops being a stacked sibling and becomes the cell's background,
   * which is why it is pulled out of the slot list rather than rendered in it.
   * Everything else in the cell draws normally on top.
   */
  /*
   * A cut-out subject is never an overlay, whatever else shares its cell.
   *
   * An overlay darkens a photographic region so copy can be read on top of it.
   * A `subject` photo has no region to darken — it is a figure on transparent
   * ground — so the treatment would wash the cell's own fill and leave the
   * person floating in a grey box. Copy sharing a cell with a subject stacks
   * above it instead, which is what a banner with a headline over a cut-out
   * figure actually looks like.
   */
  const isOverlay =
    cell.photoKind === 'scene' &&
    cell.slots.includes('photo') &&
    cell.slots.some((slot) => !SELF_BLEEDING.has(slot));
  const drawnSlots = isOverlay ? cell.slots.filter((slot) => slot !== 'photo') : cell.slots;

  const bleeds = drawnSlots.every((slot) => SELF_BLEEDING.has(slot));

  /*
   * A card is a surface, so it needs room between its edge and its type.
   *
   * An unpadded card would set the service list hard against the panel's own
   * border, which is the one thing that makes a panel look like an accident.
   * The inset is the canvas margin again rather than a new constant — the same
   * rhythm every other inset on the poster uses.
   */
  const isCard = cell.surface === 'card';
  /*
   * A card in `inherit` has no fill of its own, so it takes the neutral of the
   * family it is sitting in — light on a light page, dark on a dark one — and
   * lets the hairline do the separating. That is what the references do: the
   * HealthFirst service panel is a near-white block on a near-white field, read
   * as a panel entirely by its radius and its edge. Flipping to the opposite
   * neutral would turn a quiet panel into a slab and change the poster's
   * balance, which is not what "draw this as a card" asked for.
   */
  const cardColor =
    (cell.fill !== 'inherit' ? fillColor(cell.fill, theme) : undefined) ??
    (ground.isDark ? theme.darkNeutral : theme.lightNeutral);
  const padding = isCard ? metrics.margin : cell.padded && !bleeds ? metrics.margin : 0;
  const contentWidth = Math.max(1, width - padding * 2);

  /*
   * Copy over a photograph is copy over an unknown image, so a scrim goes under
   * it. The archetypes solved this with three-stop gradients that kept one side
   * of the frame clean; a spec says the same thing by splitting the row, so a
   * flat wash is all that is needed here.
   *
   * **Which way the wash goes follows the band, not the photograph.** Forcing
   * every overlay dark inverted the templates this exists to reproduce: a white
   * clinic poster with teal type came back as a dark band with white type, which
   * is a different poster wearing the same grid. A light band gets a light wash
   * and keeps its dark type; a dark or accent band keeps the dark treatment.
   *
   * 0.55 is enough for body copy to clear 4.5:1 against a mid-tone photograph in
   * either direction. It is a starting point measured against the placeholder,
   * not a guarantee for every image.
   */
  const overlayIsDark = effectiveFill === 'inherit' ? canvasIsDark : effectiveFill !== 'light';
  const overlayGround = isOverlay ? groundFor(theme, overlayIsDark) : ground;
  const overlayPhoto = isOverlay ? photoIndexAt() : -1;

  const drawn = drawnSlots.map((slot, index) => {
    const previous = index > 0 ? drawnSlots[index - 1] : null;
    const gap = previous ? metrics.s(slotGap(previous, slot)) : 0;

    return (
      <div
        key={index}
        style={{
          display: 'flex',
          // Photo and contact fill their cell; copy slots hang from the cell's
          // own alignment edge.
          ...(SELF_BLEEDING.has(slot)
            ? { width: '100%', flexGrow: slot === 'photo' ? 1 : 0 }
            : {}),
          ...(gap > 0 ? { marginTop: gap } : {}),
        }}
      >
        <Slot
          slot={slot}
          props={props}
          ground={overlayGround}
          align={cell.align}
          width={contentWidth}
          effectiveFill={effectiveFill}
          photoKind={cell.photoKind}
          photoIndexAt={photoIndexAt}
        />
      </div>
    );
  });

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        width,
        /*
         * An overlay cell carries no padding of its own — its inner wrapper does.
         *
         * The background layers are positioned against the padding box and sized
         * in percentages of the content box, so padding here would inset the
         * photograph by the margin on every side: a black band down the right and
         * along the bottom, which is exactly what the first version drew.
         */
        padding: isOverlay ? 0 : padding,
        overflow: 'hidden',
        alignItems: isOverlay ? 'stretch' : FLEX[cell.align],
        /*
         * A hug row is exactly as tall as its content, so there is nothing to
         * distribute. A flex or fixed row has slack, and where that slack goes
         * is now the spec's decision rather than always "the middle".
         *
         * Centring unconditionally is what left a third of the HealthFirst
         * rebuild blank above its headline: the reference starts its copy near
         * the top of the band and the renderer had no way to be told so.
         * `valign` defaults to `center`, so every stored spec draws as before.
         */
        justifyContent: rowIsHug ? 'flex-start' : FLEX[cell.valign],
        ...(cell.fill !== 'inherit' && fillColor(cell.fill, theme) && !isCard
          ? { backgroundColor: fillColor(cell.fill, theme) }
          : {}),
      }}
    >
      {/* Behind everything, including the photograph it exists to support. */}
      {cell.backdrop === 'blob' && <SubjectBackdrop color={theme.accent} width={width} />}

      {isCard && <CardSurface color={cardColor} borderColor={ground.hairline} radius={metrics.s(28)} />}

      {isOverlay && (
        <OverlayBackground props={props} photoIndex={overlayPhoto} dark={overlayIsDark} />
      )}

      {/*
        * The padded wrapper exists only for an overlay cell, and deliberately.
        *
        * A photo slot fills its cell with `flexGrow: 1`, which needs the cell
        * itself as its flex parent. Wrapping every cell put that growth inside a
        * box with no height of its own, and every full-bleed photograph in the
        * library silently disappeared. Non-overlay cells therefore keep the exact
        * structure they had.
        */}
      {isOverlay ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            position: 'relative',
            width: '100%',
            padding,
            alignItems: FLEX[cell.align],
            justifyContent: rowIsHug ? 'flex-start' : 'center',
          }}
        >
          {drawn}
        </div>
      ) : (
        drawn
      )}
    </div>
  );
}

/**
 * The photograph and scrim behind an overlay cell's copy.
 *
 * Two absolutely-positioned layers at 100% of the cell rather than one image
 * with a filter: satori has no `filter`, and a wrapper sized in percentages is
 * the only thing that fills a cell whose height is settled by flex layout rather
 * than known here. Verified against satori 0.10.14 before this was built on.
 *
 * Returns null rather than a grey box when no frame arrived — the copy stays
 * legible on the cell's own fill, which is a far better failure than a hole.
 */
function OverlayBackground({
  props,
  photoIndex,
  dark,
}: {
  props: LayoutRenderProps;
  photoIndex: number;
  /** Wash toward the dark neutral, rather than the light one. */
  dark: boolean;
}) {
  const { photos, theme } = props;
  const photo = photos[photoIndex] ?? photos[photos.length - 1];
  if (!photo) return null;

  /*
   * One rooted element, not a fragment. Satori walks the element tree itself and
   * does not flatten `<>…</>` — an earlier version returned the photo and the
   * scrim as fragment siblings and only the scrim was drawn, giving a flat dark
   * band where the photograph should have been. Both layers now hang off a single
   * absolutely-positioned container.
   */
  return (
    <div
      style={{
        display: 'flex',
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={photo.dataUri}
        alt=""
        width="100%"
        height="100%"
        style={{ objectFit: 'cover' }}
      />
      <div
        style={{
          display: 'flex',
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          backgroundColor: withAlpha(dark ? theme.darkNeutral : theme.lightNeutral, 0.55),
        }}
      />
    </div>
  );
}

function Slot({
  slot,
  props,
  ground,
  align,
  width,
  effectiveFill,
  photoKind,
  photoIndexAt,
}: {
  slot: LayoutSlot;
  props: LayoutRenderProps;
  ground: Ground;
  align: LayoutAlign;
  width: number;
  effectiveFill: LayoutFill;
  photoKind: LayoutPhotoKind;
  photoIndexAt: () => number;
}) {
  const { spec, copy, theme, identity, metrics, photos, logoDimensions, logoInkLuminance } =
    props;
  const copyAlign = ALIGN[align];

  switch (slot) {
    case 'spacer':
      // Occupies its column and draws nothing. The reason this slot exists is
      // that a vision model shown a headline with plain ground beside it will
      // otherwise fill the gap with an invented photo.
      return <div style={{ display: 'flex', width }} />;

    case 'logo':
      return (
        <LogoLock
          metrics={metrics}
          theme={theme}
          ground={ground}
          align={copyAlign}
          identity={identity}
          logoDimensions={logoDimensions}
          logoInkLuminance={logoInkLuminance}
          availableWidth={width}
        />
      );

    case 'eyebrow':
      return copy.eyebrow ? (
        <Eyebrow
          metrics={metrics}
          theme={theme}
          ground={ground}
          align={copyAlign}
          text={copy.eyebrow}
        />
      ) : null;

    case 'headline':
      return (
        <Headline
          metrics={metrics}
          theme={theme}
          ground={ground}
          align={copyAlign}
          lines={copy.headlineLines}
          accentLineIndex={copy.accentLineIndex}
          emphasis={spec.headlineEmphasis}
          textCase={spec.headlineCase}
          trailingPeriod={copy.headlinePeriod}
          availableWidth={width}
        />
      );

    case 'cta':
      return (
        <CtaButton
          metrics={metrics}
          theme={theme}
          ground={ground}
          align={copyAlign}
          label={copy.ctaLabel}
          shape={spec.ctaShape}
          availableWidth={width}
        />
      );

    case 'accentRule':
      return <AccentRule metrics={metrics} theme={theme} ground={ground} align={copyAlign} />;

    case 'body':
      return (
        <BodyCopy
          metrics={metrics}
          theme={theme}
          ground={ground}
          align={copyAlign}
          text={copy.body}
          maxWidth={Math.min(metrics.body.maxWidth, width)}
        />
      );

    case 'features':
      /*
       * Two arrangements of the same content, chosen by the shape of the space
       * rather than by the spec. A spec says "features go here"; whether that
       * reads as a horizontal strip or a vertical list is a consequence of the
       * column being wide or narrow, and making an operator specify it would be
       * asking them to re-derive something the geometry already determines.
       *
       * The threshold is the point past which three columns each hold fewer
       * than about fourteen characters per line, which is where the strip stops
       * being readable and starts being a stack of hyphens.
       */
      {
        /*
         * Trimmed to what the template has room for, and never padded out. The
         * copy stage is asked for exactly `featureCount` items, but a day whose
         * copy was written before the template was chosen — or under a different
         * template — can arrive with more, and four cards in a three-card strip
         * is the mismatch this whole field exists to stop. Fewer than asked for
         * is left alone: inventing a filler item is worse than a shorter row.
         */
        const items = copy.features.slice(0, spec.featureCount);
        const showBody = spec.featureStyle === 'labelAndBody';

        return width > metrics.s(560) ? (
          <FeatureStrip
            metrics={metrics}
            theme={theme}
            ground={ground}
            align={copyAlign}
            features={items}
            width={width}
            showBody={showBody}
          />
        ) : (
          <FeatureList
            metrics={metrics}
            theme={theme}
            ground={ground}
            align={copyAlign}
            features={items}
            width={width}
            showBody={showBody}
          />
        );
      }

    case 'contact':
      return (
        <ContactBar
          metrics={metrics}
          theme={theme}
          identity={identity}
          copy={copy}
          width={width}
          align={copyAlign}
          /*
           * The bar must never match the surface it sits on — per §2 it is the
           * poster's hard bottom edge. Where the spec has already painted the
           * row accent or dark, the bar renders transparent over it and only
           * resolves its text colours; on a light or unpainted row it paints
           * itself accent, which is the reference behaviour.
           */
          variant={effectiveFill === 'dark' ? 'dark' : 'accent'}
          transparent={effectiveFill === 'dark' || effectiveFill === 'accent'}
        />
      );

    case 'photo': {
      const index = photoIndexAt();
      // Reuse the last frame rather than render a hole — see `photos` above.
      const photo = photos[index] ?? photos[photos.length - 1];
      if (!photo) return null;

      /*
       * Two ways a photograph occupies a cell, and they are not variations on
       * each other.
       *
       * `scene` covers: the frame is a photographic region and any part of it
       * that does not fit the cell is cropped away. Centre-cropping a landscape
       * is how that composition gives.
       *
       * `subject` contains: the frame is a figure on transparent ground standing
       * on the cell's own fill, and cropping it would cut the person's head off
       * to fill a box that was never meant to be filled.
       *
       * **A contained frame is centred, and cannot be moved.** satori 0.10.14
       * ignores `object-position` outright, and its `background-size: contain`
       * does not contain — both were measured rather than assumed. Anchoring a
       * figure to the bottom edge therefore needs the image given explicit pixel
       * dimensions, which needs the cell's height, which is settled by flex
       * layout after this function has returned.
       *
       * So the slack is removed rather than pushed downward:
       * `resolveSpecPhotoRequests` estimates a subject cell's own proportions and
       * asks fal for a frame that shape, which leaves a contained fit with almost
       * nothing to centre. Trying instead to crop the difference away would put
       * the head outside the poster, which is the one failure worse than a figure
       * sitting a few pixels high.
       */
      const isSubject = photoKind === 'subject';

      return (
        <div
          style={{
            display: 'flex',
            width: '100%',
            height: '100%',
            overflow: 'hidden',
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={photo.dataUri}
            alt=""
            width="100%"
            height="100%"
            style={{ objectFit: isSubject ? 'contain' : 'cover' }}
          />
        </div>
      );
    }
  }
}

/**
 * Longest headline line this spec can set without the type shrinking.
 *
 * Exported for the console's spec editor, which warns an operator when a
 * template's headline column is so narrow that `fitHeadline` has to shrink the
 * headline toward its 55% floor — a poster that renders correctly and still
 * looks wrong, which is the hardest kind of layout fault to notice in a grid of
 * thumbnails.
 */
export function headlineColumnWidth(
  spec: PosterLayoutSpec,
  metrics: PosterMetrics,
): number {
  for (const row of spec.rows) {
    const totalWeight = row.cells.reduce((sum, cell) => sum + cell.weight, 0);
    for (const cell of row.cells) {
      if (!cell.slots.includes('headline')) continue;
      const width = (metrics.width * cell.weight) / totalWeight;
      return Math.max(1, width - (cell.padded ? metrics.margin * 2 : 0));
    }
  }
  return metrics.copyWidth;
}

/**
 * True when the headline will be shrunk, or wrapped, to fit this spec's column.
 *
 * Wrapping counts as cramped even where the resulting type is large: it means
 * the copy stage's own line breaks were overridden, so what the operator sees is
 * not the headline anyone wrote.
 */
export function headlineIsCramped(
  spec: PosterLayoutSpec,
  metrics: PosterMetrics,
  lines: string[],
): boolean {
  const width = headlineColumnWidth(spec, metrics);
  const fit = fitHeadline(metrics, lines, width);
  return fit.wrap || fit.size < metrics.s(86) * 0.8;
}
