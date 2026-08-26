/**
 * Regression suite for the clean-plate compositing path.
 *
 * The plate model rests on one claim: the generated photograph is drawn behind
 * the artwork and shows through exactly where the operator made it transparent.
 * Everything else — the heart mask surviving, the curved footer surviving, the
 * card chrome surviving — is a consequence of that and nothing else. So this
 * asserts it directly, on pixels, rather than trusting that satori composited
 * the layers in the order the tree implies.
 *
 * Synthetic plates rather than a real template: a fixture that is a flat teal
 * field with one transparent circle in it makes "the photo is visible here and
 * not there" a two-pixel test, where a real poster would make it a judgement.
 *
 * No network, no database, no fal.ai. There is no test framework in this
 * repository, so this follows the `check-poster-layouts.ts` pattern — a
 * standalone script with a non-zero exit code.
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.json scripts/check-plate-render.ts
 */
import sharp from 'sharp';

import { sampleRegionInk } from '@/lib/poster/plate-ink';
import { findPlateHoles } from '@/lib/poster/plate-regions';
import { renderPoster } from '@/lib/poster/render';
import { EMPTY_BRAND_GUIDELINE } from '@/lib/types/brand';
import { normalizeLayoutSpec, posterLayoutSpecSchema } from '@/lib/types/layout-spec';
import {
  normalizePlateSpec,
  parsePlateSpec,
  posterPlateSpecSchema,
  validatePlateSpec,
} from '@/lib/types/plate-spec';
import type { PosterCopy } from '@/lib/types/poster';

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const PLATE_RGB = { r: 0, g: 128, b: 128 }; // teal artwork
const PHOTO_RGB = { r: 220, g: 20, b: 60 }; // crimson "photograph"

/** A teal plate with a transparent rectangle punched out of its middle third. */
async function makePlate(size: number, hole: { x: number; y: number; w: number; h: number }) {
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const inHole =
        x >= hole.x * size &&
        x < (hole.x + hole.w) * size &&
        y >= hole.y * size &&
        y < (hole.y + hole.h) * size;
      px[i] = PLATE_RGB.r;
      px[i + 1] = PLATE_RGB.g;
      px[i + 2] = PLATE_RGB.b;
      px[i + 3] = inHole ? 0 : 255;
    }
  }
  return sharp(px, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
}

const flatPhoto = (size: number) =>
  sharp({
    create: { width: size, height: size, channels: 3, background: PHOTO_RGB },
  })
    .png()
    .toBuffer();

const COPY: PosterCopy = {
  headlineLines: ['GOOD HEALTH', 'HAPPIER LIFE'],
  accentLineIndex: 1,
  eyebrow: '',
  body: 'A short line of body copy.',
  features: [
    { icon: 'shieldCheck', label: 'MEDICAL', body: 'On site.' },
    { icon: 'chart', label: 'LABS', body: 'Same day.' },
  ],
  callLabel: 'CALL US TODAY',
  websiteLabel: 'VISIT OUR WEBSITE',
  ctaLabel: 'BOOK A VISIT',
  headlinePeriod: false,
};

// The grid spec is required even on the plate path — it is what a plate falls
// back to — but it must not be what gets drawn. Deliberately a composition that
// looks nothing like the plate, so a render that used it is unmistakable.
const FALLBACK_GRID = normalizeLayoutSpec(
  posterLayoutSpecSchema.parse({
    version: 1,
    name: 'fallback grid',
    ground: 'dark',
    rows: [
      {
        sizingMode: 'flex',
        heightFraction: 0,
        fill: 'dark',
        cells: [
          { weight: 100, fill: 'dark', align: 'start', padded: true, slots: ['headline'] },
        ],
      },
    ],
  }),
);

const IDENTITY = {
  companyName: 'WELLCARE',
  logoUrl: null,
  logoIncludesName: false,
  brandTagline: null,
  websiteUrl: 'www.example.com',
  displayPhone: '+91 98765 43210',
  whatsappNumber: '919876543210',
};

async function pixelAt(png: Buffer, x: number, y: number) {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return { r: data[i]!, g: data[i + 1]!, b: data[i + 2]! };
}

