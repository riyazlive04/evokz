/**
 * Approves every template in a vertical whose stored layout is sound.
 *
 * The retroactive half of auto-approval. Uploading a template now approves its
 * own extraction, but that only reaches templates uploaded from here on — a
 * vertical filled before the change is still sitting on drafts nobody clicked,
 * and those are exactly the templates an operator wanted in rotation when they
 * uploaded them.
 *
 * **Approves only what would render.** A stored spec goes through
 * `parseLayoutSpec`, which is the same gate the renderer uses: it refuses a
 * shape this build cannot read and a spec `validateLayoutSpec` finds structurally
 * faulty. Approving one of those would put a template in the rotation that draws
 * nothing — a day resolving to it fails `pinned-unreadable` or quietly drops out
 * of the walk — so they are listed for correction instead.
 *
 * **And only what `assessAutoApproval` trusts.** Rendering is the lower bar and
 * on its own it is not enough: a spec that lost its photograph renders a
 * flawless poster that is two thirds empty colour, and the structural check
 * calls it clean. This script exists to sweep a backlog in one command, which is
 * exactly the circumstance where nobody is looking at each one — so it declines
 * those and names them.
 *
 * **It cannot un-approve.** Withdrawing is a judgement about a poster somebody
 * looked at, and the console is where that belongs.
 *
 * Read the renders before running this, not after:
 *
 *     npm run check:fleet -- ./review     # every stored spec, approved or not
 *     npm run layouts:approve Medicals
 *
 * Run: DATABASE_URL=… npx tsx --env-file=.env --tsconfig scripts/tsconfig.json \
 *        scripts/approve-vertical-layouts.ts <vertical> [--dry-run]
 *
 *   <vertical>  the category name, matched case-insensitively. "all" for every one.
 *   --dry-run   report what would change and write nothing.
 */
import { PrismaClient } from '@prisma/client';

import { assessAutoApproval } from '@/lib/poster/layout-risk';
import { parseLayoutDraft } from '@/lib/types/layout-spec';

const prisma = new PrismaClient();

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const name = args
    .filter((arg) => !arg.startsWith('--'))
    .join(' ')
    .trim();

  if (!name) {
    console.error(
      'Name the vertical, or "all": npx tsx --tsconfig scripts/tsconfig.json ' +
        'scripts/approve-vertical-layouts.ts Medicals',
    );
    process.exitCode = 1;
    return;
  }

  const categories =
    name.toLowerCase() === 'all'
      ? await prisma.category.findMany({ select: { id: true, name: true } })
      : await prisma.category.findMany({
          where: { name: { equals: name, mode: 'insensitive' } },
          select: { id: true, name: true },
        });

  if (categories.length === 0) {
    const known = await prisma.category.findMany({ select: { name: true } });
    console.error(
      `No vertical called "${name}". Known: ${known.map((c) => c.name).join(', ')}`,
    );
    process.exitCode = 1;
    return;
  }

  let approved = 0;
  let skipped = 0;

  for (const category of categories) {
    const templates = await prisma.categoryTemplate.findMany({
      where: { categoryId: category.id, layoutApprovedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, label: true, layoutSpec: true, layoutReading: true },
    });

    console.log(`\n${category.name}: ${templates.length} unapproved template(s).`);

    for (const template of templates) {
      // `parseLayoutDraft`, not `parseLayoutSpec`: the strict parse answers only
      // "may this draw?" and returns null for everything it refuses, which would
      // report "no layout" for a draft that is one edit from correct and hide
      // the fault worth naming.
      const draft = parseLayoutDraft(template.layoutSpec);

      if (!draft.spec) {
        skipped += 1;
        console.log(`  skip   ${template.label} — no layout read from it yet.`);
        continue;
      }

      if (draft.problems.length > 0) {
        skipped += 1;
        console.log(
          `  skip   ${template.label} — ` +
            draft.problems.map((p) => `${p.path} ${p.message}`).join('; '),
        );
        continue;
      }

      const risks = assessAutoApproval(draft.spec, template.layoutReading);
      if (risks.length > 0) {
        skipped += 1;
        console.log(
          `  SKIP   ${template.label} — ${risks.map((r) => r.message).join(' ')}`,
        );
        continue;
      }

      approved += 1;
      if (!dryRun) {
        await prisma.categoryTemplate.update({
          where: { id: template.id },
          data: { layoutApprovedAt: new Date() },
        });
      }
      console.log(`  ${dryRun ? 'would' : 'ok   '} ${template.label}`);
    }
  }

  console.log(
    `\n${dryRun ? 'Would approve' : 'Approved'} ${approved}, skipped ${skipped}.` +
      (skipped > 0
        ? ' Skipped templates need a human: open each in the console, render it, and ' +
          'approve it there if it is right.'
        : ''),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
