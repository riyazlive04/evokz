import OpenAI from 'openai';
import { optionalEnv, requireEnv } from '@/lib/env';
import { recordOpenAiUsage } from '@/lib/usage';
import { prisma } from '@/lib/prisma';
import { UsageKeySource, UsageProvider } from '@prisma/client';

export type PosterStudioAspectRatio = '1024x1024' | '1024x1792' | '1792x1024';

export interface ImageGenerationOptions {
  prompt: string;
  size?: PosterStudioAspectRatio;
  quality?: 'standard' | 'hd';
  model?: 'dall-e-3' | 'dall-e-2';
  style?: 'vivid' | 'natural';
  clientId?: string | null;
}

export interface ImageEditOptions {
  prompt: string;
  imageBuffer?: Buffer;
  imageDataUri?: string;
  size?: PosterStudioAspectRatio;
  clientId?: string | null;
}

export interface StudioImageResult {
  imageUrl: string; // Base64 Data URI or HTTP URL
  revisedPrompt?: string;
  model: string;
  size: PosterStudioAspectRatio;
}

let cachedClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (cachedClient) return cachedClient;
  const apiKey = optionalEnv('OPENAI_API_KEY', '');
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured. Please add OPENAI_API_KEY to your environment variables to enable live AI image generation.');
  }
  cachedClient = new OpenAI({ apiKey });
  return cachedClient;
}

/**
 * Price estimation in USD Micros for DALL-E models (standard/hd, sizes).
 */
function estimateImageCostMicros(model: string, size: PosterStudioAspectRatio, quality: 'standard' | 'hd' = 'standard'): number {
  if (model === 'dall-e-3') {
    if (quality === 'hd') {
      return size === '1024x1024' ? 80_000 : 120_000; // $0.080 - $0.120
    }
    return size === '1024x1024' ? 40_000 : 80_000; // $0.040 - $0.080
  }
  // DALL-E 2 standard 1024x1024
  return 20_000; // $0.020
}

/**
 * Record OpenAI DALL-E image generation usage into UsageEvent ledger.
 */
async function recordStudioImageUsage(model: string, size: PosterStudioAspectRatio, quality: 'standard' | 'hd', clientId?: string | null): Promise<void> {
  try {
    const costUsdMicros = estimateImageCostMicros(model, size, quality);
    await prisma.usageEvent.create({
      data: {
        clientId: clientId ?? null,
        provider: UsageProvider.OPENAI,
        operation: 'image',
        model,
        imageCount: 1,
        costUsdMicros,
        keySource: UsageKeySource.PLATFORM,
      },
    });
  } catch (err) {
    console.error('[studio:usage] Failed to record image spend ledger:', err);
  }
}

/**
 * Generate a new poster image via OpenAI DALL-E API.
 */
export async function generateStudioImage(options: ImageGenerationOptions): Promise<StudioImageResult> {
  const model = options.model ?? 'dall-e-3';
  const size = options.size ?? '1024x1792';
  const quality = options.quality ?? 'standard';
  const style = options.style ?? 'vivid';

  try {
    const client = getOpenAIClient();

    const response = await client.images.generate({
      model,
      prompt: options.prompt,
      n: 1,
      size,
      quality: model === 'dall-e-3' ? quality : undefined,
      style: model === 'dall-e-3' ? style : undefined,
      response_format: 'b64_json',
    });

    const imageItem = response.data?.[0];
    if (!imageItem || (!imageItem.b64_json && !imageItem.url)) {
      throw new Error('OpenAI Image API returned no image data.');
    }

    const imageUrl = imageItem.b64_json
      ? `data:image/png;base64,${imageItem.b64_json}`
      : imageItem.url!;

    // Log to UsageEvent
    await recordStudioImageUsage(model, size, quality, options.clientId);

    return {
      imageUrl,
      revisedPrompt: imageItem.revised_prompt ?? options.prompt,
      model,
      size,
    };
  } catch (error: any) {
    console.error('[studio:openai-images] Image generation error:', error);

    // Format operator-safe error messages
    if (error?.status === 401 || error?.message?.includes('OPENAI_API_KEY')) {
      throw new Error('OPENAI_API_KEY was missing or rejected. Please verify your API key in environment variables.');
    }
    if (error?.status === 429) {
      throw new Error('OpenAI rate limit or quota exceeded. Please check your OpenAI account billing or try again later.');
    }
    if (error?.code === 'content_policy_violation' || error?.message?.includes('safety system')) {
      throw new Error('The prompt violated OpenAI safety policies. Please adjust your request details.');
    }
    throw new Error(`Poster generation failed: ${error?.message || 'Unknown provider error'}`);
  }
}

/**
 * Edit or apply natural language variation instructions to an image.
 */
export async function editStudioImage(options: ImageEditOptions): Promise<StudioImageResult> {
  const size = options.size ?? '1024x1792';

  try {
    const client = getOpenAIClient();

    // If imageBuffer is supplied and size is square (1024x1024), DALL-E 2 edit API can be called
    if (options.imageBuffer && size === '1024x1024') {
      try {
        // Prepare image file for DALL-E 2 API
        const file = await OpenAI.toFile(options.imageBuffer, 'reference.png', { type: 'image/png' });
        const response = await client.images.edit({
          image: file,
          prompt: options.prompt,
          n: 1,
          size: '1024x1024',
          response_format: 'b64_json',
        });

        const item = response.data?.[0];
        if (item?.b64_json) {
          await recordStudioImageUsage('dall-e-2', '1024x1024', 'standard', options.clientId);
          return {
            imageUrl: `data:image/png;base64,${item.b64_json}`,
            revisedPrompt: options.prompt,
            model: 'dall-e-2-edit',
            size: '1024x1024',
          };
        }
      } catch (editErr) {
        console.warn('[studio:openai-images] DALL-E 2 direct edit fallback to DALL-E 3 guided generation:', editErr);
      }
    }

    // High-fidelity fallback/default edit pipeline using DALL-E 3 with full descriptive prompt context
    return await generateStudioImage({
      prompt: options.prompt,
      size,
      model: 'dall-e-3',
      clientId: options.clientId,
    });
  } catch (error: any) {
    console.error('[studio:openai-images] Image edit error:', error);
    throw new Error(`Image edit failed: ${error?.message || 'Unknown error'}`);
  }
}
