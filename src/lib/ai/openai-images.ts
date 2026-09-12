import OpenAI from 'openai';
import { type Uploadable } from 'openai/uploads';
import { optionalEnv } from '@/lib/env';
import { prisma } from '@/lib/prisma';
import { UsageKeySource, UsageProvider } from '@prisma/client';

export type PosterStudioAspectRatio = '1024x1024' | '1024x1792' | '1792x1024';

export interface ImageGenerationOptions {
  prompt: string;
  size?: PosterStudioAspectRatio;
  quality?: 'standard' | 'low' | 'medium' | 'high' | 'auto';
  model?: string;
  clientId?: string | null;
}

export interface ImageEditOptions {
  prompt: string;
  imageBuffer?: Buffer;
  imageDataUri?: string;
  size?: PosterStudioAspectRatio;
  quality?: 'standard' | 'low' | 'medium' | 'high' | 'auto';
  model?: string;
  clientId?: string | null;
}

export interface StudioImageResult {
  imageUrl: string;
  revisedPrompt?: string;
  model: string;
  size: PosterStudioAspectRatio;
}

const DEFAULT_IMAGE_MODEL = 'gpt-image-2';

let cachedClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (cachedClient) return cachedClient;
  const apiKey = optionalEnv('OPENAI_API_KEY', '');
  if (!apiKey || apiKey.trim() === '') {
    throw new Error(
      'OPENAI_API_KEY is missing. Please configure OPENAI_API_KEY in your environment variables to enable live AI poster generation.',
    );
  }
  cachedClient = new OpenAI({ apiKey });
  return cachedClient;
}

/**
 * Record OpenAI image usage into the UsageEvent ledger.
 * Does not invent fake pricing; records actual tokens/images spent.
 */
async function recordStudioImageUsage(
  model: string,
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number },
  clientId?: string | null,
): Promise<void> {
  try {
    await prisma.usageEvent.create({
      data: {
        clientId: clientId ?? null,
        provider: UsageProvider.OPENAI,
        operation: 'image',
        model,
        imageCount: 1,
        inputTokens: usage?.input_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
        costUsdMicros: 0, // Provider billing reconciliation comes from OpenAI account dashboard
        keySource: UsageKeySource.PLATFORM,
      },
    });
  } catch (err) {
    console.error('[studio:usage] Failed to record image spend ledger entry:', err);
  }
}

/**
 * Helper to convert a Data URI or Buffer to an OpenAI Uploadable File object.
 */
async function prepareUploadableImage(imageDataUri?: string, imageBuffer?: Buffer): Promise<Uploadable> {
  if (imageBuffer) {
    return await OpenAI.toFile(imageBuffer, 'reference.png', { type: 'image/png' });
  }

  if (imageDataUri) {
    const matches = imageDataUri.match(/^data:(image\/[a-zA-Z0-9\+\-\.]+);base64,(.+)$/);
    if (!matches || !matches[2]) {
      throw new Error('Invalid image reference format. Expected a valid image Data URI.');
    }
    const mimeType = matches[1] || 'image/png';
    const allowedMimeTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
    if (!allowedMimeTypes.includes(mimeType.toLowerCase())) {
      throw new Error(`Unsupported image format: ${mimeType}. Please upload a PNG, JPEG, or WebP image.`);
    }

    const buffer = Buffer.from(matches[2], 'base64');
    if (buffer.length > 10 * 1024 * 1024) {
      throw new Error('Reference image file size exceeds the 10 MB limit.');
    }

    const ext = mimeType.includes('jpeg') || mimeType.includes('jpg') ? 'jpg' : mimeType.includes('webp') ? 'webp' : 'png';
    return await OpenAI.toFile(buffer, `reference.${ext}`, { type: mimeType });
  }

  throw new Error('No reference image content provided.');
}

/**
 * Generate a new poster image via OpenAI GPT-Image-2 API (Text-to-Image).
 */
export async function generateStudioImage(options: ImageGenerationOptions): Promise<StudioImageResult> {
  const model = options.model ?? DEFAULT_IMAGE_MODEL;
  const size = options.size ?? '1024x1792';

  try {
    const client = getOpenAIClient();

    const response = await client.images.generate({
      model,
      prompt: options.prompt,
      n: 1,
      size,
    });

    const imageItem = response.data?.[0];
    if (!imageItem) {
      throw new Error('OpenAI Image API returned an empty response.');
    }

    const imageUrl = imageItem.b64_json
      ? `data:image/png;base64,${imageItem.b64_json}`
      : imageItem.url;

    if (!imageUrl) {
      throw new Error('OpenAI Image API returned no image URL or Base64 payload.');
    }

    await recordStudioImageUsage(model, response.usage, options.clientId);

    return {
      imageUrl,
      revisedPrompt: imageItem.revised_prompt ?? options.prompt,
      model,
      size,
    };
  } catch (error: any) {
    console.error('[studio:openai-images] Image generation error:', error);
    throw formatOperatorError(error);
  }
}

/**
 * Edit or generate variations of an existing poster/image using OpenAI GPT-Image-2 API (Image-to-Image / Edit).
 */
export async function editStudioImage(options: ImageEditOptions): Promise<StudioImageResult> {
  const model = options.model ?? DEFAULT_IMAGE_MODEL;
  const size = options.size ?? '1024x1792';

  // If no reference image is supplied, fall back cleanly to text-to-image generation
  if (!options.imageDataUri && !options.imageBuffer) {
    return await generateStudioImage({
      prompt: options.prompt,
      size,
      model,
      clientId: options.clientId,
    });
  }

  try {
    const client = getOpenAIClient();
    const uploadableFile = await prepareUploadableImage(options.imageDataUri, options.imageBuffer);

    const response = await client.images.edit({
      model,
      image: uploadableFile,
      prompt: options.prompt,
      n: 1,
      size,
    });

    const imageItem = response.data?.[0];
    if (!imageItem) {
      throw new Error('OpenAI Image Edit API returned an empty response.');
    }

    const imageUrl = imageItem.b64_json
      ? `data:image/png;base64,${imageItem.b64_json}`
      : imageItem.url;

    if (!imageUrl) {
      throw new Error('OpenAI Image Edit API returned no image payload.');
    }

    await recordStudioImageUsage(model, response.usage, options.clientId);

    return {
      imageUrl,
      revisedPrompt: imageItem.revised_prompt ?? options.prompt,
      model,
      size,
    };
  } catch (error: any) {
    console.error('[studio:openai-images] Image edit error:', error);
    throw formatOperatorError(error);
  }
}

/**
 * Format provider and network errors into clean, operator-safe messages.
 */
function formatOperatorError(error: any): Error {
  if (error instanceof Error && error.message.includes('OPENAI_API_KEY is missing')) {
    return error;
  }

  const status = error?.status ?? error?.statusCode;
  const message = error?.message || 'Unknown provider error';

  if (status === 401 || message.includes('API key') || message.includes('unauthorized')) {
    return new Error('OPENAI_API_KEY was rejected. Please verify your OpenAI API key in environment variables.');
  }
  if (status === 429 || message.includes('rate limit') || message.includes('quota')) {
    return new Error('OpenAI rate limit or billing quota exceeded. Please verify your OpenAI account plan and billing.');
  }
  if (error?.code === 'content_policy_violation' || message.includes('safety') || message.includes('policy')) {
    return new Error('The poster request was declined by OpenAI safety policies. Please refine your prompt description.');
  }
  if (status >= 500) {
    return new Error('OpenAI API service is temporarily unavailable. Please try again in a few moments.');
  }

  return new Error(`Poster generation error: ${message}`);
}
