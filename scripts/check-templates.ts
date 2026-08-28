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

import sharp from 'sharp';

import { getImageSizePreset } from '@/lib/image-sizes';
import { resolvePosterCanvas } from '@/lib/poster/canvas';
import { closePosterBrowser } from '@/lib/poster/html/browser';
import { renderHtmlPoster } from '@/lib/poster/html/render';
import type { LayoutProblem } from '@/lib/poster/html/fill';
import {
  copyNeedsOf,
  HTML_TEMPLATE_SLUGS,
  loadHtmlTemplate,
  loadKitSprite,
  markedUpFeatureCount,
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
  /*
   * Constructions maps PosterCopy differently from Medicals — `body` is the
   * subhead, `ctaLabel` the line above the number, `callLabel` the word before
   * it — so its fixtures read differently too. See con-sm-06.html.
   */
  'con-sm-01': {
    copy: {
      headlineLines: ['WE BUILD', 'MORE THAN STRUCTURES'],
      accentLineIndex: 1,
      eyebrow: 'WE BUILD TRUST',
      ctaLabel: 'FROM VISION TO REALITY',
      features: [
        { icon: 'shieldCheck', label: 'Quality', body: 'We deliver excellence.' },
        { icon: 'hardHat', label: 'Safety', body: 'We build responsibly.' },
        { icon: 'handshake', label: 'Integrity', body: 'We believe in transparency.' },
        { icon: 'chart', label: 'Commitment', body: 'We complete with pride.' },
      ],
    },
  },
  'con-sm-02': {
    copy: {
      headlineLines: ['BUILT TO LAST,', 'FINISHED ON TIME'],
      accentLineIndex: 0,
      body: 'Groundwork to handover, one team.',
      ctaLabel: 'Talk to us about your site',
    },
  },
  'con-sm-03': {
    copy: {
      headlineLines: ['SAFETY FIRST,', 'ALWAYS'],
      accentLineIndex: 0,
      body: 'Every site, every shift, every day.',
      ctaLabel: 'Book a site inspection',
    },
  },
  'con-sm-04': {
    copy: {
      headlineLines: ['PLANNED WELL,', 'BUILT RIGHT'],
      accentLineIndex: 0,
      body: 'Survey, design and delivery.',
    },
  },
  'con-sm-05': {
    copy: {
      headlineLines: ['MATERIALS YOU', 'CAN RELY ON'],
      accentLineIndex: 0,
      body: 'Supplied and delivered on schedule.',
      ctaLabel: 'Ask us for a quote today',
    },
  },
  'con-sm-06': {
    copy: {
      headlineLines: ['HEAVY WORK,', 'HANDLED'],
      accentLineIndex: 0,
      body: 'Plant and operators, on hire.',
      ctaLabel: 'Tell us what you need moved',
    },
  },
  'con-sm-07': {
    copy: {
      headlineLines: ['SKILLED HANDS', 'ON EVERY SITE'],
      accentLineIndex: 0,
      body: 'Trained crews, ready to start.',
      ctaLabel: 'Hire a crew this week',
    },
  },
  'int-sm-01': {
    copy: {
      headlineLines: ['ROOMS THAT', 'WORK HARDER'],
      accentLineIndex: 1,
      eyebrow: 'INTERIOR DESIGN',
      body: 'We plan, furnish and finish the whole room, so it is ready to live in on the day we hand it back.',
      features: [
        { icon: 'houseInHand', label: 'Living', body: 'Layouts that suit how you actually use the room.' },
        { icon: 'key', label: 'Turnkey', body: 'One team from drawing to final handover.' },
        { icon: 'leaf', label: 'Finishes', body: 'Materials chosen to wear well, not just photograph well.' },
      ],
    },
  },
  'int-sm-03': {
    copy: {
      headlineLines: ['A home that', 'fits the way', 'you live in it.'],
      accentLineIndex: 2,
      body: 'Tell us how the room is used and we will plan it around that, then furnish and finish it end to end.',
      features: [
        { icon: 'houseInHand', label: 'Space planning', body: 'Measured, drawn and agreed first.' },
        { icon: 'blueprint', label: 'Custom joinery', body: 'Built to the room, not to a catalogue.' },
        { icon: 'leaf', label: 'Styling', body: 'Finishes, lighting and soft furnishing.' },
        { icon: 'key', label: 'Handover', body: 'Cleaned, snagged and ready to use.' },
      ],
    },
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

  // --- the manifest agrees with the markup ----------------------------------
  //
  // featureCount is what the sheet is generated from and what checkRowFit
  // measures a row against, so a manifest claiming four cards over markup that
  // draws three would ask an operator for a feature that lands nowhere.
  const markedUp = markedUpFeatureCount(template.contract);
  check(
    `declares ${template.manifest.featureCount} feature(s) and marks up ${markedUp}`,
    markedUp === template.manifest.featureCount,
    'the manifest and the markup disagree about how many features this design draws',
  );

  // --- the logo area belongs to the client ----------------------------------
  //
  // Several references print a "LOGO HERE" placeholder frame. Reproducing it
  // boxes in a mark that may not suit the box — the space is reserved for the
  // client's artwork and nothing else is drawn in it.
  // CSS comments as well as HTML ones: the rule reads declarations, and a
  // comment explaining why the logo has no background is not a background.
  const declarations = withoutComments.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const logoRules = [...declarations.matchAll(/([^{}]*logo[^{}]*)\{([^}]*)\}/gi)]
    .filter((match) => /border|background/i.test(match[2]!))
    .map((match) => match[1]!.trim());
  check(
    'paints nothing in the logo area',
    logoRules.length === 0,
    logoRules.length > 0
      ? `${logoRules.join(', ')} — the space is the client's mark, not a frame around it`
      : undefined,
  );

  const needs = copyNeedsOf(template);
  const draws = Object.entries(needs)
    .filter(([, value]) => value === true)
    .map(([name]) => name);
  console.log(
    `  ..   draws ${needs.features} feature(s)` +
      (draws.length > 0 ? ` and ${draws.join(', ')}` : ''),
  );

  // --- manifest photos agree with the markup --------------------------------
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
// Copy shapes — the range a template has to survive
// ---------------------------------------------------------------------------

/**
 * Copy at both ends of what the schema permits, plus the reference's own.
 *
 * One render proves almost nothing about a layout: every fault worth catching
 * here — a headline that collides with the rule beneath it, a card row that
 * reaches past the canvas, a label that vanishes — appears for *some* copy and
 * not for other copy. Med-SM-15 passed every check for a day while clipping its
 * headline, because the fixture happened to be short.
 *
 * Features are supplied at exactly the count the template draws, because that is
 * what a correct sheet row will carry. Too many is a separate concern and is
 * what `checkRowFit` warns about.
 */
function copyShapes(template: HtmlTemplate): Array<{ name: string; copy: PosterCopy }> {
  const slug = template.slug;
  const count = Math.max(2, template.manifest.featureCount);

  const featuresOf = (label: string, body: string): PosterCopy['features'] =>
    Array.from({ length: count }, (_, index) => ({
      icon: 'star' as const,
      label: `${label}${index + 1}`.slice(0, 28),
      body,
    }));

  return [
    { name: 'reference', copy: fixtureFor(slug).copy },
    {
      name: 'shortest',
      copy: {
        ...COPY,
        headlineLines: ['ONE', 'TWO'],
        accentLineIndex: 0,
        eyebrow: '',
        body: 'x',
        features: featuresOf('S', 'y'),
        ctaLabel: 'GO',
        callLabel: 'Call',
        websiteLabel: 'Visit',
      },
    },
    {
      name: 'longest',
      copy: {
        ...COPY,
        // Four lines is the schema's ceiling and 24 characters is a line's.
        headlineLines: [
          'TWENTY FOUR CHARACTERS X',
          'ANOTHER TWENTY FOUR CHAR',
          'A THIRD TWENTY FOUR CHAR',
          'A FOURTH TWENTY FOUR CHA',
        ],
        accentLineIndex: 3,
        eyebrow: 'FORTY CHARACTERS OF EYEBROW COPY HERE OK',
        body:
          'Two hundred and forty characters of body copy, which is the ceiling the ' +
          'schema allows, written out in full so the block is measured against the ' +
          'longest paragraph any day can legally carry on a poster in this library.',
        features: featuresOf(
          'A TWENTY EIGHT CHAR LABEL',
          'Ninety characters of feature body copy, which is the most a single feature may carry.',
        ),
        ctaLabel: 'TWENTY EIGHT CHARACTER CTA X'.slice(0, 28),
        callLabel: 'A TWENTY EIGHT CHAR CALL LBL',
        websiteLabel: 'A TWENTY EIGHT CHAR SITE LBL',
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// 2–5. Render, determinism, layout audit, hostile copy
// ---------------------------------------------------------------------------

function sha(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

/** Where the client’s mark landed, and what ink the template flattened it to. */
interface LogoPlacement {
  x: number;
  y: number;
  width: number;
  height: number;
  /** True when `--logo-filter` inverts, i.e. the mark is drawn light. */
  inverted: boolean;
}

/**
 * Reads the logo’s box and its resolved ink off the live page.
 *
 * The filter is read as *computed* rather than parsed out of the file, so a
 * value inherited from `_base.css`, set on an ancestor, or overridden by a later
 * rule is measured as the browser actually resolved it.
 *
 * Written as a string with no backslash in it on purpose: `page.evaluate` is
 * handed this source to evaluate, and a regex literal’s escapes do not survive
 * the template literal carrying it. `includes` needs none.
 */
const readLogoPlacement = `(() => {
  const img = document.querySelector('.pk-logo img');
  if (!img) return null;
  const box = img.getBoundingClientRect();
  if (box.width < 1 || box.height < 1) return null;
  const filter = getComputedStyle(img).filter || '';
  return {
    x: box.x, y: box.y, width: box.width, height: box.height,
    inverted: filter.includes('invert(1'),
  };
})()`;

/** WCAG relative luminance for one 8-bit sRGB triple. */
function luminance(r: number, g: number, b: number): number {
  const channel = (value: number): number => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * How well the client’s mark reads against whatever is actually behind it.
 *
 * **Measured off the rendered pixels, not off the stylesheet.** A template
 * declares its ink as one line — `--logo-filter: brightness(0)` for a dark mark,
 * `brightness(0) invert(1)` for a light one — chosen by whoever authored it
 * against the ground they had in mind. Con-SM-3 and Con-SM-4 both declared a
 * black mark over a near-black ground and shipped an invisible logo to a paying
 * client; nothing caught it, because every other check in this file reads the
 * file rather than the picture.
 *
 * The spec renderer had this guarantee — `logoReadsOn` measured the mark against
 * its ground and re-inked below 3:1 — and the template path dropped it on the
 * reasoning that a template knows its own ground at authoring time. It does.
 * Authors do not reliably know it, which is a different claim, and this restores
 * the guarantee where it costs nothing: at build time, on every template,
 * including the ones added after this was written.
 *
 * Returns null when there is nothing to judge — no logo slot, or a crop that
 * came out all mark or all ground.
 */
async function logoContrast(png: Buffer, at: LogoPlacement): Promise<number | null> {
  const image = sharp(png);
  const meta = await image.metadata();
  const left = Math.max(0, Math.round(at.x));
  const top = Math.max(0, Math.round(at.y));
  const width = Math.min(Math.round(at.width), (meta.width ?? 0) - left);
  const height = Math.min(Math.round(at.height), (meta.height ?? 0) - top);
  if (width < 2 || height < 2) return null;

  const { data, info } = await image
    .extract({ left, top, width, height })
    .raw()
    .toBuffer({ resolveWithObject: true });

  /*
   * The filter flattens the mark to one extreme, so nearness to that extreme
   * separates artwork from ground without needing to know the artwork.
   */
  const inkIsLight = at.inverted;
  let groundTotal = 0;
  let groundCount = 0;
  let inkCount = 0;

  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const isInk = inkIsLight ? r > 232 && g > 232 && b > 232 : r < 24 && g < 24 && b < 24;
    if (isInk) {
      inkCount += 1;
    } else {
      groundTotal += luminance(r, g, b);
      groundCount += 1;
    }
  }

  // A crop with no mark in it, or none of the ground around it, says nothing.
  if (inkCount < 16 || groundCount < 16) return null;

  const inkLuminance = inkIsLight ? 1 : 0;
  const groundLuminance = groundTotal / groundCount;
  const lighter = Math.max(inkLuminance, groundLuminance);
  const darker = Math.min(inkLuminance, groundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * The floor a mark has to clear, and the one the spec renderer used.
 *
 * 3:1 is WCAG’s threshold for non-text graphics. A logo below it is not subtly
 * off: Con-SM-4 measured about 1.2:1, which on the poster is a mark you have to
 * be told is there.
 */
const MIN_LOGO_CONTRAST = 3;

async function renderTemplate(
  template: HtmlTemplate,
  copy: PosterCopy,
  inspect?: Parameters<typeof renderHtmlPoster>[0]['inspect'],
  identity: PosterIdentity = IDENTITY,
  onLayoutProblems?: (problems: LayoutProblem[]) => void,
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
    ...(onLayoutProblems ? { onLayoutProblems } : {}),
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
      const placed: Array<LogoPlacement | null> = [];
      const first = await renderTemplate(
        template,
        fixture.copy,
        async (page) => {
          placed.push((await page.evaluate(readLogoPlacement)) as LogoPlacement | null);
        },
        fixture.identity,
      );
      const path = join(outDir, `${slug}.png`);
      await writeFile(path, first);
      check(`renders (${first.byteLength} bytes) → ${path}`, first.byteLength > 0);

      /*
       * The client’s mark has to be visible on the ground it lands on.
       *
       * Measured from the rendered pixels rather than from the file, because
       * what goes wrong is a correct-looking stylesheet over the wrong
       * background. See `logoContrast`.
       */
      const placement = placed[0] ?? null;
      if (placement === null) {
        console.log('  ..   draws no logo — the client’s mark never appears on this design');
      } else {
        const ratio = await logoContrast(first, placement);
        if (ratio === null) {
          console.log('  ..   logo contrast could not be measured on this ground');
        } else {
          check(
            `the client’s logo reads on its ground (${ratio.toFixed(1)}:1)`,
            ratio >= MIN_LOGO_CONTRAST,
            `${ratio.toFixed(2)}:1 is below ${MIN_LOGO_CONTRAST}:1 — ` +
              `flip --logo-filter (${placement.inverted ? 'invert(1) is wrong here' : 'it needs invert(1)'})`,
          );
        }
      }

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
       * The layout audit, across the range of copy the schema permits.
       *
       * This is the pass that answers "the poster must never ship with something
       * clipped, hidden or sitting on top of something else". Every other check
       * here can pass on a broken template — it renders, it re-renders
       * identically, its markup lints — because those questions are about the
       * file rather than about what the file produced.
       */
      for (const shape of copyShapes(template)) {
        const found: LayoutProblem[] = [];
        await renderTemplate(template, shape.copy, undefined, fixture.identity, (problems) =>
          found.push(...problems),
        );
        check(
          `lays out cleanly with ${shape.name} copy`,
          found.length === 0,
          found.map((problem) => `${problem.kind}: ${problem.detail}`).join('; '),
        );
      }

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
