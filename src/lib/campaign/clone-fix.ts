import type { PosterApprovalStatus, PosterGenerationStatus } from '@prisma/client';

import { describeBoxPosition } from '@/lib/ai/studio-prompts';
import { normalizeCheckText } from '@/lib/ai/text-check';
import {
  brandFactFieldsInInstruction,
  BRAND_FACT_KEYWORDS,
  BRAND_FACT_LABELS,
  MAX_POSTER_CHANGE_LENGTH,
  MIN_POSTER_CHANGE_LENGTH,
  type BrandFactField,
  type PosterChangeSummary,
} from '@/lib/campaign/clone-editor-view';
import { SLOT_LOCK_LABELS, slotLockOf } from '@/lib/campaign/board';
import { bookCampaignDayQuietly, type DeliveryDeps } from '@/lib/campaign/delivery-service';
import { isVersionCurrent } from '@/lib/campaign/model';
import { isGenerationInProgress, TEMPLATE_NOT_READ_MESSAGE } from '@/lib/campaign/poster-generation';
import { CLAIM_LOST_MESSAGE, cloneBrandValues, defaultPosterGenerationDeps, type PosterGenerationDeps } from '@/lib/campaign/poster-generation-service';
import { addPosterVersion, CampaignDomainError, runInCampaignTransaction, type CampaignDb } from '@/lib/campaign/service';
import { MissingEnvError } from '@/lib/env';
import { cloneSizeFor } from '@/lib/poster-studio/clone-size';
import { getAppTimeZone } from '@/lib/time';
import { StudioError, type StudioErrorKind } from '@/lib/poster-studio/errors';
import {
  materializeDayElements,
  parseDayPosterElements,
  parseTemplateElements,
  parseTextCheck,
  resolveDayElements,
  textCheckIssueCount,
  type CloneBrandValues,
  type TemplateElementsDoc,
  type TextCheckResult,
} from '@/lib/types/template-elements';

/**
 * Small, targeted changes to a campaign day's finished poster — "Fix text" and
 * "Small change" in Poster Studio's template editor.
 *
 *   `fixCampaignDayPosterText`  correct only the words the text check found wrong
 *   `editCampaignDayPoster`     apply one admin instruction ("make the background lighter")
 *
 * A clone that is right except for one misspelt feature should not cost a full
 * regeneration — which redraws the photograph, the people and every other word,
 * and can get something else wrong. Both operations instead edit the poster that
 * exists:
 *
 *   the ACTIVE version's RAW artwork (its studio row's `imageDriveFileId` — the
 *   image model's output before the client's logo was composited, so the model
 *   never sees, and cannot smear, the real logo) → an edit prompt naming only
 *   the change → gpt-image-2 at `high`, at the SAME size the clone was rendered
 *   at → usage → decode check → the client's logo composited again into the
 *   template's logo box (`composeCloneIdentity`) → RAW and FINAL files in Drive →
 *   the text check run again on the new poster → an EDIT studio row (parent: the
 *   source row; input: the source's raw file, shared) and a new POSTER_STUDIO
 *   version with the same template and content revision, which becomes active →
 *   the same booking sync generation runs.
 *
 * **Version source: POSTER_STUDIO.** The new version is an admin-requested edit
 * of an existing Poster Studio image, made in Poster Studio — exactly what the
 * enum documents ("Made or edited in AI Poster Studio"), what "Save to Day"
 * already records for a studio edit, and what the board's details show as
 * "Edited in Poster Studio". PIPELINE means "Automatic generation", which this is
 * not. `addPosterVersion` requires a studio row for POSTER_STUDIO; there is one.
 *
 * **It cannot run beside a generation.** The day is claimed with the generation
 * pipeline's own claim — a conditional NOT_REQUESTED/SUCCEEDED/FAILED → QUEUED →
 * GENERATING update restating the revision, the active version and both
 * template columns, in one transaction so the queue worker cannot take the
 * momentary QUEUED row — and released to SUCCEEDED or FAILED by the same attempt
 * (`posterGenerationStartedAt`). A generation, the queue worker and another fix
 * all see a live GENERATING claim and refuse, and this refuses theirs.
 *
 * Refused before any spend: a closed or inactive campaign, a day whose poster was
 * sent, is being sent or whose date has passed, no poster, an uploaded poster (no
 * artwork to edit), an outdated poster (its words changed —
 * fixing the old words would be wrong; regenerate instead), a poster whose
 * template is not readable, and — for a fix — a poster whose text check found
 * nothing, or was never run.
 */

