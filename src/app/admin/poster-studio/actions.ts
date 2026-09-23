'use server';

import type { PosterStudioMode } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { assertStudioImageConfigured } from '@/lib/ai/openai-images';
import { countCampaignVersionsUsingStudioGeneration } from '@/lib/campaign/poster-generation-service';
import {
  loadStudioBrandCanvas,
  summarizeStudioBrandCanvas,
  type StudioBrandCanvasSummary,
} from '@/lib/poster-studio/brand-context';
import { StudioError } from '@/lib/poster-studio/errors';
import { STUDIO_FESTIVAL_KEYS, type StudioFestivalKey } from '@/lib/poster-studio/festivals';
import {
  generateStudioPoster,
  NO_SOURCE,
  toStudioError,
  withStudioDatabase as withDatabase,
  type ResolvedSource,
  type StudioGenerateResult,
} from '@/lib/poster-studio/generate';
import { toStudioDatabaseError } from '@/lib/poster-studio/history';
import { prepareStudioInputImage } from '@/lib/poster-studio/images';
import {
  MAX_STUDIO_PROMPT_LENGTH,
  MIN_STUDIO_PROMPT_LENGTH,
  STUDIO_ASPECT_RATIO_KEYS,
  STUDIO_FOOTER_BACKGROUNDS,
  STUDIO_LOGO_BACKGROUNDS,
  STUDIO_MODES,
  STUDIO_OVERLAY_ELEMENTS,
  STUDIO_QUALITIES,
  STUDIO_SOURCE_KINDS,
  type StudioAspectRatio,
  type StudioMode,
  type StudioSourceKind,
} from '@/lib/poster-studio/limits';
import { readStudioFile, trashUnreferencedStudioFiles } from '@/lib/poster-studio/storage';
import { prisma } from '@/lib/prisma';

/**
 * Server Actions for the AI Poster Studio.
 *
 * Reachable only behind the admin session: `src/middleware.ts` gates every
 * `/admin/*` request, and a Server Action posts to the route it was rendered on.
 *
 * Every action returns a result instead of throwing — an unhandled rejection
 * reaches the browser as an opaque digest.
 */

export type { StudioGenerateResult };

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
  mode: z.enum(STUDIO_MODES, { errorMap: () => ({ message: 'Choose Generate, Edit, Variation or Mix.' }) }),
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
  /** MIX only: where the element reference — the second image — comes from. */
  elementSourceKind: z.enum(STUDIO_SOURCE_KINDS),
  elementSourceGenerationId: optionalUuid,
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
  footerBackground: z.enum(STUDIO_FOOTER_BACKGROUNDS, {
    errorMap: () => ({ message: 'Choose a footer background: Auto, Light or Dark.' }),
  }),
  /** Festival key, or empty for none. */
  festival: z
    .union([z.literal(''), z.enum(STUDIO_FESTIVAL_KEYS as [StudioFestivalKey, ...StudioFestivalKey[]])], {
      errorMap: () => ({ message: 'Unknown festival. Choose one from the list.' }),
    })
    .transform((value) => value || null),
  /** Per-image quality, or empty for the server default. */
  quality: z
    .union([z.literal(''), z.enum(STUDIO_QUALITIES)], { errorMap: () => ({ message: 'Choose Low, Medium or High quality.' }) })
    .transform((value) => value || null),
  /**
   * Customize: the History item this request remakes with new settings. The new
   * poster is recorded as its child, whatever its mode.
   */
  redoOfGenerationId: optionalUuid,
});

type StudioRequest = z.infer<typeof requestSchema>;

/** How far up a lineage the Variation brief lookup walks before giving up. */
const MAX_LINEAGE_HOPS = 8;

