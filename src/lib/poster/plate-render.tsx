import type { PosterMetrics } from '@/lib/poster/metrics';
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
  groundForSurface,
  type Ground,
} from '@/lib/poster/slots';
import { contrastRatio } from '@/lib/poster/color';
import type { ImageDimensions } from '@/lib/poster/image-info';
import {
  PLATE_FLEX,
  type PlateSlot,
  type PlateTextRegion,
  type PosterPlateSpec,
} from '@/lib/types/plate-spec';
import type {
  PosterCopy,
  PosterIdentity,
  PosterPhoto,
  PosterTheme,
} from '@/lib/types/poster';

/**
 * Draws a poster by compositing the template's own artwork, rather than
 * rebuilding an approximation of it from a grid.
 *
 * Three layers, bottom to top:
 *
 *   0. the generated photograph(s), positioned into their regions
 *   1. the clean plate, full-bleed
 *   2. the type, positioned into its regions
 *
 * **Layer 1 is the entire idea.** The plate is the reference with its own words
 * and photography erased and the photo areas made transparent, so the frame
 * beneath shows through exactly where the designer cut it — and every treatment
 * that `renderLayoutSpec` cannot express survives as pixels: the heart-shaped
 * mask, the rounded feature cards, the curved footer edge, the gradient behind
 * the headline. None of it is described anywhere. It is simply drawn.
 *
 * The trade against the grid path is real and worth stating. A spec reflows: its
 * rows hug their content, so a headline one line longer pushes the bands below
 * it down and nothing collides. A plate cannot — its geometry is a photograph of
 * itself. Copy that overruns its box overlaps the artwork, which is why
 * `describePlateCopyShape` tells the copy stage what will fit and why the
 * approval preview matters more here than anywhere else in the system.
 *
 * Every mark is still made by the same components in `slots.tsx` that the grid
 * path uses, so a headline composited onto a plate is measurably the same
 * headline as one drawn into a row. That is what stops the two paths drifting
 * into two different-looking products.
 */

export interface PlateRenderProps {
  spec: PosterPlateSpec;
  copy: PosterCopy;
  theme: PosterTheme;
  identity: PosterIdentity;
  /** The plate artwork itself, as a data URI. */
  plateDataUri: string;
  /** One per photo region, in order. Short arrays reuse the last frame. */
  photos: PosterPhoto[];
  metrics: PosterMetrics;
  logoDimensions: ImageDimensions | null;
  logoInkLuminance: number | null;
  /**
   * Whether the reference's sampled colours win over the client's theme.
   *
   * The one place the multi-tenant rule on `LAYOUT_FILLS` is deliberately
   * reversed, and it is per template rather than global: a plate is finished
   * artwork in its designer's colours, and setting the type on top of it in a
   * different brand's palette is how a composite stops looking composed. A
   * generic plate still wants the client's brand, which is why this is a choice.
   */
  useTemplatePalette: boolean;
  /**
   * The plate's own colour under each text region, in `spec.text` order, as
   * measured by `sampleRegionSurface`. A null entry means the region sits over a
   * photographic hole or the plate could not be read, and the theme's ground
   * applies as it always did.
   *
   * Measured in `renderPoster` rather than here because reading pixels is async
   * and this builds a tree synchronously — and measured per render rather than
   * stored on the spec so that every plate already in Drive gets the benefit
   * without being regenerated.
   */
  surfaces: ReadonlyArray<string | null>;
}

