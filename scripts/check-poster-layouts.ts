/**
 * Regression suite for the poster layout layer.
 *
 * Three things, in order of how cheap they are to run:
 *
 *   1. Spec validation — the rules that keep a bad layout out of production.
 *   2. Archetype renders — every one of the fifteen, so a change made for the
 *      spec path cannot silently break the path that still serves most clients.
 *   3. Spec renders — supplied spec JSON, at portrait and off-brand canvases.
 *
 * No network, no database, no fal.ai: the photography is procedural and the
 * fonts come from the same loader production uses. There is no test framework in
 * this repository, so this follows the `check-logo-key.ts` pattern — a
 * standalone script with a non-zero exit code.
 *
 * Run: npx tsx scripts/check-poster-layouts.ts [spec.json...]
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { getImageSizePreset } from '@/lib/image-sizes';
import { createPlaceholderPhoto } from '@/lib/poster/placeholder-photo';
import {
  resolvePhotoRequest,
  resolveSpecPhotoRequests,
} from '@/lib/poster/photo-request';
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
import { POSTER_ARCHETYPES, type PosterCopy } from '@/lib/types/poster';

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
  headlineLines: ['GRAND', 'OPENING', 'PROMO'],
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
  ],
  callLabel: 'TASTE IT TODAY',
  websiteLabel: 'FOLLOW OUR SOCIAL MEDIA',
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

  const overlaid = posterLayoutSpecSchema.parse(
    spec([row([cell(['photo', 'headline'])]), row([cell(['photo'])], 'flex')]),
  );
  check(
    'photo and text in one cell is rejected',
    validateLayoutSpec(normalizeLayoutSpec(overlaid)).some((p) =>
      p.message.includes('overlay'),
    ),
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

function placeholder(width: number, height: number, index: number): Buffer {
  const longest = Math.max(width, height);
  const ratio = longest > 1024 ? 1024 / longest : 1;
  return createPlaceholderPhoto(
    Math.max(1, Math.round(width * ratio)),
    Math.max(1, Math.round(height * ratio)),
    index % 2 === 0 ? 'daylight' : 'dusk',
  );
}

async function renderChecks(specs: Array<{ label: string; spec: PosterLayoutSpec }>) {
  const logoBytes = await readFile(LOGO);
  const identity = {
    ...IDENTITY_BASE,
    logoUrl: `data:image/png;base64,${logoBytes.toString('base64')}`,
  };

  console.log('\n=== archetype renders (regression) ===');
  for (const archetype of POSTER_ARCHETYPES) {
    const preset = getImageSizePreset('whatsapp-status')!;
    const request = resolvePhotoRequest(archetype, preset);
    try {
      const poster = await renderPoster({
        archetype,
        layoutSpec: null,
        dayNumber: 1,
        copy: COPY,
        guideline: EMPTY_BRAND_GUIDELINE,
        identity,
        photos: [placeholder(request.width, request.height, 0)],
        width: preset.width,
        height: preset.height,
      });
      check(
        `${archetype} renders`,
        poster.body.byteLength > 0 && poster.layout === 'archetype',
      );
    } catch (error) {
      check(`${archetype} renders`, false, describe(error));
    }
  }

  if (specs.length === 0) {
    console.log('\n(no spec files given — skipping spec renders)');
    return;
  }

  console.log('\n=== spec renders ===');
  for (const entry of specs) {
    for (const presetId of PRESETS) {
      const preset = getImageSizePreset(presetId)!;
      const requests = resolveSpecPhotoRequests(entry.spec, preset);
      const photos = requests.map((request, index) =>
        placeholder(request.width, request.height, index),
      );

      try {
        const poster = await renderPoster({
          archetype: null,
          layoutSpec: entry.spec,
          dayNumber: 1,
          copy: COPY,
          guideline: EMPTY_BRAND_GUIDELINE,
          identity,
          photos: photos.length > 0 ? photos : [placeholder(1024, 1024, 0)],
          width: preset.width,
          height: preset.height,
        });
        check(
          `${entry.label} @ ${preset.width}×${preset.height}`,
          poster.body.byteLength > 0 && poster.layout === 'spec',
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
      resolveSpecPhotoRequests(entry.spec, preset).length ===
        countPhotoSlots(entry.spec),
    );
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main() {
  validationChecks();

  const specs: Array<{ label: string; spec: PosterLayoutSpec }> = [];
  for (const path of process.argv.slice(2)) {
    const parsed = parseLayoutSpec(JSON.parse(await readFile(path, 'utf8')));
    if (!parsed) {
      failures += 1;
      console.error(`  FAIL ${basename(path)} is not a usable spec`);
      continue;
    }
    specs.push({ label: basename(path), spec: parsed });
  }

  await renderChecks(specs);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll poster layout checks passed.');
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