// ---------------------------------------------------------------------------
// Prompts — pure
// ---------------------------------------------------------------------------

/** The "Small change" length window, shared with the editor (`clone-editor-view.ts`). */
export { MAX_POSTER_CHANGE_LENGTH, MIN_POSTER_CHANGE_LENGTH };

/**
 * What a revision writes at the front of `PosterStudioGeneration.prompt` when the
 * words stored there are not an admin's own.
 *
 * The admin's instruction is stored exactly as typed, so a row that is not one
 * has to say so in the only column there is. Writer and reader share these two
 * constants and `posterRevisionSummary`, so a history row can never be read back
 * as an instruction the admin never gave.
 */
export const POSTER_FIX_PROMPT_PREFIX = 'Fix text — ';
export const POSTER_LOGO_PROMPT_PREFIX = 'Logo placement — ';

/**
 * What one stored studio row did to the poster, for the version history: its
 * kind, and one line of words for the admin.
 *
 * A row with no mode at all is an uploaded poster — nothing in Poster Studio made
 * it. Any mode other than `EDIT` is the clone itself: the poster as the template
 * first gave it.
 */
export function posterRevisionSummary(mode: string | null | undefined, prompt: string | null | undefined): PosterChangeSummary {
  const text = (prompt ?? '').replace(/\s+/g, ' ').trim();
  if (!mode) return { kind: 'upload', text: 'Uploaded poster' };
  if (mode !== 'EDIT') return { kind: 'clone', text: 'Generated from the template' };
  if (text.startsWith(POSTER_LOGO_PROMPT_PREFIX)) {
    return { kind: 'logo', text: text.slice(POSTER_LOGO_PROMPT_PREFIX.length).trim() || 'Logo placement changed' };
  }
  if (text.startsWith(POSTER_FIX_PROMPT_PREFIX)) {
    return { kind: 'fix', text: text.slice(POSTER_FIX_PROMPT_PREFIX.length).trim() || 'Text corrected' };
  }
  return { kind: 'edit', text: text || 'Changed in Poster Studio' };
}

/**
 * One line per thing the text check found wrong, in reading order:
 *
 *   - a place that reads differently: change what is there to the exact words;
 *   - a place where nothing legible was found: write the exact words there;
 *   - a leftover template text: erase it and close the space.
 *
 * A leftover that is exactly the wrong text a place was found holding is not
 * listed again: that place's correction already replaces it, and "change X to Y"
 * next to "erase X" would contradict itself.
 */
export function textFixCorrections(textCheck: TextCheckResult, doc: Pick<TemplateElementsDoc, 'elements'>): string[] {
  const elements = new Map(doc.elements.map((element) => [element.id, element]));
  const lines: string[] = [];
  const replaced = new Set<string>();

  for (const item of textCheck.items) {
    if (item.match) continue;
    const element = elements.get(item.elementId);
    const where = element ? ` (${describeBoxPosition(element.box)})` : '';
    const found = item.found?.replace(/\s+/g, ' ').trim() || null;
    if (found) {
      replaced.add(normalizeCheckText(found));
      lines.push(`${item.label}${where}: change the text "${found}" to exactly "${item.expected}".`);
    } else {
      lines.push(`${item.label}${where}: this text must read exactly "${item.expected}". Write it in this place, replacing whatever is there, in the style of the text around it.`);
    }
  }

  // A leftover is located by its template element only when that element was
  // removed (it has no place in the check): for a replaced element whose place
  // was checked, the old words are somewhere else, and its own position now holds
  // the new words the model must keep.
  const checked = new Set(textCheck.items.map((item) => item.elementId));
  for (const leftover of textCheck.leftovers) {
    const text = leftover.replace(/\s+/g, ' ').trim();
    if (!text || replaced.has(normalizeCheckText(text))) continue;
    const element = doc.elements.find((candidate) => candidate.text && normalizeCheckText(candidate.text) === normalizeCheckText(text));
    const where = element && !checked.has(element.id) ? ` (${describeBoxPosition(element.box)})` : '';
    lines.push(`Erase "${text}"${where} and close the space naturally.`);
  }
  return lines;
}

interface RevisionPromptCommon {
  /** "vertical 4:5". */
  orientation: string;
  /** The template has a logo box the client's logo is composited into afterwards. */
  hasLogoBox: boolean;
}

