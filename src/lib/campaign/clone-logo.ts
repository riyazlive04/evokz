import type { PosterApprovalStatus } from '@prisma/client';

import { SLOT_LOCK_LABELS, slotLockOf } from '@/lib/campaign/board';
import { describeLogoPlacement } from '@/lib/campaign/clone-editor-view';
import { claimForRevision, POSTER_LOGO_PROMPT_PREFIX } from '@/lib/campaign/clone-fix';
import { bookCampaignDayQuietly, type DeliveryDeps } from '@/lib/campaign/delivery-service';
import { isGenerationInProgress, TEMPLATE_NOT_READ_MESSAGE } from '@/lib/campaign/poster-generation';
import { CLAIM_LOST_MESSAGE, cloneBrandValues, defaultPosterGenerationDeps, type PosterGenerationDeps } from '@/lib/campaign/poster-generation-service';
import { addPosterVersion, CampaignDomainError, runInCampaignTransaction, type CampaignDb } from '@/lib/campaign/service';
import { MissingEnvError } from '@/lib/env';
import { StudioError, type StudioErrorKind } from '@/lib/poster-studio/errors';
import { getAppTimeZone } from '@/lib/time';
import {
  materializeDayElements,
  parseDayPosterElements,
  parseTemplateElements,
  parseTextCheck,
  resolveDayElements,
  type DayLogoPlacement,
  type DayPosterElementsDoc,
} from '@/lib/types/template-elements';
import type { Prisma } from '@prisma/client';

/**
 * "Apply logo placement" — where the client's mark sits inside the template's
 * own logo box, chosen by the admin and drawn by code.
 *
 * The first Sirah campaign lost its day 1 to this: the template's mark was
 * measured as a wide strip, the compositor's corrections deflated it twice over,
 * and the client's logo landed 70 px wide in the corner with no way to put it
 * right short of regenerating the whole poster and hoping. There is now a
 * placement on the day's document (`DayPosterElementsDoc.logo`), and this
 * service re-composites the poster that already exists with it.
 *
 * **It is `revisePoster` (`clone-fix.ts`) with the model taken out.** The active
 * version's RAW artwork — the image before any logo was drawn on it — is read,
 * the mark is composited into the template's logo box at the admin's size and
 * corner (`composeCloneIdentity` with `placement`), the FINAL file is stored, and
 * a POSTER_STUDIO version is added. Nothing else is different about the poster,
 * so:
 *
 *   - **no image model call, and no `UsageEvent`.** It costs the client nothing
 *     and takes seconds, not two minutes;
 *   - **no text check.** Not one glyph moved, so the previous version's result is
 *     carried over verbatim rather than paid for again;
 *   - **the content revision does not move.** The words did not change, so the
 *     new version is as current as the one it replaces;
 *   - **the raw file is shared, not copied.** The studio row points at its
 *     parent's `imageDriveFileId`; history deletion is reference-counted and only
 *     bins a Drive file no row still names.
 *
 * Refused exactly where a revision is — a closed or inactive campaign, a sent,
 * sending or past day, no poster, a poster whose template cannot be read, a day
 * already being generated — **minus the outdated check**: moving a mark redraws
 * no words, so a poster whose words changed afterwards can still have its logo
 * put right. An uploaded poster is refused: there is no artwork to re-composite.
 *
 * The day is claimed with the generation pipeline's own claim
 * (`claimForRevision`), so this, a generation, the queue worker and a revision
 * can never run on one day at once.
 */

export type LogoPlacementResult =
  | {
      outcome: 'placed';
      dayNumber: number;
      versionId: string;
      versionNumber: number;
      generationId: string;
      approvalStatus: PosterApprovalStatus;
      message: string;
    }
  | {
      outcome: 'failed';
      dayNumber: number;
      kind: StudioErrorKind;
      message: string;
    };

