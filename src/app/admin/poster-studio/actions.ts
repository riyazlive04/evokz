'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import {
  renderStudioImage,
  type StudioImageInput,
  type StudioImageResult,
} from '@/lib/ai/openai-images';
import {
  buildEditPrompt,
  buildGeneratePrompt,
  buildVariationPrompt,
} from '@/lib/ai/studio-prompts';
import { MissingEnvError } from '@/lib/env';
import { loadStudioClient, type ResolvedStudioClient } from '@/lib/poster-studio/brand-context';
import { StudioError, type StudioErrorKind } from '@/lib/poster-studio/errors';
import {
  studioHistorySelect,
  toStudioDatabaseError,
  toStudioHistoryItem,
  type StudioHistoryItem,
} from '@/lib/poster-studio/history';
import { prepareStudioInputImage } from '@/lib/poster-studio/images';
import {
  MAX_STUDIO_PROMPT_LENGTH,
  MIN_STUDIO_PROMPT_LENGTH,
  STUDIO_ASPECT_RATIO_KEYS,
  STUDIO_ASPECT_RATIOS,
  STUDIO_MODES,
  STUDIO_SOURCE_KINDS,
  type StudioAspectRatio,
} from '@/lib/poster-studio/limits';
import {
  readStudioFile,
  resolveStudioFolder,
  storeStudioFile,
  trashStudioFiles,
  trashUnreferencedStudioFiles,
} from '@/lib/poster-studio/storage';
import { readImageDimensions } from '@/lib/poster/image-info';
import { prisma } from '@/lib/prisma';
import { recordOpenAiImageUsage } from '@/lib/usage';

/**
 * Server Actions for the AI Poster Studio.
 *
 * Reachable only behind the admin session: `src/middleware.ts` gates every
 * `/admin/*` request, and a Server Action posts to the route it was rendered on.
 *
 * Every action returns a result instead of throwing — an unhandled rejection
 * reaches the browser as an opaque digest.
 */

export type StudioGenerateResult =
  | { ok: true; generation: StudioHistoryItem }
  | {
      ok: false;
      kind: StudioErrorKind;
      error: string;
      /**
       * Present only when the image was generated — and paid for — but could not
       * be kept. The one time image bytes travel back to the browser: a single
       * image, once, so the operator does not lose work they were billed for.
       */
      unsaved?: { dataUri: string; fileName: string };
    };

export type StudioDeleteResult = { ok: true } | { ok: false; error: string };

const optionalUuid = z
  .string()
  .trim()
  .refine((value) => value === '' || z.string().uuid().safeParse(value).success, 'Invalid id')
  .transform((value) => value || null);

const requestSchema = z.object({
  mode: z.enum(STUDIO_MODES, { errorMap: () => ({ message: 'Choose Generate, Edit or Variation.' }) }),
  prompt: z
    .string()
    .trim()
    .min(MIN_STUDIO_PROMPT_LENGTH, `Describe what you want in at least ${MIN_STUDIO_PROMPT_LENGTH} characters.`)
    .max(MAX_STUDIO_PROMPT_LENGTH, `Keep the description under ${MAX_STUDIO_PROMPT_LENGTH.toLocaleString('en-IN')} characters.`),
  aspectRatio: z.enum(STUDIO_ASPECT_RATIO_KEYS as [StudioAspectRatio, ...StudioAspectRatio[]], {
    errorMap: () => ({ message: 'Choose an output format.' }),
  }),
  clientId: optionalUuid,
  textFree: z.enum(['0', '1']).transform((value) => value === '1'),
  sourceKind: z.enum(STUDIO_SOURCE_KINDS),
  sourceGenerationId: optionalUuid,
});

type StudioRequest = z.infer<typeof requestSchema>;

/** The input image for a request, and how the new row should record it. */
interface ResolvedSource {
  image: StudioImageInput | null;
  /** The input is a fresh upload that still has to be written to Drive. */
  needsUpload: boolean;
  /** Drive file already holding the input, when it came from history. */
  existingFileId: string | null;
  parentGenerationId: string | null;
}