function frameLine(orientation: string): string {
  return `Output frame: ${orientation}, the same shape as the attached poster. Do not crop, stretch or rearrange it.`;
}

const LOGO_SPACE_LINE = "The empty space left for the client's logo stays clean and empty: no text, shape or picture may move into it.";

/**
 * Corrects only the listed texts of a finished clone. Everything else is named as
 * staying — the same stance as `buildClonePrompt`, because an edit that "improves"
 * the photo while fixing a word is a new defect.
 */
export function buildCloneTextFixPrompt(input: RevisionPromptCommon & { corrections: readonly string[] }): string {
  const count = input.corrections.length;
  return [
    'Edit the attached poster. It is finished except for the text listed below: correct only that text and keep everything else exactly as it is.',
    [`Correct ${count === 1 ? 'this text' : `these ${count} texts`}:`, ...input.corrections.map((line, index) => `${index + 1}. ${line}`)].join('\n'),
    'A corrected text keeps the position, typeface, weight, size, colour, case and alignment of the text it corrects; if it is longer it may wrap or get slightly smaller, but it stays inside the same area. Erased text leaves clean background that matches its surroundings.',
    [
      'Keep the layout, the photographs and the people in them, shapes, icons, buttons, backgrounds, colours and every other text exactly as they are, spelled exactly as they appear.',
      input.hasLogoBox ? LOGO_SPACE_LINE : null,
    ]
      .filter((line): line is string => line !== null)
      .join(' '),
    frameLine(input.orientation),
    'Do not add any new text, logos, badges, QR codes or watermarks. Spell every corrected text exactly as written.',
  ].join('\n\n');
}

/** One exact detail the poster must carry, copied from Brand Canvas. */
export interface BrandFact {
  /** "Phone", "Website" — the Brand Canvas field's own name. */
  label: string;
  value: string;
}

/**
 * One admin instruction applied to a finished clone — `buildEditPrompt`'s "apply
 * the change fully, leave the rest alone", with the clone's own rules: its words
 * stay exactly as written and its logo space stays empty, unless the change asks
 * otherwise.
 *
 * **What the change asks for is allowed to be new.** A template has only the
 * elements the reader found in it, so "add a footer with my phone and website"
 * can never be satisfied by editing an element — there is none. The closing
 * sentences therefore say twice what one ambiguous line used to say once: the
 * first permits exactly what was asked for, the second forbids everything else.
 *
 * `facts` are the Brand Canvas details the instruction mentions
 * (`brandFactsForInstruction`), listed so the model has no reason to invent a
 * phone number. It is the same value the poster's bound elements print, so the
 * two can never disagree.
 */
export function buildCloneEditPrompt(input: RevisionPromptCommon & { instruction: string; facts?: readonly BrandFact[] }): string {
  const facts = input.facts ?? [];
  return [
    'Edit the attached poster. Make this change:',
    input.instruction.replace(/\s+/g, ' ').trim(),
    facts.length > 0
      ? [BRAND_FACTS_LINE, ...facts.map((fact) => `- ${fact.label}: ${fact.value}`)].join('\n')
      : null,
    'Apply the change fully, and change nothing else. Everything the change does not mention stays exactly as it is: the layout and composition, every text (the same words, spelling, position, typeface, size and colour), the photographs and the people in them, shapes, icons, buttons and colours.',
    input.hasLogoBox ? LOGO_SPACE_LINE : null,
    frameLine(input.orientation),
    [
      'If the change asks for something the poster does not have yet — a line of text, a bar, a strip, a contact detail — draw it, in the poster’s own typefaces and colours, placed where it covers no face, no logo and no existing text.',
      'Add nothing the change did not ask for: no new logo, badge, QR code, watermark, icon, stock graphic or extra wording, and spell every text the change asks for exactly as written.',
    ].join(' '),
  ]
    .filter((part): part is string => part !== null)
    .join('\n\n');
}

/** Introduces the Brand Canvas details an instruction asked for. */
const BRAND_FACTS_LINE = 'Use these exact details, copied character for character — do not invent, reformat, abbreviate or re-space them:';

/**
 * The keyword table and the field names, re-exported from the pure view model
 * that owns them: the composer warns the admin from the same table this prompt
 * is built with, so the two can never drift.
 */
export { BRAND_FACT_KEYWORDS, type BrandFactField };

