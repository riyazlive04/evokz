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

  const tiny = posterPlateSpecSchema.parse({
    version: 1,
    name: 'x',
    text: [{ x: 0, y: 0, w: 0.02, h: 0.001, slot: 'headline', align: 'start', valign: 'start', color: null }],
  });
  check(
    'a region too small to set type in is reported',
    validatePlateSpec(normalizePlateSpec(tiny)).some((p) => p.message.includes('decimal')),
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
      { x: 0.05, y: 0.4, w: 0.9, h: 0.2, slot: 'headline', align: 'center', valign: 'center', color: '#FF00FF' },
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
    let magenta = 0;
    for (let i = 0; i < data.length; i += 3) {
      if (data[i]! > 200 && data[i + 1]! < 60 && data[i + 2]! > 200) magenta += 1;
    }
    check('the sampled colour is used when the template palette wins', magenta > 200, `${magenta} px`);
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
