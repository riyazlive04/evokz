/**
 * Bulk-imports reference posters into the vertical template library.
 *
 * The admin UI uploads one file at a time through the `uploadVerticalTemplate`
 * server action. Seeding ten verticals for a demo is 200 uploads, so this script
 * walks the same path in bulk: same Drive folder layout, same row shape, same
 * caps. It is deliberately a mirror of that action rather than a second way of
 * doing it — if the action changes, this must follow.
 *
 * Usage:
 *   node --env-file=.env scripts/import-vertical-templates.mjs <root> [--dry-run]
 *
 * `<root>` holds one subfolder per vertical. A subfolder is matched to a
 * Category by its exact name, or by the content-library slug (`03-real-estate`).
 * Re-runs are safe: a template whose label already exists in that vertical is
 * skipped rather than duplicated.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

import { PrismaClient } from '@prisma/client';
import { google } from 'googleapis';
import sharp from 'sharp';

// Mirrors the server action's constants. Kept as literals rather than imported
// because that module is TypeScript behind a `@/` alias and this is a plain
// node script — the values are asserted against the action in the README note.
const TEMPLATE_MIME_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
]);
const MAX_TEMPLATE_BYTES = 6 * 1024 * 1024;
const MAX_TEMPLATES_PER_CATEGORY = 100;
// Mirrors src/lib/template-image.ts.
const TEMPLATE_LONG_EDGE = 1600;
const TEMPLATE_QUALITY = 80;

const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive'];

/** Folder slug → Category.name, matching content-library/verticals/. */
const SLUG_TO_CATEGORY = new Map([
  ['01-interior-design', 'Interior Design'],
  ['02-construction', 'Heavy Construction'],
  ['03-real-estate', 'Real Estate'],
  ['04-healthcare-dental', 'Healthcare & Dental Clinics'],
  ['05-fitness-gyms', 'Fitness & Gyms'],
  ['06-restaurants-cafes', 'Restaurants & Cafes'],
  ['07-education-coaching', 'Education & Coaching'],
  ['08-beauty-salon', 'Beauty & Salon'],
  ['09-automotive', 'Automotive Sales & Service'],
  ['10-legal-financial', 'Legal & Financial Services'],
]);

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

let cachedDrive = null;
function getDriveClient() {
  if (cachedDrive) return cachedDrive;
  const auth = new google.auth.JWT({
    email: requireEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
    key: normalizePrivateKey(requireEnv('GOOGLE_PRIVATE_KEY')),
    scopes: DRIVE_SCOPES,
  });
  cachedDrive = google.drive({ version: 'v3', auth });
  return cachedDrive;
}

const escapeQueryValue = (value) => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

