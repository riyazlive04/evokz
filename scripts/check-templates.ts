/**
 * Regression suite for the HTML poster templates.
 *
 * Four things, in order of how cheap they are to run:
 *
 *   1. Content lint — the rule that a template hardcodes colours and never
 *      words. This is the one that cannot be caught by looking: a template that
 *      bakes in "WELLCARE" or a phone number renders perfectly and ships one
 *      client's details to every other client on that template.
 *   2. Render — every registered template drawn with procedural photography, so
 *      a template can be judged as a poster. Costs nothing; no fal.ai, no Drive,
 *      no database.
 *   3. Determinism — each template drawn twice and the bytes compared. The
 *      system leans on byte-identical re-renders so a retry after a WhatsApp
 *      failure can be compared against the original, and a Chromium or font
 *      change would otherwise break that silently.
 *   4. Hostile copy — the render path given the sort of string an
 *      operator-edited spreadsheet actually produces, with an assertion inside
 *      the live page that it became text rather than markup.
 *
 * There is no test framework in this repository, so this follows the
 * `check-poster-layouts.ts` pattern: a standalone script with a non-zero exit
 * code.
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.json scripts/check-templates.ts [outDir]
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getImageSizePreset } from '@/lib/image-sizes';
import { resolvePosterCanvas } from '@/lib/poster/canvas';
import { closePosterBrowser } from '@/lib/poster/html/browser';
import { renderHtmlPoster } from '@/lib/poster/html/render';
import {
  HTML_TEMPLATE_SLUGS,
  loadHtmlTemplate,
  loadKitSprite,
  type HtmlTemplate,
} from '@/lib/poster/html/template';
import { BUNDLED_FAMILIES } from '@/lib/poster/html/typefaces';
import { resolveTemplatePhotoRequests } from '@/lib/poster/photo-request';
import {
  createPlaceholderPhoto,
  createPlaceholderSubject,
} from '@/lib/poster/placeholder-photo';
import type { PosterCopy, PosterIdentity } from '@/lib/types/poster';

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

/** Realistic length, not lorem: a short headline hides every fitting fault. */
const COPY: PosterCopy = {
  headlineLines: ['GOOD HEALTH', 'HAPPIER LIFE'],
  accentLineIndex: 0,
  eyebrow: 'TRUSTED SINCE 1998',
  body: 'Walk in for a consultation any day of the week, or book ahead and skip the wait entirely.',
  features: [
    { icon: 'shieldCheck', label: 'Medical', body: 'General consultation, seven days a week.' },
    { icon: 'chart', label: 'Labs', body: 'Blood work and pathology, reports the same day.' },
    { icon: 'people', label: 'Therapist', body: 'Physiotherapy and rehabilitation on site.' },
    { icon: 'star', label: 'Scan Center', body: 'CT, MRI and ultrasound under one roof.' },
  ],
  callLabel: 'CALL US TODAY',
  websiteLabel: 'VISIT OUR WEBSITE',
  ctaLabel: 'BOOK AN APPOINTMENT',
  headlinePeriod: false,
};

/**
 * The copy an operator actually types, plus everything that has ever broken a
 * renderer that builds markup by concatenation.
 *
 * `<script>` is the obvious one. The quieter ones matter more: a stray
 * `</style>` closes the template's own stylesheet and unstyles the entire
 * poster, and a lone `&` breaks an XML-ish parser without breaking an HTML one.
 * The headline is also far too long, so this doubles as the fitter's test.
 */
const HOSTILE_COPY: PosterCopy = {
  ...COPY,
  headlineLines: [
    'CARE & <SCRIPT>ALERT(1)</SCRIPT>',
    "O'BRIEN </STYLE> \"QUOTED\"",
    'A HEADLINE FAR TOO LONG FOR ITS COLUMN',
  ],
  accentLineIndex: 2,
  features: COPY.features.map((feature) => ({
    ...feature,
    label: `${feature.label} & <b>x</b>`,
  })),
};

/**
 * A stand-in lockup, roughly the proportions of the reference's own (310×204).
 *
 * Abstract shapes rather than a wordmark: the template flattens it to one ink
 * anyway, and drawing letters here would make the fixture depend on a font the
 * check does not otherwise need. It exists because `logoDataUri: null` leaves
 * the top fifth of the poster empty, which is the one region that then never
 * gets looked at in review.
 */
