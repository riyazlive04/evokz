import { prisma } from '@/lib/prisma';
import { parseLayoutSpec, type PosterLayoutSpec } from '@/lib/types/layout-spec';
import { posterArchetypeSchema, type PosterArchetype } from '@/lib/types/poster';

/**
 * The layouts an operator mapped a vertical's reference templates to.
 *
 * The fallback path. A template with an approved `layoutSpec` carries its own
 * geometry and is served by `loadCategoryLayouts` below; this is what answers
 * for the rest — templates uploaded before specs existed, and any whose
 * extraction an operator has not yet reviewed.
 *
 * Satori composes from code and cannot replay a raster image, so on this path
 * the template itself is never an input — what the generator uses is the
 * composition an operator said it represents.
 *
 * **Duplicates are deliberately kept.** The list is a ballot, not a set: eight
 * templates mapped to `diagonal` and two to `curve` produce a campaign in roughly
 * that mix, which is what "follow the templates" means in practice. Deduplicating
 * here would flatten a library's emphasis into a bare list of options.
 *
 * Ordered by upload so the sequence is stable — a template added later shifts the
 * tail rather than reshuffling days already rendered, and those are pinned by
 * `ContentCalendar.posterArchetype` regardless.
 *
 * Unparseable values are dropped rather than thrown on: the column is a free
 * String, and a layout renamed in a later build would otherwise fail every render
 * for that vertical instead of quietly falling back to the day-number rotation.
 */
export async function loadCategoryArchetypes(
  categoryId: string,
): Promise<PosterArchetype[]> {
  const rows = await prisma.categoryTemplate.findMany({
    where: { categoryId, archetype: { not: null } },
    orderBy: { createdAt: 'asc' },
    select: { archetype: true },
  });

  const library: PosterArchetype[] = [];
  for (const row of rows) {
    const parsed = posterArchetypeSchema.safeParse(row.archetype);
    if (parsed.success) library.push(parsed.data);
  }
  return library;
}

/**
 * The approved layout specs for a vertical, in upload order.
 *
 * The preferred generation path. Where `loadCategoryArchetypes` returns "which
 * of our fifteen compositions did somebody say this resembles", this returns the
 * geometry of the templates themselves — so a vertical whose library is fully
 * extracted and approved produces posters laid out like its own references
 * rather than like the built-in set.
 *
 * **Only approved specs are returned.** `layoutApprovedAt` is null until an
 * operator has looked at the extraction beside the template it came from, and an
 * unreviewed draft must never reach a client: extraction is a vision model
 * reading an image, and its confident misreadings look exactly like its correct
 * ones from the database side.
 *
 * The same ballot semantics as the archetype list, and for the same reason —
 * duplicates are kept, order is by upload, and a spec this build cannot parse is
 * dropped rather than thrown on, so a shape change degrades one template to its
 * archetype instead of failing every render for the vertical.
 */
export async function loadCategoryLayouts(
  categoryId: string,
): Promise<PosterLayoutSpec[]> {
  const rows = await prisma.categoryTemplate.findMany({
    where: { categoryId, layoutApprovedAt: { not: null } },
    orderBy: { createdAt: 'asc' },
    select: { layoutSpec: true },
  });

  const library: PosterLayoutSpec[] = [];
  for (const row of rows) {
    const spec = parseLayoutSpec(row.layoutSpec);
    if (spec) library.push(spec);
  }
  return library;
}
