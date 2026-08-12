import { Readable } from 'node:stream';

import { google, type drive_v3 } from 'googleapis';

import { normalizePrivateKey, requireEnv } from '@/lib/env';

/**
 * Google Drive access through the single central service account.
 *
 * All calls set `supportsAllDrives` so the same code path works whether the
 * vault lives in the service account's own My Drive or in a Shared Drive.
 */

const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive'];
const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

export interface DriveUploadInput {
  folderId: string;
  fileName: string;
  body: Buffer;
  mimeType: string;
  /**
   * Grant anyone-with-the-link reader access. Defaults to true.
   *
   * True is required for anything Evolution API has to fetch — it pulls poster
   * media server-side carrying no Google credentials, so an unpublished file
   * comes back as a login page and the send fails. It is *wrong* for anything
   * that never leaves the console: a published file is readable by anyone who
   * ever sees its id, and Drive ids leak through screenshots, logs and browser
   * history. Pass false there and serve the bytes through an authenticated
   * route instead.
   */
  publish?: boolean;
}

export interface DriveUploadResult {
  fileId: string;
  /**
   * Direct-download link, suitable for handing to Evolution API as media —
   * but only when the file was published. On an unpublished upload the URL is
   * still well-formed and still resolves for a signed-in vault member; an
   * anonymous fetch gets Google's login page.
   */
  viewUrl: string;
  webViewLink: string | null;
  thumbnailLink: string | null;
}

let cachedDrive: drive_v3.Drive | null = null;

/** Authenticated Drive v3 client, memoised per process. */
export function getDriveClient(): drive_v3.Drive {
  if (cachedDrive) return cachedDrive;

  const auth = new google.auth.JWT({
    email: requireEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
    key: normalizePrivateKey(requireEnv('GOOGLE_PRIVATE_KEY')),
    scopes: DRIVE_SCOPES,
  });

  cachedDrive = google.drive({ version: 'v3', auth });
  return cachedDrive;
}

/** Escapes a value for use inside a Drive `q` query string literal. */
function escapeQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Creates the client's isolated subfolder under the global vault node.
 *
 * Idempotent: a folder of the same name already sitting under the parent is
 * reused, so webhook retries cannot litter the vault with duplicates.
 */
export async function ensureClientFolder(companyName: string): Promise<string> {
  return ensureFolder(companyName, requireEnv('GOOGLE_DRIVE_PARENT_FOLDER_ID'));
}

/**
 * Folder holding a vertical's reference templates.
 *
 * Nested one level under its own node rather than sitting beside the client
 * folders: the vault's top level is a list of tenants, and dropping ten
 * vertical folders into it makes that list harder to read every time somebody
 * opens Drive looking for a client.
 */
const verticalFolderCache = new Map<string, Promise<string>>();

export async function ensureVerticalTemplateFolder(
  categoryName: string,
): Promise<string> {
  /*
   * Memoised per process, because this is on the per-file upload path and each
   * call costs two Drive `files.list` round-trips — one for the parent node, one
   * for the vertical. The console uploads one file per Server Action invocation
   * (the body limit forces that), so a hundred-file batch was two hundred lookups
   * for two folder ids that cannot change between them.
   *
   * The promise is cached rather than the resolved id, so a burst of concurrent
   * uploads shares one in-flight lookup instead of racing to create the same
   * folder. A rejection is evicted so a transient Drive failure is not remembered
   * as permanent.
   *
   * Staleness is bounded and benign: folder ids are stable for the life of the
   * folder, and one deleted out from under us costs a restart, not corruption.
   */
  const cached = verticalFolderCache.get(categoryName);
  if (cached) return cached;

  const pending = (async () => {
    const root = await ensureFolder(
      'Vertical Templates',
      requireEnv('GOOGLE_DRIVE_PARENT_FOLDER_ID'),
    );
    return ensureFolder(categoryName, root);
  })();

  verticalFolderCache.set(categoryName, pending);
  pending.catch(() => verticalFolderCache.delete(categoryName));

  return pending;
}

/**
 * Finds or creates one folder under `parentFolderId`.
 *
 * Idempotent: a folder of the same name already sitting under the parent is
 * reused, so webhook retries cannot litter the vault with duplicates.
 */
