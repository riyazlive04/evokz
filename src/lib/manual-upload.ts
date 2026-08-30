import { ContentSourceType, DeliveryStatus, Prisma } from '@prisma/client';

import { buildAssetFileName } from '@/lib/ai-pipeline';
import { trashDriveFile, uploadClientAsset } from '@/lib/google-drive';
import {
  MANUAL_IMAGE_MAX_BYTES,
  MANUAL_IMAGE_MIME_TYPES,
  manualSheetRowSchema,
} from '@/lib/manual-upload-match';
import { planManualSchedule } from '@/lib/manual-upload-schedule';
import { repairClientDriveFolder } from '@/lib/onboarding';
import { prisma } from '@/lib/prisma';
import { getAppTimeZone, toTimeString, zonedDayRange } from '@/lib/time';

/**
 * Writes one manually-uploaded poster into a client's campaign.
 *
 * **This is a parallel entrance to `ContentCalendar`, not a change to the one
 * that exists.** Nothing here calls `runCreativePipeline`, resolves a layout,
 * asks fal.ai for a photograph, or composes type. The poster arrived finished;
 * the only work left is putting the bytes in the client's Drive folder and
 * writing the row that the ordinary dispatch sweep will send.
 *
 * The row it writes is deliberately shaped so the sweep cannot tell it apart
 * from a pre-generated one, because the sweep is not being changed:
 *
 *   `deliveryStatus: GENERATED` — so `claimAndPreGenerate` never sees it. That
 *     stage's claim is `updateMany({ where: { deliveryStatus: PENDING, … } })`
 *     and its backlog query filters the same way, so a row that starts at
 *     GENERATED is structurally invisible to the render path. Not "skipped by a
 *     check somebody could remove" — absent from the query.
 *
 *   `approvedAt` stamped at creation — the operator chose this file off their own
 *     machine and that *is* the review. There is no second artefact for them to
 *     look at afterwards; a poster the pipeline drew needs approval because
 *     nobody had seen it yet, and this one they made.
 *
 *   `sendAfter: null` — the send is booked by `releaseApproved` on the delivery
 *     day, exactly as for every approved poster, so a manual upload inherits the
 *     same jitter that keeps a fleet from hitting WhatsApp in one burst.
 *
 *   `posterTemplateId`, `posterCopy`, `theme`, `backgroundPrompt` all null —
 *     there is no template, no typography and no content angle, because nothing
 *     will ever be drawn from this row.
 *
 * **`imagePrompt` is the one field that cannot be null**, and it is written as an
 * empty string rather than a description of anything. The column is `TEXT NOT
 * NULL` and has been since the first migration; widening it would change a type
 * that `ai-pipeline.ts` reads, and that file is not to be touched by this
 * feature. Empty is the honest value — this row has no photo brief — and nothing
 * reads it on any path a `MANUAL_UPLOAD` row travels.
 *
 * One poster per call. Server Actions cap a request body, a batch of finished
 * posters would breach it, and sequencing gives a per-file answer — "day-7.png is
 * 9 MB" — instead of one failure for the batch with nothing to act on. The same
 * reasoning as the vertical template uploader.
 */

/**
 * A refusal the operator is meant to read, as opposed to a fault.
 *
 * "The campaign has no open day left" is a correct, expected outcome of an
 * upload — it is what "schedule as many as fit" *means* — and reporting it as an
 * error would tell an operator something went wrong when nothing did. The action
 * layer turns this into a per-file line on the results panel instead.
 */
export class ManualUploadRefusal extends Error {
  constructor(
    message: string,
    /** The `day-N` label the file claimed, for the panel's list. */
    readonly day: number,
  ) {
    super(message);
    this.name = 'ManualUploadRefusal';
  }
}

export interface StoreManualPosterInput {
  clientId: string;
  /** The `day-N` label from the filename. Reporting only — not the campaign day. */
  day: number;
  caption: string;
  hashtags: string;
  fileName: string;
  mimeType: string;
  body: Buffer;
}

