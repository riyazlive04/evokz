import { DeliveryStatus, UsageKeySource } from '@prisma/client';

import { intEnv, optionalEnv, requireEnv } from '@/lib/env';
import { resolveFalCredentials, type FalCredentials } from '@/lib/fal-credentials';
import { uploadClientAsset } from '@/lib/google-drive';
import { ensurePosterCopy } from '@/lib/ai/poster-copy';
import { resolveImageSizePreset } from '@/lib/image-sizes';
import { loadCategoryArchetypes } from '@/lib/poster/archetype-library';
import { resolvePhotoRequest, type PhotoRequest } from '@/lib/poster/photo-request';
import { renderPoster } from '@/lib/poster/render';
import { prisma } from '@/lib/prisma';
import { describeDelay, nextSendDelay } from '@/lib/send-jitter';
import { parseBrandGuideline } from '@/lib/types/brand';
import {
  archetypeForDay,
  pickForDay,
  posterArchetypeSchema,
  type PosterArchetype,
} from '@/lib/types/poster';
import { recordImageUsage, recordWhatsAppUsage } from '@/lib/usage';

/**
 * The central transaction router for one ContentCalendar row.
 *
 * Lifecycle: Flux.1 (fal.ai) -> Google Drive -> Evolution API, with every step
 * boundary persisted so a mid-flight failure is resumable rather than lost:
 *
 *   PENDING --(image uploaded)--> GENERATED --(WhatsApp sent)--> DELIVERED
 *      \--------------------- any throw ---------------------> FAILED
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PipelineOptions {
  /**
   * Reuse an already-uploaded Drive asset instead of re-billing fal.ai. Used by
   * the dashboard's "Force re-send" action and by retries of FAILED rows that
   * already reached GENERATED.
   */
  reuseExistingAsset?: boolean;
  /** Deliver even when the row is already DELIVERED (manual re-send). */
  allowRedelivery?: boolean;
  /**
   * Stop after the Drive upload, stamp `sendAfter`, and leave the broadcast to a
   * later sweep. Set only by the dispatch sweep's generation phase — every
   * operator-driven path sends immediately, because a human waiting on a button
   * does not want a randomised delay. See `src/lib/send-jitter.ts`.
   */
  deferBroadcast?: boolean;
  /**
   * Broadcast even though nobody has approved the poster.
   *
   * The operator's explicit "Send now" and nothing else. Every other path — the
   * sweep, a retry, a regenerate — must respect the approval gate, or the gate is
   * decorative.
   */
  ignoreApproval?: boolean;
}

export type PipelineStage =
  | 'load'
  | 'generate'
  /**
   * Poster composition: the vector text layer typeset over the photo. Its own
   * stage because a font fetch or a bad logo URL fails here, and attributing that
   * to `generate` would send an operator looking at fal.ai for a satori problem.
   */
  | 'compose'
  | 'upload'
  | 'broadcast'
  | 'complete';

export type PipelineOutcome =
  | {
      ok: true;
      calendarId: string;
      status: DeliveryStatus;
      skipped?: 'already-delivered' | 'claimed-by-another-sweep';
      /**
       * Set when the run stopped at GENERATED on purpose: the poster exists and
       * is scheduled, and a later sweep will broadcast it. Distinct from
       * `skipped`, which means no work was needed at all.
       */
      scheduledSendAt?: Date;
      /**
       * Set when the run stopped at GENERATED because the poster is unapproved.
       * Distinct from `scheduledSendAt`, which means a send is already booked:
       * this means no send will be booked until a human approves the row.
       */
      heldForApproval?: true;
      gDriveFileId: string | null;
      gDriveViewUrl: string | null;
      reusedAsset: boolean;
    }
  | {
      ok: false;
      calendarId: string;
      status: DeliveryStatus;
      stage: PipelineStage;
      error: string;
    };

interface FalImage {
  url: string;
  content_type?: string;
}

interface FalResponse {
  images?: FalImage[];
  detail?: unknown;
}

interface GeneratedAsset {
  body: Buffer;
  mimeType: string;
}