const near = (
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
  tol = 24,
) => Math.abs(a.r - b.r) <= tol && Math.abs(a.g - b.g) <= tol && Math.abs(a.b - b.b) <= tol;

async function main() {
  console.log('\n=== hole detection ===');

  const hole = { x: 0.3, y: 0.3, w: 0.4, h: 0.4 };
  const plate = await makePlate(600, hole);
  const found = await findPlateHoles(plate);

  check('a transparent region is found', (found?.regions.length ?? 0) === 1, `found ${found?.found}`);

  if (found?.regions[0]) {
    const r = found.regions[0];
    const close = (a: number, b: number) => Math.abs(a - b) < 0.02;
    check(
      'the measured box matches the hole that was drawn',
      close(r.x, hole.x) && close(r.y, hole.y) && close(r.w, hole.w) && close(r.h, hole.h),
      `${r.x.toFixed(2)},${r.y.toFixed(2)} ${r.w.toFixed(2)}x${r.h.toFixed(2)}`,
    );
    check('a measured hole is a scene, cover-fitted', r.kind === 'scene' && r.fit === 'cover');
  }

  // Two separate holes must stay two regions — one bounding box spanning both
  // would stretch a single frame across the artwork between them.
  const twoHolePx = Buffer.alloc(600 * 600 * 4);
  for (let y = 0; y < 600; y += 1) {
    for (let x = 0; x < 600; x += 1) {
      const i = (y * 600 + x) * 4;
      const inA = x > 60 && x < 240 && y > 60 && y < 240;
      const inB = x > 360 && x < 540 && y > 360 && y < 540;
      twoHolePx[i] = PLATE_RGB.r;
      twoHolePx[i + 1] = PLATE_RGB.g;
      twoHolePx[i + 2] = PLATE_RGB.b;
      twoHolePx[i + 3] = inA || inB ? 0 : 255;
    }
  }
  const twoHole = await sharp(twoHolePx, { raw: { width: 600, height: 600, channels: 4 } })
    .png()
    .toBuffer();
  const twoFound = await findPlateHoles(twoHole);
  check('two separate holes stay two regions', twoFound?.regions.length === 2, `got ${twoFound?.regions.length}`);

  const opaque = await sharp({
    create: { width: 400, height: 400, channels: 3, background: PLATE_RGB },
  })
    .png()
    .toBuffer();
  const opaqueFound = await findPlateHoles(opaque);
  check(
    'a fully opaque plate reports no regions rather than throwing',
    opaqueFound !== null && opaqueFound.regions.length === 0,
  );

  console.log('\n=== spec validation ===');

  const good = posterPlateSpecSchema.parse({
    version: 1,
    name: 'wellcare',
    aspect: 1,
    photos: [{ ...hole, kind: 'scene', fit: 'cover' }],
    text: [{ x: 0.1, y: 0.05, w: 0.8, h: 0.15, slot: 'headline', align: 'center', valign: 'center', color: null }],
  });
  check('a well-formed plate spec validates', validatePlateSpec(normalizePlateSpec(good)).length === 0);

  const noHeadline = posterPlateSpecSchema.parse({ version: 1, name: 'x', text: [] });
  check(
    'a plate with no headline region is refused',
    validatePlateSpec(normalizePlateSpec(noHeadline)).some((p) => p.message.includes('headline')),
  );

  const twice = posterPlateSpecSchema.parse({
    version: 1,
    name: 'x',
    text: [
      { x: 0, y: 0, w: 0.5, h: 0.1, slot: 'headline', align: 'start', valign: 'start', color: null },
      { x: 0, y: 0.5, w: 0.5, h: 0.1, slot: 'headline', align: 'start', valign: 'start', color: null },
    ],
  });
  check(
    'a slot positioned twice is deduped by normalisation',
    normalizePlateSpec(twice).text.length === 1,
  );

  /*
   * An undersized region costs its own slot, not the whole template.
   *
   * This used to be reported by `validatePlateSpec`, which refuses the entire
   * spec — so one stray box a labeller had named `contact` dropped an otherwise
   * perfect plate back to the grid path. Measured against the live library, that
   * refused seven of thirteen templates whose only fault was an eyebrow measured
   * accurately at 1.5% of the poster.
   */
  const strayRegion = posterPlateSpecSchema.parse({
    version: 1,
    name: 'x',
    text: [
      { x: 0.1, y: 0.1, w: 0.5, h: 0.1, slot: 'headline', align: 'start', valign: 'start', color: null },
      { x: 0, y: 0.9, w: 0.02, h: 0.001, slot: 'contact', align: 'start', valign: 'start', color: null },
    ],
  });
  const repaired = normalizePlateSpec(strayRegion);
  check(
    'a stray region is dropped, and the rest of the plate survives',
    repaired.text.length === 1 && repaired.text[0]!.slot === 'headline',
    `${repaired.text.length} region(s) kept`,
  );
  check(
    'dropping a stray region leaves the spec valid',
    validatePlateSpec(repaired).length === 0,
  );

  /*
   * The headline is the exception: losing it is not a repair. A plate with
   * nowhere to put the thing it is about cannot be drawn, so the spec is refused
   * on its headline count and the day falls back to the grid.
   */
  const tinyHeadline = posterPlateSpecSchema.parse({
    version: 1,
    name: 'x',
    text: [{ x: 0, y: 0, w: 0.02, h: 0.001, slot: 'headline', align: 'start', valign: 'start', color: null }],
  });
  check(
    'a plate whose headline is too small to set is refused outright',
    validatePlateSpec(normalizePlateSpec(tinyHeadline)).some((p) =>
      p.message.includes('headline'),
    ),
  );

  /*
   * One measured line of small type is a legitimate region, not a misread. An
   * eyebrow is nothing but one line, and at 1.5% of a 1600px poster it is 24px.
   */
  const oneLine = posterPlateSpecSchema.parse({
    version: 1,
    name: 'x',
    text: [
      { x: 0.1, y: 0.1, w: 0.5, h: 0.1, slot: 'headline', align: 'start', valign: 'start', color: null },
      { x: 0.1, y: 0.05, w: 0.45, h: 0.015, slot: 'eyebrow', align: 'start', valign: 'start', color: null },
    ],
  });
  check(
    'a single measured line of type is kept',
    normalizePlateSpec(oneLine).text.length === 2,
  );

  check('unreadable JSON parses to null', parsePlateSpec({ version: 9 }) === null);

  console.log('\n=== compositing (the claim this path rests on) ===');

  const spec = parsePlateSpec({
    version: 1,
    name: 'teal plate',
    aspect: 1,
    photos: [{ ...hole, kind: 'scene', fit: 'cover' }],
    text: [
      { x: 0.08, y: 0.75, w: 0.84, h: 0.18, slot: 'headline', align: 'center', valign: 'center', color: null },
    ],
  });
  if (!spec) {
    check('the fixture plate spec parses', false);
  } else {
    const poster = await renderPoster({
      layoutSpec: FALLBACK_GRID,
      copy: COPY,
      guideline: EMPTY_BRAND_GUIDELINE,
      identity: IDENTITY,
      photos: [await flatPhoto(512)],
      plate: { spec, bytes: plate, mimeType: 'image/png', useTemplatePalette: false },
      width: 600,
      height: 600,
    });

    const centre = await pixelAt(poster.body, 300, 300);
    const corner = await pixelAt(poster.body, 20, 20);
    const justOutside = await pixelAt(poster.body, 300, 140);

    check('the photograph shows through the hole', near(centre, PHOTO_RGB), JSON.stringify(centre));
    check('the plate covers the photograph everywhere else', near(corner, PLATE_RGB), JSON.stringify(corner));
    check(
      'the photograph does not leak past the hole edge',
      near(justOutside, PLATE_RGB),
      JSON.stringify(justOutside),
    );
    check('the plate path drew, not the fallback grid', poster.layoutName === 'fallback grid');
  }

  console.log('\n=== template palette ===');

  const tinted = parsePlateSpec({
    version: 1,
    name: 'tinted',
    aspect: 1,
    photos: [],
    text: [
      /*
       * Amber, not the magenta this fixture used to carry.
       *
       * Magenta reads at 1.52:1 on the teal plate underneath it — a pairing no
       * designer would set and, since the ink guard landed, one the renderer
       * refuses outright. The test was passing because nothing checked. Amber is
       * a colour a template really might use, clears the 3:1 a headline needs at
       * 3.9:1, and is still nowhere near the white fallback, so a pixel count
       * still tells the two apart.
       */
      { x: 0.05, y: 0.4, w: 0.9, h: 0.2, slot: 'headline', align: 'center', valign: 'center', color: '#FFEB3B' },
    ],
  });
  if (tinted) {
    const opaquePlate = await makePlate(600, { x: 0, y: 0, w: 0.001, h: 0.001 });
    const withPalette = await renderPoster({
      layoutSpec: FALLBACK_GRID,
      copy: COPY,
      guideline: EMPTY_BRAND_GUIDELINE,
      identity: IDENTITY,
      photos: [],
      plate: { spec: tinted, bytes: opaquePlate, mimeType: 'image/png', useTemplatePalette: true },
      width: 600,
      height: 600,
    });
    const { data } = await sharp(withPalette.body).raw().toBuffer({ resolveWithObject: true });
    let amber = 0;
    for (let i = 0; i < data.length; i += 3) {
      if (data[i]! > 200 && data[i + 1]! > 180 && data[i + 2]! < 110) amber += 1;
    }
    check('the sampled colour is used when the template palette wins', amber > 200, `${amber} px`);
  }

  /*
   * Ink sampling.
   *
   * The colour in a plate spec's text region is what makes composited type match
   * the type printed on the artwork around it, and it is measured rather than
   * asked of the model — so it has to be measured *right*. Synthetic again: a
   * white field with a crimson bar across a fifth of it is a case where the
   * answer is known exactly, which a real poster never is.
   */
  console.log('\n=== ink sampling ===');

  /** A white square with one horizontal bar of `ink` across its middle. */
  async function makeInked(size: number, ink: { r: number; g: number; b: number }) {
    const px = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const i = (y * size + x) * 4;
        const inBar = y > size * 0.45 && y < size * 0.55;
        px[i] = inBar ? ink.r : 255;
        px[i + 1] = inBar ? ink.g : 255;
        px[i + 2] = inBar ? ink.b : 255;
        px[i + 3] = 255;
      }
    }
    return sharp(px, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
  }

  {
    const inked = await makeInked(400, PHOTO_RGB);

    const sampled = await sampleRegionInk(inked, { x: 0.1, y: 0.3, w: 0.8, h: 0.4 });
    const parsedInk = sampled
      ? {
          r: Number.parseInt(sampled.slice(1, 3), 16),
          g: Number.parseInt(sampled.slice(3, 5), 16),
          b: Number.parseInt(sampled.slice(5, 7), 16),
        }
      : null;

    check(
      'the ink colour is read, not the surface behind it',
      parsedInk !== null && near(parsedInk, PHOTO_RGB, 24),
      sampled ?? 'null',
    );

    // A box an operator dragged slightly off sits on flat artwork, and reporting
    // the artwork's own colour would set the headline in its own background.
    check(
      'a region with no type in it reports no colour',
      (await sampleRegionInk(inked, { x: 0.05, y: 0.05, w: 0.3, h: 0.2 })) === null,
    );

    // Boxes are allowed past the edge — see `boxSchema` — so the crop must
    // clamp rather than throw.
    check(
      'a region running off the edge still samples',
      (await sampleRegionInk(inked, { x: 0.8, y: 0.3, w: 0.5, h: 0.4 })) !== null,
    );
  }

  {
    /*
     * The case that actually failed.
     *
     * A headline box dragged slightly low catches the top of the photograph
     * under it. The pale element covers three times the area of the letterforms,
     * so scoring ink by area alone reports the photograph — and the composited
     * headline comes out pale grey on artwork whose own headline is teal. The
     * fixture is that poster in miniature: a small crimson bar and a large pale
     * blob in one box.
     */
    const size = 400;
    const px = Buffer.alloc(size * size * 4);
    const PALE = { r: 203, g: 213, b: 225 };
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const i = (y * size + x) * 4;
        const inBar = y > size * 0.08 && y < size * 0.18;
        const inBlob = y > size * 0.4;
        const rgb = inBar ? PHOTO_RGB : inBlob ? PALE : { r: 255, g: 255, b: 255 };
        px[i] = rgb.r;
        px[i + 1] = rgb.g;
        px[i + 2] = rgb.b;
        px[i + 3] = 255;
      }
    }
    const mixed = await sharp(px, { raw: { width: size, height: size, channels: 4 } })
      .png()
      .toBuffer();

    const sampled = await sampleRegionInk(mixed, { x: 0, y: 0, w: 1, h: 1 });
    const parsedInk = sampled
      ? {
          r: Number.parseInt(sampled.slice(1, 3), 16),
          g: Number.parseInt(sampled.slice(3, 5), 16),
          b: Number.parseInt(sampled.slice(5, 7), 16),
        }
      : null;

    check(
      'the type wins over a larger, lower-contrast neighbour',
      parsedInk !== null && near(parsedInk, PHOTO_RGB, 24),
      sampled ?? 'null',
    );
  }

  /*
   * A headline longer than its region used to wrap and grow downward over
   * whatever the artwork had below it — on a live plate a five-word headline in
   * a narrow box became five lines and buried the eyebrow and the feature list.
   * A plate's boxes cannot move, so the type has to fit both ways.
   */
  console.log('\n=== a plate headline fits its box ===');
  {
    const { fitHeadline, resolveMetrics } = await import('@/lib/poster/metrics');
    const m = resolveMetrics(1080, 1920);
    const lines = ['MODERN CARE', 'CLOSE TO HOME'];
    const narrow = 380;
    const boxHeight = 150;

    const unbounded = fitHeadline(m, lines, narrow);
    const bounded = fitHeadline(m, lines, narrow, boxHeight);

    check(
      'a height ceiling shrinks the type',
      bounded.size < unbounded.size,
      unbounded.size.toFixed(0) + 'px unbounded vs ' + bounded.size.toFixed(0) + 'px in a ' + boxHeight + 'px box',
    );

    // The whole point of the ceiling: what it returns must actually fit.
    const perLine = bounded.size * m.headline.lineHeight;
    check(
      'the fitted block is no taller than the box',
      perLine * lines.length <= boxHeight + 1,
      (perLine * lines.length).toFixed(0) + 'px of type in ' + boxHeight + 'px',
    );

    check(
      'a roomy box is left alone',
      fitHeadline(m, lines, 900, 4000).size === fitHeadline(m, lines, 900).size,
    );
  }

  /*
   * A cut-out subject stands in FRONT of the artwork, not behind a hole in it.
   *
   * A plate keeps whatever the designer put on it, so a template built around a
   * photographed person hands that person to every client. Erasing them and
   * cutting a hole does not help — the hole shows the canvas ground rather than
   * the artwork's own background. The figure has to go over the top.
   */
  console.log('\n=== a subject is composited over the plate ===');
  {
    // Fully opaque plate: nothing can show through it, so anything visible must
    // have been drawn on top.
    const opaque = await makePlate(600, { x: 0, y: 0, w: 0.001, h: 0.001 });

    const subjectSpec = parsePlateSpec({
      version: 1,
      name: 'subject over plate',
      aspect: 1,
      photos: [{ x: 0.25, y: 0.25, w: 0.5, h: 0.5, kind: 'subject', fit: 'contain' }],
      text: [
        { x: 0.05, y: 0.02, w: 0.9, h: 0.12, slot: 'headline', align: 'center', valign: 'start', color: null },
      ],
    });

    const sceneSpec = parsePlateSpec({
      version: 1,
      name: 'scene under plate',
      aspect: 1,
      photos: [{ x: 0.25, y: 0.25, w: 0.5, h: 0.5, kind: 'scene', fit: 'cover' }],
      text: [
        { x: 0.05, y: 0.02, w: 0.9, h: 0.12, slot: 'headline', align: 'center', valign: 'start', color: null },
      ],
    });

    if (subjectSpec && sceneSpec) {
      const draw = async (spec: NonNullable<typeof subjectSpec>) =>
        renderPoster({
          layoutSpec: FALLBACK_GRID,
          copy: COPY,
          guideline: EMPTY_BRAND_GUIDELINE,
          identity: IDENTITY,
          photos: [await flatPhoto(600)],
          plate: { spec, bytes: opaque, mimeType: 'image/png', useTemplatePalette: false },
          width: 600,
          height: 600,
        });

      const withSubject = await draw(subjectSpec);
      const withScene = await draw(sceneSpec);

      const middleOfSubject = await pixelAt(withSubject.body, 300, 300);
      const middleOfScene = await pixelAt(withScene.body, 300, 300);

      check(
        'a subject shows through an opaque plate, because it is drawn over it',
        near(middleOfSubject, PHOTO_RGB),
        JSON.stringify(middleOfSubject),
      );
      check(
        'a scene stays hidden behind the same opaque plate',
        near(middleOfScene, PLATE_RGB),
        JSON.stringify(middleOfScene),
      );
    }
  }


  /*
   * Type is coloured for the artwork it lands on, not for a surface the plate
   * path never paints.
   *
   * The regression these guard is not hypothetical: two delivered posters lost
   * their whole footer to it. `ContactBar` was asked for `variant="accent"` and
   * `transparent` together — colours derived from the gold accent field, and
   * that field then not drawn — so a near-black phone number was set on navy
   * artwork. `BodyCopy` reads `ground.muted`, which `groundForRegion` never
   * overrode, so the body paragraph was theme-dark on every plate whatever was
   * behind it.
   *
   * Both are asserted on pixels rather than on the resolved colours, because
   * the colours were always defensible in isolation. It is the pairing with the
   * plate that was wrong, and only the composite shows that.
   */
  console.log('\n=== type reads against the plate it is set on ===');
  {
    // A fully opaque, very dark plate. Anything drawn in the theme's light-ground
    // ink lands within a few points of it and vanishes.
    const DARK = { r: 12, g: 30, b: 62 }; // navy, as in the delivered poster
    const darkPlate = await sharp({
      create: { width: 600, height: 600, channels: 4, background: { ...DARK, alpha: 1 } },
    })
      .png()
      .toBuffer();

    const spec = parsePlateSpec({
      version: 1,
      name: 'dark plate',
      aspect: 1,
      photos: [],
      text: [
        { x: 0.05, y: 0.04, w: 0.9, h: 0.2, slot: 'headline', align: 'start', valign: 'start', color: null },
        { x: 0.05, y: 0.34, w: 0.9, h: 0.18, slot: 'body', align: 'start', valign: 'start', color: null },
        { x: 0.05, y: 0.72, w: 0.9, h: 0.22, slot: 'contact', align: 'start', valign: 'center', color: null },
      ],
    })!;

    const poster = await renderPoster({
      layoutSpec: FALLBACK_GRID,
      copy: COPY,
      guideline: EMPTY_BRAND_GUIDELINE,
      identity: IDENTITY,
      photos: [],
      plate: { spec, bytes: darkPlate, mimeType: 'image/png', useTemplatePalette: false },
      width: 600,
      height: 600,
    });

    /*
     * Counts pixels in a horizontal band that differ from the plate colour.
     *
     * Type is a small share of any band it sits in, so this asks whether the
     * block made *any* legible mark rather than how much — the failure being
     * guarded is total invisibility, where the answer is zero or close to it.
     */
    const { data, info } = await sharp(poster.body).raw().toBuffer({ resolveWithObject: true });
    const legibleIn = (top: number, bottom: number): number => {
      let seen = 0;
      for (let y = Math.round(top * info.height); y < Math.round(bottom * info.height); y += 1) {
        for (let x = 0; x < info.width; x += 1) {
          const i = (y * info.width + x) * info.channels;
          const px = { r: data[i]!, g: data[i + 1]!, b: data[i + 2]! };
          // Well beyond anti-aliasing: a mark that clears this is readable ink.
          if (!near(px, DARK, 60)) seen += 1;
        }
      }
      return seen;
    };

    check(
      'the body paragraph is visible on a dark plate',
      legibleIn(0.34, 0.52) > 200,
      `${legibleIn(0.34, 0.52)} px of ink`,
    );

    check(
      'the contact bar is visible on a dark plate',
      legibleIn(0.72, 0.94) > 200,
      `${legibleIn(0.72, 0.94)} px of ink`,
    );

    check(
      'the headline is visible on a dark plate',
      legibleIn(0.04, 0.24) > 200,
      `${legibleIn(0.04, 0.24)} px of ink`,
    );
  }

  /*
   * A sampled ink colour is a proposal, not an instruction.
   *
   * `sampleRegionInk` reads the reference; the type is composited onto the
   * plate, and the eraser reconstructs what was under the words. A headline
   * that sat on a pale band can end up over the darker artwork that band was
   * covering, and the sample then names a colour indistinguishable from its new
   * background. Seen live: feature labels sampled to a mid-teal, set on teal.
   */
  console.log('\n=== an unreadable sampled colour is refused ===');
  {
    const TEAL = { r: 0, g: 128, b: 128 };
    const tealPlate = await sharp({
      create: { width: 600, height: 600, channels: 4, background: { ...TEAL, alpha: 1 } },
    })
      .png()
      .toBuffer();

    // A sampled colour a couple of points off the plate — exactly the failure.
    const sunk = parsePlateSpec({
      version: 1,
      name: 'sunken ink',
      aspect: 1,
      photos: [],
      text: [
        { x: 0.05, y: 0.3, w: 0.9, h: 0.3, slot: 'headline', align: 'start', valign: 'start', color: '#0d8583' },
      ],
    })!;

    const poster = await renderPoster({
      layoutSpec: FALLBACK_GRID,
      copy: COPY,
      guideline: EMPTY_BRAND_GUIDELINE,
      identity: IDENTITY,
      photos: [],
      plate: { spec: sunk, bytes: tealPlate, mimeType: 'image/png', useTemplatePalette: true },
      width: 600,
      height: 600,
    });

    const { data, info } = await sharp(poster.body).raw().toBuffer({ resolveWithObject: true });
    let legible = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      const px = { r: data[i]!, g: data[i + 1]!, b: data[i + 2]! };
      if (!near(px, TEAL, 60)) legible += 1;
    }

    check(
      'a headline sampled to its own background is redrawn in a readable ink',
      legible > 200,
      `${legible} px of ink`,
    );
  }

  /*
   * The other half of that trade: a sampled colour that DOES read must survive.
   * Refusing every sample would keep the type legible and throw away the
   * designer's palette, which is the whole reason `paletteSource: "template"`
   * exists.
   */
  console.log('\n=== a readable sampled colour is kept ===');
  {
    const WHITE = { r: 250, g: 250, b: 250 };
    const lightPlate = await sharp({
      create: { width: 600, height: 600, channels: 4, background: { ...WHITE, alpha: 1 } },
    })
      .png()
      .toBuffer();

    const crimson = parsePlateSpec({
      version: 1,
      name: 'kept ink',
      aspect: 1,
      photos: [],
      text: [
        { x: 0.05, y: 0.3, w: 0.9, h: 0.3, slot: 'headline', align: 'start', valign: 'start', color: '#b0122f' },
      ],
    })!;

    const poster = await renderPoster({
      layoutSpec: FALLBACK_GRID,
      copy: COPY,
      guideline: EMPTY_BRAND_GUIDELINE,
      identity: IDENTITY,
      photos: [],
      plate: { spec: crimson, bytes: lightPlate, mimeType: 'image/png', useTemplatePalette: true },
      width: 600,
      height: 600,
    });

    const { data, info } = await sharp(poster.body).raw().toBuffer({ resolveWithObject: true });
    let crimsonPixels = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      if (near({ r: data[i]!, g: data[i + 1]!, b: data[i + 2]! }, { r: 176, g: 18, b: 47 }, 30)) {
        crimsonPixels += 1;
      }
    }

    check(
      "the designer's colour is used where it reads",
      crimsonPixels > 200,
      `${crimsonPixels} px`,
    );
  }


  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll plate checks passed.');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
