import OpenAI from 'openai';

import { intEnv, optionalEnv, requireEnv } from '@/lib/env';
import { recordOpenAiUsage, type UsageContext, type UsageOperation } from '@/lib/usage';

/**
 * Shared OpenAI access for the copy/tokenizer stages.
 *
 * Every call goes through `generateStructured`, which pins the response with
 * Structured Outputs (`response_format: json_schema`, `strict: true`) so the
 * model cannot wrap its JSON in prose — the failure mode the blueprint calls out
 * under "Failures in Content Formatting".
 *
 * Replaces the blueprint's Claude 3.5 Sonnet stage (retired 2025-10-28).
 */

const DEFAULT_MODEL = 'gpt-4o-mini';

export interface StructuredRequest {
  /** Short label used in logs and error messages. */
  label: string;
  /**
   * Stable instructions. Everything reusable across calls belongs here — OpenAI
   * caches long prompt *prefixes* automatically, so per-call detail must go in
   * `userPrompt` or it invalidates the shared prefix for every later batch.
   */
  systemPrompt: string;
  /** The varying part of the request. */
  userPrompt: string;
  /**
   * An image to reason over, as a `data:` URI, attached alongside `userPrompt`.
   *
   * Used by the layout extractor, which reads an uploaded reference poster and
   * describes its grid. A data URI rather than an http URL because the only
   * images this system holds are private Drive objects the model could not fetch
   * — the bytes have to travel in the request.
   *
   * `detail: 'high'` is not optional for that job. On `low` the image is
   * downsampled to 512px before the model sees it, which is enough to say "a
   * poster with an orange bar" and not enough to tell a 40/60 column split from
   * a 50/50 one. The extra tokens are charged once per upload, never per poster.
   */
  imageDataUri?: string;
  /**
   * JSON Schema the response is constrained to. Under `strict: true` every
   * object needs `additionalProperties: false` and must list *all* of its
   * properties in `required` — optional fields are not supported.
   */
  schema: Record<string, unknown>;
  /** Schema name sent to the API: a-z, A-Z, 0-9, underscore, dash only. */
  schemaName: string;
  /**
   * Overrides the fleet model for this one call.
   *
   * The default exists because every other stage here is text-in/JSON-out and
   * `gpt-4o-mini` does it well and cheaply. Layout extraction is neither: it is
   * a vision task where a misread column split silently becomes every poster
   * that vertical ever renders. Charging a stronger model once per uploaded
   * template is the cheapest part of that decision.
   */
  model?: string;
  maxTokens?: number;
  /** 0–2. Higher values give more caption variance. */
  temperature?: number;
  /**
   * Attribution for the spend ledger. Omit and the call is still logged but not
   * billed to any client — used by callers with no tenant in scope.
   */
  bill?: UsageContext & { operation: UsageOperation };
}

export class LlmError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | 'refusal'
      | 'truncated'
      | 'filtered'
      | 'malformed'
      | 'transport'
      | 'config',
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'LlmError';
  }
}

let cachedClient: OpenAI | null = null;

function getClient(): OpenAI {
  if (cachedClient) return cachedClient;
  // Explicit rather than relying on ambient resolution, so a missing key fails
  // with our own message instead of a 401 at request time.
  cachedClient = new OpenAI({ apiKey: requireEnv('OPENAI_API_KEY') });
  return cachedClient;
}

export function getModel(): string {
  return optionalEnv('OPENAI_MODEL', DEFAULT_MODEL);
}

/**
 * Runs one schema-constrained completion and returns the parsed JSON.
 *
 * Retries only transport-level and rate-limit faults; a refusal or a schema
 * violation is deterministic and re-billing it would be waste.
 */
