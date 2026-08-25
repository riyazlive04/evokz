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
  type Ground,
} from '@/lib/poster/slots';
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
        <TextRegion key={`text-${index}`} region={region} props={props} />
      ))}
    </div>
  );
}

function TextRegion({
  region,
  props,
}: {
  region: PlateTextRegion;
  props: PlateRenderProps;
}) {
  const { metrics } = props;

  const width = region.w * metrics.width;
  const height = region.h * metrics.height;

  const content = renderSlot(region, props, width, height);
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
): Ground {
  if (useTemplatePalette && region.color) {
    /*
     * `groundForFill` resolves the colours that read *against* a surface, which
     * is not what is wanted here — the sampled hex is the ink, not the ground
     * behind it. So the base is the theme's own light/dark ground, with the
     * text colours overridden to what the reference used.
     */
    const base = groundFor(theme, false);
    return { ...base, text: region.color, accentText: region.color };
  }

  // Plates are overwhelmingly light artwork with dark type; a plate whose type
  // sits on a dark band carries a sampled colour and takes the branch above.
  return groundFor(theme, false);
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
): React.ReactElement | null {
  const { spec, copy, theme, identity, metrics, logoDimensions, logoInkLuminance } = props;
  const ground = groundForRegion(region, theme, props.useTemplatePalette);
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
        />
      );
  }
}

/** Kept for parity with the grid path's export surface; plates draw their own rules. */
export { AccentRule };
