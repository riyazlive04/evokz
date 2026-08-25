/**
 * Reads the layout of every template in a vertical that has never had one read.
 *
 * The console does this one card at a time, which is the right shape when an
 * operator is uploading a template and reviewing the result. It is the wrong
 * shape for a vertical that was filled before extraction existed: Constructions'
 * templates were uploaded and "Read layout" was never pressed, so they carry no
 * `layoutSpec` at all — and a template with no spec cannot be approved, cannot
 * enter the rotation, and cannot be composited onto a plate either, since
 * `loadCategoryLayouts` filters on `layoutApprovedAt` before it looks at the
 * plate.
 *
 * **A clean first read is approved automatically**, matching what an upload now
 * does. A draft with structural problems is not: `parseLayoutSpec` refuses it at
 * render time, so approving one would put a template in the rotation that never
 * draws. Those are listed for correction.
 *
 * **A re-read under `--all` is never approved**, and that asymmetry is the point.
 * A first read is a template that could not be used at all, so approving it can
 * only add. A re-read replaces geometry that is already drawing live posters,
 * with a non-deterministic result — that is the one case still worth a human
 * looking, and it leaves the template withdrawn until somebody does.
 *
 * Costs one vision call per template, billed to the platform key.
 *
 * Run: DATABASE_URL=… OPENAI_API_KEY=… npx tsx --env-file=.env \
 *        --tsconfig scripts/tsconfig.json scripts/read-vertical-layouts.ts <vertical> [--all]
 *
 *   <vertical>  the category name, matched case-insensitively ("Constructions")
 *   --all       re-read every template, not only those with no spec. Extraction
 *               is non-deterministic, so this changes posters that are already
 *               approved — it clears their approval, and every calendar day
 *               pinned to one fails `pinned-unapproved` until it is approved
 *               again. See the note in the memory on re-reading.
 */
import { Prisma, PrismaClient } from '@prisma/client';

import { extractLayoutSpec } from '@/lib/ai/layout-extractor';
import { downloadDriveFile } from '@/lib/google-drive';
import { readImageDimensions } from '@/lib/poster/image-info';

const prisma = new PrismaClient();

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  // Only a first read approves itself. See the header.
  const approveClean = !all;
  const name = args.filter((arg) => !arg.startsWith('--')).join(' ').trim();

  if (!name) {
    console.error(
      'Name the vertical: npx tsx --tsconfig scripts/tsconfig.json ' +
        'scripts/read-vertical-layouts.ts Constructions',
    );
    process.exitCode = 1;
    return;
  }

  const category = await prisma.category.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
    select: { id: true, name: true },
  });

  if (!category) {
    const known = await prisma.category.findMany({ select: { name: true } });
    console.error(
      `No vertical called "${name}". Known: ${known.map((c) => c.name).join(', ')}`,
    );
    process.exitCode = 1;
    return;
  }

  const templates = await prisma.categoryTemplate.findMany({
    where: {
      categoryId: category.id,
      // `AnyNull`, not `DbNull`: the column is free-form Json, and a row whose
      // extraction failed at upload carries a database NULL while one written by
      // an older path may carry a JSON null. Both mean "never read".
      ...(all ? {} : { layoutSpec: { equals: Prisma.AnyNull } }),
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      label: true,
      gDriveFileId: true,
      mimeType: true,
      width: true,
      height: true,
    },
  });

  if (templates.length === 0) {
    console.log(`${category.name}: nothing to read.`);
    return;
  }

  console.log(`${category.name}: reading ${templates.length} template(s).\n`);

  let failed = 0;

  // Sequential on purpose. Vision calls are rate-limited per key and this runs
  // against a live vertical; a burst that trips a 429 halfway leaves a mixed
  // state that is harder to reason about than a slow run.
  for (const template of templates) {
    process.stdout.write(`  ${template.label} … `);

    try {
      const bytes = await downloadDriveFile(template.gDriveFileId);
      const measured = readImageDimensions(bytes);

      const draft = await extractLayoutSpec({
        bytes,
        mimeType: template.mimeType,
        label: template.label,
        width: measured?.width ?? template.width,
        height: measured?.height ?? template.height,
      });

      await prisma.categoryTemplate.update({
        where: { id: template.id },
        data: {
          layoutSpec: draft.spec,
          layoutReading: draft.reading,
          // Cleared on a re-read even when it was set: the approval on file
          // refers to the spec this one replaced.
          layoutApprovedAt:
            approveClean && draft.problems.length === 0 ? new Date() : null,
        },
      });

      const problems = draft.problems.length;
      console.log(
        problems > 0
          ? `read with ${problems} problem(s) to correct, left unapproved: ` +
              draft.problems.map((p) => `${p.path} ${p.message}`).join('; ')
          : approveClean
            ? 'read and approved — in the rotation'
            : 'read — re-reads are left unapproved, approve it in the console',
      );
    } catch (error) {
      failed += 1;
      console.log(`FAILED — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(
    `\nDone. ${templates.length - failed} read, ${failed} failed. ` +
      'Nothing is approved: open the vertical, check each with "See this template ' +
      'rendered", then approve.',
  );

  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