export function renderPlateSpec(props: PlateRenderProps): React.ReactElement {
  const { spec, metrics, plateDataUri, photos } = props;

  return (
    <div
      style={{
        display: 'flex',
        position: 'relative',
        width: metrics.width,
        height: metrics.height,
        overflow: 'hidden',
      }}
    >
      {/*
       * Layer 0 — scene photography, behind everything.
       *
       * Drawn even where a region is partly covered by opaque plate: the plate's
       * alpha decides what survives, and second-guessing it here would mean
       * reimplementing the mask this design exists to avoid describing.
       *
       * **Only the scenes.** A `subject` is a person with their background
       * removed, and a person belongs in front of the artwork rather than behind
       * a hole cut in it — see `SubjectPhotos` below.
       */}
      {spec.photos.map((region, index) => {
        if (region.kind === 'subject') return null;
        const photo = photos[index] ?? photos[photos.length - 1];
        if (!photo) return null;

        return (
          <div
            key={`photo-${index}`}
            style={{
              display: 'flex',
              position: 'absolute',
              left: region.x * metrics.width,
              top: region.y * metrics.height,
              width: region.w * metrics.width,
              height: region.h * metrics.height,
              overflow: 'hidden',
              ...(region.fit === 'contain'
                ? { alignItems: 'flex-end', justifyContent: 'center' }
                : {}),
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photo.dataUri}
              alt=""
              width="100%"
              height="100%"
              style={{ objectFit: region.fit }}
            />
          </div>
        );
      })}

      {/*
       * Layer 1 — the plate.
       *
       * `objectFit: fill`, not cover, and deliberately. Every other image in this
       * system is content being fitted into a region it does not match; the plate
       * *is* the region. `resolvePosterCanvas` has already given the canvas the
       * plate's own aspect, so fill is an identity transform — and if the two
       * ever disagree, stretching is the honest failure. Cropping would silently
       * cut the artwork's edge off and look deliberate.
       */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={plateDataUri}
        alt=""
        width={metrics.width}
        height={metrics.height}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: metrics.width,
          height: metrics.height,
          objectFit: 'fill',
        }}
      />

      {/*
       * Layer 1b — cut-out subjects, in front of the artwork.
       *
       * **The layer that lets a template stop supplying its own model.** A plate
       * keeps whatever the designer put on it, so a template built around a
       * photographed person hands that person to every client who ever draws it.
       * Cutting a hole where they stood does not help: the hole shows the canvas
       * ground, not the artwork's own background, so the figure ends up standing
       * in a rectangle of the wrong colour.
       *
       * The answer is order. Erase the original figure from the plate — the
       * background reconstructs behind them — and composite the generated one
       * *over* the finished artwork, which is where a cut-out belongs and what
       * `photoKind: 'subject'` already means on the grid path.
       *
       * `contain` and bottom-anchored, always: cropping a person to fill a box
       * removes their head, and people stand on the ground rather than floating
       * in the middle of it.
       */}
      {spec.photos.map((region, index) => {
        if (region.kind !== 'subject') return null;
        const photo = photos[index] ?? photos[photos.length - 1];
        if (!photo) return null;

        return (
          <div
            key={`subject-${index}`}
            style={{
              display: 'flex',
              position: 'absolute',
              left: region.x * metrics.width,
              top: region.y * metrics.height,
              width: region.w * metrics.width,
              height: region.h * metrics.height,
              overflow: 'hidden',
              alignItems: 'flex-end',
              justifyContent: 'center',
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photo.dataUri}
              alt=""
              width="100%"
              height="100%"
              style={{ objectFit: 'contain' }}
            />
          </div>
        );
      })}

      {/* Layer 2 — the type. */}
      {spec.text.map((region, index) => (
        <TextRegion
          key={`text-${index}`}
          region={region}
          props={props}
          surface={props.surfaces[index] ?? null}
        />
      ))}
    </div>
  );
}

function TextRegion({
  region,
  props,
  surface,
}: {
  region: PlateTextRegion;
  props: PlateRenderProps;
  surface: string | null;
}) {
  const { metrics } = props;

  const width = region.w * metrics.width;
  const height = region.h * metrics.height;

  const content = renderSlot(region, props, width, height, surface);
  if (!content) return null;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        position: 'absolute',
        left: region.x * metrics.width,
        top: region.y * metrics.height,
        width,
        /*
         * `minHeight`, not `height`.
         *
         * A box measured from the reference describes the reference's copy, and
         * this day's is a different length. A hard height clips the overflow
         * against `overflow: hidden` on the canvas — a poster that renders, looks
         * deliberate, and is missing the bottom of its own headline. The same
         * argument the layout spec's `fixed` rows settled the same way.
         */
        minHeight: height,
        alignItems: PLATE_FLEX[region.align],
        justifyContent: PLATE_FLEX[region.valign],
      }}
    >
      {content}
    </div>
  );
}

/**
 * The ground a plate region's type is drawn against.
 *
 * A plate has no `fill` roles — the artwork already carries its own colour — so
 * there is nothing to resolve a ground from except the sampled colour itself.
 * Under the template palette the region states its colour outright and the
 * ground is built around it; otherwise the theme's ground applies, exactly as on
 * the grid path.
 */
function groundForRegion(
  region: PlateTextRegion,
  theme: PosterTheme,
  useTemplatePalette: boolean,
  /**
   * The plate's own colour under this region, measured by `sampleRegionSurface`.
   * Null where the region sits over a photographic hole, or where the plate could
   * not be read.
   */
  surface: string | null,
): Ground {
  /*
   * The ground is built from what the type is actually going to sit on.
   *
   * This used to be `groundFor(theme, false)` unconditionally — the theme's
   * *light* ground — on the reasoning that plates are overwhelmingly light
   * artwork with dark type. Plenty are not, and the ones that are not delivered
   * dark type on dark artwork: a body paragraph and a phone number that were
   * present, correct, and invisible. The comment even said so, and treated the
   * sampled ink colour as the escape hatch — but the sample only ever reached
   * `text` and `accentText`, so `muted`, `hairline` and `accentFill` stayed
   * light-ground regardless. Body copy reads `muted`. That is the whole bug.
   *
   * With the surface measured there is nothing left to assume.
   */
  const base = surface ? groundForSurface(theme, surface) : groundFor(theme, false);

  if (!useTemplatePalette || !region.color) return base;

  /*
   * The reference's own ink, but only where it can still be seen.
   *
   * A sampled hex is the colour this block was printed in on the *reference*,
   * and the plate is not the reference — the eraser reconstructs what was under
   * the type, and a headline that sat on a pale band can end up over the darker
   * artwork that band was hiding. Trusted outright, that sinks the type into the
   * plate: measured on a live template, feature labels sampled to a mid-teal and
   * were composited onto teal artwork.
   *
   * So the sample has to clear the same bar any other text colour would. Where
   * it does, the composite keeps the designer's palette, which is the entire
   * point of `paletteSource: "template"`. Where it does not, the surface's own
   * contrasting ink wins — a legible poster in the wrong colour beats a
   * beautiful one nobody can read.
   */
  if (surface) {
    const ratio = contrastRatio(region.color, surface);
    const required = minInkContrast(region.slot);

    if (ratio < required) {
      console.warn(
        `[ace:plate] the "${region.slot}" region's sampled colour ${region.color} reads at ` +
          `${ratio.toFixed(2)}:1 on the plate's ${surface} behind it, under the ` +
          `${required}:1 that slot needs; using ${base.text} instead so the block stays legible.`,
      );
      return base;
    }
  }

  return { ...base, text: region.color, accentText: region.color };
}

