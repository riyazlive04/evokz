/**
 * Regression suite for the auto-approval gate.
 *
 * **The fixtures are real.** Every spec and every `reading` string below was
 * taken verbatim from `CategoryTemplate` rows in the Medicals vertical on
 * 2026-08-25, after two of them delivered posters that were two thirds empty
 * colour to a client's approval queue. A synthetic fixture would have proved the
 * rule matches itself; these prove it matches the library it exists for.
 *
 * The four are chosen because they fail differently, and the reason both checks
 * exist is that each one misses a case the other catches:
 *
 *   Med-SM-11  consistent, has its photo, renders correctly     — must approve
 *   Med-SM-12  self-consistent, no photo, hollow flex row       — hollow only
 *   Med-SM-13  contradicts its reading AND hollow               — both
 *   Med-SM-16  contradicts its reading, flex row can absorb     — mismatch only
 *
 * All four pass `validateLayoutSpec`. That is the point: the structural check
 * calls every one of them clean, and three of them are wrong.
 *
 * No network, no database. Run: npm run check:risk
 */
import { assessAutoApproval, readPhotoCountFromReading } from '@/lib/poster/layout-risk';
import {
  normalizeLayoutSpec,
  posterLayoutSpecSchema,
  validateLayoutSpec,
  type LayoutSlot,
} from '@/lib/types/layout-spec';

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const cell = (slots: LayoutSlot[], fill = 'inherit', weight = 100, align = 'center') => ({
  weight,
  fill,
  align,
  padded: true,
  photoKind: 'scene',
  slots,
});

const row = (
  sizingMode: string,
  fill: string,
  cells: ReturnType<typeof cell>[],
  heightFraction = 0,
) => ({ sizingMode, heightFraction, fill, cells });

const BASE = {
  version: 1,
  ground: 'light',
  aspect: 0.5625,
  featureCount: 4,
  featureStyle: 'labelOnly',
  ctaShape: 'pill',
  headlineCase: 'upper',
} as const;

interface Fixture {
  label: string;
  spec: unknown;
  reading: string;
  /** Risk codes this template must produce. Empty means it must auto-approve. */
  expect: string[];
}

const FIXTURES: Fixture[] = [
  {
    label: 'Med-SM-11 (control)',
    spec: {
      ...BASE,
      name: 'Med-SM-11',
      headlineEmphasis: ['heavy', 'heavy'],
      rows: [
        row('hug', 'inherit', [cell(['headline', 'accentRule'])]),
        row('hug', 'inherit', [cell(['features'])]),
        row('flex', 'inherit', [cell(['photo', 'contact'])]),
      ],
    },
    reading:
      'There is one photographic region, which is a rectangular photograph with visible ' +
      'edges. There are no buttons. The largest block of type is the headline, which has ' +
      'two lines. Both lines are set in heavy type and in capitals. The poster has three ' +
      'horizontal bands. The first band contains the headline and an accent rule, centered. ' +
      'The second band contains four features, each with a label only, centered. The third ' +
      'band contains a photo and contact information, centered.',
    expect: [],
  },
  {
    label: 'Med-SM-12 (self-consistent, still voids)',
    spec: {
      ...BASE,
      name: 'Med-SM-12',
      headlineEmphasis: ['accent', 'heavy'],
      rows: [
        row('hug', 'inherit', [cell(['headline', 'accentRule'])]),
        row('hug', 'inherit', [cell(['features'])]),
        row('flex', 'accent', [cell(['contact'], 'accent')]),
      ],
    },
    reading:
      'There are no photographic regions on this poster. There are no buttons. The headline ' +
      'is the largest block of type, with two lines, both set in capitals. The first line is ' +
      'in accent color, and the second line is in heavy type. The poster has three horizontal ' +
      'bands: 1) A headline with an accent rule underneath, centered. 2) A row of four ' +
      'features, each with an icon and label only, centered. 3) A contact bar with a phone ' +
      'number and a short sentence, centered.',
    expect: ['hollow-flex-row'],
  },
  {
    label: 'Med-SM-13 (contradicts itself and voids)',
    spec: {
      ...BASE,
      name: 'Med-SM-13',
      headlineEmphasis: ['heavy', 'heavy'],
      rows: [
        row('hug', 'inherit', [cell(['headline'])]),
        row('hug', 'inherit', [cell(['features'])]),
        row('flex', 'dark', [cell(['contact'], 'dark')]),
      ],
    },
    reading:
      'There is one photographic region, which is a rectangular photograph with visible ' +
      'edges. There are no buttons. The headline is the largest block of type, with two ' +
      'lines, both set in heavy type and in capitals. The poster has three horizontal bands. ' +
      'The first band contains the headline, centered. The second band contains features, ' +
      'with four items, each with a label only. The third band contains contact information, ' +
      'centered, with a dark fill.',
    expect: ['photo-count-mismatch', 'hollow-flex-row'],
  },
  {
    label: 'Med-SM-16 (drops a cut-out person into a spacer)',
    spec: {
      ...BASE,
      name: 'Med-SM-16',
      headlineCase: 'sentence',
      headlineEmphasis: ['heavy', 'heavy', 'accent'],
      rows: [
        row('hug', 'inherit', [cell(['logo'])]),
        row('hug', 'inherit', [cell(['headline'])]),
        row('flex', 'inherit', [
          cell(['features'], 'inherit', 44, 'start'),
          cell(['spacer'], 'inherit', 56, 'start'),
        ]),
        row('fixed', 'dark', [cell(['contact'], 'dark')], 0.1),
      ],
    },
    reading:
      'There is one photographic region, which is a person cut out of the background and ' +
      "standing directly on the poster's flat colour. There are no buttons. The largest " +
      'block of type is the headline, which has three lines. The first two lines are set in ' +
      'heavy type, and the third line is in accent colour. The headline is in sentence case. ' +
      'The poster has four horizontal bands. The first band contains the logo, centred. The ' +
      'second band contains the headline, centred. The third band is split into two cells: ' +
      'features on the left and a plain ground on the right, with the boundary at about 44%. ' +
      'The fourth band contains contact information, centred. There are four feature items, ' +
      'each with just a label.',
    expect: ['photo-count-mismatch'],
  },
];

