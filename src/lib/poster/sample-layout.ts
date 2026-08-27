import { normalizeLayoutSpec, type PosterLayoutSpec } from '@/lib/types/layout-spec';

/**
 * A layout to render when there is no real one to render.
 *
 * Exactly one surface needs this: the brand panel's poster thumbnail, which
 * exists so an operator can see a palette and a logo applied through the real
 * satori path before spending anything on a client. That preview is about colour
 * and type, not geometry — and it must keep working for a vertical whose
 * templates nobody has approved yet, which is precisely the state a brand is
 * usually tokenised in.
 *
 * Deliberately **not** a replacement for the retired archetypes. Nothing in the
 * generation path may reach for it: a client whose vertical has no approved
 * template gets a loud `[compose]` failure, because silently shipping a built-in
 * layout is how "the poster follows the uploaded template" stops being true.
 *
 * Its name is what makes the fallback visible. The preview route returns it in
 * `X-Poster-Layout`, and the brand panel says in words when this is what you are
 * looking at.
 */
export const SAMPLE_LAYOUT_SPEC: PosterLayoutSpec = normalizeLayoutSpec({
  version: 1,
  name: 'Built-in sample',
  /*
   * Zero, so the thumbnail keeps whatever shape the caller asked for.
   *
   * A real template pins the poster to its own proportions. This one has no
   * proportions to pin — it was never read from an image — and the brand panel
   * that renders it wants a thumbnail at the size it requested, not one this
   * module chose.
   */
  aspect: 0,
  ground: 'light',
  // Stated rather than defaulted: this spec is hand-authored, and a reader
  // comparing it against a rendered thumbnail should not have to know what the
  // schema fills in.
  featureCount: 3,
  featureStyle: 'labelAndBody',
  ctaShape: 'pill',
  accentRuleStyle: 'bar',
  // Empty, so the headline renders through the legacy `accentLineIndex` path —
  // one accent line, everything heavy. This preview is about colour and type,
  // and an emphasis pattern here would be a claim about a template that does
  // not exist.
  headlineEmphasis: [],
  headlineCase: 'upper',
  rows: [
    {
      // Logo, eyebrow, headline, rule and body — the full copy stack, so every
      // token the brand tokenizer produces is visible in one frame.
      sizingMode: 'hug',
      edge: 'none',
      heightFraction: 0,
      fill: 'inherit',
      cells: [
        {
          weight: 100,
          fill: 'inherit',
          align: 'start',
          padded: true,
          photoKind: 'scene',
          surface: 'none',
          backdrop: 'none',
          valign: 'center',
          slots: ['logo', 'eyebrow', 'headline', 'accentRule', 'body'],
        },
      ],
    },
    {
      // The flex row every spec must have. A photograph here shows the accent
      // against a real image rather than against flat colour.
      sizingMode: 'flex',
      edge: 'none',
      heightFraction: 0,
      fill: 'inherit',
      cells: [
        {
          weight: 100,
          fill: 'inherit',
          align: 'center',
          padded: false,
          photoKind: 'scene',
          surface: 'none',
          backdrop: 'none',
          valign: 'center',
          slots: ['photo'],
        },
      ],
    },
    {
      // Dark ground, so `onDark` and `accentOnDark` are exercised too — a
      // palette that reads on light and fails on dark is a common tokenizer
      // outcome and the whole reason to look at a preview.
      sizingMode: 'hug',
      edge: 'none',
      heightFraction: 0,
      fill: 'dark',
      cells: [
        {
          weight: 100,
          fill: 'dark',
          align: 'center',
          padded: true,
          photoKind: 'scene',
          surface: 'none',
          backdrop: 'none',
          valign: 'center',
          slots: ['features'],
        },
      ],
    },
    {
      sizingMode: 'fixed',
      edge: 'none',
      heightFraction: 0.1,
      fill: 'accent',
      cells: [
        {
          weight: 100,
          fill: 'accent',
          align: 'center',
          padded: false,
          photoKind: 'scene',
          surface: 'none',
          backdrop: 'none',
          valign: 'center',
          slots: ['contact'],
        },
      ],
    },
  ],
});
