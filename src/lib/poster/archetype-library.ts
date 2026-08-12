import { prisma } from '@/lib/prisma';
import { posterArchetypeSchema, type PosterArchetype } from '@/lib/types/poster';

/**
 * The layouts an operator mapped a vertical's reference templates to.
 *
 * This is how an uploaded reference poster reaches the renderer. Satori composes
 * from code and cannot replay a raster image, so the template itself is never an
 * input — what the generator uses is the composition an operator said it
 * represents.
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
