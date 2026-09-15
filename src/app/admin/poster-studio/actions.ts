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
import {
  loadStudioBrandCanvas,
  summarizeStudioBrandCanvas,
  type StudioBrandCanvas,
  type StudioBrandCanvasSummary,
} from '@/lib/poster-studio/brand-context';
import { composeStudioPoster, prepareStudioOverlay, type StudioOverlayPlan } from '@/lib/poster-studio/compose';
import { StudioError, type StudioErrorKind } from '@/lib/poster-studio/errors';
import {
  studioHistorySelect,
  toStudioDatabaseError,
  toStudioHistoryItem,
  type StudioHistoryItem,
} from '@/lib/poster-studio/history';
import { prepareStudioInputImage } from '@/lib/poster-studio/images';
import {
  identityBandFraction,
  MAX_STUDIO_PROMPT_LENGTH,
  MIN_STUDIO_PROMPT_LENGTH,
  STUDIO_ASPECT_RATIO_KEYS,
  STUDIO_ASPECT_RATIOS,
  STUDIO_LOGO_BACKGROUNDS,
  STUDIO_MODES,
  STUDIO_OVERLAY_ELEMENTS,
  STUDIO_SOURCE_KINDS,
  type StudioAspectRatio,
  type StudioOverlayElement,
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
  | {
      ok: true;
      generation: StudioHistoryItem;
      /**
       * Set when the raw artwork was generated and saved but the identity overlay
       * could not be composited afterwards. The pre-flight dry run makes this
       * unlikely; the raw artwork is kept either way.
       */
      warning?: string;
    }
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

export type StudioBrandCanvasResult =
  | { ok: true; summary: StudioBrandCanvasSummary }
  | { ok: false; error: string };

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
  /** Comma-separated subset of STUDIO_OVERLAY_ELEMENTS; empty means no identity overlay. */
  overlayElements: z
    .string()
    .trim()
    .transform((value) => [...new Set(value.split(',').map((part) => part.trim()).filter(Boolean))])
    .pipe(
      z.array(
        z.enum(STUDIO_OVERLAY_ELEMENTS, {
          errorMap: () => ({ message: 'Unknown brand identity element.' }),
        }),
      ),
    ),
  logoBackground: z.enum(STUDIO_LOGO_BACKGROUNDS, {
    errorMap: () => ({ message: 'Choose a logo background.' }),
  }),
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
    const client = request.clientId
      ? await withDatabase(() => loadStudioBrandCanvas(request.clientId!), 'Loading the Brand Canvas')
      : null;
    // RAW artwork of a history item, never its composited final — see `resolveSource`.
    const source = await resolveSource(request, formData);

    // ---- Pre-flight: everything deterministic, before any spend -------------
    // The identity overlay's prerequisites — each selected element present in
    // Brand Canvas, the logo readable, the chosen logo background achievable,
    // the brand fonts loadable, and a full dry-run composite.
    const overlay: StudioOverlayPlan | null =
      client && request.overlayElements.length > 0
        ? await prepareStudioOverlay(
            client,
            { elements: request.overlayElements, logoBackground: request.logoBackground },
            request.aspectRatio,
          )
        : null;

    // A request whose image cannot be stored must not be paid for.
    const folderId = await resolveStudioFolder(client?.companyName ?? null);

    const format = STUDIO_ASPECT_RATIOS[request.aspectRatio];
    const sentPrompt = buildPrompt(request, client, source.image !== null, overlay !== null);

    rendered = await renderStudioImage({ prompt: sentPrompt, size: format.size, image: source.image });

    // Recorded before storage: the money is spent whether or not the image is kept.
    await recordOpenAiImageUsage(rendered.usage, rendered.model, { clientId: client?.clientId ?? null });

    // ---- FINAL poster: raw artwork + exact Brand Canvas identity ------------
    let composed: { bytes: Buffer; mimeType: string; drawn: string[] } | null = null;
    let warning: string | undefined;
    if (overlay) {
      try {
        composed = await composeStudioPoster(rendered.bytes, overlay);
      } catch (error) {
        console.error('[studio:action] identity overlay failed after generation:', error);
        warning =
          'The artwork was generated and saved, but the brand identity overlay could not be drawn on it. The saved image has no logo or contact details.';
      }
    }

    const stamp = fileStamp();
    const imageDriveFileId = await storeStudioFile({
      folderId,
      fileName: `poster-studio-${stamp}-${request.mode.toLowerCase()}-raw.${extensionFor(rendered.mimeType)}`,
      body: rendered.bytes,
      mimeType: rendered.mimeType,
    });
    writtenThisRequest.push(imageDriveFileId);

    let finalImageDriveFileId: string | null = null;
    if (composed) {
      finalImageDriveFileId = await storeStudioFile({
        folderId,
        fileName: `poster-studio-${stamp}-${request.mode.toLowerCase()}-final.png`,
        body: composed.bytes,
        mimeType: composed.mimeType,
      });
      writtenThisRequest.push(finalImageDriveFileId);
    }

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
            clientId: client?.clientId ?? null,
            // Per-poster choices only — the brand values stay on Client.
            finalImageDriveFileId,
            finalImageMimeType: composed ? composed.mimeType : null,
            overlayElements: composed ? composed.drawn : [],
            overlayPreset: composed && overlay ? overlay.preset : null,
            logoBackground: composed && overlay?.logo ? overlay.logo.background : null,
          },
          select: studioHistorySelect,
        }),
      'Saving to history',
    );

    revalidatePath('/admin/poster-studio');
    return { ok: true, generation: toStudioHistoryItem(row), ...(warning ? { warning } : {}) };
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
 * Loads the selected client's existing Brand Canvas for the studio panel.
 *
 * Read-only. Returns what is available and how the logo can be drawn — including
 * whether "Remove background" is achievable, checked by running the same
 * resolution a poster would — with no Drive ids, URLs or folder ids.
 */