const PLACEHOLDER_LOGO =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMTAgMjA0Ij48cGF0aCBkPSJNMTM4IDhoMzR2MjZoMjZ2MzRoLTI2djI2aC0zNFY2OGgtMjZWMzRoMjZ6IiBmaWxsPSIjMTIzYTYzIi8+PHBhdGggZD0iTTE4MCAxNGMyMiAxMCAzMCAzNCAyMiA1Ni04IDIxLTMwIDMwLTUyIDI2IDI2LTYgNDAtMjIgNDItNDIgMS0xNi00LTMwLTEyLTQweiIgZmlsbD0iIzBkODE4OSIvPjxyZWN0IHg9IjE2IiB5PSIxMTIiIHdpZHRoPSIyNzgiIGhlaWdodD0iMzQiIHJ4PSI2IiBmaWxsPSIjMTIzYTYzIi8+PHJlY3QgeD0iNjAiIHk9IjE2NCIgd2lkdGg9IjE5MCIgaGVpZ2h0PSIxMiIgcng9IjYiIGZpbGw9IiMwZDgxODkiLz48L3N2Zz4=';

/**
 * Per-template copy, matched to what its own reference says.
 *
 * Not decoration. The render is judged by holding it beside the reference JPEG,
 * and a template set with someone else's headline cannot be judged that way —
 * Med-SM-16's design is three lines with the accent on the third, and reviewing
 * it against two lines accented on the first says nothing about whether the
 * template is right. Templates not listed here fall back to `COPY`.
 *
 * The *hostile* pass deliberately does not do this: proving a template survives
 * arbitrary copy is a different job from proving it reproduces its reference.
 */
