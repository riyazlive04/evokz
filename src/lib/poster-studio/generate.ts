import { MissingEnvError } from '@/lib/env';
import {
  assertStudioImageConfigured,
  renderStudioImage,
  type StudioImageInput,
  type StudioImageResult,
} from '@/lib/ai/openai-images';
import {
  buildEditPrompt,
  buildGeneratePrompt,
  buildMixPrompt,
  buildVariationPrompt,
  VARIATION_APPROACHES,
} from '@/lib/ai/studio-prompts';
import { loadStudioBrandCanvas, type StudioBrandCanvas } from '@/lib/poster-studio/brand-context';
import {
  composeStudioPoster,
  prepareStudioOverlay,
  type ComposedPoster,
  type StudioOverlayPlan,
} from '@/lib/poster-studio/compose';
import { StudioError, type StudioErrorKind } from '@/lib/poster-studio/errors';
import {
  studioHistorySelect,
  toStudioDatabaseError,
  toStudioHistoryItem,
  type StudioHistoryItem,
} from '@/lib/poster-studio/history';
import { findStudioFestival } from '@/lib/poster-studio/festivals';
import { readStudioImageSize, reduceVariationSource } from '@/lib/poster-studio/images';
import {
  identityBandFraction,
  STUDIO_ASPECT_RATIOS,
  type StudioAspectRatio,
  type StudioFooterBackground,
  type StudioLogoBackground,
  type StudioMode,
  type StudioOverlayElement,
  type StudioQuality,
} from '@/lib/poster-studio/limits';
import { resolveStudioFolder, storeStudioFile, trashStudioFiles } from '@/lib/poster-studio/storage';
import { prisma } from '@/lib/prisma';
import { recordOpenAiImageUsage } from '@/lib/usage';

/**
 * One Poster Studio image, end to end: the pipeline behind the studio's
 * Generate button, and behind anything else that makes a studio image the same
 * way.
 *
 * Never throws. Every failure comes back as a result, and an image that was
 * generated — and so paid for — but could not be kept is handed back once as a
 * data URI rather than lost.
 *
 * Deliberately not a Server Action: the caller decides where its request came
 * from (a form, a queue) and what to refresh afterwards.
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

/** A validated request: what the operator asked for, independent of where it came from. */
export interface StudioGenerationRequest {
  mode: StudioMode;
  prompt: string;
  aspectRatio: StudioAspectRatio;
  clientId: string | null;
  textFree: boolean;
  overlayElements: StudioOverlayElement[];
  logoBackground: StudioLogoBackground;
  footerBackground: StudioFooterBackground;
  /** Festival key (`STUDIO_FESTIVALS`) whose treatment is added to the prompt; null for none. */
  festival?: string | null;
  /** Overrides POSTER_STUDIO_IMAGE_QUALITY for this image; null uses it. */
  quality?: StudioQuality | null;
}

/** An input image for a request, and how the new row should record it. */
export interface ResolvedSource {
  image: StudioImageInput | null;
  /** The input is a fresh upload that still has to be written to Drive. */
  needsUpload: boolean;
  /** Drive file already holding the input, when it came from history. */
  existingFileId: string | null;
  parentGenerationId: string | null;
  /** Variation of a History item only: the brief its lineage was generated from. */
  campaignBrief: string | null;
}

export const NO_SOURCE: ResolvedSource = {
  image: null,
  needsUpload: false,
  existingFileId: null,
  parentGenerationId: null,
  campaignBrief: null,
};

export interface StudioGenerationOptions {
  /** MIX only: the second image, whose named elements are carried onto `source`. */
  elementSource?: ResolvedSource | null;
  /**
   * Lineage to record when it is not the source's own — a Customize redo of a
   * History item is that item's child although it is a fresh Generate.
   */
  parentGenerationId?: string | null;
  /** Set by a bulk run: the batch row this image belongs to (kept out of History). */
  batchItemId?: string | null;
}