export async function loadStudioBrandCanvasAction(clientId: string): Promise<StudioBrandCanvasResult> {
  const parsed = z.string().uuid().safeParse(clientId);
  if (!parsed.success) return { ok: false, error: 'That client id is not valid.' };

  try {
    const canvas = await withDatabase(() => loadStudioBrandCanvas(parsed.data), 'Loading the Brand Canvas');
    return { ok: true, summary: await summarizeStudioBrandCanvas(canvas) };
  } catch (error) {
    const failure = toStudioError(error);
    if (failure.kind !== 'validation') {
      console.error(`[studio:brand-canvas] ${failure.kind}: ${failure.message}`, failure.cause ?? '');
    }
    return { ok: false, error: failure.message };
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
      select: { imageDriveFileId: true, finalImageDriveFileId: true, referenceDriveFileId: true },
    });
    // Already gone is the state the operator asked for.
    if (!row) return { ok: true };

    await prisma.posterStudioGeneration.delete({ where: { id: parsed.data } });
    // Studio files only. A client's Brand Canvas logo is never referenced by a
    // studio row, so it can never be trashed from here.
    await trashUnreferencedStudioFiles([
      row.imageDriveFileId,
      row.finalImageDriveFileId,
      row.referenceDriveFileId,
    ]);

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
    overlayElements: field('overlayElements'),
    logoBackground: field('logoBackground') || 'ORIGINAL',
  });

  if (!parsed.success) {
    throw new StudioError('validation', parsed.error.issues[0]?.message ?? 'The request was not valid.');
  }

  const request = parsed.data;

  // The overlay draws a client's Brand Canvas; with no client there is nothing
  // exact to draw, and silently dropping the request would ship an unbranded poster.
  if (request.overlayElements.length > 0 && !request.clientId) {
    throw new StudioError(
      'validation',
      'Select a client to add brand identity, or untick the identity elements for a generic poster.',
    );
  }

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
      // `imageDriveFileId` is the RAW artwork. The composited final is never sent
      // back to the model: it would redraw — and so corrupt — the exact logo and
      // contact details, which are composited afresh on the new result instead.
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
  client: StudioBrandCanvas | null,
  hasImage: boolean,
  withIdentityOverlay: boolean,
): string {
  // Only when exact identity will be composited: the model then keeps the band
  // clear and draws no logo, name, tagline, phone, URL or QR code itself.
  const identityBand = withIdentityOverlay ? identityBandFraction(request.aspectRatio) : null;

  switch (request.mode) {
    case 'GENERATE':
      return buildGeneratePrompt({
        brief: request.prompt,
        aspectRatio: request.aspectRatio,
        textFree: request.textFree,
        brand: client?.brand ?? null,
        hasReference: hasImage,
        identityBandFraction: identityBand,
      });
    case 'EDIT':
      // No brand block: an edit preserves the design it is given. The Brand
      // Canvas still decides what is composited on the result.
      return buildEditPrompt({
        instruction: request.prompt,
        aspectRatio: request.aspectRatio,
        textFree: request.textFree,
        identityBandFraction: identityBand,
      });
    case 'VARIATION':
      return buildVariationPrompt({
        direction: request.prompt,
        aspectRatio: request.aspectRatio,
        textFree: request.textFree,
        brand: client?.brand ?? null,
        identityBandFraction: identityBand,
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