async function ensureFolder(name: string, parentFolderId: string): Promise<string> {
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
    requestBody: {
      name: folderName,
      mimeType: FOLDER_MIME_TYPE,
      parents: [parentFolderId],
    },
    fields: 'id',
    supportsAllDrives: true,
  });

  const folderId = created.data.id;
  if (!folderId) {
    throw new Error(`Google Drive returned no folder id for "${folderName}"`);
  }
  return folderId;
}

/**
 * Streams a binary asset into a client folder and returns the identifiers
 * persisted on `ContentCalendar`.
 *
 * Published link-readable unless `publish: false` — see `DriveUploadInput`.
 */
export async function uploadClientAsset(
  input: DriveUploadInput,
): Promise<DriveUploadResult> {
  const drive = getDriveClient();

  const created = await drive.files.create({
    requestBody: {
      name: input.fileName,
      parents: [input.folderId],
    },
    media: {
      mimeType: input.mimeType,
      body: Readable.from(input.body),
    },
    fields: 'id',
    supportsAllDrives: true,
  });

  const fileId = created.data.id;
  if (!fileId) {
    throw new Error(`Google Drive returned no file id for "${input.fileName}"`);
  }

  if (input.publish !== false) {
    // Anyone-with-the-link reader access: Evolution API fetches the media
    // server-side and carries no Google credentials.
    await drive.permissions.create({
      fileId,
      requestBody: { role: 'reader', type: 'anyone' },
      supportsAllDrives: true,
    });
  }

  const metadata = await drive.files.get({
    fileId,
    fields: 'id, webViewLink, webContentLink, thumbnailLink',
    supportsAllDrives: true,
  });

  return {
    fileId,
    // `webContentLink` is the direct-download form; the constructed `uc` URL is
    // an equivalent fallback if Drive omits the field.
    viewUrl: metadata.data.webContentLink ?? buildDirectDownloadUrl(fileId),
    webViewLink: metadata.data.webViewLink ?? null,
    thumbnailLink: metadata.data.thumbnailLink ?? null,
  };
}

/** Stable direct-download URL for a link-readable Drive file. */
export function buildDirectDownloadUrl(fileId: string): string {
  return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
}

/**
 * Moves a file to the Drive trash. Used when a client's logo is replaced, so the
 * vault does not accumulate every superseded upload.
 *
 * Trashed rather than permanently deleted: an operator who replaces the wrong
 * logo can recover it from the bin, and the file is no longer reachable from the
 * client folder either way.
 *
 * Never throws. A logo that cannot be tidied up must not fail the upload that
 * replaced it — the new logo is already live at that point, and the stale file is
 * clutter rather than a fault.
 */
export async function trashDriveFile(fileId: string): Promise<boolean> {
  try {
    await getDriveClient().files.update({
      fileId,
      requestBody: { trashed: true },
      supportsAllDrives: true,
    });
    return true;
  } catch (error) {
    console.warn(
      `[ace:drive] could not trash superseded file ${fileId}:`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

/**
 * Reads a file's bytes back out of the vault through the service account.
 *
 * The way an unpublished file is displayed: nothing on Google's content hosts
 * will serve it to a browser, so the console proxies it through a route of its
 * own that is already behind the admin session.
 *
 * Buffered rather than streamed. These are reference posters capped at a
 * 1600px long edge by `prepareTemplateImage` — a few hundred kilobytes — and a
 * Buffer is what the resize on the other side needs anyway.
 */
export async function downloadDriveFile(fileId: string): Promise<Buffer> {
  const response = await getDriveClient().files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' },
  );

  return Buffer.from(response.data as ArrayBuffer);
}

/**
 * Bandwidth-cheap thumbnail URL used by the dashboard grid.
 *
 * Only works for files uploaded with `publish` left on — this host serves
 * link-readable files and nothing else. An unpublished file needs the proxy
 * route instead.
 *
 * Points at the content host rather than `drive.google.com/thumbnail?id=`.
 * That endpoint only 302s here anyway, but the hop is served from the signed-in
 * Drive origin: it carries `Cross-Origin-Opener-Policy` and `X-Frame-Options`,
 * and it varies on the viewer's Google cookies, so an `<img>` in the console
 * breaks for a logged-in operator while working fine for an anonymous fetch.
 * This host answers with `Access-Control-Allow-Origin: *` and no such headers.
 *
 * The API also reports a `thumbnailLink`, but it is a fixed-size, expiring URL —
 * not something worth persisting.
 */
export function buildThumbnailUrl(fileId: string, width = 512): string {
  return `https://lh3.googleusercontent.com/d/${encodeURIComponent(fileId)}=w${width}`;
}