export async function generateStudioPoster(
  request: StudioGenerationRequest,
  source: ResolvedSource,
  options: StudioGenerationOptions = {},
): Promise<StudioGenerateResult> {
  let rendered: StudioImageResult | null = null;
  let persisted = false;
  const writtenThisRequest: string[] = [];
  const elementSource = options.elementSource ?? null;

  try {
    // Cheapest check first: without a key nothing else is worth doing.
    assertStudioImageConfigured();
    if (request.mode === 'MIX' && (!source.image || !elementSource?.image)) {
      throw new StudioError('validation', 'Mix needs two images: the base poster and the element reference.');
    }
    const client = request.clientId
      ? await withStudioDatabase(() => loadStudioBrandCanvas(request.clientId!), 'Loading the Brand Canvas')
      : null;

    // ---- Pre-flight: everything deterministic, before any spend -------------
    // The identity overlay's prerequisites — each selected element present in
    // Brand Canvas, the logo readable, the chosen logo background achievable,
    // the brand fonts loadable, and a full dry-run composite.
    const overlay: StudioOverlayPlan | null =
      client && request.overlayElements.length > 0
        ? await prepareStudioOverlay(
            client,
            {
              elements: request.overlayElements,
              logoBackground: request.logoBackground,
              footerBackground: request.footerBackground,
            },
            request.aspectRatio,
          )
        : null;

    // A request whose image cannot be stored must not be paid for.
    const folderId = await resolveStudioFolder(client?.companyName ?? null);

    const format = STUDIO_ASPECT_RATIOS[request.aspectRatio];
    const approach = request.mode === 'VARIATION' ? await chooseVariationApproach(source.parentGenerationId) : 0;
    const sentPrompt = buildStudioPrompt(request, client, source, overlay !== null, approach);

    // Variation sends a reduced preview of its source, so the model takes the
    // campaign from it rather than the layout (see `reduceVariationSource`). The
    // stored input stays the full image.
    const modelImage =
      request.mode === 'VARIATION' && source.image ? await reduceVariationSource(source.image) : source.image;

    rendered = await renderStudioImage({
      prompt: sentPrompt,
      size: format.size,
      image: modelImage,
      quality: request.quality ?? undefined,
      extraImages: request.mode === 'MIX' && elementSource?.image ? [elementSource.image] : null,
    });

    // Recorded before storage: the money is spent whether or not the image is kept.
    await recordOpenAiImageUsage(rendered.usage, rendered.model, { clientId: client?.clientId ?? null });

    // Bytes that do not decode are not an image, whatever the response said.
    // Nothing is stored and nothing is offered for download.
    const dimensions = await readStudioImageSize(rendered.bytes);
    if (!dimensions) {
      rendered = null;
      throw new StudioError(
        'provider',
        'OpenAI returned an image that could not be read. Nothing was saved — try again.',
      );
    }

    // ---- FINAL poster: raw artwork + exact Brand Canvas identity ------------
    let composed: ComposedPoster | null = null;
    let warning: string | undefined;
    if (overlay) {
      try {
        composed = await composeStudioPoster(rendered.bytes, overlay);
      } catch (error) {
        console.error('[studio:generate] identity overlay failed after generation:', error);
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

    const storeInput = async (input: ResolvedSource, suffix: string): Promise<string | null> => {
      if (!input.needsUpload || !input.image) return input.existingFileId;
      const fileId = await storeStudioFile({
        folderId,
        fileName: `poster-studio-${stamp}-${suffix}.${extensionFor(input.image.mimeType)}`,
        body: input.image.bytes,
        mimeType: input.image.mimeType,
      });
      writtenThisRequest.push(fileId);
      return fileId;
    };
    const referenceDriveFileId = await storeInput(source, 'input');
    const elementReferenceDriveFileId =
      request.mode === 'MIX' && elementSource ? await storeInput(elementSource, 'element') : null;

    const row = await withStudioDatabase(
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
            festival: findStudioFestival(request.festival)?.key ?? null,
            imageDriveFileId,
            imageMimeType: rendered!.mimeType,
            width: dimensions.width,
            height: dimensions.height,
            referenceDriveFileId,
            referenceMimeType: referenceDriveFileId ? (source.image?.mimeType ?? null) : null,
            elementReferenceDriveFileId,
            elementReferenceMimeType: elementReferenceDriveFileId ? (elementSource?.image?.mimeType ?? null) : null,
            parentGenerationId: options.parentGenerationId ?? source.parentGenerationId,
            batchItemId: options.batchItemId ?? null,
            clientId: client?.clientId ?? null,
            // Per-poster choices only — the brand values stay on Client.
            finalImageDriveFileId,
            finalImageMimeType: composed ? composed.mimeType : null,
            overlayElements: composed ? composed.drawn : [],
            overlayPreset: composed && overlay ? overlay.preset : null,
            logoBackground: composed && overlay?.logo ? overlay.logo.background : null,
            footerBackground: composed && overlay ? overlay.footerBackground : null,
            footerTone: composed ? composed.footerTone : null,
          },
          select: studioHistorySelect,
        }),
      'Saving to history',
    );
    // From here on the row references the Drive files: a later failure must
    // never trash them or tell the operator the poster was not kept.
    persisted = true;

    return { ok: true, generation: toStudioHistoryItem(row), ...(warning ? { warning } : {}) };
  } catch (error) {
    const failure = toStudioError(error);

    if (persisted) {
      console.error('[studio:generate] poster saved, but the response could not be built:', failure.cause ?? failure.message);
      return {
        ok: false,
        kind: failure.kind,
        error: 'The poster was generated and saved to History, but the page could not be updated. Reload to see it.',
      };
    }

    if (!rendered) {
      if (failure.kind !== 'validation') {
        console.error(`[studio:generate] ${failure.kind}: ${failure.message}`, failure.cause ?? '');
      }
      return { ok: false, kind: failure.kind, error: failure.message };
    }

    // The image exists and was billed; something after it failed. Remove any
    // half-saved files so Drive holds nothing the history does not, and hand the
    // image back once so the operator's paid work is not lost.
    console.error(
      `[studio:generate] image generated but not kept (${failure.kind}): ${failure.message}`,
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
 * Which of `VARIATION_APPROACHES` a new Variation uses: the next one for its
 * parent, so successive variations of one poster each take a different
 * approach. Offset by the parent id, so first variations of different posters do
 * not all start with the same one. An uploaded source has no parent and rotates
 * with the studio's variation count instead. Deterministic, and recorded in the
 * sent prompt.
 */
async function chooseVariationApproach(parentGenerationId: string | null): Promise<number> {
  try {
    const siblings = await prisma.posterStudioGeneration.count({
      where: parentGenerationId ? { mode: 'VARIATION', parentGenerationId } : { mode: 'VARIATION' },
    });
    const offset = parentGenerationId
      ? [...parentGenerationId].reduce((sum, character) => sum + character.charCodeAt(0), 0)
      : 0;
    return (siblings + offset) % VARIATION_APPROACHES.length;
  } catch (error) {
    // Context for the prompt only; never a reason to stop the request.
    console.warn('[studio:generate] could not count earlier variations:', error instanceof Error ? error.message : error);
    return 0;
  }
}

function buildStudioPrompt(
  request: StudioGenerationRequest,
  client: StudioBrandCanvas | null,
  source: ResolvedSource,
  withIdentityOverlay: boolean,
  variationApproach: number,
): string {
  // Only when exact identity will be composited: the model then keeps the band
  // clear and draws no logo, name, tagline, phone, URL or QR code itself.
  const identityBand = withIdentityOverlay ? identityBandFraction(request.aspectRatio) : null;
  const festival = findStudioFestival(request.festival);

  switch (request.mode) {
    case 'GENERATE':
      return buildGeneratePrompt({
        brief: request.prompt,
        aspectRatio: request.aspectRatio,
        textFree: request.textFree,
        brand: client?.brand ?? null,
        hasReference: source.image !== null,
        identityBandFraction: identityBand,
        festival,
      });
    case 'EDIT':
      // No brand block: an edit preserves the design it is given. The Brand
      // Canvas still decides what is composited on the result.
      return buildEditPrompt({
        instruction: request.prompt,
        aspectRatio: request.aspectRatio,
        textFree: request.textFree,
        identityBandFraction: identityBand,
        festival,
      });
    case 'VARIATION':
      return buildVariationPrompt({
        direction: request.prompt,
        aspectRatio: request.aspectRatio,
        textFree: request.textFree,
        brand: client?.brand ?? null,
        identityBandFraction: identityBand,
        festival,
        campaignBrief: source.campaignBrief,
        approach: variationApproach,
      });
    case 'MIX':
      // Like Edit, no brand block: the base's design is what is kept.
      return buildMixPrompt({
        instruction: request.prompt,
        aspectRatio: request.aspectRatio,
        textFree: request.textFree,
        identityBandFraction: identityBand,
        festival,
      });
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export async function withStudioDatabase<T>(run: () => Promise<T>, context: string): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw toStudioDatabaseError(error, context);
  }
}

export function toStudioError(error: unknown): StudioError {
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

