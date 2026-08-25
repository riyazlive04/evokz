import {
  countPhotoSlots,
  type LayoutSlot,
  type PosterLayoutSpec,
} from '@/lib/types/layout-spec';

/**
 * Faults that make a spec unsafe to approve without a human, but that
 * `validateLayoutSpec` calls clean.
 *
 * **Why this is a second file rather than more rules in `validateLayoutSpec`.**
 * That function answers "may this draw a poster at all?", and everything it
 * refuses is refused at render time too — a spec failing it is inert. These are
 * different: every spec below renders happily, produces a 1080×1920 PNG at the
 * right aspect, and is wrong. They are questions about whether the *extraction*
 * can be trusted, not about whether the geometry is legal, and the only
 * consumer is the auto-approval gate. Putting them in `validateLayoutSpec` would
 * take existing approved templates out of rotation retroactively, which is a
 * much larger blast radius than declining to approve a new one.
 *
 * **Measured against the real library, not imagined.** Across 31 stored
 * templates on 2026-08-25: 28 consistent, 2 mismatched, 1 unparseable reading;
 * separately, 2 with a hollow flex row. The two sets overlap in one template and
 * miss each other in two, which is the whole reason both checks exist — either
 * one alone still lets a void poster through. Med-SM-12 is self-consistent and
 * voids; Med-SM-16 has an absorbing flex row and drops a person.
 */

export interface LayoutRisk {
  /** Stable, for logs and for a script to group on. */
  code: 'photo-count-mismatch' | 'reading-unreadable' | 'hollow-flex-row';
  message: string;
}

/**
 * Slots that carry no typographic mass of their own in a flex row.
 *
 * `contact` is the surprising member and the reason this list exists.
 * `ContactBar` is full-bleed and, unlike `photo`, is given `flexGrow: 0` by the
 * renderer (see `SELF_BLEEDING` in layout-render.tsx) — so a flex row holding
 * only a contact bar expands to eat every remaining pixel, paints its fill
 * across all of it, and centres a phone number in the middle of the slab.
 *
 * `spacer` and `accentRule` are here for the obvious reason: neither is content.
 */
const WEIGHTLESS: ReadonlySet<LayoutSlot> = new Set<LayoutSlot>([
  'contact',
  'spacer',
  'accentRule',
]);

/**
 * The photograph count the model asserted in its own reading.
 *
 * The extractor is told to state this first — see the `reading` field's
 * description in layout-extractor.ts — precisely so it commits to a number
 * before it starts emitting geometry. That makes the sentence a free assertion
 * to check the geometry against, and the two disagreeing means the model
 * contradicted itself inside one response.
 *
 * Null when no such sentence can be found, which is **not** the same as zero and
 * must not be treated as agreement — see `assessAutoApproval`.
 */
export function readPhotoCountFromReading(reading: string | null): number | null {
  if (!reading) return null;

  const words: Record<string, number> = {
    no: 0,
    none: 0,
    zero: 0,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
  };

  // "There is one photographic region", "There are no photographic regions",
  // "There are 2 photographic regions". The count sits between the verb and the
  // noun, so anchor on both rather than grabbing the first number in the string
  // — a reading also quotes column percentages and line counts.
  const match = reading
    .toLowerCase()
    .match(/there (?:is|are)\s+(\d+|no|none|zero|one|two|three|four|five)\s+photographic\s+region/);

  if (!match?.[1]) return null;

  const token = match[1];
  const numeric = Number.parseInt(token, 10);
  return Number.isFinite(numeric) ? numeric : (words[token] ?? null);
}

/**
 * Everything that should stop a spec approving itself.
 *
 * Empty means the extraction agrees with itself and the geometry can absorb its
 * own slack — which is 28 of the 31 templates measured, so the gate stays open
 * for the overwhelming majority and closes exactly where it was demonstrably
 * needed.
 */
export function assessAutoApproval(
  spec: PosterLayoutSpec,
  reading: string | null,
): LayoutRisk[] {
  const risks: LayoutRisk[] = [];

  const declared = readPhotoCountFromReading(reading);
  const actual = countPhotoSlots(spec);

  if (declared === null) {
    /*
     * Fail closed.
     *
     * "Cannot tell" is not "fine". The check exists because the model
     * contradicts itself, and a reading this cannot parse is the one case where
     * there is no way to know whether it did — treating that as agreement would
     * open the gate widest exactly where the evidence is thinnest.
     */
    risks.push({
      code: 'reading-unreadable',
      message:
        'the model’s reading does not state how many photographs it saw, so the spec ' +
        'cannot be checked against it.',
    });
  } else if (declared !== actual) {
    risks.push({
      code: 'photo-count-mismatch',
      message:
        `the model said it saw ${declared} photograph(s) and then emitted ${actual} photo ` +
        'slot(s) in the same response. One of the two is wrong and only a human can say ' +
        'which.',
    });
  }

  /*
   * A flex row with nothing in it that can hold the space open.
   *
   * `validateLayoutSpec` requires at least one flex row so that overflow has
   * somewhere to go, and `LAYOUT_SIZING_MODES` says the photo row is the natural
   * one. When the extractor drops the photograph, the requirement is still met
   * by whatever row is left — and if that row holds only a contact bar it
   * becomes a coloured slab with a phone number floating in the middle of it.
   * Two of the 31 templates were in exactly this state.
   *
   * Only when the spec has no photograph anywhere: a spec that kept its photo
   * has the row the invariant was written for, and a hollow *second* flex row
   * beside it just shares the leftovers.
   */
  if (actual === 0) {
    for (const [index, row] of spec.rows.entries()) {
      if (row.sizingMode !== 'flex') continue;

      const slots = row.cells.flatMap((cell) => cell.slots);
      if (slots.length === 0) continue;
      if (!slots.every((slot) => WEIGHTLESS.has(slot))) continue;

      risks.push({
        code: 'hollow-flex-row',
        message:
          `row ${index + 1} is the row that absorbs leftover space and holds only ` +
          `${slots.join(', ')} — with no photograph anywhere in the layout it will render ` +
          'as an empty band of colour taking most of the poster.',
      });
    }
  }

  return risks;
}
