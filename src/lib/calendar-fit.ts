import { headlineCharBudget } from '@/lib/ai/poster-copy';
import { describeCopyShape, type PosterLayoutSpec } from '@/lib/types/layout-spec';
import { DEFAULT_CTA_LABEL } from '@/lib/types/poster';
import type { TemplateCopyNeeds } from '@/lib/poster/html/template';
import type { PosterCopy } from '@/lib/types/poster';

/**
 * Whether a sheet's row will actually draw in the template it names.
 *
 * **The gap this closes.** `describeLayoutFit` already works out everything
 * below and hands it to the copy model — how many headline lines the template
 * sets, how many characters fit a line, how many feature items it draws. It runs
 * only when `posterCopy` is null, and both the importer and the calendar
 * generator always supply one, so in production it has never executed. The
 * result reached clients: five of seven live days carried a two-line headline
 * into a template whose emphasis pattern is three lines long, so the accent
 * colour the design is built around never appeared, and nothing anywhere said so
 * until somebody looked at a poster.
 *
 * So the same arithmetic runs at import, where it is free and where the person
 * who can fix it is standing in front of the answer. Nothing is rejected — a row
 * that does not fit still imports and still delivers, because a poster with a
 * flat headline is worth more than no poster. It is reported.
 */

export interface FitWarning {
  dayNumber: number;
  templateLabel: string;
  message: string;
}

/**
 * Phrases in an image brief that mean it does not describe a standing person.
 *
 * Only consulted for a template whose photo cell is a `subject`, where the frame
 * is background-removed and composited as a cut-out figure. A brief that asks
 * for something else does not fail loudly — it produces a frame with no salient
 * figure in it, `birefnet` returns an empty or partial matte, and the poster
 * ships with a pair of disembodied hands or nothing at all. Measured on the live
 * sheet: of seven days, one asked for "no people in frame" and rendered empty,
 * two asked for hands only, and one for a seated consultant who came back as an
 * arm.
 *
 * Matched as plain substrings because these are the exact phrases a brief uses;
 * anything cleverer would be guessing at intent this cannot see.
 */
const NOT_A_STANDING_FIGURE = [
  'no people',
  'no one',
  'nobody',
  'hands only',
  'close view of',
  'close-up of',
  'seated at',
  'sitting at',
  'photographed from the side',
];

/**
 * Reports every way one row will disappoint the template it names.
 *
 * Empty means the row draws as designed.
 */
export function checkRowFit(input: {
  dayNumber: number;
  templateLabel: string;
  spec: PosterLayoutSpec;
  copy: PosterCopy | null;
  imagePrompt: string;
  /** Whether the layout's photo cell wants a cut-out figure. */
  wantsSubject: boolean;
  /**
   * The authored template drawing this day, when there is one.
   *
   * Present, it replaces the spec as the authority on shape — because the spec
   * has stopped describing what will be drawn. Two of the checks below then have
   * no subject left: an HTML template takes whatever number of headline lines
   * the copy gives it and reflows, and measures its own type rather than
   * budgeting characters against a column. Leaving them on told operators to
   * rewrite copy that draws perfectly well, which is worse than saying nothing.
   */
  needs?: TemplateCopyNeeds | null;
}): FitWarning[] {
  const warnings: FitWarning[] = [];
  const say = (message: string) =>
    warnings.push({
      dayNumber: input.dayNumber,
      templateLabel: input.templateLabel,
      message,
    });

  if (input.wantsSubject) {
    const brief = input.imagePrompt.toLowerCase();
    const phrase = NOT_A_STANDING_FIGURE.find((candidate) => brief.includes(candidate));
    if (phrase) {
      say(
        `the image brief says "${phrase}", but "${input.templateLabel}" composites a cut-out ` +
          'person. A brief that does not describe one standing person produces an empty or ' +
          'partial figure. Rewrite it as one person, standing, full body, plain background.',
      );
    }
  }

  // Everything below is about copy the sheet supplied. A row deferring its
  // poster block gets `ensurePosterCopy`, which is already shaped by the layout.
  if (!input.copy) return warnings;

  const shape = describeCopyShape(input.spec);
  const lines = input.copy.headlineLines;

  /*
   * The two headline checks only mean anything on the spec renderer.
   *
   * There, `headlineEmphasis` is a fixed-length array and the type size comes
   * from a line count, so a headline of the wrong length genuinely loses the
   * contrast the layout was built around, and an over-long line genuinely wraps
   * and undoes the copy's line breaks. An authored template does neither: it
   * takes the lines it is given, and `data-fit` measures the real type at the
   * real size and shrinks it before letting it wrap.
   */
  if (!input.needs) {
    if (shape.headlineLineCount > 0 && lines.length !== shape.headlineLineCount) {
      say(
        `the headline is ${lines.length} line(s) but "${input.templateLabel}" sets its ` +
          `headline over ${shape.headlineLineCount}, and the emphasis on each line is measured ` +
          'from it — so the contrast the template is built around will not appear.',
      );
    }

    const budget = headlineCharBudget(shape.headlineWidthShare);
    const tooLong = lines.filter((line) => line.length > budget);
    if (tooLong.length > 0) {
      say(
        `${tooLong.length} headline line(s) run past the ${budget} characters that fit this ` +
          `template's column — "${tooLong[0]}" is ${tooLong[0]!.length}. They will wrap, which ` +
          'undoes the line breaks the copy chose.',
      );
    }
  }

  /*
   * This one survives the migration, because it is still true: a template with
   * three cards given four features draws three. Only the source of the number
   * changes — the manifest rather than the spec.
   */
  const featureCount = input.needs ? input.needs.features : shape.featureCount;
  const drawsFeatures = input.needs ? featureCount > 0 : shape.hasFeatures;
  const supplied = input.copy.features.length;

  if (drawsFeatures && supplied > featureCount) {
    say(
      `${supplied} features were supplied but "${input.templateLabel}" draws ` +
        `${featureCount}. The last ${supplied - featureCount} will not appear on the poster.`,
    );
  }

  /*
   * The other half of the same question, and the half that was missing.
   *
   * Too many features is visible on the poster as words that never arrived; too
   * few is visible as a card that never arrived, which is harder to notice and
   * just as wrong. A design built as a four-up given three draws three, evenly
   * spaced, and looks deliberate. Only the sheet knows it was not.
   */
  if (input.needs && featureCount > 0 && supplied < featureCount) {
    say(
      `${supplied} features were supplied but "${input.templateLabel}" is built for ` +
        `${featureCount}. It will draw ${supplied} and the row will not look like the ` +
        'template it names.',
    );
  }

  /*
   * A call to action the template draws and the sheet did not write.
   *
   * `ctaLabel` falls through to a schema default when the column is blank, so
   * the poster does not fail — it goes out saying LEARN MORE, in the one place
   * on these designs where the words are the whole point.
   */
  if (input.needs?.ctaLabel && input.copy.ctaLabel === DEFAULT_CTA_LABEL) {
    say(
      `"${input.templateLabel}" draws a call to action and this row left the CTA label ` +
        `blank, so the poster will read "${DEFAULT_CTA_LABEL}".`,
    );
  }

  return warnings;
}