export interface LogoPlacementOptions {
  deps?: PosterGenerationDeps;
  /** Delivery dependencies for the booking sync that follows a new version. */
  deliveryDeps?: DeliveryDeps;
  now?: Date;
  timeZone?: string;
}

/**
 * Re-composites the active poster with `placement`, and stores it on the day.
 * Null puts the mark back where the compositor itself would place it.
 */
export async function setCampaignDayLogoPlacement(
  db: CampaignDb,
  dayId: string,
  placement: DayLogoPlacement | null,
  options: LogoPlacementOptions = {},
): Promise<LogoPlacementResult> {
  const deps = options.deps ?? defaultPosterGenerationDeps;
  const now = options.now ?? new Date();

  // ---- Refusals: everything decidable before any claim -------------------------
  const day = await db.contentCalendar.findUnique({
    where: { id: dayId },
    select: {
      id: true,
      dayNumber: true,
      scheduledDate: true,
      clientId: true,
      contentRevision: true,
      posterElements: true,
      imagePrompt: true,
      headline: true,
      supportingText: true,
      cta: true,
      posterTemplateId: true,
      suggestedTemplateId: true,
      generationStatus: true,
      posterGenerationStartedAt: true,
      campaign: { select: { id: true, status: true, deliveryTime: true } },
      delivery: { select: { status: true, scheduledFor: true } },
      activePosterVersion: {
        select: {
          id: true,
          versionNumber: true,
          contentRevision: true,
          templateId: true,
          textCheck: true,
          studioGeneration: {
            select: { id: true, imageDriveFileId: true, imageMimeType: true, aspectRatio: true, size: true, width: true, height: true, sourceTemplateId: true },
          },
        },
      },
    },
  });
  if (!day) throw new CampaignDomainError('not-found', 'Campaign day does not exist.');
  if (!day.campaign) throw new CampaignDomainError('not-a-campaign-day', 'This calendar row is not part of a campaign.');
  if (day.campaign.status === 'COMPLETED' || day.campaign.status === 'CANCELLED') {
    throw new CampaignDomainError('campaign-closed', `The campaign is ${day.campaign.status}.`);
  }
  if (day.campaign.status !== 'ACTIVE') {
    throw new CampaignDomainError('invalid-transition', `The campaign is ${day.campaign.status.toLowerCase()} — activate it to change posters.`);
  }
  const lock = slotLockOf(day, now, options.timeZone ?? getAppTimeZone(), day.campaign.deliveryTime);
  if (lock) {
    throw new CampaignDomainError('invalid-transition', `${SLOT_LOCK_LABELS[lock]} Its poster can no longer change.`);
  }
  const active = day.activePosterVersion;
  if (!active) throw new CampaignDomainError('invalid-transition', 'This day has no poster yet. Generate one first.');
  const source = active.studioGeneration;
  if (!source) throw new CampaignDomainError('invalid-transition', 'An uploaded poster has no artwork to re-composite. Generate one from the template instead.');
  // No `isVersionCurrent`: the mark can be put right on an outdated poster too.
  if (day.generationStatus === 'QUEUED' || isGenerationInProgress(day.generationStatus, day.posterGenerationStartedAt, now)) {
    throw new CampaignDomainError('conflict', 'A poster is being generated for this day. Wait for it to finish, then try again.');
  }

  const templateId = active.templateId ?? source.sourceTemplateId;
  if (!templateId) throw new CampaignDomainError('invalid-transition', 'This poster was not made from a template, so its logo cannot be placed here.');
  const template = await db.categoryTemplate.findUnique({ where: { id: templateId }, select: { id: true, label: true, elements: true } });
  if (!template) throw new CampaignDomainError('invalid-transition', 'The template this poster was made from no longer exists. Regenerate it from another template.');
  const doc = parseTemplateElements(template.elements);
  if (!doc) throw new CampaignDomainError('invalid-transition', TEMPLATE_NOT_READ_MESSAGE);
  if (!doc.elements.some((element) => element.kind === 'logo')) {
    throw new CampaignDomainError('invalid-transition', 'This template has no logo box, so there is nothing to place.');
  }

  // ---- Claim -------------------------------------------------------------------
  const startedAt = now;
  await claimForRevision(db, { ...day, activeVersionId: active.id }, startedAt);

  const written: string[] = [];
  try {
    const canvas = await deps.loadBrandCanvas(day.clientId);
    const logo = await deps.resolveLogo(canvas);
    if (!logo) throw new StudioError('logo', 'This client has no Brand Canvas logo, so there is nothing to place. Add one in Brand Canvas first.');
    const folderId = await deps.resolveFolder(canvas.companyName);

    // The day's document with the new placement on it — the same document that is
    // stored below, so what is drawn and what is recorded cannot disagree.
    const current = materializeDayElements(doc, parseDayPosterElements(day.posterElements), template.id, day, { businessName: canvas.companyName });
    const elements = withPlacement(current, placement);
    const brand = cloneBrandValues(canvas, true);
    const resolved = resolveDayElements(doc, elements, brand, day.imagePrompt);
    if (!resolved.some((item) => item.action.type === 'logo')) {
      throw new StudioError('validation', 'The logo is hidden on this poster, so there is nothing to place. Show it in Brand details first.');
    }

    let finalBytes: Buffer;
    try {
      // The RAW artwork: the image model's own output, before any mark was drawn
      // on it. Compositing over the finished poster would leave two logos.
      const raw = await deps.readFile(source.imageDriveFileId);
      finalBytes = await deps.composeIdentity(raw, { resolved, logo, drawIdentityText: false, placement });
    } catch (error) {
      const cause = toStudioError(error);
      throw new StudioError(
        cause.kind === 'storage' ? 'storage' : 'composition',
        `The logo could not be placed on this poster, so nothing was saved. ${cause.message}`,
        { cause: error },
      );
    }

    const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
    const finalFileId = await deps.store({
      folderId,
      fileName: `campaign-day-${day.dayNumber}-logo-${stamp}-final.png`,
      body: finalBytes,
      mimeType: 'image/png',
    });
    written.push(finalFileId);

    const summary = describeLogoPlacement(placement);
    const saved = await runInCampaignTransaction(db, async (tx) => {
      // The claim is settled first, restating this attempt's token, exactly as a
      // revision does: when another run took the day over meanwhile, nothing is
      // recorded and the catch below bins the file this attempt stored.
      const settled = await tx.contentCalendar.updateMany({
        where: { id: day.id, generationStatus: 'GENERATING', posterGenerationStartedAt: startedAt },
        data: { generationStatus: 'SUCCEEDED', errorMessage: null },
      });
      if (settled.count === 0) throw new CampaignDomainError('conflict', CLAIM_LOST_MESSAGE);

      const generation = await tx.posterStudioGeneration.create({
        data: {
          mode: 'EDIT',
          // Not an admin's own words, so the history says whose they are
          // (`posterRevisionSummary` reads the prefix back).
          prompt: `${POSTER_LOGO_PROMPT_PREFIX}${summary}`.slice(0, 4_000),
          sentPrompt: 'No prompt was sent: the logo was placed by code from the day’s stored placement, with no image model call.',
          aspectRatio: source.aspectRatio,
          size: source.size,
          // There is no model and no quality tier to record, and leaving the
          // parent's would read back as an image nobody generated.
          model: 'none',
          quality: 'none',
          textFree: false,
          // The parent's RAW artwork, shared rather than copied: it is byte for
          // byte the input this composite was made from, and Drive deletion only
          // bins a file no row still references.
          imageDriveFileId: source.imageDriveFileId,
          imageMimeType: source.imageMimeType,
          width: source.width,
          height: source.height,
          finalImageDriveFileId: finalFileId,
          finalImageMimeType: 'image/png',
          overlayElements: ['logo'],
          overlayPreset: 'clone-identity',
          logoBackground: logo.background,
          referenceDriveFileId: source.imageDriveFileId,
          referenceMimeType: source.imageMimeType,
          parentGenerationId: source.id,
          clientId: day.clientId,
          sourceTemplateId: template.id,
        },
        select: { id: true },
      });
      const version = await addPosterVersion(tx, {
        calendarDayId: day.id,
        source: 'POSTER_STUDIO',
        imageDriveFileId: finalFileId,
        imageMimeType: 'image/png',
        width: source.width,
        height: source.height,
        // The same revision, deliberately: no word changed, so a poster that was
        // current stays current and an outdated one stays outdated.
        contentRevision: active.contentRevision,
        templateId: template.id,
        parentVersionId: active.id,
        studioGenerationId: generation.id,
        // The previous check verbatim: it read this poster's words, and they are
        // still exactly these.
        textCheck: parseTextCheck(active.textCheck),
      });

      // The placement itself, guarded on the revision the document was read at:
      // a save of the day's words meanwhile makes this a conflict rather than an
      // overwrite of what the admin typed.
      const stored = await tx.contentCalendar.updateMany({
        where: { id: day.id, contentRevision: day.contentRevision },
        data: { posterElements: elements as unknown as Prisma.InputJsonValue },
      });
      if (stored.count === 0) throw new CampaignDomainError('conflict', 'This day was changed by someone else. Reload it and try again.');
      return { generationId: generation.id, version };
    });

    // The day's poster changed, so its booking follows — as after a generation.
    await bookCampaignDayQuietly(db, day.id, { deps: options.deliveryDeps });

    return {
      outcome: 'placed',
      dayNumber: day.dayNumber,
      versionId: saved.version.versionId,
      versionNumber: saved.version.versionNumber,
      generationId: saved.generationId,
      approvalStatus: saved.version.approvalStatus,
      message: `Day ${day.dayNumber}: v${saved.version.versionNumber} made — logo ${summary}${saved.version.approvalStatus === 'APPROVED' ? ', approved by policy' : ', needs approval'}. No AI, nothing billed.`,
    };
  } catch (error) {
    const failure = toStudioError(error);
    if (failure.kind !== 'validation') console.error(`[campaign:poster-logo] day ${day.dayNumber} failed (${failure.kind}):`, failure.cause ?? failure.message);
    await deps.trash(written);
    // A lost claim belongs to the run that took the day over; the guarded FAILED
    // update below cannot match it.
    const claimLost = error instanceof CampaignDomainError && error.code === 'conflict' && error.message === CLAIM_LOST_MESSAGE;
    const message = claimLost ? CLAIM_LOST_MESSAGE : failure.message;
    try {
      await db.contentCalendar.updateMany({
        where: { id: day.id, generationStatus: 'GENERATING', posterGenerationStartedAt: startedAt },
        data: { generationStatus: 'FAILED', errorMessage: message.slice(0, 2000) },
      });
    } catch (statusError) {
      console.error(`[campaign:poster-logo] could not record the failure of day ${day.dayNumber}:`, statusError);
    }
    return { outcome: 'failed', dayNumber: day.dayNumber, kind: failure.kind, message };
  }
}

/**
 * The day's document with `placement` on it, or with it taken off — never
 * mutating the one that was read, so a failure leaves nothing half-changed.
 */
function withPlacement(doc: DayPosterElementsDoc, placement: DayLogoPlacement | null): DayPosterElementsDoc {
  if (placement) return { ...doc, logo: placement };
  const { logo: _dropped, ...rest } = doc;
  return rest;
}

function toStudioError(error: unknown): StudioError {
  if (error instanceof StudioError) return error;
  if (error instanceof CampaignDomainError) return new StudioError('validation', error.message, { cause: error });
  if (error instanceof MissingEnvError) {
    return new StudioError('config', `The server is missing required configuration (${error.key}).`, { cause: error });
  }
  return new StudioError('provider', 'Something went wrong. The details are in the server log.', { cause: error });
}
