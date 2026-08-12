/**
 * Revokes anyone-with-the-link access on reference templates already in Drive.
 *
 * Uploads used to publish every asset, because the poster path has to: Evolution
 * API fetches media server-side with no Google credentials. Reference templates
 * never leave the console, so they are now uploaded unpublished and served
 * through `/api/templates/[templateId]/thumbnail` instead — but that only fixes
 * files uploaded after the change. Anything already in the vault stays readable
 * by anyone who has ever seen its Drive id until this is run.
 *
 * Touches `CategoryTemplate` rows only. Poster files on `ContentCalendar` are
 * left alone deliberately — unpublishing one breaks the send.
 *
 * Usage:
 *   node --env-file=.env scripts/unpublish-templates.mjs [--dry-run]
 */

import { PrismaClient } from '@prisma/client';
import { google } from 'googleapis';

const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive'];

const prisma = new PrismaClient();

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function normalizePrivateKey(raw) {
  return raw
    .replace(/^["']|["']$/g, '')
    .replace(/\\n/g, '\n')
    .trim();
}

function getDriveClient() {
  const auth = new google.auth.JWT({
    email: requireEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
    key: normalizePrivateKey(requireEnv('GOOGLE_PRIVATE_KEY')),
    scopes: DRIVE_SCOPES,
  });
  return google.drive({ version: 'v3', auth });
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const drive = getDriveClient();

  const templates = await prisma.categoryTemplate.findMany({
    select: { id: true, label: true, gDriveFileId: true, category: { select: { name: true } } },
    orderBy: [{ categoryId: 'asc' }, { createdAt: 'asc' }],
  });

  if (templates.length === 0) {
    console.log('No reference templates recorded.');
    return;
  }

  let revoked = 0;
  let alreadyPrivate = 0;
  const problems = [];

  for (const template of templates) {
    const where = `${template.category.name} / ${template.label}`;
    try {
      const permissions = await drive.permissions.list({
        fileId: template.gDriveFileId,
        fields: 'permissions(id, type, role)',
        supportsAllDrives: true,
      });

      // `type: 'anyone'` is the only one that makes a file public. Named users
      // and the domain grant are how the vault's own members reach it, and
      // removing those would lock the operator out of their own library.
      const public_ = (permissions.data.permissions ?? []).filter((p) => p.type === 'anyone');

      if (public_.length === 0) {
        alreadyPrivate += 1;
        continue;
      }

      if (dryRun) {
        console.log(`would revoke  ${where}`);
        revoked += 1;
        continue;
      }

      for (const permission of public_) {
        await drive.permissions.delete({
          fileId: template.gDriveFileId,
          permissionId: permission.id,
          supportsAllDrives: true,
        });
      }
      console.log(`revoked       ${where}`);
      revoked += 1;
    } catch (error) {
      // A file trashed out from under the row, or a transient Drive fault.
      // Reported and stepped over: one unreachable template must not stop the
      // rest of the library from being made private.
      problems.push(`${where}: ${error.message}`);
    }
  }

  console.log(
    `\n${dryRun ? 'Dry run: would revoke' : 'Revoked'} ${revoked}; ${alreadyPrivate} already private; ${templates.length} total.`,
  );
  if (problems.length > 0) {
    console.log('\nProblems:');
    for (const p of problems) console.log(`  - ${p}`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