export async function generateStudioPosterAction(formData: FormData): Promise<StudioGenerateResult> {
  let rendered: StudioImageResult | null = null;
  const writtenThisRequest: string[] = [];

  try {
    const request = parseRequest(formData);
    const client = request.clientId ? await withDatabase(() => loadStudioClient(request.clientId!), 'Loading the client') : null;
    const source = await resolveSource(request, formData);

    // Before any spend: a request whose image cannot be stored must not be paid for.
    const folderId = await resolveStudioFolder(client?.companyName ?? null);

    const format = STUDIO_ASPECT_RATIOS[request.aspectRatio];
    const sentPrompt = buildPrompt(request, client, source.image !== null);

    rendered = await renderStudioImage({ prompt: sentPrompt, size: format.size, image: source.image });

    // Recorded before storage: the money is spent whether or not the image is kept.
    await recordOpenAiImageUsage(rendered.usage, rendered.model, { clientId: client?.id ?? null });

    const stamp = fileStamp();
    const imageDriveFileId = await storeStudioFile({
      folderId,
      fileName: `poster-studio-${stamp}-${request.mode.toLowerCase()}.${extensionFor(rendered.mimeType)}`,
      body: rendered.bytes,
      mimeType: rendered.mimeType,
    });
    writtenThisRequest.push(imageDriveFileId);

    let referenceDriveFileId = source.existingFileId;
    if (source.needsUpload && source.image) {
      referenceDriveFileId = await storeStudioFile({
        folderId,
        fileName: `poster-studio-${stamp}-input.${extensionFor(source.image.mimeType)}`,
        body: source.image.bytes,
        mimeType: source.image.mimeType,
      });
      writtenThisRequest.push(referenceDriveFileId);
    }

    const dimensions = readImageDimensions(rendered.bytes);

    const row = await withDatabase(
      () =>
        prisma.posterStudioGeneration.create({
          data: {
            mode: request.mode,
            prompt: request.prompt,
            sentPrompt,
            aspectRatio: request.aspectRatio,
            size: format.size,
            model: rendered!.model,
            quality: rendered!.quality,
            textFree: request.textFree,
            imageDriveFileId,
            imageMimeType: rendered!.mimeType,
            width: dimensions?.width ?? null,
            height: dimensions?.height ?? null,
            referenceDriveFileId,
            referenceMimeType: referenceDriveFileId ? (source.image?.mimeType ?? null) : null,
            parentGenerationId: source.parentGenerationId,
            clientId: client?.id ?? null,
          },
          select: studioHistorySelect,
        }),
      'Saving to history',
    );

    revalidatePath('/admin/poster-studio');
    return { ok: true, generation: toStudioHistoryItem(row) };
  } catch (error) {
    const failure = toStudioError(error);

    if (!rendered) {
      if (failure.kind !== 'validation') {
        console.error(`[studio:action] ${failure.kind}: ${failure.message}`, failure.cause ?? '');
      }
      return { ok: false, kind: failure.kind, error: failure.message };
    }

    // The image exists and was billed; something after it failed. Remove any
    // half-saved files so Drive holds nothing the history does not, and hand the
    // image back once so the operator's paid work is not lost.
    console.error(
      `[studio:action] image generated but not kept (${failure.kind}): ${failure.message}`,
      failure.cause ?? '',
    );
    await trashStudioFiles(writtenThisRequest);

    return {
      ok: false,
      kind: failure.kind,
      error: describeUnkeptImage(failure),
      unsaved: {
        dataUri: `data:${rendered.mimeType};base64,${rendered.bytes.toString('base64')}`,
        fileName: `poster-studio-unsaved-${fileStamp()}.${extensionFor(rendered.mimeType)}`,
      },
    };
  }
}

/**
 * Deletes one history row and bins its Drive files once nothing else uses them.
 *
 * An edit made from this row keeps working: its own output is its own file, its
 * input is shared and therefore kept, and its parent link is nulled by the
 * foreign key rather than cascading.
 */
export async function deleteStudioGenerationAction(id: string): Promise<StudioDeleteResult> {
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) return { ok: false, error: 'That history item id is not valid.' };

  try {
    const row = await prisma.posterStudioGeneration.findUnique({
      where: { id: parsed.data },
      select: { imageDriveFileId: true, referenceDriveFileId: true },
    });
    // Already gone is the state the operator asked for.
    if (!row) return { ok: true };

    await prisma.posterStudioGeneration.delete({ where: { id: parsed.data } });
    await trashUnreferencedStudioFiles([row.imageDriveFileId, row.referenceDriveFileId]);

    revalidatePath('/admin/poster-studio');
    return { ok: true };
  } catch (error) {
    const failure = toStudioDatabaseError(error, 'Deleting the poster');
    console.error(`[studio:action] ${failure.message}`, failure.cause ?? '');
    return { ok: false, error: failure.message };
  }
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