export async function generateStructured<T>(request: StructuredRequest): Promise<T> {
  const client = getClient();
  const model = request.model ?? getModel();
  const maxAttempts = Math.max(1, intEnv('OPENAI_MAX_ATTEMPTS', 3));
  // gpt-4o-mini caps output at 16,384 tokens; clamp so an over-large env value
  // becomes a 400 at request time rather than a confusing truncation.
  const maxTokens = Math.min(
    request.maxTokens ?? intEnv('OPENAI_MAX_TOKENS', 8_000),
    16_384,
  );
  const temperature = request.temperature ?? 1;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await client.chat.completions.create({
        model,
        max_completion_tokens: maxTokens,
        temperature,
        messages: [
          { role: 'system', content: request.systemPrompt },
          {
            role: 'user',
            content: request.imageDataUri
              ? [
                  { type: 'text', text: request.userPrompt },
                  {
                    type: 'image_url',
                    image_url: { url: request.imageDataUri, detail: 'high' },
                  },
                ]
              : request.userPrompt,
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: request.schemaName,
            schema: request.schema,
            strict: true,
          },
        },
      });

      const choice = response.choices[0];
      if (!choice) {
        throw new LlmError(`${request.label}: response contained no choices`, 'malformed');
      }

      // Structured Outputs surface a safety decline in its own field rather
      // than as an error, so this must be checked before reading content.
      if (choice.message.refusal) {
        throw new LlmError(
          `${request.label}: the model declined this request — ${choice.message.refusal}`,
          'refusal',
        );
      }

      if (choice.finish_reason === 'length') {
        throw new LlmError(
          `${request.label}: response hit the ${maxTokens}-token cap and is incomplete. Reduce CALENDAR_BATCH_SIZE or raise OPENAI_MAX_TOKENS.`,
          'truncated',
        );
      }

      if (choice.finish_reason === 'content_filter') {
        throw new LlmError(
          `${request.label}: response was blocked by the content filter`,
          'filtered',
        );
      }

      const text = choice.message.content?.trim();
      if (!text) {
        throw new LlmError(`${request.label}: model returned no content`, 'malformed');
      }

      logUsage(request.label, response.usage);

      // Recorded before the JSON parse: the tokens are billed by OpenAI whether
      // or not the payload turns out to be usable.
      if (request.bill && response.usage) {
        const { operation, ...context } = request.bill;
        await recordOpenAiUsage(
          {
            inputTokens: response.usage.prompt_tokens,
            cachedTokens: response.usage.prompt_tokens_details?.cached_tokens ?? 0,
            outputTokens: response.usage.completion_tokens,
          },
          model,
          operation,
          context,
        );
      }

      try {
        return JSON.parse(text) as T;
      } catch (cause) {
        // Structured Outputs make this near-impossible, but a truncated payload
        // that somehow reported finish_reason "stop" would land here.
        throw new LlmError(
          `${request.label}: response was not valid JSON`,
          'malformed',
          { cause },
        );
      }
    } catch (error) {
      lastError = error;

      if (attempt === maxAttempts || !isRetryable(error)) break;

      const backoffMs = 1_000 * 2 ** (attempt - 1);
      console.warn(
        `[ace:llm] ${request.label} attempt ${attempt}/${maxAttempts} failed (${describe(error)}). Retrying in ${backoffMs}ms.`,
      );
      await sleep(backoffMs);
    }
  }

  throw toLlmError(lastError, request.label);
}

/**
 * Retry only faults a later attempt could plausibly survive. Checked against
 * the SDK's typed error classes — `APIConnectionError` is tested before
 * `APIError` because it derives from it.
 */
function isRetryable(error: unknown): boolean {
  if (error instanceof LlmError) return false;
  if (error instanceof OpenAI.RateLimitError) return true;
  if (error instanceof OpenAI.APIConnectionError) return true;
  if (error instanceof OpenAI.APIError) {
    return typeof error.status === 'number' && error.status >= 500;
  }
  return false;
}

function toLlmError(error: unknown, label: string): LlmError {
  if (error instanceof LlmError) return error;

  if (error instanceof OpenAI.AuthenticationError) {
    return new LlmError(`${label}: OPENAI_API_KEY was rejected`, 'config', { cause: error });
  }
  if (error instanceof OpenAI.PermissionDeniedError) {
    return new LlmError(
      `${label}: this API key is not permitted to use model "${getModel()}"`,
      'config',
      { cause: error },
    );
  }
  if (error instanceof OpenAI.NotFoundError) {
    return new LlmError(
      `${label}: model "${getModel()}" was not found — check OPENAI_MODEL`,
      'config',
      { cause: error },
    );
  }
  if (error instanceof OpenAI.BadRequestError) {
    // Most often a schema that violates a strict-mode constraint.
    return new LlmError(
      `${label}: request rejected — ${error.message}`,
      'config',
      { cause: error },
    );
  }
  if (error instanceof OpenAI.RateLimitError) {
    return new LlmError(
      `${label}: rate limited by the OpenAI API after retries`,
      'transport',
      { cause: error },
    );
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return new LlmError(`${label}: could not reach the OpenAI API`, 'transport', {
      cause: error,
    });
  }
  if (error instanceof OpenAI.APIError) {
    return new LlmError(
      `${label}: OpenAI API error ${error.status ?? '?'} — ${error.message}`,
      'transport',
      { cause: error },
    );
  }

  return new LlmError(`${label}: ${describe(error)}`, 'transport', { cause: error });
}

/**
 * Cache effectiveness is only observable from usage. OpenAI caches prompt
 * prefixes over ~1024 tokens automatically — a `cached` of 0 across repeated
 * batches means the shared prefix is either too short or is being invalidated
 * by per-call content leaking into `systemPrompt`.
 */
function logUsage(label: string, usage: OpenAI.CompletionUsage | undefined): void {
  if (!usage) return;
  console.info(
    `[ace:llm] ${label} in=${usage.prompt_tokens} out=${usage.completion_tokens} cached=${usage.prompt_tokens_details?.cached_tokens ?? 0}`,
  );
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'Unknown error';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