async function ensureFolder(name, parentFolderId) {
  const drive = getDriveClient();
  const folderName = name.trim();

  const existing = await drive.files.list({
    q: [
      `name = '${escapeQueryValue(folderName)}'`,
      `mimeType = '${FOLDER_MIME_TYPE}'`,
      `'${escapeQueryValue(parentFolderId)}' in parents`,
      'trashed = false',
    ].join(' and '),
    fields: 'files(id, name)',
    pageSize: 1,
    spaces: 'drive',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  const found = existing.data.files?.[0]?.id;
  if (found) return found;

  const created = await drive.files.create({
    requestBody: { name: folderName, mimeType: FOLDER_MIME_TYPE, parents: [parentFolderId] },
    fields: 'id',
    supportsAllDrives: true,
  });
  if (!created.data.id) throw new Error(`Drive returned no folder id for "${folderName}"`);
  return created.data.id;
}

async function ensureVerticalTemplateFolder(categoryName) {
  const root = await ensureFolder(
    'Vertical Templates',
    requireEnv('GOOGLE_DRIVE_PARENT_FOLDER_ID'),
  );
  return ensureFolder(categoryName, root);
}

const buildDirectDownloadUrl = (fileId) =>
  `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;

async function uploadClientAsset({ folderId, fileName, body, mimeType }) {
  const drive = getDriveClient();

  const created = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId] },
    media: { mimeType, body: Readable.from(body) },
    fields: 'id',
    supportsAllDrives: true,
  });
  const fileId = created.data.id;
  if (!fileId) throw new Error(`Drive returned no file id for "${fileName}"`);

  // No anyone-with-the-link permission, matching the server action: reference
  // templates are served to the console through /api/templates/[id]/thumbnail
  // and must not be readable by anyone holding a Drive id.

  const metadata = await drive.files.get({
    fileId,
    fields: 'id, webViewLink, webContentLink',
    supportsAllDrives: true,
  });

  return {
    fileId,
    viewUrl: metadata.data.webContentLink ?? buildDirectDownloadUrl(fileId),
  };
}

/**
 * Downscales before storing, mirroring src/lib/template-image.ts.
 *
 * Best-effort in the same way: a file sharp cannot decode is uploaded exactly
 * as it was read, because a bulk import of two hundred references should not
 * stop on one malformed-but-viewable PNG.
 */
async function prepareTemplateImage(bytes, mimeType) {
  try {
    const body = await sharp(bytes)
      .rotate()
      .resize({
        width: TEMPLATE_LONG_EDGE,
        height: TEMPLATE_LONG_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: TEMPLATE_QUALITY })
      .toBuffer();
    return { body, mimeType: 'image/webp' };
  } catch (error) {
    console.warn(`  ! could not downscale, storing the original: ${error.message}`);
    return { body: bytes, mimeType };
  }
}

/** Swaps an uploaded filename's extension for the stored format's. */
function templateFileName(original, mimeType) {
  const base = original.replace(/\.[^.]+$/, '') || 'template';
  const extension = mimeType === 'image/webp' ? 'webp' : (mimeType.split('/')[1] ?? 'png');
  return `${base}.${extension}`;
}

/**
 * Best-effort intrinsic size. Display-only in the gallery, and the column is
 * nullable, so an unparseable header costs a size badge and never the import.
 */
function readImageDimensions(bytes) {
  // PNG: IHDR width/height are the two big-endian u32s at offset 16.
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }

  // WebP: RIFF container, then a VP8/VP8L/VP8X chunk with its own encoding.
  if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' &&
      bytes.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = bytes.toString('ascii', 12, 16);
    if (chunk === 'VP8 ') {
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L') {
      const bits = bytes.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') {
      const read24 = (o) => bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16);
      return { width: read24(24) + 1, height: read24(27) + 1 };
    }
    return null;
  }

  // JPEG: walk the marker chain to the frame header that carries the size.
  if (bytes.length >= 4 && bytes.readUInt16BE(0) === 0xffd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      // SOF0-SOF15, excluding the DHT/JPG/DAC markers interleaved in that range.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      }
      offset += 2 + bytes.readUInt16BE(offset + 2);
    }
  }

  return null;
}

async function resolveCategories() {
  const categories = await prisma.category.findMany({
    select: { id: true, name: true, _count: { select: { templates: true } } },
  });
  const byName = new Map(categories.map((c) => [c.name.toLowerCase(), c]));
  return { categories, byName };
}

function matchCategory(folderName, byName) {
  const slugged = SLUG_TO_CATEGORY.get(folderName.toLowerCase());
  if (slugged) return byName.get(slugged.toLowerCase()) ?? null;
  return byName.get(folderName.toLowerCase()) ?? null;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const root = args.find((a) => !a.startsWith('--'));
  if (!root) {
    console.error('Usage: node --env-file=.env scripts/import-vertical-templates.mjs <root> [--dry-run]');
    process.exitCode = 1;
    return;
  }

  const { byName } = await resolveCategories();
  const entries = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory());
  if (entries.length === 0) {
    console.error(`No vertical subfolders found under ${root}`);
    process.exitCode = 1;
    return;
  }

  let imported = 0;
  let skipped = 0;
  const problems = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const category = matchCategory(entry.name, byName);
    if (!category) {
      problems.push(`${entry.name}: no matching vertical in the database`);
      continue;
    }

    const dir = path.join(root, entry.name);
    const files = (await readdir(dir))
      .filter((f) => TEMPLATE_MIME_TYPES.has(path.extname(f).toLowerCase()))
      .sort();

    const existing = new Set(
      (
        await prisma.categoryTemplate.findMany({
          where: { categoryId: category.id },
          select: { label: true },
        })
      ).map((t) => t.label),
    );

    let count = existing.size;
    let addedHere = 0;
    const folderId = dryRun ? null : await ensureVerticalTemplateFolder(category.name);

    for (const fileName of files) {
      const label = fileName.replace(/\.[^.]+$/, '').slice(0, 120) || 'Untitled';
      if (existing.has(label)) {
        skipped += 1;
        continue;
      }
      if (count >= MAX_TEMPLATES_PER_CATEGORY) {
        problems.push(
          `${category.name}: at the ${MAX_TEMPLATES_PER_CATEGORY}-template cap, ${
            files.length - addedHere - existing.size
          } file(s) left on disk`,
        );
        break;
      }

      const filePath = path.join(dir, fileName);
      const { size } = await stat(filePath);
      if (size > MAX_TEMPLATE_BYTES) {
        problems.push(`${fileName}: ${(size / 1024 / 1024).toFixed(1)} MB exceeds the 6 MB limit`);
        continue;
      }

      const mimeType = TEMPLATE_MIME_TYPES.get(path.extname(fileName).toLowerCase());

      if (dryRun) {
        count += 1;
        addedHere += 1;
        imported += 1;
        continue;
      }

      const bytes = await readFile(filePath);
      const stored = await prepareTemplateImage(bytes, mimeType);
      // Measured from what is stored, not what was read off disk, so the
      // gallery's size badge describes the file in Drive.
      const dimensions = readImageDimensions(stored.body);
      const uploaded = await uploadClientAsset({
        folderId,
        fileName: templateFileName(fileName, stored.mimeType),
        body: stored.body,
        mimeType: stored.mimeType,
      });

      await prisma.categoryTemplate.create({
        data: {
          categoryId: category.id,
          label,
          gDriveFileId: uploaded.fileId,
          gDriveViewUrl: uploaded.viewUrl,
          mimeType: stored.mimeType,
          width: dimensions?.width ?? null,
          height: dimensions?.height ?? null,
        },
      });

      count += 1;
      addedHere += 1;
      imported += 1;
    }

    console.log(
      `${category.name.padEnd(34)} +${String(addedHere).padStart(2)}  → ${count}/${MAX_TEMPLATES_PER_CATEGORY}`,
    );
  }

  console.log(
    `\n${dryRun ? 'Dry run: would import' : 'Imported'} ${imported} template(s); ${skipped} already present.`,
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