function parseRequest(formData: FormData): StudioRequest {
  const field = (name: string) => {
    const value = formData.get(name);
    return typeof value === 'string' ? value : '';
  };

  const parsed = requestSchema.safeParse({
    mode: field('mode'),
    prompt: field('prompt'),
    aspectRatio: field('aspectRatio'),
    clientId: field('clientId'),
    textFree: field('textFree') || '0',
    sourceKind: field('sourceKind') || 'none',
    sourceGenerationId: field('sourceGenerationId'),
  });

  if (!parsed.success) {
    throw new StudioError('validation', parsed.error.issues[0]?.message ?? 'The request was not valid.');
  }

  const request = parsed.data;

  // Edit and Variation are defined by their input image. Without one they would
  // silently become a text-only generation of an unrelated poster.
  if (request.sourceKind === 'none') {
    if (request.mode === 'EDIT') {
      throw new StudioError(
        'validation',
        'Edit needs an image to change. Upload an image, or choose Edit on a poster in History.',
      );
    }
    if (request.mode === 'VARIATION') {
      throw new StudioError(
        'validation',
        'Variation needs a parent image. Upload an image, or choose Variant on a poster in History.',
      );
    }
  }

  if (
    (request.sourceKind === 'generation-output' || request.sourceKind === 'generation-reference') &&
    !request.sourceGenerationId
  ) {
    throw new StudioError('validation', 'The selected history image is missing its id. Select it again.');
  }

  return request;
}

async function resolveSource(request: StudioRequest, formData: FormData): Promise<ResolvedSource> {
  switch (request.sourceKind) {
    case 'none':
      return { image: null, needsUpload: false, existingFileId: null, parentGenerationId: null };

    case 'upload': {
      const file = formData.get('image');
      if (!(file instanceof File) || file.size === 0) {
        throw new StudioError('validation', 'Choose an image file to upload.');
      }
      const prepared = await prepareStudioInputImage(
        Buffer.from(await file.arrayBuffer()),
        file.type,
        file.name || 'The uploaded file',
      );
      return {
        image: { bytes: prepared.bytes, mimeType: prepared.mimeType },
        needsUpload: true,
        existingFileId: null,
        parentGenerationId: null,
      };
    }

    case 'generation-output':
    case 'generation-reference': {
      const sourceId = request.sourceGenerationId!;
      const row = await withDatabase(
        () =>
          prisma.posterStudioGeneration.findUnique({
            where: { id: sourceId },
            select: {
              id: true,
              imageDriveFileId: true,
              imageMimeType: true,
              referenceDriveFileId: true,
              referenceMimeType: true,
            },
          }),
        'Loading the selected history image',
      );
      if (!row) {
        throw new StudioError(
          'validation',
          'The selected history image no longer exists. Choose another image or upload one.',
        );
      }

      const useOutput = request.sourceKind === 'generation-output';
      const fileId = useOutput ? row.imageDriveFileId : row.referenceDriveFileId;
      const mimeType = useOutput ? row.imageMimeType : row.referenceMimeType;
      if (!fileId || !mimeType) {
        throw new StudioError('validation', 'That history item has no stored input image to reuse. Upload the image again.');
      }

      return {
        image: { bytes: await readStudioFile(fileId), mimeType },
        needsUpload: false,
        existingFileId: fileId,
        // Lineage means "made from that poster". Only an edit or a variation of
        // another generation's output is one; a style reference is not.
        parentGenerationId: useOutput && request.mode !== 'GENERATE' ? row.id : null,
      };
    }
  }
}

function buildPrompt(
  request: StudioRequest,
  client: ResolvedStudioClient | null,
  hasImage: boolean,
): string {
  switch (request.mode) {
    case 'GENERATE':
      return buildGeneratePrompt({
        brief: request.prompt,
        aspectRatio: request.aspectRatio,
        textFree: request.textFree,
        brand: client?.brand ?? null,
        hasReference: hasImage,
      });
    case 'EDIT':
      return buildEditPrompt({
        instruction: request.prompt,
        aspectRatio: request.aspectRatio,
        textFree: request.textFree,
      });
    case 'VARIATION':
      return buildVariationPrompt({
        direction: request.prompt,
        aspectRatio: request.aspectRatio,
        textFree: request.textFree,
        brand: client?.brand ?? null,
      });
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

async function withDatabase<T>(run: () => Promise<T>, context: string): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw toStudioDatabaseError(error, context);
  }
}

function toStudioError(error: unknown): StudioError {
  if (error instanceof StudioError) return error;
  if (error instanceof MissingEnvError) {
    return new StudioError('config', `The server is missing required configuration (${error.key}).`, {
      cause: error,
    });
  }
  return new StudioError('provider', 'Something went wrong. The details are in the server log.', {
    cause: error,
  });
}

function describeUnkeptImage(failure: StudioError): string {
  const reason =
    failure.kind === 'storage'
      ? 'it could not be saved to Google Drive'
      : failure.kind === 'database'
        ? 'it could not be recorded in the database'
        : 'a later step failed';
  return `The poster was generated and billed by OpenAI, but ${reason}, so it is not in History. Download it now — it will not be kept. (${failure.message})`;
}

function extensionFor(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  return 'png';
}

function fileStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