/**
 * The Brand Canvas details an instruction asks the poster to carry, with their
 * exact values — nothing for an instruction that names none, and nothing for a
 * field Brand Canvas has left empty (there is no exact value to give, and the
 * composer warns the admin before they send).
 */
export function brandFactsForInstruction(instruction: string, brand: CloneBrandValues): BrandFact[] {
  const facts: BrandFact[] = [];
  for (const field of brandFactFieldsInInstruction(instruction)) {
    const value = brand[field]?.replace(/\s+/g, ' ').trim();
    if (value) facts.push({ label: BRAND_FACT_LABELS[field], value });
  }
  return facts;
}

/** An instruction as stored and sent: whitespace collapsed; refused when too short or too long. */
export function normalizePosterChangeInstruction(instruction: string): string {
  const clean = instruction.replace(/\s+/g, ' ').trim();
  if (clean.length < MIN_POSTER_CHANGE_LENGTH) {
    throw new CampaignDomainError('invalid-input', 'Describe the change you want in a few words.');
  }
  if (clean.length > MAX_POSTER_CHANGE_LENGTH) {
    throw new CampaignDomainError('invalid-input', `Keep the change under ${MAX_POSTER_CHANGE_LENGTH} characters — describe one change at a time.`);
  }
  return clean;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export type PosterRevisionResult =
  | {
      outcome: 'revised';
      dayNumber: number;
      versionId: string;
      versionNumber: number;
      generationId: string;
      approvalStatus: PosterApprovalStatus;
      /** Differences the new poster's text check found; null when the check could not run. */
      textCheckIssues: number | null;
      message: string;
    }
  | {
      outcome: 'failed';
      dayNumber: number;
      kind: StudioErrorKind;
      message: string;
      /** The image was generated (and billed) before the failure. */
      billed: boolean;
    };

export interface PosterRevisionOptions {
  deps?: PosterGenerationDeps;
  /** Delivery dependencies for the booking sync that follows a new version. */
  deliveryDeps?: DeliveryDeps;
  now?: Date;
  timeZone?: string;
}

type Revision = { type: 'fix' } | { type: 'edit'; instruction: string };

/** Corrects only the texts the active poster's text check found wrong. */
export function fixCampaignDayPosterText(db: CampaignDb, dayId: string, options: PosterRevisionOptions = {}): Promise<PosterRevisionResult> {
  return revisePoster(db, dayId, { type: 'fix' }, options);
}

/** Applies one admin instruction to the active poster. */
export async function editCampaignDayPoster(
  db: CampaignDb,
  dayId: string,
  instruction: string,
  options: PosterRevisionOptions = {},
): Promise<PosterRevisionResult> {
  return revisePoster(db, dayId, { type: 'edit', instruction: normalizePosterChangeInstruction(instruction) }, options);
}

async function revisePoster(db: CampaignDb, dayId: string, revision: Revision, options: PosterRevisionOptions): Promise<PosterRevisionResult> {
  const deps = options.deps ?? defaultPosterGenerationDeps;
  const now = options.now ?? new Date();

  // ---- Refusals: everything decidable before any claim or spend --------------
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
      campaign: { select: { id: true, status: true } },
      delivery: { select: { status: true, scheduledFor: true } },
      activePosterVersion: {
        select: {
          id: true,
          versionNumber: true,
          contentRevision: true,
          templateId: true,
          textCheck: true,
          studioGeneration: { select: { id: true, imageDriveFileId: true, imageMimeType: true, aspectRatio: true, size: true, sourceTemplateId: true } },
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
  // A sent poster is what the client received, one being sent is on its way, and
  // a past day is over: none of them is ever changed.
  const lock = slotLockOf(day, now, options.timeZone ?? getAppTimeZone());
  if (lock === 'sent' || lock === 'sending' || lock === 'past') {
    throw new CampaignDomainError('invalid-transition', `${SLOT_LOCK_LABELS[lock]} Its poster can no longer change.`);
  }
  const active = day.activePosterVersion;
  if (!active) throw new CampaignDomainError('invalid-transition', 'This day has no poster yet. Generate one first.');
  const source = active.studioGeneration;
  if (!source) throw new CampaignDomainError('invalid-transition', 'This poster was uploaded, so it has no artwork to change with AI. Generate a new one instead.');
  if (!isVersionCurrent(active, day)) {
    throw new CampaignDomainError('invalid-transition', 'This poster is outdated — its words or template changed after it was made. Regenerate it instead.');
  }
  if (day.generationStatus === 'QUEUED' || isGenerationInProgress(day.generationStatus, day.posterGenerationStartedAt, now)) {
    throw new CampaignDomainError('conflict', 'A poster is being generated for this day. Wait for it to finish, then try again.');
  }

  const templateId = active.templateId ?? source.sourceTemplateId;
  if (!templateId) throw new CampaignDomainError('invalid-transition', 'This poster was not made from a template, so it cannot be changed here.');
  const template = await db.categoryTemplate.findUnique({ where: { id: templateId }, select: { id: true, label: true, elements: true } });
  if (!template) throw new CampaignDomainError('invalid-transition', 'The template this poster was made from no longer exists. Regenerate it from another template.');
  const doc = parseTemplateElements(template.elements);
  if (!doc) throw new CampaignDomainError('invalid-transition', TEMPLATE_NOT_READ_MESSAGE);

  // The size the clone was rendered at, exactly; its shape words for the prompt.
  const sized = /^(\d{2,5})x(\d{2,5})$/.exec(source.size);
  const width = sized ? Number(sized[1]) : 0;
  const height = sized ? Number(sized[2]) : 0;
  const shape = cloneSizeFor(width, height);
  if (!shape) throw new CampaignDomainError('invalid-transition', 'This poster was made at a size that cannot be edited. Regenerate it instead.');

  let corrections: string[] = [];
  if (revision.type === 'fix') {
    const textCheck = parseTextCheck(active.textCheck);
    if (!textCheck) throw new CampaignDomainError('invalid-transition', 'This poster has no text check, so there is nothing to fix. Use Small change or regenerate it.');
    corrections = textCheckIssueCount(textCheck) > 0 ? textFixCorrections(textCheck, doc) : [];
    if (corrections.length === 0) throw new CampaignDomainError('invalid-transition', 'The text check found no differences on this poster, so there is nothing to fix.');
  }

  // Cheapest check first, before the claim: without a key nothing can run.
  try {
    deps.assertConfigured();
  } catch (error) {
    const failure = toStudioError(error);
    return { outcome: 'failed', dayNumber: day.dayNumber, kind: failure.kind, message: failure.message, billed: false };
  }

  // ---- Claim -------------------------------------------------------------------
  const startedAt = now;
  await claimForRevision(db, { ...day, activeVersionId: active.id }, startedAt);

  const written: string[] = [];
  let billed = false;
  try {
    const canvas = await deps.loadBrandCanvas(day.clientId);
    const logo = await deps.resolveLogo(canvas);
    const folderId = await deps.resolveFolder(canvas.companyName);

    const elements = materializeDayElements(doc, parseDayPosterElements(day.posterElements), template.id, day, { businessName: canvas.companyName });
    const brand = cloneBrandValues(canvas, logo !== null);
    const resolved = resolveDayElements(doc, elements, brand, day.imagePrompt);
    const hasLogoBox = resolved.some((item) => item.action.type === 'logo');

    const sentPrompt =
      revision.type === 'fix'
        ? buildCloneTextFixPrompt({ corrections, orientation: shape.orientation, hasLogoBox })
        : buildCloneEditPrompt({
            instruction: revision.instruction,
            orientation: shape.orientation,
            hasLogoBox,
            // The same Brand Canvas values the poster's bound elements print, so
            // what the chat adds and what the template already carries agree.
            facts: brandFactsForInstruction(revision.instruction, brand),
          });

    let image: { bytes: Buffer; mimeType: string };
    try {
      image = await deps.prepareTemplate(await deps.readFile(source.imageDriveFileId), { ...shape, size: source.size, width, height });
    } catch (error) {
      const cause = toStudioError(error);
      throw new StudioError(
        cause.kind === 'storage' ? 'storage' : 'invalid-image',
        `The poster's artwork could not be loaded, so nothing was changed. ${cause.message}`,
        { cause: error },
      );
    }

    // ---- Spend -------------------------------------------------------------------
    const rendered = await deps.render({ prompt: sentPrompt, size: source.size, image, quality: 'high' });
    billed = true;
    await deps.recordUsage(rendered.usage, rendered.model, { clientId: day.clientId, calendarId: day.id });

    const dimensions = await deps.readImageSize(rendered.bytes);
    if (!dimensions) throw new StudioError('provider', 'OpenAI returned an image that could not be read. Nothing was saved — try again.');

    let finalBytes: Buffer;
    try {
      // As for a generation: the day's stored placement decides where the mark goes.
      finalBytes = await deps.composeIdentity(rendered.bytes, { resolved, logo, drawIdentityText: false, placement: elements.logo ?? null });
    } catch (error) {
      throw new StudioError('composition', "The client's logo could not be placed on the changed poster, so nothing was saved.", { cause: error });
    }
    const logoPlaced = logo !== null && hasLogoBox;

    const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
    const base = `campaign-day-${day.dayNumber}-${revision.type === 'fix' ? 'text-fix' : 'edit'}-${stamp}`;
    const rawFileId = await deps.store({ folderId, fileName: `${base}-raw.${extensionFor(rendered.mimeType)}`, body: rendered.bytes, mimeType: rendered.mimeType });
    written.push(rawFileId);
    const finalFileId = await deps.store({ folderId, fileName: `${base}-final.png`, body: finalBytes, mimeType: 'image/png' });
    written.push(finalFileId);

    // Advisory, as for generation: a failed read-back leaves the poster unchecked.
    let textCheck: TextCheckResult | null = null;
    try {
      textCheck = await deps.checkText({ bytes: finalBytes, mimeType: 'image/png', resolved, templateDoc: doc, bill: { clientId: day.clientId, calendarId: day.id } });
    } catch (error) {
      console.error(`[campaign:poster-fix] text check failed for day ${day.dayNumber}; the poster is saved unchecked:`, error instanceof Error ? error.message : error);
    }

    const saved = await runInCampaignTransaction(db, async (tx) => {
      // The claim is settled first, restating this attempt's token: when a slow
      // attempt's claim went stale and another run took the day, nothing is
      // recorded, and the catch below bins this attempt's files.
      const settled = await tx.contentCalendar.updateMany({
        where: { id: day.id, generationStatus: 'GENERATING', posterGenerationStartedAt: startedAt },
        data: { generationStatus: 'SUCCEEDED', errorMessage: null },
      });
      if (settled.count === 0) throw new CampaignDomainError('conflict', CLAIM_LOST_MESSAGE);

      const generation = await tx.posterStudioGeneration.create({
        data: {
          mode: 'EDIT',
          // The admin's own words for an edit; for a fix, the prefix the history reads back (`posterRevisionSummary`).
          prompt: (revision.type === 'fix' ? `${POSTER_FIX_PROMPT_PREFIX}${corrections.join(' ')}` : revision.instruction).slice(0, 4_000),
          sentPrompt,
          aspectRatio: source.aspectRatio,
          size: source.size,
          model: rendered.model,
          quality: rendered.quality,
          textFree: false,
          imageDriveFileId: rawFileId,
          imageMimeType: rendered.mimeType,
          width: dimensions.width,
          height: dimensions.height,
          finalImageDriveFileId: finalFileId,
          finalImageMimeType: 'image/png',
          overlayElements: logoPlaced ? ['logo'] : [],
          overlayPreset: logoPlaced ? 'clone-identity' : null,
          logoBackground: logoPlaced && logo ? logo.background : null,
          // The input is the source's raw artwork, shared rather than copied:
          // History deletion only bins a file no row references.
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
        width: dimensions.width,
        height: dimensions.height,
        contentRevision: active.contentRevision,
        templateId: template.id,
        parentVersionId: active.id,
        studioGenerationId: generation.id,
        textCheck,
      });
      return { generationId: generation.id, version };
    });

    // The day's poster changed, so its booking follows — as after a generation.
    await bookCampaignDayQuietly(db, day.id, { deps: options.deliveryDeps });

    const issues = textCheck ? textCheckIssueCount(textCheck) : null;
    const what = revision.type === 'fix' ? 'text fixed' : 'change applied';
    const check = issues === null ? ' The text check could not run.' : issues === 0 ? ' Text check: all text correct.' : ` Text check: ${issues} ${issues === 1 ? 'difference' : 'differences'} left.`;
    return {
      outcome: 'revised',
      dayNumber: day.dayNumber,
      versionId: saved.version.versionId,
      versionNumber: saved.version.versionNumber,
      generationId: saved.generationId,
      approvalStatus: saved.version.approvalStatus,
      textCheckIssues: issues,
      message: `Day ${day.dayNumber}: v${saved.version.versionNumber} made — ${what}${saved.version.approvalStatus === 'APPROVED' ? ' and approved by policy' : ', needs approval'}.${check}`,
    };
  } catch (error) {
    const failure = toStudioError(error);
    if (failure.kind !== 'validation') console.error(`[campaign:poster-fix] day ${day.dayNumber} failed (${failure.kind}):`, failure.cause ?? failure.message);
    await deps.trash(written);
    // A lost claim belongs to the run that took the day over; the guarded FAILED
    // update below cannot match it.
    const claimLost = error instanceof CampaignDomainError && error.code === 'conflict' && error.message === CLAIM_LOST_MESSAGE;
    const message = claimLost
      ? `The image was generated and billed, but ${CLAIM_LOST_MESSAGE.charAt(0).toLowerCase()}${CLAIM_LOST_MESSAGE.slice(1)}`
      : billed
        ? `The image was generated and billed, but a later step failed. Nothing was saved; the poster is unchanged. (${failure.message})`
        : failure.message;
    try {
      await db.contentCalendar.updateMany({
        where: { id: day.id, generationStatus: 'GENERATING', posterGenerationStartedAt: startedAt },
        data: { generationStatus: 'FAILED', errorMessage: message.slice(0, 2000) },
      });
    } catch (statusError) {
      console.error(`[campaign:poster-fix] could not record the failure of day ${day.dayNumber}:`, statusError);
    }
    return { outcome: 'failed', dayNumber: day.dayNumber, kind: failure.kind, message, billed };
  }
}

/**
 * The generation claim (`claimDay` in `poster-generation-service.ts`), for an
 * edit of the active poster: a stale GENERATING claim is released first, then
 * NOT_REQUESTED/SUCCEEDED/FAILED → QUEUED → GENERATING, the first update
 * restating the revision, the active version and both template columns. Both
 * steps run in one transaction, so the queue worker — which takes QUEUED rows —
 * never sees the momentary QUEUED state. Throws a conflict when the day moved on.
 *
 * Exported for `clone-logo.ts`, which re-composites the mark on the poster that
 * exists: it changes the day's active version exactly as a revision does, so it
 * must hold the same claim and be refused by the same one.
 */
export async function claimForRevision(
  db: CampaignDb,
  day: {
    id: string;
    contentRevision: number;
    posterTemplateId: string | null;
    suggestedTemplateId: string | null;
    generationStatus: PosterGenerationStatus | null;
    posterGenerationStartedAt: Date | null;
    campaign: { id: string } | null;
    activeVersionId: string;
  },
  startedAt: Date,
): Promise<void> {
  const conflict = () => new CampaignDomainError('conflict', 'This day changed or started generating meanwhile. Reload it and try again.');

  const claimed = await runInCampaignTransaction(db, async (tx) => {
    let from: PosterGenerationStatus | null = day.generationStatus;
    if (from === 'GENERATING') {
      const released = await tx.contentCalendar.updateMany({
        where: { id: day.id, generationStatus: 'GENERATING', posterGenerationStartedAt: day.posterGenerationStartedAt },
        data: { generationStatus: 'FAILED', errorMessage: 'The previous attempt was interrupted before it finished.' },
      });
      if (released.count === 0) return false;
      from = 'FAILED';
    }
    if (from === 'QUEUED') return false;

    const queued = await tx.contentCalendar.updateMany({
      where: {
        id: day.id,
        campaignId: day.campaign?.id,
        generationStatus: from,
        contentRevision: day.contentRevision,
        activePosterVersionId: day.activeVersionId,
        posterTemplateId: day.posterTemplateId,
        suggestedTemplateId: day.suggestedTemplateId,
        campaign: { status: 'ACTIVE' },
      },
      data: { generationStatus: 'QUEUED', errorMessage: null },
    });
    if (queued.count === 0) return false;
    const generating = await tx.contentCalendar.updateMany({
      where: { id: day.id, generationStatus: 'QUEUED' },
      data: { generationStatus: 'GENERATING', posterGenerationStartedAt: startedAt },
    });
    return generating.count === 1;
  });
  if (!claimed) throw conflict();
}

function toStudioError(error: unknown): StudioError {
  if (error instanceof StudioError) return error;
  if (error instanceof CampaignDomainError) return new StudioError('validation', error.message, { cause: error });
  if (error instanceof MissingEnvError) {
    return new StudioError('config', `The server is missing required configuration (${error.key}).`, { cause: error });
  }
  return new StudioError('provider', 'Something went wrong. The details are in the server log.', { cause: error });
}

function extensionFor(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  return 'png';
}
