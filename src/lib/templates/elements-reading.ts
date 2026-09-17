import { Prisma } from '@prisma/client';

import { LlmError } from '@/lib/ai/openai';
import { readTemplateElements, stabilizeElementIds, type TemplateElementsInput } from '@/lib/ai/template-elements';
import { MissingEnvError } from '@/lib/env';
import { downloadDriveFile } from '@/lib/google-drive';
import { readImageDimensions } from '@/lib/poster/image-info';
import { prisma } from '@/lib/prisma';
import {
  parseTemplateElements,
  summarizeTemplateElements,
  type TemplateElementsDoc,
} from '@/lib/types/template-elements';

/**
 * Reading a template's elements and storing the outcome on its row.
 *
 * Three callers, one behaviour: `uploadVerticalTemplate` reads a file it has just
 * stored, `readTemplateElementsAction` re-reads one card, and
 * `scripts/read-template-elements.ts` backfills a library. They share this so a
 * template read from the console and one read from the script are stored — and
 * fail — identically.
 *
 * **Never throws for a failed read.** The reader (`readTemplateElements`) is
 * right to throw: a caller asking for elements should hear about a missing key.
 * Every caller here has something better to do with a failure than crash — the
 * upload has already written the file to Drive, and the card and the script both
 * exist to report what happened. So a failure becomes a short sentence an admin
 * can act on, stored in `elementsError`, with the detail logged server-side.
 */

export type TemplateElementsReading =
  | { ok: true; doc: TemplateElementsDoc; summary: string }
  | { ok: false; error: string };

export interface ReadElementsInput {
  bytes: Buffer;
  mimeType: string;
  label: string;
  /** The stored file's pixel size. Null when it could not be measured. */
  width: number | null;
  height: number | null;
}

/** Seam for the check script: the real reader makes a vision call. */
export type TemplateElementsReader = (input: TemplateElementsInput) => Promise<TemplateElementsDoc>;

const LOG_PREFIX = '[ace:template-elements]';

export const NO_SIZE_MESSAGE = 'The image size could not be measured, so its elements were not read.';
export const DRIVE_READ_MESSAGE =
  'The template image could not be read back from Drive. Check the service account can still open the vertical template folder.';

/**
 * Reads the elements of one image, turning any failure into an operator message.
 *
 * Billed as a platform spend (`bill: {}`): a template belongs to a vertical, not
 * to a client. Leaving `bill` out would log the tokens but keep them out of the
 * spend ledger entirely.
 */
export async function readElementsQuietly(
  input: ReadElementsInput,
  read: TemplateElementsReader = readTemplateElements,
): Promise<TemplateElementsReading> {
  const { width, height } = input;
  // The document records its boxes against this size and refuses anything but a
  // positive integer, so a read without one would only fail after being paid for.
  if (!isPixelSize(width) || !isPixelSize(height)) {
    console.warn(`${LOG_PREFIX} "${input.label}" has no measurable size; not read.`);
    return { ok: false, error: NO_SIZE_MESSAGE };
  }

  try {
    const doc = await read({
      bytes: input.bytes,
      mimeType: input.mimeType,
      label: input.label,
      width,
      height,
      bill: {},
    });
    return { ok: true, doc, summary: summarizeTemplateElements(doc) };
  } catch (error) {
    console.warn(`${LOG_PREFIX} reading "${input.label}" failed: ${errorText(error)}`);
    return { ok: false, error: describeElementsFailure(error) };
  }
}

function isPixelSize(value: number | null): value is number {
  return value !== null && Number.isInteger(value) && value > 0;
}

/**
 * One short sentence for the template card, from whatever the read threw.
 *
 * The raw messages name the template, the model call and sometimes the provider's
 * own wording — useful in a log, noise on a card that already shows the name. The
 * reader's own failures are matched on their message because it throws plain
 * `Error`s; `check:template-elements-view` pins each match against the text the
 * reader really produces, so a reworded message fails a check, not a card.
 */