const FIXTURES: Record<string, { copy?: Partial<PosterCopy>; tagline?: string }> = {
  'med-sm-15': {
    copy: { headlineLines: ['GOOD HEALTH', 'HAPPIER LIFE'], accentLineIndex: 0 },
    tagline: 'Prevention. Diagnosis. Care.',
  },
  'med-sm-16': {
    copy: { headlineLines: ['EXPERT CARE', 'FOR A', 'HEALTHIER YOU'], accentLineIndex: 2 },
    tagline: 'Better Health, Better Life.',
  },
  'med-sm-14': {
    copy: { headlineLines: ['GOOD HEALTH', 'HAPPIER LIFE'], accentLineIndex: 0 },
    tagline: 'Prevention. Diagnosis. Care.',
  },
  'med-sm-13': {
    copy: { headlineLines: ['GOOD HEALTH', 'HAPPIER LIFE'], accentLineIndex: 0 },
    tagline: 'Prevention. Diagnosis. Care.',
  },
  'med-sm-12': {
    copy: { headlineLines: ['GOOD HEALTH', 'HAPPIER LIFE'], accentLineIndex: 0 },
    tagline: 'Prevention. Diagnosis. Care.',
  },
  'med-sm-11': {
    copy: { headlineLines: ['GOOD HEALTH', 'HAPPIER LIFE'], accentLineIndex: 0 },
    tagline: 'Prevention. Diagnosis. Care.',
  },
  'med-sm-08': {
    copy: {
      headlineLines: ['Trusted Care', 'Every Step', 'of the Way'],
      accentLineIndex: 0,
      features: [
        { icon: 'people', label: 'Patient Focused', body: 'x' },
        { icon: 'shieldCheck', label: 'Safe & Hygienic', body: 'x' },
        { icon: 'building', label: 'Advanced Facilities', body: 'x' },
        { icon: 'award', label: 'Expert Doctors', body: 'x' },
      ],
    },
    tagline: 'Better Health, Brighter Tomorrow.',
  },
  'med-sm-07': {
    copy: {
      headlineLines: ['24/7', 'Emergency', 'Care'],
      accentLineIndex: 0,
      body: 'We are here when you need us most.',
    },
    tagline: 'Better Health, Brighter Tomorrow.',
  },
  'med-sm-06': {
    copy: {
      headlineLines: ['Advanced Care', 'Closer to You'],
      accentLineIndex: 0,
      features: [
        { icon: 'people', label: 'Expert Team', body: 'x' },
        { icon: 'chart', label: 'Modern Technology', body: 'x' },
        { icon: 'stopwatch', label: '24/7 Care', body: 'x' },
        { icon: 'handshake', label: 'Patient First', body: 'x' },
      ],
    },
    tagline: 'Better Health, Brighter Tomorrow.',
  },
  'med-sm-05': {
    copy: {
      headlineLines: ['Your Health', 'Our Commitment'],
      accentLineIndex: 1,
      features: [
        { icon: 'chart', label: 'Advanced Care', body: 'x' },
        { icon: 'award', label: 'Expert Doctors', body: 'x' },
        { icon: 'shieldCheck', label: 'Trusted Care', body: 'x' },
        { icon: 'people', label: 'Patient Focused', body: 'x' },
      ],
    },
    tagline: 'Better Health, Brighter Tomorrow.',
  },
  'med-sm-04': {
    copy: {
      headlineLines: ['We Care', 'For You'],
      accentLineIndex: 1,
      features: [
        { icon: 'people', label: 'Expert Medical Team', body: 'x' },
        { icon: 'chart', label: 'Modern Facilities', body: 'x' },
        { icon: 'shieldCheck', label: 'Safe & Trusted Care', body: 'x' },
        { icon: 'stopwatch', label: '24/7 Emergency Support', body: 'x' },
      ],
    },
    tagline: 'Better Health, Brighter Tomorrow.',
  },
  'med-sm-03': {
    copy: {
      headlineLines: ['Better Care', 'Better Life'],
      accentLineIndex: 1,
      features: [
        { icon: 'award', label: 'Expert Doctors', body: 'x' },
        { icon: 'chart', label: 'Advanced Technology', body: 'x' },
        { icon: 'stopwatch', label: '24/7 Care & Support', body: 'x' },
        { icon: 'people', label: 'Patient Focused Care', body: 'x' },
      ],
    },
    tagline: 'Better Health, Brighter Tomorrow.',
  },
  'med-sm-01': {
    copy: {
      headlineLines: ['YOUR HEALTH', 'OUR PRIORITY'],
      accentLineIndex: 1,
      body: 'Expert care. Advanced technology. Healthier you.',
      ctaLabel: 'BOOK YOUR APPOINTMENT NOW',
      features: [
        { icon: 'star', label: 'General Consultation', body: 'x' },
        { icon: 'shieldCheck', label: 'Preventive Health Checkups', body: 'x' },
        { icon: 'chart', label: 'Accurate Diagnostics', body: 'x' },
        { icon: 'people', label: 'Patient Care & Support', body: 'x' },
      ],
    },
    tagline: 'Trusted care for you and your family.',
  },
  'med-sm-17': {
    copy: {
      headlineLines: ['Care that keeps', 'pace with your', 'whole family.'],
      accentLineIndex: 2,
    },
  },
};

function fixtureFor(slug: string): { copy: PosterCopy; identity: PosterIdentity } {
  const fixture = FIXTURES[slug];
  return {
    copy: { ...COPY, ...(fixture?.copy ?? {}) },
    identity: { ...IDENTITY, ...(fixture?.tagline ? { brandTagline: fixture.tagline } : {}) },
  };
}

const IDENTITY: PosterIdentity = {
  companyName: 'Lorem Ipsum Clinic',
  logoDataUri: PLACEHOLDER_LOGO,
  logoIncludesName: false,
  brandTagline: 'Prevention. Diagnosis. Care.',
  phone: '+91 90000 11111',
  website: 'www.loremipsum.com',
};

// ---------------------------------------------------------------------------
// 1. Content lint — the rule that a template hardcodes colours but never words
// ---------------------------------------------------------------------------

/**
 * Strips everything a phone number could hide behind without being copy.
 *
 * SVG path data is the reason this exists: `d="M362.5 480C300 442 0 302…"` is a
 * long run of digits and separators, and every phone pattern worth writing
 * matches something in it eventually. Geometry attributes are removed before the
 * number scan rather than the patterns being weakened to tolerate them.
 */