/**
 * Contrast a sampled ink colour must reach against the plate behind it.
 *
 * WCAG AA, with its own large-text allowance rather than one bar for everything.
 * That distinction is load-bearing here rather than pedantic: a poster headline
 * is display type several times the large-text threshold, and holding it to the
 * body-copy ratio refuses pairings that are not merely acceptable but *deliberate*
 * — a deep amber headline on teal reads at 3.9:1 and is exactly the sort of thing
 * a designer chooses. Refusing it would repaint the template's own artwork in
 * white and lose the palette this whole path exists to preserve.
 *
 * It costs nothing in safety. The failure being guarded against is not a tight
 * pairing but a collapsed one — a sample that has gone wrong lands a point or two
 * off its background, far below either threshold.
 */
function minInkContrast(slot: PlateSlot): number {
  // Display type: the headline, and the imperative set inside the button. Both
  // are far above 18pt at every canvas the renderer will accept.
  return slot === 'headline' || slot === 'cta' ? 3 : 4.5;
}

function renderSlot(
  region: PlateTextRegion,
  props: PlateRenderProps,
  width: number,
  /**
   * The region's own height. Passed on to any slot that can grow downward,
   * because on a plate there is nowhere for it to grow into — the artwork below
   * is fixed and overflow lands on top of it.
   */
  height: number,
  surface: string | null,
): React.ReactElement | null {
  const { spec, copy, theme, identity, metrics, logoDimensions, logoInkLuminance } = props;
  const ground = groundForRegion(region, theme, props.useTemplatePalette, surface);
  const align = region.align;

  const slot: PlateSlot = region.slot;

  switch (slot) {
    case 'logo':
      return (
        <LogoLock
          metrics={metrics}
          theme={theme}
          ground={ground}
          align={align}
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
          align={align}
          text={copy.eyebrow}
        />
      ) : null;

    case 'headline':
      return (
        <Headline
          metrics={metrics}
          theme={theme}
          ground={ground}
          align={align}
          lines={copy.headlineLines}
          accentLineIndex={copy.accentLineIndex}
          emphasis={spec.headlineEmphasis}
          textCase={spec.headlineCase}
          trailingPeriod={copy.headlinePeriod}
          availableWidth={width}
          availableHeight={height}
        />
      );

    case 'body':
      return (
        <BodyCopy
          metrics={metrics}
          theme={theme}
          ground={ground}
          align={align}
          text={copy.body}
          maxWidth={width}
        />
      );

    case 'features': {
      const items = copy.features.slice(0, spec.featureCount);
      const showBody = spec.featureStyle === 'labelAndBody';

      // Same threshold as the grid path, so a feature block reads identically
      // whichever renderer drew it.
      return width > metrics.s(560) ? (
        <FeatureStrip
          metrics={metrics}
          theme={theme}
          ground={ground}
          align={align}
          features={items}
          width={width}
          showBody={showBody}
        />
      ) : (
        <FeatureList
          metrics={metrics}
          theme={theme}
          ground={ground}
          align={align}
          features={items}
          width={width}
          showBody={showBody}
        />
      );
    }

    case 'cta':
      return (
        <CtaButton
          metrics={metrics}
          theme={theme}
          ground={ground}
          align={align}
          label={copy.ctaLabel}
          shape={spec.ctaShape}
          availableWidth={width}
        />
      );

    case 'contact':
      /*
       * Transparent, always.
       *
       * On the grid path the bar paints its own accent field because it is the
       * poster's hard bottom edge and nothing else draws one. On a plate that
       * field is already printed — the curved teal footer *is* the bar's
       * background — and painting a flat rectangle over it would cover the
       * artwork this whole path exists to preserve.
       */
      return (
        <ContactBar
          metrics={metrics}
          theme={theme}
          identity={identity}
          copy={copy}
          width={width}
          align={align}
          variant="accent"
          transparent
          ground={ground}
        />
      );
  }
}

/** Kept for parity with the grid path's export surface; plates draw their own rules. */
export { AccentRule };
