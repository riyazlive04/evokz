import OpenAI from 'openai';
import type { ImagesResponse } from 'openai/resources/images';

import { optionalEnv } from '@/lib/env';
import { StudioError } from '@/lib/poster-studio/errors';
import type { ImageTokenUsage } from '@/lib/pricing';

/**
 * OpenAI image access for the AI Poster Studio.
 *
 * One entry point, `renderStudioImage`, which picks the endpoint from whether an
 * input image is supplied:
 *
 *   no image  -> `images.generate`
 *   image     -> `images.edit`, with the image attached
 *
 * The edit endpoint is how *every* image-guided request reaches the model — an
 * edit, a variation, and a generate that carries a style reference. The first
 * version described a reference with a gpt-4o vision call and then sent only that
 * text, so the image model never saw the reference at all.
 *
 * Returns raw bytes. Storage is the caller's job (`src/lib/poster-studio/storage.ts`);
 * nothing here writes to Drive or the database.
 */

/**
 * Pinned rather than read from the environment: the output sizes in
 * `STUDIO_ASPECT_RATIOS` are gpt-image-2's flexible sizes, which `gpt-image-1`
 * and `gpt-image-1.5` reject. Changing the model means changing those sizes.
 */
export const STUDIO_IMAGE_MODEL = 'gpt-image-2';

const QUALITIES = ['low', 'medium', 'high', 'auto'] as const;
export type StudioImageQuality = (typeof QUALITIES)[number];

/**
 * Render quality, from `POSTER_STUDIO_IMAGE_QUALITY`.
 *
 * Defaults to `low` — the cheapest setting — deliberately: output tokens, and so
 * cost, scale with quality, and the API's own default of `auto` is free to pick
 * `high`. Raise it once real-API testing has shown what each setting costs.
 */
export function getStudioImageQuality(): StudioImageQuality {
  const raw = optionalEnv('POSTER_STUDIO_IMAGE_QUALITY', 'low').toLowerCase();
  return (QUALITIES as readonly string[]).includes(raw) ? (raw as StudioImageQuality) : 'low';
}

/**
 * Per-request ceiling. Image generation at high quality and large sizes can take
 * well over a minute; the SDK default of ten minutes would leave an operator
 * watching a spinner long after anything useful could come back.
 */
const REQUEST_TIMEOUT_MS = 5 * 60_000;

export interface StudioImageInput {
  bytes: Buffer;
  mimeType: string;
}

export interface StudioImageRequest {
  prompt: string;
  /** Exact `WIDTHxHEIGHT` from `STUDIO_ASPECT_RATIOS`. */
  size: string;
  /** When present the request goes through `images.edit` with this image attached. */
  image?: StudioImageInput | null;
  /**
   * Overrides `POSTER_STUDIO_IMAGE_QUALITY` for this request. Clone mode renders
   * at `high`: small type redrawn at `low` is where a template stops looking like
   * itself.
   */
  quality?: StudioImageQuality;
  /**
   * How closely an edit holds to the input image's detail and faces. Edit only;
   * omitted, the API default applies — exactly as before this option existed.
   *
   * **Not for `STUDIO_IMAGE_MODEL`.** gpt-image-2 answers it with a 400
   * (`invalid_input_fidelity_model`) before generating — measured 2026-09-17. It
   * is here for the gpt-image-1.x models that accept it.
   */
  inputFidelity?: 'high' | 'low';
  /**
   * PNG the same size as `image`, fully transparent where the edit may change the
   * image and opaque elsewhere. Edit only; omitted, the whole image is editable.
   */
  mask?: { bytes: Buffer } | null;
}

export interface StudioImageResult {
  bytes: Buffer;
  mimeType: string;
  model: string;
  quality: StudioImageQuality;
  /** Null when the response carried no usage block. */
  usage: ImageTokenUsage | null;
}

let cachedClient: OpenAI | null = null;

function getClient(): OpenAI {
  if (cachedClient) return cachedClient;

  const apiKey = optionalEnv('OPENAI_API_KEY', '');
  if (!apiKey) {
    throw new StudioError(
      'config',
      'OPENAI_API_KEY is not set on the server, so the studio cannot reach OpenAI. Add it to the environment and restart the app.',
    );
  }

  cachedClient = new OpenAI({
    apiKey,
    timeout: REQUEST_TIMEOUT_MS,
    // No automatic retries. A retried image request doubles the wait invisibly,
    // and a request that timed out client-side may still have been generated
    // and billed. The operator can press the button again and see that they did.
    maxRetries: 0,
  });
  return cachedClient;
}

/**
 * Throws the operator-facing `config` error when no API key is configured.
 * Called at the start of a request, before any Drive or database work.
 */
export function assertStudioImageConfigured(): void {
  getClient();
}