export interface StoredManualPoster {
  /** The `day-N` label this file carried. */
  day: number;
  fileName: string;
  /** The campaign day it was actually given. */
  dayNumber: number;
  scheduledDate: Date;
  gDriveFileId: string;
  gDriveViewUrl: string;
  calendarId: string;
}

export async function storeManualPoster(
  input: StoreManualPosterInput,
  now: Date = new Date(),
): Promise<StoredManualPoster> {
  if (!MANUAL_IMAGE_MIME_TYPES.has(input.mimeType)) {
    throw new ManualUploadRefusal(
      `"${input.mimeType || 'unknown'}" is not a supported image format. Use PNG, JPEG or WebP.`,
      input.day,
    );
  }
  if (input.body.byteLength > MANUAL_IMAGE_MAX_BYTES) {
    throw new ManualUploadRefusal(
      `${input.fileName} is ${(input.body.byteLength / 1024 / 1024).toFixed(1)} MB. The limit is ${
        MANUAL_IMAGE_MAX_BYTES / 1024 / 1024
      } MB.`,
      input.day,
    );
  }

  /*
   * Re-validated here even though the browser validated the same cells.
   *
   * The panel's parse is a courtesy — the same relationship `applyCalendarImport`
   * has with `CalendarImportPanel`. A caption that arrives blank or a hashtag
   * string three pages long has not been through the schema until it has been
   * through it *here*.
   */
  const copy = manualSheetRowSchema.parse({
    day: input.day,
    caption: input.caption,
    hashtags: input.hashtags,
  });

  const client = await prisma.client.findUnique({
    where: { id: input.clientId },
    select: {
      id: true,
      companyName: true,
      gDriveFolderId: true,
      startDate: true,
      endDate: true,
      deliveryDays: true,
      cronTime: true,
      plan: { select: { name: true, durationDays: true } },
    },
  });
  if (!client) throw new Error(`Client ${input.clientId} does not exist`);

  const totalDays = client.plan.durationDays;
  if (totalDays < 1) {
    throw new Error(`Plan "${client.plan.name}" has an invalid durationDays`);
  }

  /*
   * The open day is chosen here, per call, against a fresh read — never taken
   * from the wire.
   *
   * The confirm screen predicted this same answer in the browser from the same
   * pure function, and in the ordinary case the two agree exactly. They are still
   * not the same thing: the preview is a snapshot from whenever the panel
   * rendered, and a sheet import or a seed running in another tab since then
   * would have moved which days are free. Deciding again at write time means the
   * prediction can be stale without the write ever being wrong.
   */
  const occupiedDays = (
    await prisma.contentCalendar.findMany({
      where: { clientId: client.id },
      select: { dayNumber: true },
    })
  ).map((row) => row.dayNumber);

  const timeZone = getAppTimeZone();
  const plan = planManualSchedule(
    [{ day: copy.day, fileName: input.fileName, caption: copy.caption, hashtags: copy.hashtags }],
    {
      startDate: client.startDate,
      endDate: client.endDate,
      deliveryDays: client.deliveryDays,
      totalDays,
      occupiedDays,
      timeZone,
      notBefore: earliestDeliverableDay(now, client.cronTime, timeZone),
    },
  );

  const placement = plan.scheduled[0];
  if (!placement) {
    throw new ManualUploadRefusal(
      `${client.companyName} has no open delivery day left in this campaign, so day-${copy.day} ` +
        'was not scheduled. Nothing was uploaded for it.',
      copy.day,
    );
  }

  // Provisioned on demand rather than assumed. A client onboarded before Drive
  // was reachable has a null folder, and `repairClientDriveFolder` is the
  // existing helper that fixes it — via `ensureClientFolder`, which is idempotent.
  const folderId = client.gDriveFolderId ?? (await repairClientDriveFolder(client.id));

  /*
   * Published link-readable, which is the opposite of the vertical template
   * uploader and is not a slip.
   *
   * Evolution API fetches poster media server-side carrying no Google
   * credentials, so an unpublished file comes back as a login page and the send
   * fails. A reference template never leaves the console and is deliberately
   * unpublished; this file is the thing the client receives.
   *
   * Stored exactly as uploaded, with no downscale. `prepareTemplateImage` exists
   * because a reference is only ever looked at — this is the finished creative,
   * and re-encoding somebody's artwork on the way to their client would be
   * throwing away quality nobody asked us to spend.
   */
  const uploaded = await uploadClientAsset({
    folderId,
    // The same name a generated poster gets, so the vault does not sort into two
    // conventions depending on who made the file.
    fileName: buildAssetFileName(placement.dayNumber, input.mimeType),
    body: input.body,
    mimeType: input.mimeType,
  });

  try {
    const created = await prisma.contentCalendar.create({
      data: {
        clientId: client.id,
        dayNumber: placement.dayNumber,
        scheduledDate: placement.scheduledDate,
        sourceType: ContentSourceType.MANUAL_UPLOAD,
        // Straight to GENERATED: the asset exists, so there is nothing for the
        // render path to do and nothing for it to claim. See the note above.
        deliveryStatus: DeliveryStatus.GENERATED,
        caption: copy.caption,
        hashtags: copy.hashtags,
        // See the module note. The column is NOT NULL and this row has no brief.
        imagePrompt: '',
        gDriveFileId: uploaded.fileId,
        gDriveViewUrl: uploaded.viewUrl,
        // Auto-approved. Choosing the file was the review.
        approvedAt: now,
        // Left for `releaseApproved` to book on the day, so a manual upload gets
        // the same send jitter as everything else.
        sendAfter: null,
      },
      select: { id: true },
    });

    return {
      day: copy.day,
      fileName: input.fileName,
      dayNumber: placement.dayNumber,
      scheduledDate: placement.scheduledDate,
      gDriveFileId: uploaded.fileId,
      gDriveViewUrl: uploaded.viewUrl,
      calendarId: created.id,
    };
  } catch (error) {
    /*
     * The row did not land, so the file in Drive is an orphan — bin it.
     *
     * `@@unique([clientId, dayNumber])` is the case that actually happens: two
     * uploads racing, or a sheet import that claimed the day between the read
     * above and this write. Leaving the bytes behind would leave the vault
     * accumulating a poster per collision, none of them reachable from anything.
     *
     * `trashDriveFile` never throws, so a Drive that is unreachable cannot mask
     * the database error that brought us here.
     */
    await trashDriveFile(uploaded.fileId);

    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new ManualUploadRefusal(
        `Campaign day ${placement.dayNumber} was written by something else while ` +
          `day-${copy.day} was uploading, so it was not scheduled. Try it again.`,
        copy.day,
      );
    }

    throw error;
  }
}

/**
 * The earliest date still worth scheduling a poster onto.
 *
 * Today, unless the client's delivery minute has already gone by — in which case
 * tomorrow, because nothing will pick up a row placed on today after that point.
 * The sweep's release phase only looks at rows whose `scheduledDate` falls in
 * *today's* range and only during the minute matching `cronTime`, so a row
 * written onto a passed day is never selected again by any phase.
 *
 * The same reasoning `hasMissedItsWindow` applies when approving a poster after
 * its minute — except that one can rescue the row by booking a send immediately,
 * and this one can simply not create it in the wrong place to begin with.
 */
function earliestDeliverableDay(now: Date, cronTime: string, timeZone: string): Date {
  const { start, end } = zonedDayRange(now, timeZone);
  // Both sides are zero-padded "HH:MM", so a lexicographic compare is a
  // chronological one. `end` is tomorrow's local midnight.
  return toTimeString(now, timeZone) >= cronTime ? end : start;
}
