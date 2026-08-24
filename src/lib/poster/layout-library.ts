import { prisma } from '@/lib/prisma';
import { parseLayoutSpec, type PosterLayoutSpec } from '@/lib/types/layout-spec';
import { pickForDay } from '@/lib/types/poster';

/**
 * Which layout a given day's poster is drawn in.
 *
 * Every poster comes from a reference template an operator uploaded and approved
 * — there is no built-in composition to fall back on. Two ways a day gets one:
 *
 *   pinned    an imported sheet named the template for that day.
 *   rotation  nothing named one, so the vertical's approved templates are walked
 *             deterministically by day number.
 *
 * Both live here rather than in `ai-pipeline.ts` so the pipeline and the preview
 * route cannot drift apart. The reverse arrangement — the route importing the
 * pipeline for its resolution — dragged fal.ai, Drive and WhatsApp modules into
 * a request that renders a placeholder.
 */

/** One approved template, with the identity a caller needs to report on it. */
export interface CategoryLayout {
  templateId: string;
  label: string;
  spec: PosterLayoutSpec;
}

/**
 * The approved layouts for a vertical, in upload order.
 *
 * **Only approved specs.** `layoutApprovedAt` stays null until an operator has
 * seen the extraction rendered as a poster, and an unreviewed draft must never
 * reach a client: extraction is a vision model reading an image, and its
 * confident misreadings look exactly like its correct answers from here.
 *
 * A ballot rather than a set — duplicates are kept and order is by upload, so a
 * vertical that approves the same composition twice sees it twice as often. A
 * spec this build cannot parse is dropped rather than thrown on, so a shape
 * change degrades one template instead of failing every render for the vertical.
 */
export async function loadCategoryLayouts(categoryId: string): Promise<CategoryLayout[]> {
  const rows = await prisma.categoryTemplate.findMany({
    where: { categoryId, layoutApprovedAt: { not: null } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, label: true, layoutSpec: true },
  });

  const library: CategoryLayout[] = [];
  for (const row of rows) {
    const spec = parseLayoutSpec(row.layoutSpec);
    if (spec) library.push({ templateId: row.id, label: row.label, spec });
  }
  return library;
}

/**
 * Why a day could not be laid out. Each reason maps to a different fix, which is
 * why they are distinct rather than one "no layout" case.
 */
export type LayoutFailure =
  | { reason: 'no-approved-templates' }
  | { reason: 'pinned-missing' | 'pinned-unapproved' | 'pinned-unreadable' | 'pinned-foreign' };

export type LayoutResolution =
  | { ok: true; spec: PosterLayoutSpec; templateId: string; label: string; source: 'pinned' | 'rotation' }
  | ({ ok: false } & LayoutFailure);

/**
 * Resolves one day's layout.
 *
 * **A pin never falls back.** If the named template has been deleted, had its
 * approval withdrawn, moved to another vertical, or its spec has stopped
 * parsing, this fails rather than quietly rotating — a silent fallback makes a
 * pin look honoured when it was not, which is the whole failure this system
 * exists to remove. The rotation is for days that never named a template.
 */
export async function resolveDayLayout(input: {
  categoryId: string;
  dayNumber: number;
  pinnedTemplateId: string | null;
}): Promise<LayoutResolution> {
  if (input.pinnedTemplateId) {
    const template = await prisma.categoryTemplate.findUnique({
      where: { id: input.pinnedTemplateId },
      select: { id: true, label: true, categoryId: true, layoutSpec: true, layoutApprovedAt: true },
    });

    if (!template) return { ok: false, reason: 'pinned-missing' };
    // A client moved between verticals keeps pins into its old one. No foreign
    // key can catch that, so it is checked here.
    if (template.categoryId !== input.categoryId) {
      return { ok: false, reason: 'pinned-foreign' };
    }
    if (template.layoutApprovedAt === null) {
      return { ok: false, reason: 'pinned-unapproved' };
    }

    const spec = parseLayoutSpec(template.layoutSpec);
    if (!spec) return { ok: false, reason: 'pinned-unreadable' };

    return { ok: true, spec, templateId: template.id, label: template.label, source: 'pinned' };
  }

  const library = await loadCategoryLayouts(input.categoryId);
  const chosen = pickForDay(input.dayNumber, library);
  if (!chosen) return { ok: false, reason: 'no-approved-templates' };

  return {
    ok: true,
    spec: chosen.spec,
    templateId: chosen.templateId,
    label: chosen.label,
    source: 'rotation',
  };
}

/**
 * Operator-facing sentence for a resolution failure.
 *
 * Names the surface, the action and the escape hatch, because this text lands in
 * `ContentCalendar.errorMessage` and is read from the dashboard by someone
 * deciding what to do next — not by whoever wrote this file.
 */
export function describeLayoutFailure(
  failure: LayoutFailure,
  context: { categoryId: string; categoryName: string; dayNumber: number },
): string {
  const where = `/admin/verticals/${context.categoryId}`;

  switch (failure.reason) {
    case 'no-approved-templates':
      return (
        `Cannot compose day ${context.dayNumber}: the "${context.categoryName}" vertical has ` +
        'no approved template layout, and every poster is now drawn from one. Open ' +
        `${where}, use "Read layout" on a reference template, check it with "See this ` +
        'template rendered", then "Approve layout".'
      );
    case 'pinned-missing':
      return (
        `Cannot compose day ${context.dayNumber}: the template this day was pinned to no ` +
        `longer exists. Re-import the day naming a current template, or clear the pin to ` +
        `use the "${context.categoryName}" rotation.`
      );
    case 'pinned-unapproved':
      return (
        `Cannot compose day ${context.dayNumber}: the template this day is pinned to has no ` +
        `approved layout. Approve it at ${where}, or re-import the day naming another.`
      );
    case 'pinned-unreadable':
      return (
        `Cannot compose day ${context.dayNumber}: the layout stored for this day's template ` +
        `cannot be read by this build. Re-read and re-approve it at ${where}.`
      );
    case 'pinned-foreign':
      return (
        `Cannot compose day ${context.dayNumber}: this day is pinned to a template belonging ` +
        `to a different vertical, which happens when a client is moved. Re-import the day ` +
        `naming one of "${context.categoryName}"'s templates.`
      );
  }
}