export function describeElementsFailure(error: unknown): string {
  if (error instanceof MissingEnvError) {
    return `The server is missing ${error.key}, so templates cannot be read.`;
  }

  if (error instanceof LlmError) {
    switch (error.kind) {
      case 'transport':
        return 'The AI service could not be reached or was busy. Try again in a minute.';
      case 'truncated':
        return 'The reading was cut off before it finished. Try again.';
      case 'refusal':
      case 'filtered':
        return 'The AI declined to read this image.';
      case 'malformed':
        return 'The AI returned an answer that could not be used. Try again.';
      case 'config':
        return 'The AI service rejected the request. Check the server logs.';
    }
  }

  const message = error instanceof Error ? error.message : '';
  if (message.includes('could not be decoded as an image')) {
    return 'The image could not be decoded.';
  }
  if (message.includes('found nothing that can be changed')) {
    return 'No words, photo or logo were found on this template.';
  }
  if (message.includes('returned no element list')) {
    return 'The AI returned no elements. Try again.';
  }
  if (message.includes('produced a document this build cannot store')) {
    return 'The AI reading could not be stored. Try again.';
  }
  return 'The elements could not be read. Check the server logs.';
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'Unknown error';
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

type ElementsColumns = Pick<
  Prisma.CategoryTemplateUncheckedCreateInput,
  'elements' | 'elementsReadAt' | 'elementsError'
>;

/** The element columns for a new row: the reading, or no reading and why. */
export function elementsCreateData(reading: TemplateElementsReading, now: Date = new Date()): ElementsColumns {
  return reading.ok
    ? {
        elements: reading.doc as unknown as Prisma.InputJsonValue,
        elementsReadAt: now,
        elementsError: null,
      }
    : { elements: Prisma.DbNull, elementsReadAt: null, elementsError: reading.error };
}

/**
 * The element columns for an existing row.
 *
 * **A failed re-read keeps the reading it could not replace.** Only the error is
 * written. Campaign days hold copies keyed to the stored element ids, and a
 * transient fault — a timeout, a rate limit — must not strip a working template
 * of its elements. `elementsReadAt` therefore still dates the reading on file,
 * and the card shows the failure beside it.
 */
export function elementsUpdateData(
  reading: TemplateElementsReading,
  now: Date = new Date(),
): Partial<ElementsColumns> {
  return reading.ok ? elementsCreateData(reading, now) : { elementsError: reading.error };
}

// ---------------------------------------------------------------------------
// Re-reading a stored template
// ---------------------------------------------------------------------------

export interface TemplateElementsRefresh {
  label: string;
  reading: TemplateElementsReading;
}

/**
 * Reads a stored template's elements again, from its file in Drive, and stores
 * the outcome. Null when the template no longer exists, including one deleted
 * while its read was running.
 *
 * The size is measured from the bytes read back, falling back to the row's
 * columns: those were written at upload and are almost always right, but a
 * template stored before they were populated carries nulls.
 */
export async function refreshTemplateElements(
  templateId: string,
  read: TemplateElementsReader = readTemplateElements,
): Promise<TemplateElementsRefresh | null> {
  const template = await prisma.categoryTemplate.findUnique({
    where: { id: templateId },
    select: { label: true, gDriveFileId: true, mimeType: true, width: true, height: true, elements: true },
  });
  if (!template) return null;

  let reading: TemplateElementsReading;
  let bytes: Buffer | null = null;
  try {
    bytes = await downloadDriveFile(template.gDriveFileId);
  } catch (error) {
    console.warn(`${LOG_PREFIX} could not download "${template.label}" from Drive: ${errorText(error)}`);
  }

  if (bytes) {
    const measured = readImageDimensions(bytes);
    reading = await readElementsQuietly(
      {
        bytes,
        mimeType: template.mimeType,
        label: template.label,
        width: measured?.width ?? template.width,
        height: measured?.height ?? template.height,
      },
      read,
    );
  } else {
    reading = { ok: false, error: DRIVE_READ_MESSAGE };
  }

  // Campaign days hold per-element values by id, so a re-read keeps the ids of
  // the reading it replaces wherever an element is recognisably the same one.
  if (reading.ok) {
    reading = { ...reading, doc: stabilizeElementIds(parseTemplateElements(template.elements), reading.doc) };
  }

  // `updateMany`, not `update`: a template deleted during a read that takes up
  // to a minute is an outcome to report, not an exception to map.
  const { count } = await prisma.categoryTemplate.updateMany({
    where: { id: templateId },
    data: elementsUpdateData(reading),
  });
  return count === 0 ? null : { label: template.label, reading };
}
