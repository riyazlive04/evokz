/**
 * Saves and restores every column of a `CategoryTemplate` that an experiment
 * touches, so trying something on a live template is reversible exactly rather
 * than approximately.
 *
 * **Written because "we can revert it" is worth nothing without a record of what
 * to revert to.** The columns involved — a layout spec, a plate spec, two
 * approval stamps, a palette choice, a Drive file id — are not reconstructable
 * from memory once they have been overwritten, and re-running the extractor does
 * not reproduce them either: extraction is non-deterministic, so a "restore" by
 * re-reading gives a different template than the one that was there.
 *
 * Restores the *stored* state, not the *rendered* one. A snapshot taken after a
 * bad edit faithfully restores the bad edit — take it before.
 *
 * The plate's Drive file is deliberately never trashed. A restore that deleted
 * it would make the snapshot one-shot: point the row back at a plate whose bytes
 * are gone and the template is worse off than if nothing had been tried. Drive
 * clutter is the cheaper mistake.
 *
 * Run:
 *   … scripts/template-snapshot.ts save    <templateId> <file.json>
 *   … scripts/template-snapshot.ts restore <templateId> <file.json>
 */
import { readFile, writeFile } from 'node:fs/promises';

import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Everything an experiment can change about a template.
 *
 * Deliberately not `select: undefined` — a snapshot of every column would carry
 * `createdAt` and the category id, and restoring those either fails or lies.
 * This is the mutable surface and nothing else.
 */
const COLUMNS = {
  label: true,
  layoutSpec: true,
  layoutReading: true,
  layoutApprovedAt: true,
  plateDriveFileId: true,
  plateViewUrl: true,
  plateWidth: true,
  plateHeight: true,
  plateSpec: true,
  plateApprovedAt: true,
  paletteSource: true,
} as const;

async function main() {
  const [mode, templateId, file] = process.argv.slice(2);

  if (!mode || !templateId || !file || (mode !== 'save' && mode !== 'restore')) {
    console.error(
      'Usage: template-snapshot.ts save|restore <templateId> <file.json>',
    );
    process.exitCode = 1;
    return;
  }

  if (mode === 'save') {
    const row = await prisma.categoryTemplate.findUnique({
      where: { id: templateId },
      select: COLUMNS,
    });
    if (!row) {
      console.error('No template with that id.');
      process.exitCode = 1;
      return;
    }

    await writeFile(file, JSON.stringify({ templateId, saved: true, row }, null, 2), 'utf8');
    console.log(`saved ${row.label} → ${file}`);
    console.log(
      `  layout approved=${row.layoutApprovedAt ? 'yes' : 'no'}  ` +
        `plate=${row.plateDriveFileId ? 'yes' : 'none'} approved=${row.plateApprovedAt ? 'yes' : 'no'}  ` +
        `palette=${row.paletteSource}`,
    );
    return;
  }

  const snapshot = JSON.parse(await readFile(file, 'utf8')) as {
    templateId: string;
    row: Record<string, unknown>;
  };

  // A snapshot restored onto a different template would silently overwrite it
  // with another template's geometry, which is the one mistake this tool must
  // not make quietly.
  if (snapshot.templateId !== templateId) {
    console.error(
      `That snapshot is for ${snapshot.templateId}, not ${templateId}. Refusing.`,
    );
    process.exitCode = 1;
    return;
  }

  const row = snapshot.row;
  const jsonOrNull = (value: unknown) =>
    value === null || value === undefined
      ? Prisma.DbNull
      : (value as Prisma.InputJsonValue);
  const dateOrNull = (value: unknown) => (typeof value === 'string' ? new Date(value) : null);

  await prisma.categoryTemplate.update({
    where: { id: templateId },
    data: {
      layoutSpec: jsonOrNull(row.layoutSpec),
      layoutReading: (row.layoutReading as string | null) ?? null,
      layoutApprovedAt: dateOrNull(row.layoutApprovedAt),
      plateDriveFileId: (row.plateDriveFileId as string | null) ?? null,
      plateViewUrl: (row.plateViewUrl as string | null) ?? null,
      plateWidth: (row.plateWidth as number | null) ?? null,
      plateHeight: (row.plateHeight as number | null) ?? null,
      plateSpec: jsonOrNull(row.plateSpec),
      plateApprovedAt: dateOrNull(row.plateApprovedAt),
      paletteSource: (row.paletteSource as string | undefined) ?? 'client',
    },
  });

  console.log(`restored ${row.label} from ${file}`);
  console.log(
    `  layout approved=${row.layoutApprovedAt ? 'yes' : 'no'}  ` +
      `plate=${row.plateDriveFileId ? 'yes' : 'none'} approved=${row.plateApprovedAt ? 'yes' : 'no'}  ` +
      `palette=${row.paletteSource}`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
