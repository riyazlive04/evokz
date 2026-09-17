/**
 * Reads the elements of every template that has none — the backfill for clone mode.
 *
 * Uploads read a template's elements as they store it (`uploadVerticalTemplate`),
 * and a card can read one on demand ("Read now"). Templates uploaded before
 * either existed carry no reading, and a vertical of them is a lot of clicking,
 * so this reads them all in one pass through exactly the path the console uses —
 * `refreshTemplateElements` — so a template read here is stored, and fails,
 * exactly as one read from its card.
 *
 * **A failed read keeps what was there.** On `--all`, a template whose re-read
 * fails keeps its previous reading and only records the error; see
 * `elementsUpdateData`.
 *
 * **Re-reading is not free of consequences.** A reading is non-deterministic, so
 * `--all` can renumber a template's elements, and campaign days copy their words
 * from those elements by id. Reach for it deliberately, not as a routine sweep.
 *
 * Sequential on purpose: each template is one vision call on the platform key,
 * billed to the ledger as `template-elements`, and a burst that trips a rate limit
 * halfway leaves a library harder to reason about than a slow run.
 *
 * **It writes and spends, so it asks first.** Without `--yes` it prints the
 * database it is pointed at (host and name, never credentials) and how many
 * templates it would read, then exits 2 without reading anything.
 *
 * Run: npm run templates:read-elements -- [--all] [--category <categoryId>] --yes
 *
 *   --all                  re-read templates that already have a reading too
 *   --category <id>        only this vertical's templates (also --category=<id>)
 *   --yes                  actually read and store (one billed vision call each)
 */
import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { refreshTemplateElements } from '@/lib/templates/elements-reading';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const USAGE = 'Usage: npm run templates:read-elements -- [--all] [--category <categoryId>] --yes';

function parseArgs(args: readonly string[]): {
  all: boolean;
  yes: boolean;
  categoryId: string | null;
  problem: string | null;
} {
  const all = args.includes('--all');
  const yes = args.includes('--yes');
  let categoryId: string | null = null;

  for (const [index, arg] of args.entries()) {
    if (arg === '--category') categoryId = args[index + 1] ?? '';
    else if (arg.startsWith('--category=')) categoryId = arg.slice('--category='.length);
  }

  const known = new Set(['--all', '--yes', '--category']);
  const unknown = args.filter(
    (arg, index) =>
      arg.startsWith('--') ? !known.has(arg) && !arg.startsWith('--category=') : args[index - 1] !== '--category',
  );

  if (unknown.length > 0) return { all, yes, categoryId, problem: `Unknown argument(s): ${unknown.join(' ')}` };
  if (categoryId !== null && !UUID_PATTERN.test(categoryId)) {
    return { all, yes, categoryId, problem: `--category needs a vertical id (a UUID), got "${categoryId}".` };
  }
  return { all, yes, categoryId, problem: null };
}

/** "evokz_ai_dev @ localhost:5434" — host, port and database name only, never credentials. */
function describeDatabase(): string {
  try {
    const url = new URL(process.env.DATABASE_URL ?? '');
    const database = url.pathname.replace(/^\//, '') || '?';
    return `${database} @ ${url.hostname || '?'}${url.port ? `:${url.port}` : ''}`;
  } catch {
    return 'unknown (DATABASE_URL is not set or not a URL)';
  }
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

async function main() {
  const { all, yes, categoryId, problem } = parseArgs(process.argv.slice(2));
  if (problem) {
    console.error(`${problem}\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Database: ${describeDatabase()}`);

  if (categoryId) {
    const category = await prisma.category.findUnique({ where: { id: categoryId }, select: { id: true } });
    if (!category) {
      console.error(`No vertical with id ${categoryId}.`);
      process.exitCode = 1;
      return;
    }
  }

  const templates = await prisma.categoryTemplate.findMany({
    where: {
      ...(categoryId ? { categoryId } : {}),
      // `AnyNull`: a database NULL and a JSON null both mean "never read".
      ...(all ? {} : { elements: { equals: Prisma.AnyNull } }),
    },
    orderBy: [{ category: { name: 'asc' } }, { createdAt: 'asc' }],
    select: { id: true, label: true, category: { select: { name: true } } },
  });

  if (templates.length === 0) {
    console.log(all ? 'No templates to read.' : 'Every template already has a reading. Use --all to re-read.');
    return;
  }

  if (!yes) {
    console.log(
      `Would read the elements of ${templates.length} template(s)${all ? ', re-reading any already read' : ''}: ` +
        'one billed vision call each, stored on the template.',
    );
    console.error(`Nothing was read. Check the database above, then add --yes to proceed.\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  console.log(`Reading the elements of ${templates.length} template(s)${all ? ', re-reading any already read' : ''}.\n`);

  const started = Date.now();
  let read = 0;
  let failed = 0;
  let vertical: string | null = null;

  for (const template of templates) {
    if (template.category.name !== vertical) {
      vertical = template.category.name;
      console.log(vertical);
    }

    const began = Date.now();
    try {
      const outcome = await refreshTemplateElements(template.id);
      const took = seconds(Date.now() - began);
      if (!outcome) {
        failed += 1;
        console.log(`  ${template.label} → deleted while being read (${took})`);
      } else if (outcome.reading.ok) {
        read += 1;
        console.log(
          `  ${template.label} → ${outcome.reading.summary} [${outcome.reading.doc.elements.length} elements, ${took}]`,
        );
      } else {
        failed += 1;
        console.log(`  ${template.label} → FAILED: ${outcome.reading.error} (${took})`);
      }
    } catch (error) {
      // Only the database can throw here; the read itself never does.
      failed += 1;
      console.log(`  ${template.label} → FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`\nDone in ${seconds(Date.now() - started)}. ${read} read, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
