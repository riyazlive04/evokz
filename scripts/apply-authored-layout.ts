/**
 * Gives a vertical's templates a hand-authored layout instead of an extracted one.
 *
 * **Why a template would want this.** Extraction exists because an operator can
 * upload any reference and the system has to work out what it is. Evokz's own
 * templates are not that: they are one design reused across every vertical, and
 * the design is known before any file is uploaded. Recovering it from a
 * flattened JPEG — by erasing the words, or by measuring the panels — was tried
 * and failed in both directions, and a spec somebody wrote down cannot fail in
 * either, because it guesses nothing.
 *
 * So this writes the authored spec over whatever was read from the image, and
 * approves it. **Approval is legitimate here in a way it is not for an
 * extraction:** the gate exists because a vision model's confident mistakes look
 * exactly like its correct answers, and there is no vision model in this path.
 * The spec is a fixture, rendered at every preset by `check:layouts` on every
 * run, and reviewed by whoever wrote it.
 *
 * **It also withdraws the plate.** An approved plate wins over the grid, so a
 * template left holding one would keep compositing onto erased artwork and the
 * authored layout would never draw. The plate file and its spec are left in
 * place — only the approval is removed, so nothing is destroyed and re-approving
 * puts it straight back.
 *
 * Every template is snapshotted first, exactly as `autoplate-vertical.ts` does.
 *
 * Run: DATABASE_URL=… scripts/apply-authored-layout.ts \
 *        <vertical> <spec.json> <snapshotDir> [--labels a,b] [--keep-plates]
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

import { Prisma, PrismaClient } from '@prisma/client';

import {
  normalizeLayoutSpec,
  posterLayoutSpecSchema,
  validateLayoutSpec,
} from '@/lib/types/layout-spec';

const prisma = new PrismaClient();

function valueOf(args: string[], flag: string): string | null {
  const hit = args.find((a) => a === flag || a.startsWith(`${flag}=`));
  if (!hit) return null;
  return hit.includes('=')
    ? hit.split('=').slice(1).join('=')
    : (args[args.indexOf(hit) + 1] ?? null);
}

async function main() {
  const args = process.argv.slice(2);
  const keepPlates = args.includes('--keep-plates');

  const labelsValue = valueOf(args, '--labels');
  const labelsIndex =
    labelsValue && !args.some((a) => a.startsWith('--labels=')) ? args.indexOf(labelsValue) : -1;

  const positional = args.filter((a, i) => !a.startsWith('--') && i !== labelsIndex);
  const [vertical, specPath, snapshotDir] = positional;

  if (!vertical || !specPath || !snapshotDir) {
    console.error(
      'Usage: apply-authored-layout.ts <vertical> <spec.json> <snapshotDir> ' +
        '[--labels a,b] [--keep-plates]',
    );
    process.exitCode = 1;
    return;
  }

  const labels = (labelsValue ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  /*
   * Validated before a single row is touched.
   *
   * A spec that cannot render would take every template in the vertical off the
   * rotation at once — `parseLayoutSpec` refuses it and the day fails with
   * `pinned-unreadable`. Far better to refuse here, where nothing has changed.
   */
  const parsed = posterLayoutSpecSchema.safeParse(
    JSON.parse(await readFile(specPath, 'utf8')),
  );
  if (!parsed.success) {
    console.error(
      `${specPath} is not a layout spec:\n` +
        parsed.error.issues
          .slice(0, 5)
          .map((issue) => `  ${issue.path.join('.') || 'spec'}: ${issue.message}`)
          .join('\n'),
    );
    process.exitCode = 1;
    return;
  }

  const spec = normalizeLayoutSpec(parsed.data);
  const problems = validateLayoutSpec(spec);
  if (problems.length > 0) {
    console.error(
      `${specPath} is structurally invalid and would draw nothing:\n` +
        problems.map((p) => `  ${p.path} ${p.message}`).join('\n'),
    );
    process.exitCode = 1;
    return;
  }

  const category = await prisma.category.findFirst({
    where: { name: { equals: vertical, mode: 'insensitive' } },
    select: { id: true, name: true },
  });
  if (!category) {
    console.error(`No vertical called "${vertical}".`);
    process.exitCode = 1;
    return;
  }

  const templates = await prisma.categoryTemplate.findMany({
    where: {
      categoryId: category.id,
      ...(labels.length > 0 ? { label: { in: labels } } : {}),
    },
    orderBy: { label: 'asc' },
    select: {
      id: true,
      label: true,
      layoutSpec: true,
      layoutApprovedAt: true,
      layoutAuthoredAt: true,
      layoutReading: true,
      plateApprovedAt: true,
      paletteSource: true,
    },
  });

  if (templates.length === 0) {
    console.error('No templates matched.');
    process.exitCode = 1;
    return;
  }

  console.log(`${category.name}: applying "${spec.name}" to ${templates.length} template(s)\n`);

  let applied = 0;
  let platesWithdrawn = 0;

  for (const template of templates) {
    const snapshotPath = `${snapshotDir}/${template.label}.layout.json`;
    if (!existsSync(snapshotPath)) {
      const { id: _id, ...columns } = template;
      await writeFile(
        snapshotPath,
        JSON.stringify({ templateId: template.id, saved: true, row: columns }, null, 2),
        'utf8',
      );
    }

    const withdrawing = !keepPlates && template.plateApprovedAt !== null;

    await prisma.categoryTemplate.update({
      where: { id: template.id },
      data: {
        layoutSpec: spec as unknown as Prisma.InputJsonValue,
        layoutApprovedAt: new Date(),
        // What stops "Read layout" quietly replacing this with an extraction.
        layoutAuthoredAt: new Date(),
        // The stored reading described the extraction this replaces. Leaving it
        // would have an operator reading a vision model's account of a spec no
        // model produced.
        layoutReading: `Hand-authored layout "${spec.name}", applied from ${specPath}.`,
        ...(withdrawing ? { plateApprovedAt: null } : {}),
      },
    });

    applied += 1;
    if (withdrawing) platesWithdrawn += 1;

    console.log(
      `  ${template.label.padEnd(12)} layout applied and approved` +
        (withdrawing ? ', plate approval withdrawn' : ''),
    );
  }

  console.log(
    `\n${applied} template(s) now draw "${spec.name}".` +
      (platesWithdrawn > 0
        ? ` ${platesWithdrawn} plate approval(s) withdrawn so the layout is what renders.`
        : ''),
  );
  console.log(`Snapshots in ${snapshotDir}; each holds the columns as they were.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