export async function generateStudioPosterAction(formData: FormData): Promise<StudioGenerateResult> {
  let request: StudioRequest;
  let source: ResolvedSource;
  let elementSource: ResolvedSource | null = null;
  try {
    request = parseRequest(formData);
    // Cheapest check first: without a key nothing else is worth doing.
    assertStudioImageConfigured();
    // RAW artwork of a history item, never its composited final — see `resolveSource`.
    source = await resolveSource(request.mode, request.sourceKind, request.sourceGenerationId, formData.get('image'));
    if (request.mode === 'MIX') {
      elementSource = await resolveSource(
        request.mode,
        request.elementSourceKind,
        request.elementSourceGenerationId,
        formData.get('elementImage'),
        { lineage: false },
      );
    }
    if (request.redoOfGenerationId) {
      const original = await withDatabase(
        () => prisma.posterStudioGeneration.findUnique({ where: { id: request.redoOfGenerationId! }, select: { id: true } }),
        'Loading the poster to customize',
      );
      if (!original) {
        throw new StudioError('validation', 'The poster you are customizing no longer exists. Choose another one in History.');
      }
    }
  } catch (error) {
    const failure = toStudioError(error);
    if (failure.kind !== 'validation') {
      console.error(`[studio:action] ${failure.kind}: ${failure.message}`, failure.cause ?? '');
    }
    return { ok: false, kind: failure.kind, error: failure.message };
  }

  const result = await generateStudioPoster(request, source, {
    elementSource,
    parentGenerationId: request.redoOfGenerationId,
  });
  if (result.ok) {
    try {
      revalidatePath('/admin/poster-studio');
    } catch (error) {
      console.warn('[studio:action] could not revalidate the studio page:', error instanceof Error ? error.message : error);
    }
  }
  return result;
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
      select: {
        imageDriveFileId: true,
        finalImageDriveFileId: true,
        referenceDriveFileId: true,
        elementReferenceDriveFileId: true,
      },
    });
    // Already gone is the state the operator asked for.
    if (!row) return { ok: true };

    // A campaign poster version draws its image from this row's files. The
    // foreign key would refuse the delete anyway; say why instead of failing.
    const campaignVersions = await countCampaignVersionsUsingStudioGeneration(prisma, parsed.data);
    if (campaignVersions > 0) {
      return {
        ok: false,
        error: `This poster is used by ${campaignVersions} campaign poster version${campaignVersions === 1 ? '' : 's'}, so it cannot be deleted from History.`,
      };
    }

    await prisma.posterStudioGeneration.delete({ where: { id: parsed.data } });
    // Studio files only. A client's Brand Canvas logo is never referenced by a
    // studio row, so it can never be trashed from here.
    await trashUnreferencedStudioFiles([
      row.imageDriveFileId,
      row.finalImageDriveFileId,
      row.referenceDriveFileId,
      row.elementReferenceDriveFileId,
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
    elementSourceKind: field('elementSourceKind') || 'none',
    elementSourceGenerationId: field('elementSourceGenerationId'),
    overlayElements: field('overlayElements'),
    logoBackground: field('logoBackground') || 'ORIGINAL',
    footerBackground: field('footerBackground') || 'AUTO',
    festival: field('festival'),
    quality: field('quality'),
    redoOfGenerationId: field('redoOfGenerationId'),
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
        'Variation needs a parent image. Upload an image, or choose Vary on a poster in History.',
      );
    }
    if (request.mode === 'MIX') {
      throw new StudioError(
        'validation',
        'Mix needs a base image. Upload the poster to change, or choose Mix on a poster in History.',
      );
    }
  }

  if (request.mode === 'MIX' && request.elementSourceKind === 'none') {
    throw new StudioError(
      'validation',
      'Mix needs a reference image to take elements from. Upload it, or pick one from History.',
    );
  }

  const missingHistoryId = (kind: StudioSourceKind, id: string | null) => kind !== 'none' && kind !== 'upload' && !id;
  if (
    missingHistoryId(request.sourceKind, request.sourceGenerationId) ||
    (request.mode === 'MIX' && missingHistoryId(request.elementSourceKind, request.elementSourceGenerationId))
  ) {
    throw new StudioError('validation', 'The selected history image is missing its id. Select it again.');
  }

  return request;
}

/**
 * One input image of a request. `lineage: false` is for Mix's element reference:
 * the result is a child of its base, never of the image it borrowed from.
 */
async function resolveSource(
  mode: StudioMode,
  kind: StudioSourceKind,
  sourceGenerationId: string | null,
  file: FormDataEntryValue | null,
  options: { lineage?: boolean } = {},
): Promise<ResolvedSource> {
  const lineage = options.lineage ?? true;
  switch (kind) {
    case 'none':
      return NO_SOURCE;

    case 'upload': {
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
        campaignBrief: null,
      };
    }

    case 'generation-output':
    case 'generation-reference':
    case 'generation-element-reference': {
      const sourceId = sourceGenerationId!;
      const row = await withDatabase(
        () =>
          prisma.posterStudioGeneration.findUnique({
            where: { id: sourceId },
            select: {
              id: true,
              mode: true,
              prompt: true,
              parentGenerationId: true,
              imageDriveFileId: true,
              imageMimeType: true,
              referenceDriveFileId: true,
              referenceMimeType: true,
              elementReferenceDriveFileId: true,
              elementReferenceMimeType: true,
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

      const useOutput = kind === 'generation-output';
      // `imageDriveFileId` is the RAW artwork. The composited final is never sent
      // back to the model: it would redraw — and so corrupt — the exact logo and
      // contact details, which are composited afresh on the new result instead.
      const [fileId, mimeType] = useOutput
        ? [row.imageDriveFileId, row.imageMimeType]
        : kind === 'generation-element-reference'
          ? [row.elementReferenceDriveFileId, row.elementReferenceMimeType]
          : [row.referenceDriveFileId, row.referenceMimeType];
      if (!fileId || !mimeType) {
        throw new StudioError('validation', 'That history item has no stored input image to reuse. Upload the image again.');
      }

      return {
        image: { bytes: await readStudioFile(fileId), mimeType },
        needsUpload: false,
        existingFileId: fileId,
        // Lineage means "made from that poster". Only an edit or a variation of
        // another generation's output is one; a style reference is not.
        parentGenerationId: lineage && useOutput && mode !== 'GENERATE' ? row.id : null,
        campaignBrief: lineage && useOutput && mode === 'VARIATION' ? await findCampaignBrief(row) : null,
      };
    }
  }
}

/**
 * The brief a History item's campaign was generated from: its own prompt when
 * it is a Generate, otherwise the nearest Generate up its lineage. An Edit's or
 * a Variation's own prompt is an instruction, not a brief, so it is skipped.
 *
 * Context for Variation only, so a failed lookup degrades to no brief rather
 * than stopping the request.
 */
async function findCampaignBrief(row: {
  mode: PosterStudioMode;
  prompt: string;
  parentGenerationId: string | null;
}): Promise<string | null> {
  let current: typeof row | null = row;
  try {
    for (let hop = 0; current && hop < MAX_LINEAGE_HOPS; hop += 1) {
      if (current.mode === 'GENERATE') return current.prompt;
      if (!current.parentGenerationId) return null;
      current = await prisma.posterStudioGeneration.findUnique({
        where: { id: current.parentGenerationId },
        select: { mode: true, prompt: true, parentGenerationId: true },
      });
    }
  } catch (error) {
    console.warn('[studio:action] could not read the campaign brief for a variation:', error instanceof Error ? error.message : error);
  }
  return null;
}
