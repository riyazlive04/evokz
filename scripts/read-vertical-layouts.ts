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
 * does. Two things stop that: a structural problem, which `parseLayoutSpec`
 * refuses at render time anyway, and a risk from `assessAutoApproval` — a spec
 * that renders perfectly well and is wrong, such as one that contradicts its own
 * reading about how many photographs the poster has. Both are listed.
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
 *   --labels a,b re-read exactly these templates by name, whatever state they are
 *               in. The surgical form of `--all`, and the one to reach for when a
 *               named template has gone wrong: `--all` on a vertical of
 *               seventeen would withdraw the fourteen that are fine along with
 *               the three that are not, taking the whole rotation down to fix a
 *               fifth of it.
 */
import { Prisma, PrismaClient } from '@prisma/client';

import { extractLayoutSpec } from '@/lib/ai/layout-extractor';
import { downloadDriveFile } from '@/lib/google-drive';
import { assessAutoApproval } from '@/lib/poster/layout-risk';
import { readImageDimensions } from '@/lib/poster/image-info';

const prisma = new PrismaClient();

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes('--all');

  const labelsArg = args.find((arg) => arg.startsWith('--labels'));
  const labels = labelsArg
    ? (labelsArg.includes('=') ? labelsArg.split('=').slice(1).join('=') : (args[args.indexOf(labelsArg) + 1] ?? ''))
        .split(',')
        .map((label) => label.trim())
        .filter(Boolean)
    : [];

  /*
   * Only a first read approves itself. See the header.
   *
   * A named re-read counts as a re-read: the template is already in the
   * rotation, and the whole reason for naming it is that what it draws is wrong,
   * so the last thing this should do is put a fresh unexamined spec straight
   * back into production.
   */
  const approveClean = !all && labels.length === 0;
  // The value of `--labels x,y` is a bare argument too; drop it before the rest
  // is read as the vertical's name, or "Medicals Med-SM-12,Med-SM-13" is looked up.
  const labelValueIndex = labelsArg && !labelsArg.includes('=') ? args.indexOf(labelsArg) + 1 : -1;
  const name = args
    .filter((arg, index) => !arg.startsWith('--') && index !== labelValueIndex)
    .join(' ')
    .trim();

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
      // Named templates are read whatever state they are in — that is the point
      // of naming them.
      ...(labels.length > 0
        ? { label: { in: labels } }
        : all
          ? {}
          : // `AnyNull`, not `DbNull`: the column is free-form Json, and a row
            // whose extraction failed at upload carries a database NULL while one
            // written by an older path may carry a JSON null. Both mean "never
            // read".
            { layoutSpec: { equals: Prisma.AnyNull } }),
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

  // A typo in a label would otherwise read the templates that did match and say
  // nothing about the one that did not, which on a three-template repair reads
  // as success.
  const missing = labels.filter(
    (label) => !templates.some((template) => template.label === label),
  );
  if (missing.length > 0) {
    console.error(`No template in ${category.name} called: ${missing.join(', ')}`);
    process.exitCode = 1;
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
            approveClean &&
            draft.problems.length === 0 &&
            assessAutoApproval(draft.spec, draft.reading).length === 0
              ? new Date()
              : null,
        },
      });

      const problems = draft.problems.map((p) => `${p.path} ${p.message}`);
      const risks = assessAutoApproval(draft.spec, draft.reading).map((r) => r.message);

      console.log(
        problems.length > 0
          ? `read with ${problems.length} problem(s), left unapproved: ${problems.join('; ')}`
          : risks.length > 0
            ? `read but NOT approved — ${risks.join(' ')}`
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
