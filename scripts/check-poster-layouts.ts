/**
 * Regression suite for the poster layout layer.
 *
 * Three things, in order of how cheap they are to run:
 *
 *   1. Spec validation — the rules that keep a bad layout out of production.
 *   2. Fixture renders — every spec in `scripts/fixtures/`, chosen to span the
 *      interpreter's decision space rather than to imitate any real template.
 *      They load by default, so this suite is meaningful with no arguments and
 *      adding a regression case is a file drop.
 *   3. Failure modes — the throws that must stay catchable, including the canvas
 *      aspect that used to panic resvg in Rust and abort the whole process.
 *
 * No network, no database, no fal.ai: the photography is procedural and the
 * fonts come from the same loader production uses. There is no test framework in
 * this repository, so this follows the `check-logo-key.ts` pattern — a
 * standalone script with a non-zero exit code.
 *
 * Run: npx tsx scripts/check-poster-layouts.ts [spec.json...]
 */
import { readdir, readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { getImageSizePreset } from '@/lib/image-sizes';
import { measuredAspect, resolvePosterCanvas } from '@/lib/poster/canvas';
import { AVERAGE_CAP_ADVANCE, fitHeadline, resolveMetrics } from '@/lib/poster/metrics';
import {
  createPlaceholderPhoto,
  createPlaceholderSubject,
} from '@/lib/poster/placeholder-photo';
import { resolveSpecPhotoRequests } from '@/lib/poster/photo-request';
import { SAMPLE_LAYOUT_SPEC } from '@/lib/poster/sample-layout';
import { renderPoster } from '@/lib/poster/render';
import { EMPTY_BRAND_GUIDELINE } from '@/lib/types/brand';
import {
  countPhotoSlots,
  normalizeLayoutSpec,
  parseLayoutSpec,
  posterLayoutSpecSchema,
  validateLayoutSpec,
  type PosterLayoutSpec,
} from '@/lib/types/layout-spec';
import type { PosterCopy } from '@/lib/types/poster';

let failures = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Realistic length: a short headline hides every fitting fault there is. */
const COPY: PosterCopy = {
  // Long enough to overflow a narrow column, so the fitter's shrink and wrap
  // paths are exercised by the render suite and not only by arithmetic.
  headlineLines: ['THE GRAND', 'OPENING CELEBRATION'],
  accentLineIndex: 1,
  eyebrow: 'NOW OPEN',
  body: "Celebrate our new journey at our restaurant's grand opening with special prices on all of our menu.",
  features: [
    {
      icon: 'star',
      label: 'Discount up to 25% off',
      body: 'Across the entire menu, counter to kitchen.',
    },
    {
      icon: 'stopwatch',
      label: 'Promo duration',
      body: '17 - 20 August 2026, open from 8am daily.',
    },
    {
      icon: 'locationPin',
      label: 'Find us',
      body: '123 Anywhere St., any city — walk in, no booking.',
    },
    // A fourth, so a spec asking for three exercises the clamp rather than
    // silently getting exactly what it wanted.
    {
      icon: 'people',
      label: 'Walk-ins welcome',
      body: 'No booking needed at any hour we are open.',
    },
  ],
  callLabel: 'TASTE IT TODAY',
  websiteLabel: 'FOLLOW OUR SOCIAL MEDIA',
  ctaLabel: 'BOOK A SITE VISIT',
  headlinePeriod: true,
};

/**
 * A logo is part of the fixture rather than an option.
 *
 * `LogoLock`'s image branch is roughly 95 reference px taller than its wordmark
 * fallback, and that difference is what overflowed the `bands` archetype — a
 * poster that rendered, looked deliberate, and lost its contact bar to the
 * canvas clip. A suite that renders without a logo does not exercise the case
 * that actually broke.
 */
const LOGO = new URL('../../sample_logo-removebg-preview.png', import.meta.url);

const IDENTITY_BASE = {
  companyName: 'TEST COMPANY 2',
  brandTagline: 'COOKING SINCE 1980',
  websiteUrl: 'www.example.com',
  displayPhone: '+91 98765 43210',
  whatsappNumber: '919876543210',
};

/** Portrait first, then the off-brand shapes an operator may still pick. */
const PRESETS = [
  'whatsapp-status',
  'instagram-portrait',
  'instagram-square',
  'instagram-landscape',
  // 2.39:1, so it resolves to `letterbox` and compresses every row — the widest
  // shape the renderer will still attempt.
  'desktop-ultrawide',
];

// ---------------------------------------------------------------------------
// 1. Validation
// ---------------------------------------------------------------------------

function row(cells: unknown[], sizingMode = 'hug', fill = 'inherit') {
  return { sizingMode, heightFraction: 0, fill, cells };
}

function cell(slots: string[], overrides: Record<string, unknown> = {}) {
  return { weight: 100, fill: 'inherit', align: 'start', padded: true, slots, ...overrides };
}

function spec(rows: unknown[], name = 'fixture'): unknown {
  return { version: 1, name, ground: 'light', rows };
}

function validationChecks(): void {
  console.log('\n=== spec validation ===');

  const good = posterLayoutSpecSchema.safeParse(
    spec([
      row([cell(['logo', 'headline'])]),
      row([cell(['photo'], { padded: false })], 'flex'),
      row([cell(['contact'])], 'fixed'),
    ]),
  );
  check('a well-formed spec parses', good.success);

  if (good.success) {
    check(
      'no problems reported for a well-formed spec',
      validateLayoutSpec(normalizeLayoutSpec(good.data)).length === 0,
    );
  }

  const noHeadline = posterLayoutSpecSchema.parse(
    spec([row([cell(['logo', 'body'])]), row([cell(['photo'])], 'flex')]),
  );
  check(
    'a spec with no headline is rejected',
    validateLayoutSpec(normalizeLayoutSpec(noHeadline)).some((p) =>
      p.message.includes('headline'),
    ),
  );

  const twoHeadlines = posterLayoutSpecSchema.parse(
    spec([
      row([cell(['headline']), cell(['headline'])]),
      row([cell(['photo'])], 'flex'),
    ]),
  );
  check(
    'a spec with two headlines is rejected',
    validateLayoutSpec(normalizeLayoutSpec(twoHeadlines)).some((p) =>
      p.message.includes('headline'),
    ),
  );

  // Copy over a photograph is now an overlay cell, not an error. The commonest
  // poster shape there is; approximating it as two bands is visibly not the same
  // poster.
  const overlaid = posterLayoutSpecSchema.parse(
    spec([row([cell(['photo', 'headline'])], 'flex')]),
  );
  check(
    'photo and text in one cell is accepted as an overlay',
    validateLayoutSpec(normalizeLayoutSpec(overlaid)).length === 0,
    JSON.stringify(validateLayoutSpec(normalizeLayoutSpec(overlaid))),
  );

  // Two photos behind one block of copy has no meaning — the second is drawn
  // underneath the first and never seen.
  const doubleBacked = posterLayoutSpecSchema.parse(
    spec([row([cell(['photo', 'photo', 'headline'])], 'flex')]),
  );
  check(
    'an overlay backed by two photos is rejected',
    validateLayoutSpec(normalizeLayoutSpec(doubleBacked)).some((p) =>
      p.message.includes('overlay'),
    ),
  );

  // The feature shape a template asks for must survive the round trip.
  const labelOnly = posterLayoutSpecSchema.parse({
    ...(spec([
      row([cell(['headline'])]),
      row([cell(['features'])]),
      row([cell(['photo'])], 'flex'),
    ]) as Record<string, unknown>),
    featureCount: 4,
    featureStyle: 'labelOnly',
  });
  check(
    'featureCount and featureStyle survive parsing',
    labelOnly.featureCount === 4 && labelOnly.featureStyle === 'labelOnly',
  );

  // The defaults are what let every template stored before these fields existed
  // keep rendering exactly as it did.
  const legacy = posterLayoutSpecSchema.parse(
    spec([row([cell(['headline'])]), row([cell(['photo'])], 'flex')]),
  );
  check(
    'a spec without the feature fields defaults to 3 and labelAndBody',
    legacy.featureCount === 3 && legacy.featureStyle === 'labelAndBody',
  );

  /*
   * The whole compatibility claim for the banner work, in one assertion: a spec
   * stored before any of these fields existed must parse to values that make the
   * renderer behave exactly as it did. `aspect: 0` falls the canvas back to the
   * client's preset, and an empty `headlineEmphasis` falls the headline back to
   * `accentLineIndex`. Either one defaulting the other way would silently change
   * every live template's output on deploy.
   */
  check(
    'a spec predating the banner fields defaults to the pre-banner behaviour',
    legacy.aspect === 0 &&
      legacy.headlineEmphasis.length === 0 &&
      legacy.headlineCase === 'upper' &&
      legacy.ctaShape === 'pill',
  );

  check(
    'a cell predating photoKind defaults to scene',
    legacy.rows.every((r) => r.cells.every((c) => c.photoKind === 'scene')),
  );

  const twoCtas = posterLayoutSpecSchema.parse(
    spec([
      row([cell(['headline', 'cta']), cell(['cta'])]),
      row([cell(['photo'])], 'flex'),
    ]),
  );
  check(
    'a spec with two CTA buttons is rejected',
    validateLayoutSpec(normalizeLayoutSpec(twoCtas)).some((p) => p.message.includes('cta')),
  );

  // The reference banner shape: one band, type and a button beside a cut-out
  // figure, no contact bar and no features.
  const banner = posterLayoutSpecSchema.parse({
    version: 1,
    name: 'banner',
    aspect: 1,
    ground: 'light',
    headlineEmphasis: ['plain', 'heavy', 'plain'],
    rows: [
      row(
        [
          cell(['headline', 'cta'], { weight: 55 }),
          cell(['photo'], { weight: 45, padded: false, photoKind: 'subject' }),
        ],
        'flex',
      ),
    ],
  });
  check(
    'a one-row banner with a CTA and a cut-out subject is valid',
    validateLayoutSpec(normalizeLayoutSpec(banner)).length === 0,
    JSON.stringify(validateLayoutSpec(normalizeLayoutSpec(banner))),
  );
  check(
    'a subject cell keeps photoKind through normalisation',
    normalizeLayoutSpec(banner).rows[0]!.cells[1]!.photoKind === 'subject',
  );
  check(
    'a cell holding a CTA is padded by normalisation',
    normalizeLayoutSpec(banner).rows[0]!.cells[0]!.padded === true,
  );

  const threePhotos = posterLayoutSpecSchema.parse(
    spec([
      row([cell(['headline'])]),
      row([cell(['photo']), cell(['photo']), cell(['photo'])], 'flex'),
    ]),
  );
  check(
    'more than two photo slots is rejected',
    validateLayoutSpec(normalizeLayoutSpec(threePhotos)).some((p) =>
      p.message.includes('photo slots'),
    ),
  );

  // The invariant that makes overflow structurally impossible.
  const allHug = posterLayoutSpecSchema.parse(
    spec([row([cell(['headline'])]), row([cell(['photo'], { padded: false })])]),
  );
  const promoted = normalizeLayoutSpec(allHug);
  check(
    'normalisation promotes the photo row to flex when nothing is flexible',
    promoted.rows[1]?.sizingMode === 'flex',
    `got "${promoted.rows[1]?.sizingMode}"`,
  );
  check(
    'a spec with no flex row is otherwise rejected',
    validateLayoutSpec({
      ...allHug,
      rows: allHug.rows.map((r) => ({ ...r, sizingMode: 'hug' as const })),
    }).some((p) => p.message.includes('flexible')),
  );

  const unpadded = normalizeLayoutSpec(
    posterLayoutSpecSchema.parse(
      spec([
        row([cell(['headline'], { padded: false })]),
        row([cell(['photo'], { padded: false })], 'flex'),
      ]),
    ),
  );
  check(
    'normalisation pads a cell holding type',
    unpadded.rows[0]?.cells[0]?.padded === true,
  );
  check(
    'normalisation leaves a photo cell bleeding',
    unpadded.rows[1]?.cells[0]?.padded === false,
  );

  check('a null column parses to null', parseLayoutSpec(null) === null);
  check('junk in the column parses to null', parseLayoutSpec({ nope: 1 }) === null);
  check(
    'a structurally invalid stored spec parses to null',
    parseLayoutSpec(spec([row([cell(['body'])])])) === null,
  );
}

// ---------------------------------------------------------------------------
// 2 & 3. Renders
// ---------------------------------------------------------------------------

function placeholder(
  width: number,
  height: number,
  index: number,
  kind: 'scene' | 'subject' = 'scene',
): Buffer {
  const longest = Math.max(width, height);
  const ratio = longest > 1024 ? 1024 / longest : 1;
  const w = Math.max(1, Math.round(width * ratio));
  const h = Math.max(1, Math.round(height * ratio));

  return kind === 'subject'
    ? createPlaceholderSubject(w, h)
    : createPlaceholderPhoto(w, h, index % 2 === 0 ? 'daylight' : 'dusk');
}

/**
 * Renders every spec at the canvas production would actually give it.
 *
 * The preset sweep above is deliberately hostile — it draws each layout at
 * shapes it was never authored for, which is what caught the letterbox scale
 * that panicked resvg. This is the opposite case and just as worth pinning: the
 * happy path, where `resolvePosterCanvas` has given the spec its own proportions
 * and `resolveMetrics` therefore re-proportions the design to match. A banner
 * only ever renders correctly here, so without this section the two fixtures
 * modelled on the real references would only ever be tested squeezed.
 */
async function resolvedCanvasChecks(
  specs: Array<{ label: string; spec: PosterLayoutSpec }>,
  identity: RenderIdentity,
): Promise<void> {
  console.log('\n=== renders at the canvas the template asks for ===');

  const preset = getImageSizePreset('whatsapp-status')!;

  for (const entry of specs) {
    const canvas = resolvePosterCanvas(entry.spec, preset);
    const requests = resolveSpecPhotoRequests(entry.spec, canvas);
    const photos = requests.map((request, index) =>
      placeholder(request.width, request.height, index, request.kind),
    );

    try {
      const poster = await renderPoster({
        layoutSpec: entry.spec,
        copy: COPY,
        guideline: EMPTY_BRAND_GUIDELINE,
        identity,
        photos,
        width: canvas.width,
        height: canvas.height,
      });
      check(
        `${entry.label} @ ${canvas.width}×${canvas.height} (resolved)`,
        poster.body.byteLength > 0,
      );
    } catch (error) {
      check(
        `${entry.label} @ ${canvas.width}×${canvas.height} (resolved)`,
        false,
        describe(error),
      );
    }
  }
}

/**
 * The template's shape decides the poster's, and the preset only decides how
 * many pixels of it the client gets.
 *
 * Worth its own section because it silently changes the delivered dimensions for
 * every client whose vertical holds a non-9:16 template — the kind of change
 * that is obvious the day it ships and impossible to reconstruct a year later.
 */
function canvasChecks(): void {
  console.log('\n=== canvas resolution ===');

  const status = getImageSizePreset('whatsapp-status')!;
  const landscape = getImageSizePreset('instagram-landscape')!;

  const square = resolvePosterCanvas({ aspect: 1, name: 'square' }, status);
  check(
    'a square template on a 9:16 preset delivers square',
    square.width === 1080 && square.height === 1080,
    `${square.width}×${square.height}`,
  );

  const tall = resolvePosterCanvas({ aspect: 1080 / 1920, name: 'tall' }, status);
  check(
    'a 9:16 template on a 9:16 preset is unchanged',
    tall.width === 1080 && tall.height === 1920,
    `${tall.width}×${tall.height}`,
  );

  // The surprising direction, and the one that has to be deliberate: the preset
  // no longer controls shape at all.
  const tallOnWide = resolvePosterCanvas({ aspect: 1080 / 1920, name: 'tall' }, landscape);
  check(
    'a 9:16 template on a landscape preset still delivers 9:16',
    tallOnWide.width === 1080 && tallOnWide.height === 1920,
    `${tallOnWide.width}×${tallOnWide.height}`,
  );

  const legacy = resolvePosterCanvas({ aspect: 0, name: 'unmeasured' }, landscape);
  check(
    'a spec with no measured aspect falls back to the preset',
    legacy.width === landscape.width && legacy.height === landscape.height,
    `${legacy.width}×${legacy.height}`,
  );

  // Beyond 4:1 `assertRenderableCanvas` throws, so the constructor must never
  // hand it a canvas that trips it.
  const extreme = resolvePosterCanvas({ aspect: 40, name: 'strip' }, status);
  check(
    'an absurd stored aspect is clamped inside the renderable range',
    extreme.width / extreme.height <= 4.001,
    `${extreme.width}×${extreme.height}`,
  );

  check(
    'an unmeasurable template reports no aspect rather than guessing',
    measuredAspect(null, 600) === 0 && measuredAspect(600, 600) === 1,
  );

  /*
   * The reason the canvas work exists. A square canvas used to scale by
   * min(1080/940, 1080/1568) = 0.689 — type set for a 648px poster — and now
   * matches what a 9:16 poster of the same width gets.
   */
  const squareMetrics = resolveMetrics(1080, 1080, 1);
  const tallMetrics = resolveMetrics(1080, 1920, 1080 / 1920);
  check(
    'a square canvas typesets at the same scale as a portrait one of equal width',
    Math.abs(squareMetrics.scale - tallMetrics.scale) < 0.001,
    `square ${squareMetrics.scale.toFixed(3)} vs tall ${tallMetrics.scale.toFixed(3)}`,
  );

  /*
   * And the guard on it. Re-proportioning only applies when the canvas actually
   * has the template's shape: a four-row editorial stack fitted to a letterbox
   * reference overflows far enough to panic resvg in Rust, which aborts the
   * process rather than throwing.
   */
  const mismatched = resolveMetrics(1080, 566, 0);
  check(
    'a canvas that does not match the template keeps the conservative fit',
    mismatched.scale < 0.4,
    `scale ${mismatched.scale.toFixed(3)}`,
  );
}

type RenderIdentity = typeof IDENTITY_BASE & { logoUrl: string };

async function renderChecks(
  specs: Array<{ label: string; spec: PosterLayoutSpec }>,
): Promise<RenderIdentity> {
  const logoBytes = await readFile(LOGO);
  const identity: RenderIdentity = {
    ...IDENTITY_BASE,
    logoUrl: `data:image/png;base64,${logoBytes.toString('base64')}`,
  };

  console.log('\n=== fixture spec renders (regression) ===');

  for (const entry of specs) {
    for (const presetId of PRESETS) {
      const preset = getImageSizePreset(presetId)!;
      const requests = resolveSpecPhotoRequests(entry.spec, preset);
      const photos = requests.map((request, index) =>
        placeholder(request.width, request.height, index, request.kind),
      );

      try {
        const poster = await renderPoster({
          layoutSpec: entry.spec,
          copy: COPY,
          guideline: EMPTY_BRAND_GUIDELINE,
          identity,
          photos,
          width: preset.width,
          height: preset.height,
        });
        check(
          `${entry.label} @ ${preset.width}×${preset.height}`,
          poster.body.byteLength > 0 && poster.layoutName === entry.spec.name,
        );
      } catch (error) {
        check(
          `${entry.label} @ ${preset.width}×${preset.height}`,
          false,
          describe(error),
        );
      }
    }

    // One request per declared slot, or the pipeline buys the wrong number of
    // frames — the expensive kind of mismatch.
    const preset = getImageSizePreset('whatsapp-status')!;
    check(
      `${entry.label} asks for one photo per slot`,
      resolveSpecPhotoRequests(entry.spec, preset).length === countPhotoSlots(entry.spec),
    );
  }

  console.log('\n=== failure modes ===');

  const preset = getImageSizePreset('whatsapp-status')!;
  const withPhoto = specs.find((entry) => countPhotoSlots(entry.spec) > 0);

  // A spec that wants photography and is handed none must say so by name, not
  // die on a generic "no background photo" from deep in the renderer.
  if (withPhoto) {
    try {
      await renderPoster({
        layoutSpec: withPhoto.spec,
        copy: COPY,
        guideline: EMPTY_BRAND_GUIDELINE,
        identity,
        photos: [],
        width: preset.width,
        height: preset.height,
      });
      check('a photo spec with no frames throws', false, 'it rendered');
    } catch (error) {
      check(
        'a photo spec with no frames throws, naming the layout',
        describe(error).includes(withPhoto.spec.name),
        describe(error),
      );
    }
  }

  // The canvas that used to panic resvg in Rust and abort the whole process,
  // taking a cron sweep with it. It must be a catchable JS throw.
  try {
    await renderPoster({
      layoutSpec: SAMPLE_LAYOUT_SPEC,
      copy: COPY,
      guideline: EMPTY_BRAND_GUIDELINE,
      identity,
      photos: [placeholder(1024, 256, 0)],
      width: 2400,
      height: 400,
    });
    check('a beyond-4:1 canvas is refused', false, 'it rendered');
  } catch (error) {
    check(
      'a beyond-4:1 canvas is refused before resvg sees it',
      describe(error).includes('the poster layer can compose'),
      describe(error),
    );
  }

  return identity;
}

// ---------------------------------------------------------------------------
// Headline fitting
// ---------------------------------------------------------------------------

/**
 * The headline must never be predicted to overflow its column.
 *
 * A property check rather than a fixture, because the fault this replaces was
 * invisible to fixtures: `narrow-copy-column` had been clipping the "G" off
 * "OPENING" since it was written, and nobody saw it in a grid of thumbnails.
 * Fixtures only prove the shapes someone thought of. Sweeping the whole input
 * space proves the guarantee for every spec that can ever be extracted — which
 * is the only claim worth making about a renderer that runs unattended.
 *
 * Asserted against the same `AVERAGE_CAP_ADVANCE` estimate the fitter uses, so
 * this proves internal consistency, not typographic truth. Satori does the real
 * shaping; `SAFETY` is the margin between the two.
 */
function headlineFitChecks(): void {
  console.log('\n=== headline fitting ===');

  // Column shares from a full-width band down to a quarter-width one, against
  // headlines from a single short word to a line no copy stage should emit.
  const SHARES = [1, 0.6, 0.5, 0.45, 0.4, 0.35, 0.3, 0.25];
  const LINE_SETS: string[][] = [
    ['GRAND', 'OPENING', 'PROMO'],
    ['MEDICAL SUPPLIES', 'YOU CAN TRUST'],
    ['EXPERT CARE', 'FOR A', 'HEALTHIER YOU'],
    ['COMPREHENSIVE', 'MULTISPECIALITY', 'CONSULTATION'],
    // One unbreakable word longer than any column here: wrapping cannot help,
    // so only fitting to the word itself keeps it whole.
    ['OTORHINOLARYNGOLOGY'],
    ['A'],
  ];

  let worst = { overflow: 0, detail: '' };
  let wrapped = 0;
  let total = 0;

  for (const presetId of PRESETS) {
    const preset = getImageSizePreset(presetId)!;
    const metrics = resolveMetrics(preset.width, preset.height);

    for (const share of SHARES) {
      // What `Cell` hands the slot: the column less its padding on both sides.
      const room = Math.max(1, preset.width * share - metrics.margin * 2);

      for (const lines of LINE_SETS) {
        total += 1;
        const fit = fitHeadline(metrics, lines, room);
        if (fit.wrap) wrapped += 1;

        // Wrapping breaks lines at spaces, so the widest thing that must fit is
        // the longest word; without it, the longest line.
        const units = fit.wrap
          ? lines.flatMap((line) => line.split(/\s+/))
          : lines;
        const longest = units.reduce((max, unit) => Math.max(max, unit.length), 0);
        const predicted = longest * fit.size * AVERAGE_CAP_ADVANCE;

        if (predicted - room > worst.overflow) {
          worst = {
            overflow: predicted - room,
            detail:
              `${presetId} @ ${Math.round(share * 100)}% column: ` +
              `"${lines.join(' / ')}" needs ${Math.round(predicted)}px in ${Math.round(room)}px` +
              `${fit.wrap ? ' (wrapped)' : ''}`,
          };
        }
      }
    }
  }

  check(
    `no headline overflows its column (${total} combinations)`,
    worst.overflow <= 0,
    worst.detail,
  );
  // A guard on the guard: if nothing wrapped, the wrapping branch is untested
  // and this suite would keep passing after it was deleted.
  check('the narrow cases actually reach the wrapping branch', wrapped > 0);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main() {
  validationChecks();
  canvasChecks();
  headlineFitChecks();

  console.log('\n=== shipped sample layout ===');
  check(
    'SAMPLE_LAYOUT_SPEC is structurally valid',
    validateLayoutSpec(SAMPLE_LAYOUT_SPEC).length === 0,
    validateLayoutSpec(SAMPLE_LAYOUT_SPEC)
      .map((problem) => `${problem.path} ${problem.message}`)
      .join('; '),
  );

  const specs: Array<{ label: string; spec: PosterLayoutSpec }> = [
    { label: 'SAMPLE_LAYOUT_SPEC', spec: SAMPLE_LAYOUT_SPEC },
  ];

  // Fixtures load by default, so the suite has real coverage with no arguments.
  // Parsed through `parseLayoutSpec` rather than trusted, which exercises the
  // stored-column path at the same time.
  const fixtureDir = new URL('fixtures/', import.meta.url);
  for (const name of (await readdir(fixtureDir)).filter((f) => f.endsWith('.json'))) {
    const parsed = parseLayoutSpec(
      JSON.parse(await readFile(new URL(name, fixtureDir), 'utf8')),
    );
    if (!parsed) {
      failures += 1;
      console.error(`  FAIL fixture ${name} is not a usable spec`);
      continue;
    }
    specs.push({ label: name, spec: parsed });
  }

  for (const path of process.argv.slice(2)) {
    const parsed = parseLayoutSpec(JSON.parse(await readFile(path, 'utf8')));
    if (!parsed) {
      failures += 1;
      console.error(`  FAIL ${basename(path)} is not a usable spec`);
      continue;
    }
    specs.push({ label: basename(path), spec: parsed });
  }

  const identity = await renderChecks(specs);
  await resolvedCanvasChecks(specs, identity);

  if (failures > 0) {
    console.error(`
${failures} check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll poster layout checks passed.');
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