function main(): void {
  console.log('\n=== reading the photo count out of a reading ===');

  check('"There is one photographic region"', readPhotoCountFromReading('There is one photographic region, which is…') === 1);
  check('"There are no photographic regions"', readPhotoCountFromReading('There are no photographic regions on this poster.') === 0);
  check('"There are 2 photographic regions"', readPhotoCountFromReading('There are 2 photographic regions.') === 2);
  // Must not be fooled by the other numbers a reading carries — column splits,
  // line counts, feature counts all appear as digits in the same string.
  check(
    'a reading full of other numbers still reads the right one',
    readPhotoCountFromReading(
      'The band splits at about 44%. There is one photographic region. The headline has 3 lines.',
    ) === 1,
  );
  // Real phrasings from re-reads of the same three templates. The extractor
  // varies its opening verb, and an earlier version of this parser anchored on
  // "there is/are" and reported a correct Med-SM-13 as unreadable.
  check(
    '"The poster has one photographic region"',
    readPhotoCountFromReading('The poster has one photographic region, which is rectangular.') === 1,
  );
  check(
    '"It has two photographic regions"',
    readPhotoCountFromReading('It has two photographic regions.') === 2,
  );
  check(
    'the count is read even mid-sentence',
    readPhotoCountFromReading('Looking at the poster, no photographic regions are present.') === 0,
  );
  check('a reading that never says', readPhotoCountFromReading('A poster with a headline and a footer.') === null);
  check('no reading at all', readPhotoCountFromReading(null) === null);

  console.log('\n=== the four templates that caused this ===');

  for (const fixture of FIXTURES) {
    const spec = normalizeLayoutSpec(posterLayoutSpecSchema.parse(fixture.spec));

    // The premise of the whole file: the structural check clears all four.
    check(
      `${fixture.label}: validateLayoutSpec passes it`,
      validateLayoutSpec(spec).length === 0,
    );

    const codes = assessAutoApproval(spec, fixture.reading).map((risk) => risk.code).sort();
    const wanted = [...fixture.expect].sort();

    check(
      `${fixture.label}: ${wanted.length === 0 ? 'approves itself' : `held back by ${wanted.join(' + ')}`}`,
      codes.join(',') === wanted.join(','),
      codes.length === 0 ? 'no risks' : codes.join(', '),
    );
  }

  console.log('\n=== failing closed ===');

  const clean = normalizeLayoutSpec(posterLayoutSpecSchema.parse(FIXTURES[0]!.spec));
  check(
    'a spec whose reading cannot be parsed is not approved',
    assessAutoApproval(clean, 'The poster looks nice.').some(
      (risk) => risk.code === 'reading-unreadable',
    ),
  );
  check(
    'a spec with no reading at all is not approved',
    assessAutoApproval(clean, null).some((risk) => risk.code === 'reading-unreadable'),
  );

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll auto-approval checks passed.');
  }
}

main();