/** Raised so the catch block can attribute a failure to a specific stage. */
class PipelineStageError extends Error {
  constructor(
    public readonly stage: PipelineStage,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'PipelineStageError';
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runCreativePipeline(
  calendarId: string,
  options: PipelineOptions = {},
): Promise<PipelineOutcome> {
  let stage: PipelineStage = 'load';
  // Declared out here rather than inside the `if (!canReuse)` block below because
  // the catch feeds it to `redactSecrets`: an operator-supplied key comes from the
  // database, so it is not in `process.env` for that helper to find on its own.
  let falCredentials: FalCredentials | null = null;

  try {
    const entry = await prisma.contentCalendar.findUnique({
      where: { id: calendarId },
      include: { client: true },
    });

    if (!entry) {
      throw new PipelineStageError('load', `Calendar entry ${calendarId} not found`);
    }
    if (
      entry.deliveryStatus === DeliveryStatus.DELIVERED &&
      !options.allowRedelivery
    ) {
      return {
        ok: true,
        calendarId,
        status: entry.deliveryStatus,
        skipped: 'already-delivered',
        gDriveFileId: entry.gDriveFileId,
        gDriveViewUrl: entry.gDriveViewUrl,
        reusedAsset: true,
      };
    }

    const { client } = entry;
    if (!client.gDriveFolderId) {
      throw new PipelineStageError(
        'load',
        `Client "${client.companyName}" has no gDriveFolderId — onboarding never provisioned a Drive folder`,
      );
    }

    // Clear any stale failure trace up front so a partial retry does not read as
    // still-broken while it is in flight.
    if (entry.errorMessage) {
      await prisma.contentCalendar.update({
        where: { id: calendarId },
        data: { errorMessage: null },
      });
    }

    const canReuse =
      options.reuseExistingAsset === true &&
      Boolean(entry.gDriveFileId) &&
      Boolean(entry.gDriveViewUrl);

    /**
     * An unapproved poster may be produced, but never broadcast.
     *
     * Settled once here rather than at each exit, because `canReuse` skips the
     * entire generate/upload block below — checkpoint included — and lands
     * straight on the broadcast. A guard placed only at that checkpoint would
     * leave every reuse path (a retry, the sweep's own send phase) free to
     * deliver a poster nobody has looked at, which is the whole thing this
     * prevents.
     */
    const awaitingApproval =
      entry.approvedAt === null && options.ignoreApproval !== true;

    let gDriveFileId = entry.gDriveFileId;
    let gDriveViewUrl = entry.gDriveViewUrl;
    let assetFileName: string | null = null;

    if (!canReuse) {
      const sizePreset = resolveImageSizePreset(
        client.imageSizePreset,
        optionalEnv('FAL_IMAGE_SIZE', ''),
      );

      // The archetype is settled before the render because it dictates the photo's
      // aspect ratio — see resolvePhotoRequest.
      //
      // One indexed query per render, skipped entirely when the row already has a
      // stored archetype, which is every re-render of a day that has run before.
      const library = entry.posterArchetype
        ? []
        : await loadCategoryArchetypes(client.categoryId);
      const archetype = resolvePosterArchetype(
        entry.posterArchetype,
        entry.dayNumber,
        library,
      );
      const photoRequest = resolvePhotoRequest(archetype, sizePreset);

      // ---- Step 1: Flux.1 via fal.ai --------------------------------------
      stage = 'generate';
      // Resolved *after* `stage` is set, so a missing FAL_KEY or an undecryptable
      // operator key lands as "[generate] …" rather than "[load] …". An operator
      // reading a generate failure goes and looks at the fal credentials, which is
      // exactly where the fault is.
      falCredentials = await resolveFalCredentials();
      const photo = await generateCreativeAsset(
        entry.imagePrompt,
        photoRequest,
        falCredentials,
      );

      // Billed the moment fal returns pixels — before the upload, which can
      // still fail without making the render free. The source comes from the same
      // credentials object that made the call, never re-resolved: a key saved
      // mid-sweep must not re-attribute a render it did not pay for.
      await recordImageUsage(
        getFalEndpoint(),
        { clientId: client.id, calendarId: entry.id },
        falCredentials.source,
      );

      // ---- Step 2: Poster composition -------------------------------------
      stage = 'compose';
      // Backfills rows seeded before the poster layer existed, and any whose
      // batch-generated copy was unusable. A no-op for a normally seeded day.
      const posterCopy = await ensurePosterCopy(entry.id);

      const poster = await renderPoster({
        archetype,
        dayNumber: entry.dayNumber,
        copy: posterCopy,
        guideline: parseBrandGuideline(client.brandGuideline),
        identity: {
          companyName: client.companyName,
          logoUrl: client.logoUrl,
          brandTagline: client.brandTagline,
          websiteUrl: client.websiteUrl,
          displayPhone: client.displayPhone,
          whatsappNumber: client.whatsappNumber,
        },
        photo: photo.body,
        width: sizePreset.width,
        height: sizePreset.height,
      });

      // Persisted so a later re-render of this row reproduces the same layout
      // rather than re-deriving it, and so the queue ledger can show it.
      if (entry.posterArchetype !== poster.archetype) {
        await prisma.contentCalendar.update({
          where: { id: calendarId },
          data: { posterArchetype: poster.archetype },
        });
      }

      const asset: GeneratedAsset = {
        body: poster.body,
        mimeType: poster.mimeType,
      };

      // ---- Step 3: Google Drive storage sync ------------------------------
      stage = 'upload';
      assetFileName = buildAssetFileName(entry.dayNumber, asset.mimeType);
      const uploaded = await uploadClientAsset({
        folderId: client.gDriveFolderId,
        fileName: assetFileName,
        body: asset.body,
        mimeType: asset.mimeType,
      });

      gDriveFileId = uploaded.fileId;
      gDriveViewUrl = uploaded.viewUrl;

      // Checkpoint: the asset now exists in Drive. If the WhatsApp broadcast
      // fails, a retry can skip generation entirely.
      //
      // On the dispatch sweep this is also where the run *ends*: the broadcast is
      // held back a few random minutes so the fleet stops messaging WhatsApp in a
      // synchronised burst. The wait is persisted rather than slept — the sweep is
      // an HTTP request with a 300s ceiling, and a sleeping worker would also hold
      // one of its concurrency slots against every other client due this minute.
      //
      // An unapproved row books nothing at all. `sendAfter` stays null, which is
      // precisely what makes it invisible to the send phase's index — so the
      // poster sits here indefinitely until the approval action stamps one.
      const scheduled =
        awaitingApproval || !options.deferBroadcast ? null : nextSendDelay();

      await prisma.contentCalendar.update({
        where: { id: calendarId },
        data: {
          gDriveFileId,
          gDriveViewUrl,
          deliveryStatus: DeliveryStatus.GENERATED,
          sendAfter: scheduled?.sendAfter ?? null,
        },
      });

      if (awaitingApproval) {
        console.info(
          `[ace:pipeline] day ${entry.dayNumber} generated for ${client.companyName} — ` +
            `held for approval`,
        );

        return {
          ok: true,
          calendarId,
          status: DeliveryStatus.GENERATED,
          heldForApproval: true,
          gDriveFileId,
          gDriveViewUrl,
          reusedAsset: false,
        };
      }

      if (scheduled) {
        console.info(
          `[ace:pipeline] day ${entry.dayNumber} generated for ${client.companyName} — ` +
            `sending in ${describeDelay(scheduled.delaySeconds)}`,
        );

        return {
          ok: true,
          calendarId,
          status: DeliveryStatus.GENERATED,
          scheduledSendAt: scheduled.sendAfter,
          gDriveFileId,
          gDriveViewUrl,
          reusedAsset: false,
        };
      }
    }

    // Only the reuse path arrives here unapproved — the block above returns
    // before this whenever it produced the asset itself. Reached in practice by a
    // bulk retry over FAILED rows, where the asset survived but the broadcast did
    // not.
    //
    // The row is left exactly as found. Stamping `sendAfter` here would book the
    // send this guard exists to withhold, and rewriting the status would erase the
    // FAILED marker an operator is still working through.
    if (awaitingApproval) {
      return {
        ok: true,
        calendarId,
        status: entry.deliveryStatus,
        heldForApproval: true,
        gDriveFileId,
        gDriveViewUrl,
        reusedAsset: canReuse,
      };
    }

    if (!gDriveViewUrl) {
      throw new PipelineStageError(
        'broadcast',
        'No Google Drive view URL available for delivery',
      );
    }

    // ---- Step 3: Evolution API broadcast ---------------------------------
    stage = 'broadcast';
    await broadcastWhatsAppMedia({
      number: client.whatsappNumber,
      media: gDriveViewUrl,
      caption: composeCaption(entry.caption, entry.hashtags),
      // On the reuse path the original mime type isn't reloaded; the extension
      // is cosmetic here, so fall back to the conventional .png name.
      fileName: assetFileName ?? buildAssetFileName(entry.dayNumber, 'image/png'),
    });

    await recordWhatsAppUsage({ clientId: client.id, calendarId: entry.id });

    stage = 'complete';
    await prisma.contentCalendar.update({
      where: { id: calendarId },
      data: {
        deliveryStatus: DeliveryStatus.DELIVERED,
        errorMessage: null,
        gDriveFileId,
        gDriveViewUrl,
        // The schedule has been honoured; clearing it keeps `sendAfter` meaning
        // exactly one thing — "a broadcast is still owed" — which is what the
        // send phase's index is built to answer.
        sendAfter: null,
      },
    });

    return {
      ok: true,
      calendarId,
      status: DeliveryStatus.DELIVERED,
      gDriveFileId,
      gDriveViewUrl,
      reusedAsset: canReuse,
    };
  } catch (error) {
    const failedStage = error instanceof PipelineStageError ? error.stage : stage;
    const message = redactSecrets(describeError(error), [
      falCredentials?.key,
      // The halves separately: a provider that echoed back only the secret part
      // would slip past a whole-string match.
      falCredentials?.key.split(':')[1],
    ]);

    // Best-effort persistence of the failure trace. A row that vanished
    // mid-flight (deleted client -> cascade) must not mask the original error.
    try {
      await prisma.contentCalendar.update({
        where: { id: calendarId },
        data: {
          deliveryStatus: DeliveryStatus.FAILED,
          errorMessage: `[${failedStage}] ${message}`.slice(0, 4000),
        },
      });
    } catch (persistError) {
      console.error(
        `[ace:pipeline] could not persist failure for ${calendarId}:`,
        describeError(persistError),
      );
    }

    console.error(`[ace:pipeline] ${calendarId} failed at "${failedStage}": ${message}`);

    return {
      ok: false,
      calendarId,
      status: DeliveryStatus.FAILED,
      stage: failedStage,
      error: message,
    };
  }
}

// ---------------------------------------------------------------------------
// Step 1 — Flux.1 image synthesis
// ---------------------------------------------------------------------------

/** The configured image endpoint. Shared with the spend ledger's `model` column. */
export function getFalEndpoint(): string {
  return optionalEnv('FAL_MODEL_ENDPOINT', 'fal-ai/flux/schnell');
}

/**
 * The archetype for a row, in order of authority:
 *
 *   1. Its stored choice — an operator's pin, or what a previous render settled
 *      on. This is what makes a retry reproduce the poster the client received.
 *   2. The layouts mapped to the vertical's reference templates, walked by day
 *      number. Duplicates in that list are the whole point: they weight a layout
 *      by how many references were mapped to it.
 *   3. The eight base compositions, for a vertical with nothing mapped.
 *
 * Every step is deterministic rather than random, so an operator comparing a
 * re-render against the original never sees a spurious difference.
 */
export function resolvePosterArchetype(
  stored: string | null,
  dayNumber: number,
  library: readonly PosterArchetype[] = [],
): PosterArchetype {
  const parsed = posterArchetypeSchema.safeParse(stored);
  if (parsed.success) return parsed.data;
  return pickForDay(dayNumber, library) ?? archetypeForDay(dayNumber);
}

/**
 * Renders the background photo at the aspect its archetype needs.
 *
 * Note this is *not* the client's output preset. The preset sizes the composite
 * canvas; the photo only has to cover the region the archetype gives it, which for
 * the band and curve layouts is landscape even when the poster is 9:16.
 *
 * `image_size` is sent as explicit `{width, height}` rather than one of fal's
 * named shapes (`square`, `portrait_16_9`, …): those top out at 1024 px and cap
 * the short edge at 576, which cannot express the sizes this spec needs.
 */
async function generateCreativeAsset(
  imagePrompt: string,
  photoRequest: PhotoRequest,
  credentials: FalCredentials,
): Promise<GeneratedAsset> {
  const endpoint = getFalEndpoint();
  const timeoutMs = intEnv('FAL_TIMEOUT_MS', 120_000);
  const maxAttempts = Math.max(1, intEnv('FAL_MAX_ATTEMPTS', 3));

  // The source, never the key. `redactSecrets` guards `errorMessage`, not stdout.
  console.info(
    `[ace:pipeline] photo ${photoRequest.width}×${photoRequest.height} — ${photoRequest.reason} ` +
      `(${describeKeySource(credentials.source)} fal key)`,
  );

  const url = `https://fal.run/${endpoint.replace(/^\/+/, '')}`;

  const payload = {
    prompt: imagePrompt,
    image_size: { width: photoRequest.width, height: photoRequest.height },
    num_images: 1,
    // `sync_mode` blocks until pixels are ready, so no queue polling is needed.
    sync_mode: true,
    enable_safety_checker: true,
  };

  let response: FalResponse;
  try {
    response = await withRetries(
      'fal.ai',
      maxAttempts,
      async () =>
        fetchJson<FalResponse>(url, {
          method: 'POST',
          headers: {
            // The key belongs in this header and nowhere else. It must never be
            // interpolated into a log line or an error message: `withRetries`
            // logs unredacted, and only `errorMessage` is scrubbed downstream.
            Authorization: `Key ${credentials.key}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(payload),
          timeoutMs,
          stage: 'generate',
        }),
      'generate',
    );
  } catch (error) {
    // A 401/403 already breaks out on the first attempt — `isRetryable` treats
    // every status outside 408/425/429/5xx as terminal — so no attempts are burned
    // on a dead key. What is missing is *which* key died, which is the difference
    // between a legible failure and a support conversation.
    if (/responded (401|403)\b/.test(describeError(error))) {
      throw new PipelineStageError('generate', describeKeyRejection(credentials, endpoint), {
        cause: error,
      });
    }
    throw error;
  }

  const image = response.images?.[0];
  if (!image?.url) {
    throw new PipelineStageError(
      'generate',
      'fal.ai returned no image in the response payload',
    );
  }

  // With `sync_mode: true` fal inlines the result as a data URI; hosted URLs
  // are still returned for larger payloads, so both forms are handled.
  if (image.url.startsWith('data:')) {
    return decodeDataUri(image.url);
  }

  const binary = await withRetries(
    'fal.ai asset download',
    maxAttempts,
    async () => fetchBinary(image.url, timeoutMs, 'generate'),
    'generate',
  );

  return {
    body: binary.body,
    mimeType: image.content_type ?? binary.mimeType,
  };
}

function decodeDataUri(dataUri: string): GeneratedAsset {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUri);
  if (!match) {
    throw new PipelineStageError('generate', 'Malformed data URI returned by fal.ai');
  }

  const [, mimeType, base64Flag, data = ''] = match;
  const body = base64Flag
    ? Buffer.from(data, 'base64')
    : Buffer.from(decodeURIComponent(data), 'binary');

  if (body.byteLength === 0) {
    throw new PipelineStageError('generate', 'fal.ai returned an empty image payload');
  }

  return { body, mimeType: mimeType ?? 'image/png' };
}

/** One word for a log line: whose account this render is being billed to. */
function describeKeySource(source: UsageKeySource): string {
  return source === UsageKeySource.BYO ? 'operator' : 'platform';
}

/**
 * Turns a bare 401/403 into something an operator can act on.
 *
 * Names the endpoint as well as the key, because the two failures look identical
 * from here: a valid key on an account that cannot reach `FAL_MODEL_ENDPOINT` is
 * rejected exactly like a revoked one.
 */
function describeKeyRejection(credentials: FalCredentials, endpoint: string): string {
  return credentials.source === UsageKeySource.BYO
    ? `fal.ai rejected the operator key saved in the console (…${credentials.last4}) for ` +
        `${endpoint}. Check the account's balance and that the key is still valid, then save ` +
        'a working key from the dashboard — "Test key" verifies one before you commit to it. ' +
        'The platform FAL_KEY is deliberately never used as a fallback.'
    : `fal.ai rejected the platform FAL_KEY for ${endpoint}. Check the value in .env, or save ` +
        'an operator key from the dashboard.';
}

/** The cheapest render fal will do — a diagnostic, not a creative call. */
const PROBE_ENDPOINT = 'fal-ai/flux/schnell';
const PROBE_EDGE = 512;
const PROBE_TIMEOUT_MS = 30_000;

export interface FalProbeResult {
  endpoint: string;
  elapsedMs: number;
}

/**
 * Spends one real render to prove a key works.
 *
 * Deliberately not routed through `withRetries`: this answers a diagnostic
 * question, and a retry would both muddy the signal and spend again. The timeout is
 * fixed at 30s rather than `FAL_TIMEOUT_MS`'s 120s so a hung probe cannot hold a
 * server action open for two minutes.
 *
 * Rethrows already-redacted, so the caller never has to think about the key.
 */
export async function probeFalKey(credentials: FalCredentials): Promise<FalProbeResult> {
  const startedAt = Date.now();

  try {
    const response = await fetchJson<FalResponse>(`https://fal.run/${PROBE_ENDPOINT}`, {
      method: 'POST',
      headers: {
        Authorization: `Key ${credentials.key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        prompt: 'a plain neutral grey background',
        image_size: { width: PROBE_EDGE, height: PROBE_EDGE },
        num_images: 1,
        sync_mode: true,
        enable_safety_checker: true,
      }),
      timeoutMs: PROBE_TIMEOUT_MS,
      stage: 'generate',
    });

    if (!response.images?.[0]?.url) {
      throw new PipelineStageError(
        'generate',
        'fal.ai accepted the key but returned no image — the account may be rate limited.',
      );
    }

    return { endpoint: PROBE_ENDPOINT, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    throw new PipelineStageError('generate', redactSecrets(describeError(error), [
      credentials.key,
      credentials.key.split(':')[1],
    ]), { cause: error });
  }
}

// ---------------------------------------------------------------------------
// Step 3 — Evolution API broadcast
// ---------------------------------------------------------------------------

interface BroadcastInput {
  number: string;
  media: string;
  caption: string;
  fileName: string;
}

/**
 * Sends the creative over WhatsApp via Evolution GO.
 *
 * Note this differs from the blueprint, which specifies the Evolution **Node
 * v2** contract (`POST /message/sendMedia/{instance}` with
 * `{media, mediatype}`). Evolution GO exposes `POST /send/media` with
 * `{url, type}` and takes no instance path segment — the instance is selected
 * by the API key, so each instance's own token must be used here. The global
 * admin key is rejected with 401 on this route.
 */
async function broadcastWhatsAppMedia(input: BroadcastInput): Promise<void> {
  const baseUrl = requireEnv('EVOLUTION_API_URL').replace(/\/+$/, '');
  const apiKey = requireEnv('EVOLUTION_API_KEY');
  const timeoutMs = intEnv('EVOLUTION_TIMEOUT_MS', 60_000);

  const url = `${baseUrl}/send/media`;

  await fetchJson<unknown>(url, {
    method: 'POST',
    headers: {
      apikey: apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      number: input.number,
      url: input.media,
      type: 'image',
      caption: input.caption,
      filename: input.fileName,
    }),
    timeoutMs,
    stage: 'broadcast',
    // Deliberately not retried: a timeout here is ambiguous — the message may
    // already have been queued — so a retry risks double-sending to the
    // client's WhatsApp. The row is left FAILED for an operator to re-send.
    tolerateEmptyBody: true,
  });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** `Day_042_Creative.png` */
export function buildAssetFileName(dayNumber: number, mimeType: string): string {
  const extension = extensionFromMimeType(mimeType);
  return `Day_${String(dayNumber).padStart(3, '0')}_Creative.${extension}`;
}

function extensionFromMimeType(mimeType: string): string {
  switch (mimeType.toLowerCase().split(';')[0]?.trim()) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/avif':
      return 'avif';
    default:
      return 'png';
  }
}

/** Caption + blank line + hashtags, matching the WhatsApp payload contract. */
export function composeCaption(caption: string, hashtags: string): string {
  const trimmedCaption = caption.trim();
  const trimmedHashtags = hashtags.trim();
  if (!trimmedHashtags) return trimmedCaption;
  return `${trimmedCaption}\n\n${trimmedHashtags}`;
}

interface FetchOptions {
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  stage: PipelineStage;
  tolerateEmptyBody?: boolean;
}

async function fetchJson<T>(url: string, options: FetchOptions): Promise<T> {
  const response = await fetchWithTimeout(url, options);
  const rawBody = await response.text();

  if (!response.ok) {
    throw new PipelineStageError(
      options.stage,
      `${new URL(url).host} responded ${response.status} ${response.statusText}: ${truncate(rawBody, 500)}`,
    );
  }

  if (!rawBody.trim()) {
    if (options.tolerateEmptyBody) return undefined as T;
    throw new PipelineStageError(
      options.stage,
      `${new URL(url).host} returned an empty response body`,
    );
  }

  try {
    return JSON.parse(rawBody) as T;
  } catch {
    if (options.tolerateEmptyBody) return undefined as T;
    throw new PipelineStageError(
      options.stage,
      `${new URL(url).host} returned non-JSON payload: ${truncate(rawBody, 300)}`,
    );
  }
}

async function fetchBinary(
  url: string,
  timeoutMs: number,
  stage: PipelineStage,
): Promise<GeneratedAsset> {
  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers: { Accept: 'image/*' },
    timeoutMs,
    stage,
  });

  if (!response.ok) {
    throw new PipelineStageError(
      stage,
      `Asset download failed with ${response.status} ${response.statusText}`,
    );
  }

  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength === 0) {
    throw new PipelineStageError(stage, 'Downloaded asset was empty');
  }

  return {
    body,
    mimeType: response.headers.get('content-type')?.split(';')[0]?.trim() ?? 'image/png',
  };
}

async function fetchWithTimeout(
  url: string,
  options: Omit<FetchOptions, 'tolerateEmptyBody'>,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    return await fetch(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new PipelineStageError(
        options.stage,
        `Request to ${new URL(url).host} timed out after ${options.timeoutMs}ms`,
      );
    }
    throw new PipelineStageError(
      options.stage,
      `Network failure calling ${new URL(url).host}: ${describeError(error)}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Retries transient faults with exponential backoff. Deterministic 4xx
 * responses are surfaced immediately — re-billing a rejected prompt is waste.
 */
async function withRetries<T>(
  label: string,
  maxAttempts: number,
  operation: () => Promise<T>,
  stage: PipelineStage,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (attempt === maxAttempts || !isRetryable(error)) break;

      const backoffMs = 1_000 * 2 ** (attempt - 1);
      console.warn(
        `[ace:pipeline] ${label} attempt ${attempt}/${maxAttempts} failed (${describeError(error)}). Retrying in ${backoffMs}ms.`,
      );
      await sleep(backoffMs);
    }
  }

  throw lastError instanceof PipelineStageError
    ? lastError
    : new PipelineStageError(stage, `${label} failed: ${describeError(lastError)}`, {
        cause: lastError,
      });
}

function isRetryable(error: unknown): boolean {
  const message = describeError(error);
  if (/timed out|Network failure/i.test(message)) return true;
  // Retry 408/425/429 and all 5xx; treat other 4xx as terminal.
  return /responded (408|425|429|5\d{2})\b/.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return 'Unknown error';
  }
}

/**
 * Keeps API credentials out of `errorMessage`, which the dashboard renders.
 *
 * `extra` exists for credentials that are not in the environment: an
 * operator-supplied fal key lives in the database, so there is nothing here for
 * this function to find on its own and the caller has to hand it in.
 */
function redactSecrets(message: string, extra: Array<string | null | undefined> = []): string {
  const secrets = [
    ...extra,
    process.env.FAL_KEY,
    process.env.EVOLUTION_API_KEY,
    process.env.RAZORPAY_WEBHOOK_SECRET,
    process.env.GOOGLE_PRIVATE_KEY,
    process.env.CRON_SECRET,
  ].filter((value): value is string => typeof value === 'string' && value.length > 6);

  return secrets.reduce(
    (acc, secret) => acc.split(secret).join('«redacted»'),
    message,
  );
}

function truncate(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}