function stripGeometry(html: string): string {
  return html.replace(
    /\s(?:d|viewBox|points|transform|stroke-dasharray|href)="[^"]*"/gi,
    ' ',
  );
}

function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, ' ');
}

/**
 * Number shapes that are a contact detail rather than a measurement.
 *
 * Anchored on grouping rather than on length alone: `1600` is a canvas edge and
 * `98765 43210` is somebody's phone. The Indian grouping is first because it is
 * the one the reference set carries and therefore the one most likely to be
 * copied into a template by whoever is looking at the JPEG while they author.
 */
const NUMBER_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'international (+NN …)', pattern: /\+\d[\d\s().-]{7,}\d/g },
  { label: 'Indian grouping (NNNNN NNNNN)', pattern: /\b\d{5}[\s.-]\d{5}\b/g },
  { label: 'bare 10-digit', pattern: /\b\d{10}\b/g },
  { label: 'US grouping (NNN NNN NNNN)', pattern: /\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b/g },
];

/** A hostname a client would recognise as theirs. */
const DOMAIN_PATTERN = /\b(?:www\.)?[a-z0-9][a-z0-9-]{1,}\.(?:com|in|org|net|co|clinic)\b/gi;

const EMAIL_PATTERN = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi;

function lintTemplate(template: HtmlTemplate): void {
  const { slug, html } = template;
  console.log(`\n${slug} — content lint`);

  const withoutComments = stripComments(html);

  // --- the central rule: no literal words anywhere ---------------------------
  //
  // Every text-bearing element must be empty in the file and filled at render.
  // With that held, the template's entire text content is whitespace, and a
  // single check catches a baked-in company name, service label, strapline or
  // phone number without needing a pattern for each.
  const proseOnly = withoutComments
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .trim();

  check(
    'carries no literal text outside its slots',
    proseOnly.length === 0,
    proseOnly.length > 0
      ? `found ${JSON.stringify(proseOnly.slice(0, 120))} — put it in a data-slot, or ` +
        'if it is decoration, draw it rather than typing it'
      : undefined,
  );

  // --- every slot element is empty ------------------------------------------
  // A more precise message for the commonest way the rule above is broken:
  // authoring against the reference with the reference's own words left in as
  // placeholder text.
  const filled: string[] = [];
  const slotPattern = /<([a-z][a-z0-9]*)\b[^>]*\bdata-slot="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const match of withoutComments.matchAll(slotPattern)) {
    if (match[3]!.trim().length > 0) filled.push(`${match[2]}="${match[3]!.trim()}"`);
  }
  check(
    'every data-slot element is empty in the file',
    filled.length === 0,
    filled.join(', '),
  );

  // --- contact details ------------------------------------------------------
  const scannable = stripGeometry(withoutComments);
  for (const { label, pattern } of NUMBER_PATTERNS) {
    const hits = [...scannable.matchAll(pattern)].map((m) => m[0].trim());
    check(
      `holds no ${label} number`,
      hits.length === 0,
      hits.length > 0 ? hits.join(', ') : undefined,
    );
  }

  const domains = [...scannable.matchAll(DOMAIN_PATTERN)].map((m) => m[0]);
  check('holds no hardcoded domain', domains.length === 0, domains.join(', '));

  const emails = [...scannable.matchAll(EMAIL_PATTERN)].map((m) => m[0]);
  check('holds no hardcoded email address', emails.length === 0, emails.join(', '));

  // --- self-containment -----------------------------------------------------
  // The renderer aborts every non-data request, so a remote asset is already a
  // hard failure at render. Catching it here says *which line* rather than
  // leaving an operator with a blank logo and a network abort in the log.
  const remote = [...withoutComments.matchAll(/https?:\/\/[^\s"')]+/gi)].map((m) => m[0]);
  check(
    'references nothing over the network',
    remote.length === 0,
    remote.join(', '),
  );

  const scripts = [...withoutComments.matchAll(/<script\b[^>]*>/gi)]
    .map((m) => m[0])
    .filter((tag) => !/id=["']poster-manifest["']/i.test(tag));
  check('carries no script but its manifest', scripts.length === 0, scripts.join(', '));

  // --- fonts ----------------------------------------------------------------
  // A family that is not bundled resolves to a system fallback on the dev
  // machine and to nothing in the container — the exact silent substitution
  // `typefaces.ts` exists to prevent.
  const families = new Set<string>();
  for (const match of withoutComments.matchAll(/font-family:\s*([^;}]+)/gi)) {
    for (const part of match[1]!.split(',')) {
      const named = part.trim().match(/^['"]([^'"]+)['"]$/);
      if (named) families.add(named[1]!);
    }
  }
  const unbundled = [...families].filter((family) => !BUNDLED_FAMILIES.includes(family));
  check(
    'names only bundled typefaces',
    unbundled.length === 0,
    unbundled.length > 0
      ? `${unbundled.join(', ')} — add to BUNDLED_TYPEFACES or use ${BUNDLED_FAMILIES.join('/')}`
      : undefined,
  );

  // --- manifest agrees with the markup --------------------------------------
  const declared = template.manifest.photos.map((photo) => photo.name);
  const present = new Set(
    [...withoutComments.matchAll(/data-image="([^"]+)"/gi)].map((m) => m[1]!),
  );
  const missing = declared.filter((name) => !present.has(name));
  check(
    'declares a data-image for every manifest photo',
    missing.length === 0,
    missing.join(', '),
  );
}

// ---------------------------------------------------------------------------
// 2–4. Render, determinism, hostile copy
// ---------------------------------------------------------------------------

function sha(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

async function renderTemplate(
  template: HtmlTemplate,
  copy: PosterCopy,
  inspect?: Parameters<typeof renderHtmlPoster>[0]['inspect'],
  identity: PosterIdentity = IDENTITY,
): Promise<Buffer> {
  const preset = getImageSizePreset('whatsapp-status') ?? { width: 1080, height: 1920 };
  const canvas = resolvePosterCanvas(
    { aspect: template.manifest.aspect, name: template.manifest.label },
    preset,
  );

  // Photography is procedural, so the suite is meaningful with no network and
  // no fal.ai spend — the same bargain `check:layouts` strikes.
  const requests = resolveTemplatePhotoRequests(template.manifest, canvas);
  const photos = requests.map((request) => {
    /*
     * A `subject` frame gets a transparent silhouette, not a landscape.
     *
     * The first version handed every frame the same rectangular placeholder,
     * which made a cut-out template impossible to judge: Med-SM-16 stands a
     * figure on its contact bar, and reviewing it with a photograph of a skyline
     * in that slot tells you nothing about whether the figure lands correctly.
     * The preview route has always drawn this distinction; the check had not.
     */
    const bytes =
      request.kind === 'subject'
        ? createPlaceholderSubject(request.width, request.height)
        : createPlaceholderPhoto(request.width, request.height, 'daylight');
    return {
      dataUri: `data:image/png;base64,${bytes.toString('base64')}`,
      width: request.width,
      height: request.height,
    };
  });

  return renderHtmlPoster({
    template,
    copy,
    identity,
    photos,
    width: canvas.width,
    height: canvas.height,
    inspect,
  });
}

/**
 * The shared sprite gets its own pass.
 *
 * It is not in `HTML_TEMPLATE_SLUGS`, so nothing else looks at it — and it is
 * the one file whose faults reach every template at once. The rules are the
 * template rules minus the ones about slots, which it has none of.
 */
async function lintKit(): Promise<void> {
  console.log('');
  console.log('_kit.svg — content lint');
  let kit: string;
  try {
    kit = await loadKitSprite();
  } catch (error: unknown) {
    failures += 1;
    console.error(`  FAIL could not be read — ${describe(error)}`);
    return;
  }

  const body = stripComments(kit);

  const text = body
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .trim();
  check('carries no literal text', text.length === 0, JSON.stringify(text.slice(0, 100)));

  // `xmlns` is a namespace name rather than a fetch — it is never resolved — so
  // it is the one http(s) string allowed anywhere in the poster layer.
  const remote = [...body.matchAll(/https?:\/\/[^\s"')]+/gi)]
    .map((m) => m[0])
    .filter((url) => url !== 'http://www.w3.org/2000/svg');
  check('references nothing over the network', remote.length === 0, remote.join(', '));

  const ids = [...body.matchAll(/<symbol[^>]*id="([^"]+)"/gi)].map((m) => m[1]!);
  check(`declares ${ids.length} mark(s): ${ids.join(', ')}`, ids.length > 0);
  check(
    'gives every mark a viewBox',
    [...body.matchAll(/<symbol[^>]*>/gi)].every((m) => /viewBox=/.test(m[0])),
    'a symbol without one scales unpredictably wherever it is used',
  );
  // A hardcoded ink would make the mark unusable on the next template that needs
  // it in another colour, which is the whole point of sharing it.
  const inks = [...body.matchAll(/(?:fill|stroke)="(#[0-9a-f]{3,8})"/gi)].map((m) => m[1]!);
  check('draws only in currentColor', inks.length === 0, inks.join(', '));
}

async function main(): Promise<void> {
  const outDir = process.argv[2] ?? join('snapshots', 'templates');
  await mkdir(outDir, { recursive: true });

  await lintKit();

  for (const slug of HTML_TEMPLATE_SLUGS) {
    let template: HtmlTemplate;
    try {
      template = await loadHtmlTemplate(slug);
    } catch (error: unknown) {
      failures += 1;
      console.error(`\n${slug} — FAIL could not be loaded: ${describe(error)}`);
      continue;
    }

    lintTemplate(template);

    console.log(`\n${slug} — render`);
    try {
      const fixture = fixtureFor(slug);
      const first = await renderTemplate(template, fixture.copy, undefined, fixture.identity);
      const path = join(outDir, `${slug}.png`);
      await writeFile(path, first);
      check(`renders (${first.byteLength} bytes) → ${path}`, first.byteLength > 0);

      /*
       * Byte-identical, not merely similar. A retry after a WhatsApp failure is
       * compared against the original, so "close enough" is not a passing grade
       * — and the things that break it (a Chromium bump, an unpinned font, a
       * date or a random in a template) all break it completely rather than
       * subtly.
       */
      const second = await renderTemplate(template, fixture.copy, undefined, fixture.identity);
      check(
        're-renders byte-identically',
        sha(first) === sha(second),
        `${sha(first)} vs ${sha(second)}`,
      );

      /*
       * The hostile pass asserts inside the page, because once it is a PNG the
       * difference between "drew the characters `<b>`" and "parsed a bold tag"
       * is a few pixels that nobody will notice in review.
       */
      // Collected into an array rather than a `let`: TypeScript's control-flow
      // analysis does not follow a write made inside a callback, so a plain
      // variable narrows to `never` after this and every read of it is an error.
      const probed: Array<{ scripts: number; headline: string }> = [];
      const hostile = await renderTemplate(template, HOSTILE_COPY, async (page) => {
        probed.push(await page.evaluate(() => ({
          // The manifest is removed by fillPoster, so any script here arrived
          // through the copy.
          scripts: document.querySelectorAll('script').length,
          headline: document.querySelector('[data-fit]')?.textContent ?? '',
        })));
      });
      const injected = probed[0] ?? null;

      check('renders hostile copy without throwing', hostile.byteLength > 0);
      check(
        'hostile copy became text, not markup',
        injected !== null && injected.scripts === 0,
        injected === null ? 'the page was never inspected' : `${injected.scripts} script element(s)`,
      );
      check(
        'hostile copy survived verbatim',
        injected !== null && injected.headline.includes('<SCRIPT>ALERT(1)</SCRIPT>'),
        injected === null ? undefined : JSON.stringify(injected.headline.slice(0, 80)),
      );

      const hostilePath = join(outDir, `${slug}.hostile.png`);
      await writeFile(hostilePath, hostile);
      console.log(`  ..   hostile render written → ${hostilePath}`);
    } catch (error: unknown) {
      failures += 1;
      console.error(`  FAIL render — ${describe(error)}`);
    }
  }

  // Without this the script hangs holding a live Chromium.
  await closePosterBrowser();

  console.log(
    failures === 0
      ? '\nAll template checks passed.'
      : `\n${failures} template check(s) failed.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

function describe(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

main().catch((error: unknown) => {
  console.error(describe(error));
  process.exit(1);
});
