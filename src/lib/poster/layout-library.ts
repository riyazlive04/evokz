import { prisma } from '@/lib/prisma';
import { parseLayoutSpec, type PosterLayoutSpec } from '@/lib/types/layout-spec';
import { parsePlateSpec, type PosterPlateSpec } from '@/lib/types/plate-spec';
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
  plate: ResolvedPlate | null;
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
    select: { id: true, label: true, layoutSpec: true, ...PLATE_COLUMNS },
  });

  const library: CategoryLayout[] = [];
  for (const row of rows) {
    const spec = parseLayoutSpec(row.layoutSpec);
    if (spec) {
      library.push({ templateId: row.id, label: row.label, spec, plate: readPlate(row) });
    }
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

/**
 * The clean plate a resolved day should be composited onto, when it has one.
 *
 * Carried beside the spec rather than instead of it: the spec is still what the
 * copy stage is shaped by and what the day falls back to if the plate's own spec
 * stops parsing. Null means this template renders on the grid path, which is
 * every template until someone uploads a plate for it.
 */
export interface ResolvedPlate {
  spec: PosterPlateSpec;
  driveFileId: string;
  mimeType: string;
  useTemplatePalette: boolean;
}

export type LayoutResolution =
  | {
      ok: true;
      spec: PosterLayoutSpec;
      templateId: string;
      label: string;
      source: 'pinned' | 'rotation';
      plate: ResolvedPlate | null;
    }
  | ({ ok: false } & LayoutFailure);

/**
 * Reads a row's plate, or null.
 *
 * **Approval is checked here and separately from the layout's.** The two gates
 * describe different artefacts and can be right or wrong independently: a
 * template may have a sound grid and a plate whose headline box sits across
 * somebody's face. An unapproved plate silently falls the day back to the grid
 * rather than failing it, which is the opposite of how a *pinned template* fails
 * — and deliberately, because there the operator named something specific and a
 * silent substitution would hide that, whereas here the grid is a legitimate way
 * to draw the same template.
 */
function readPlate(row: {
  plateSpec: unknown;
  plateDriveFileId: string | null;
  plateApprovedAt: Date | null;
  paletteSource: string;
}): ResolvedPlate | null {
  if (!row.plateDriveFileId || row.plateApprovedAt === null) return null;

  const spec = parsePlateSpec(row.plateSpec);
  if (!spec) return null;

  return {
    spec,
    driveFileId: row.plateDriveFileId,
    // Plates are stored as uploaded; PNG is the only format that carries the
    // alpha this path depends on, and `prepareTemplateImage` is not used for
    // them for exactly that reason — it re-encodes to WebP.
    mimeType: 'image/png',
    useTemplatePalette: row.paletteSource === 'template',
  };
}

/** Columns every plate read needs. Kept in one place so the two queries agree. */
const PLATE_COLUMNS = {
  plateSpec: true,
  plateDriveFileId: true,
  plateApprovedAt: true,
  paletteSource: true,
} as const;

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
      select: {
        id: true,
        label: true,
        categoryId: true,
        layoutSpec: true,
        layoutApprovedAt: true,
        ...PLATE_COLUMNS,
      },
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

    return {
      ok: true,
      spec,
      templateId: template.id,
      label: template.label,
      source: 'pinned',
      plate: readPlate(template),
    };
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
    plate: chosen.plate,
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