export async function renderStudioImage(request: StudioImageRequest): Promise<StudioImageResult> {
  const client = getClient();
  const quality = request.quality ?? getStudioImageQuality();

  try {
    const response: ImagesResponse = request.image
      ? await client.images.edit({
          model: STUDIO_IMAGE_MODEL,
          image: await OpenAI.toFile(
            request.image.bytes,
            `input.${extensionFor(request.image.mimeType)}`,
            { type: request.image.mimeType },
          ),
          prompt: request.prompt,
          n: 1,
          size: request.size,
          quality,
          output_format: 'png',
          // Spread only when set, so a request without them is byte-for-byte the
          // request every existing caller has always sent.
          ...(request.inputFidelity ? { input_fidelity: request.inputFidelity } : {}),
          ...(request.mask
            ? { mask: await OpenAI.toFile(request.mask.bytes, 'mask.png', { type: 'image/png' }) }
            : {}),
        })
      : await client.images.generate({
          model: STUDIO_IMAGE_MODEL,
          prompt: request.prompt,
          n: 1,
          size: request.size,
          quality,
          output_format: 'png',
        });

    // GPT image models always answer in base64; there is no URL form to fall
    // back to.
    const encoded = response.data?.[0]?.b64_json;
    if (!encoded) {
      throw new StudioError(
        'provider',
        'OpenAI answered without an image. Nothing was saved — try again.',
      );
    }

    return {
      bytes: Buffer.from(encoded, 'base64'),
      mimeType: `image/${response.output_format ?? 'png'}`,
      model: STUDIO_IMAGE_MODEL,
      quality,
      usage: toTokenUsage(response.usage),
    };
  } catch (error) {
    throw toStudioError(error);
  }
}

function extensionFor(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  return 'png';
}

function toTokenUsage(usage: ImagesResponse['usage']): ImageTokenUsage | null {
  if (!usage) return null;
  const imageInputTokens = usage.input_tokens_details?.image_tokens ?? 0;
  const textInputTokens =
    usage.input_tokens_details?.text_tokens ?? Math.max(usage.input_tokens - imageInputTokens, 0);
  return {
    textInputTokens,
    imageInputTokens,
    outputTokens: usage.output_tokens ?? 0,
  };
}

/**
 * Maps a provider failure to operator copy.
 *
 * The raw provider message is logged, never returned: it can name internal
 * parameters, and it is not written for an operator. Checked against the SDK's
 * typed error classes — `APIConnectionTimeoutError` before `APIConnectionError`,
 * which it extends, and both before `APIError`, which they extend.
 */
function toStudioError(error: unknown): StudioError {
  if (error instanceof StudioError) return error;

  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return new StudioError(
      'timeout',
      'OpenAI did not return the image within 5 minutes. Nothing was saved. Try again; if it keeps happening, try a smaller format.',
      { cause: error },
    );
  }

  if (error instanceof OpenAI.APIConnectionError) {
    return new StudioError(
      'network',
      'The server could not reach the OpenAI API. Check its network connection and try again.',
      { cause: error },
    );
  }

  if (error instanceof OpenAI.APIError) {
    console.error('[studio:openai] image request failed', {
      status: error.status,
      code: error.code,
      type: error.type,
      param: error.param,
      requestId: error.requestID,
      message: error.message,
    });

    const code = error.code ?? '';
    const param = error.param ?? '';

    if (
      code === 'moderation_blocked' ||
      code === 'content_policy_violation' ||
      (error.status === 400 && /safety system|moderation/i.test(error.message))
    ) {
      return new StudioError(
        'moderation',
        'OpenAI declined this request under its safety policy. Rephrase the prompt, or use a different input image.',
        { cause: error },
      );
    }

    switch (error.status) {
      case 401:
        return new StudioError(
          'auth',
          'OpenAI rejected the API key configured on the server. Check OPENAI_API_KEY.',
          { cause: error },
        );
      case 403:
        return new StudioError(
          'access',
          `This OpenAI API key or organisation is not allowed to use ${STUDIO_IMAGE_MODEL}. GPT image models can require organisation verification in the OpenAI dashboard.`,
          { cause: error },
        );
      case 404:
        return new StudioError(
          'model',
          `OpenAI could not find ${STUDIO_IMAGE_MODEL} or its image endpoint for this API key. Confirm the model is available to your organisation.`,
          { cause: error },
        );
      case 413:
        return new StudioError(
          'image-too-large',
          'OpenAI refused the input image as too large. Use a smaller file.',
          { cause: error },
        );
      case 429:
        return code === 'insufficient_quota'
          ? new StudioError(
              'quota',
              'The OpenAI account is out of credit or over its billing limit. Check billing in the OpenAI dashboard.',
              { cause: error },
            )
          : new StudioError(
              'rate-limit',
              'OpenAI is rate-limiting requests from this account. Wait a minute and try again.',
              { cause: error },
            );
      default:
        break;
    }

    if (error.status === 400 || error.status === 422) {
      if (param.startsWith('image') || /image/i.test(code)) {
        return new StudioError(
          'invalid-image',
          'OpenAI could not use the input image. Try a different PNG, JPEG or WebP file.',
          { cause: error },
        );
      }
      if (param === 'size' || /size/i.test(code)) {
        return new StudioError(
          'bad-request',
          `OpenAI rejected the requested output size for ${STUDIO_IMAGE_MODEL}. Try a different format.`,
          { cause: error },
        );
      }
      return new StudioError(
        'bad-request',
        'OpenAI rejected the request. The details are in the server log.',
        { cause: error },
      );
    }

    if (typeof error.status === 'number' && error.status >= 500) {
      return new StudioError(
        'provider',
        'OpenAI had a server error. Nothing was saved — try again shortly.',
        { cause: error },
      );
    }
  }

  console.error('[studio:openai] unexpected image failure', error);
  return new StudioError(
    'provider',
    'The image request failed unexpectedly. The details are in the server log.',
    { cause: error },
  );
}
