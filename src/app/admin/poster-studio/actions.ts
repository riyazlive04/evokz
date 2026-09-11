'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/prisma';
import { generateStudioImage, editStudioImage, type PosterStudioAspectRatio } from '@/lib/ai/openai-images';
import { analyzeReferencePoster, buildStudioImagePrompt, type ReferenceAnalysisResult } from '@/lib/ai/studio-prompts';

export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

export interface StudioGenerateInput {
  prompt: string;
  mode?: 'generate' | 'edit' | 'variation';
  aspectRatio?: PosterStudioAspectRatio;
  referenceDataUri?: string;
  editInstruction?: string;
  parentGenerationId?: string;
  clientId?: string | null;
  hybridOverlay?: boolean;
}

export interface StudioHistoryItem {
  id: string;
  prompt: string;
  mode: string;
  aspectRatio: string;
  referenceUrl: string | null;
  imageUrl: string;
  revisedPrompt: string | null;
  parentGenerationId: string | null;
  clientId: string | null;
  createdAt: Date;
}

export async function generateStudioPosterAction(
  input: StudioGenerateInput,
): Promise<ActionResult<{ generation: StudioHistoryItem; analysis?: ReferenceAnalysisResult }>> {
  try {
    if (!input.prompt || input.prompt.trim().length < 3) {
      return { ok: false, error: 'Please provide a valid poster generation prompt (at least 3 characters).' };
    }

    const mode = input.mode ?? 'generate';
    const aspectRatio = input.aspectRatio ?? '1024x1792';

    let referenceAnalysis: ReferenceAnalysisResult | null = null;
    if (input.referenceDataUri) {
      try {
        referenceAnalysis = await analyzeReferencePoster(input.referenceDataUri);
      } catch (analErr) {
        console.warn('[studio-action] Reference image analysis warning:', analErr);
      }
    }

    // Fetch client brand guidelines if a client is selected
    let brandTokens = null;
    if (input.clientId) {
      const client = await prisma.client.findUnique({
        where: { id: input.clientId },
        select: { companyName: true, brandTagline: true, brandGuideline: true, category: { select: { name: true } } },
      });
      if (client) {
        const bg = client.brandGuideline as any;
        brandTokens = {
          companyName: client.companyName,
          tagline: client.brandTagline ?? undefined,
          industry: client.category?.name,
          primaryColor: bg?.primaryColor ?? bg?.palette?.[0],
          accentColor: bg?.accentColor ?? bg?.palette?.[1],
        };
      }
    }

    // Build optimized prompt
    const finalPrompt = buildStudioImagePrompt({
      userPrompt: input.prompt,
      editInstruction: input.editInstruction,
      referenceAnalysis,
      aspectRatio,
      brandTokens,
      hybridVectorOverlay: input.hybridOverlay,
    });

    let imageResult;
    if (mode === 'edit' || mode === 'variation') {
      imageResult = await editStudioImage({
        prompt: finalPrompt,
        imageDataUri: input.referenceDataUri,
        size: aspectRatio,
        clientId: input.clientId,
      });
    } else {
      imageResult = await generateStudioImage({
        prompt: finalPrompt,
        size: aspectRatio,
        clientId: input.clientId,
      });
    }

    // Save to Database
    let generationRecord: StudioHistoryItem;
    try {
      const dbGen = await prisma.posterStudioGeneration.create({
        data: {
          prompt: input.prompt,
          mode,
          aspectRatio,
          referenceUrl: input.referenceDataUri ? '[Reference Image Attached]' : null,
          imageUrl: imageResult.imageUrl,
          revisedPrompt: imageResult.revisedPrompt ?? null,
          parentGenerationId: input.parentGenerationId ?? null,
          clientId: input.clientId ?? null,
        },
      });
      generationRecord = dbGen;
    } catch (dbErr) {
      console.warn('[studio-action] DB save fallback (dev DB offline or schema pending):', dbErr);
      generationRecord = {
        id: `local-${Date.now()}`,
        prompt: input.prompt,
        mode,
        aspectRatio,
        referenceUrl: input.referenceDataUri ? 'attached' : null,
        imageUrl: imageResult.imageUrl,
        revisedPrompt: imageResult.revisedPrompt ?? null,
        parentGenerationId: input.parentGenerationId ?? null,
        clientId: input.clientId ?? null,
        createdAt: new Date(),
      };
    }

    revalidatePath('/admin/poster-studio');

    return {
      ok: true,
      data: {
        generation: generationRecord,
        analysis: referenceAnalysis ?? undefined,
      },
    };
  } catch (error: any) {
    console.error('[studio-action] Failed to generate studio poster:', error);
    return {
      ok: false,
      error: error?.message || 'Failed to generate poster. Please check your prompt and API key settings.',
    };
  }
}

export async function fetchStudioHistoryAction(): Promise<ActionResult<StudioHistoryItem[]>> {
  try {
    const records = await prisma.posterStudioGeneration.findMany({
      orderBy: { createdAt: 'desc' },
      take: 24,
    });
    return { ok: true, data: records };
  } catch (err: any) {
    console.warn('[studio-action] Fetch history DB fallback:', err);
    return { ok: true, data: [] };
  }
}

export async function deleteStudioGenerationAction(id: string): Promise<ActionResult> {
  try {
    await prisma.posterStudioGeneration.delete({
      where: { id },
    });
    revalidatePath('/admin/poster-studio');
    return { ok: true, data: undefined };
  } catch (err: any) {
    return { ok: false, error: 'Failed to delete record' };
  }
}

export async function fetchStudioClientsAction(): Promise<ActionResult<Array<{ id: string; companyName: string }>>> {
  try {
    const clients = await prisma.client.findMany({
      where: { isActive: true },
      select: { id: true, companyName: true },
      orderBy: { companyName: 'asc' },
    });
    return { ok: true, data: clients };
  } catch (err: any) {
    return { ok: true, data: [] };
  }
}
