'use server';

import { Prisma } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import type { ActionResult } from '@/app/admin/dashboard/actions';
import { loadBoardDayDetails, moveCampaignPost, setCampaignApprovalPolicy } from '@/lib/campaign/board-service';
import { MAX_CAMPAIGN_DAYS } from '@/lib/campaign/model';
import { CampaignDomainError } from '@/lib/campaign/service';
import { prisma } from '@/lib/prisma';
import { formatDisplayDateTime, getAppTimeZone } from '@/lib/time';

/**
 * Campaign board actions — the writes the board adds on top of the existing
 * campaign actions (`./actions.ts`), which it reuses for generate, approve,
 * reject, send, retry, cancel and status.
 *
 * Same conventions as that file: parse the wire input, call one service, map
 * failures to operator copy; behind the admin session (`src/middleware.ts`).
 * Every day is addressed **by id together with its campaign**, never by day
 * number alone, so a stale tab cannot move or read another campaign's day.
 */

const uuid = z.string().uuid();

function revalidateAdmin(): void {
  revalidatePath('/admin', 'layout');
}

function toFailure(error: unknown, context: string): ActionResult<never> {
  if (error instanceof CampaignDomainError) return { ok: false, error: error.message };
  if (error instanceof z.ZodError) return { ok: false, error: error.issues[0]?.message ?? 'The request was not valid.' };
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
    return { ok: false, error: 'That record no longer exists.' };
  }
  console.error(`[campaign:board-action] ${context} failed:`, error);
  return { ok: false, error: `${context} failed. Check the server logs for details.` };
}

export interface MovePostView {
  moves: Array<{ dayId: string; fromDayNumber: number; toDayNumber: number }>;
  rescheduled: number[];
  rebooked: number[];
  cancelled: number[];
}

/**
 * Moves one post to another day: it is inserted there and the posts between
 * shift one day. Sent, sending, due and past days keep their place. Refused as
 * a whole — nothing moves — when the move is not allowed.
 */
export async function moveCampaignPostAction(
  campaignId: string,
  dayId: string,
  targetDayNumber: number,
): Promise<ActionResult<MovePostView>> {
  try {
    const result = await moveCampaignPost(
      prisma,
      uuid.parse(campaignId),
      uuid.parse(dayId),
      z.number({ invalid_type_error: 'Choose a day number.' }).int('Choose a whole day number.').min(1, 'Choose a day within the campaign.').max(MAX_CAMPAIGN_DAYS).parse(targetDayNumber),
    );
    revalidateAdmin();
    return {
      ok: true,
      data: {
        moves: result.moves.map(({ dayId: id, fromDayNumber, toDayNumber }) => ({ dayId: id, fromDayNumber, toDayNumber })),
        rescheduled: result.rescheduled,
        rebooked: result.rebooked,
        cancelled: result.cancelled,
      },
    };
  } catch (error) {
    return toFailure(error, 'Moving the post');
  }
}

/** The header's Auto-approve switch. Affects posters made from now on only. */
export async function setCampaignApprovalPolicyAction(
  campaignId: string,
  policy: 'MANUAL_REVIEW' | 'AUTO_APPROVE',
): Promise<ActionResult<{ changed: boolean; policy: 'MANUAL_REVIEW' | 'AUTO_APPROVE' }>> {
  try {
    const result = await setCampaignApprovalPolicy(prisma, uuid.parse(campaignId), z.enum(['MANUAL_REVIEW', 'AUTO_APPROVE']).parse(policy));
    revalidateAdmin();
    return { ok: true, data: result };
  } catch (error) {
    return toFailure(error, 'Changing auto-approve');
  }
}

export interface BoardDayDetailsView {
  dayId: string;
  dayNumber: number;
  content: { headline: string | null; supportingText: string | null; cta: string | null; contentStatus: string };
  versions: Array<{
    id: string;
    versionNumber: number;
    source: string;
    approvalStatus: string;
    active: boolean;
    current: boolean;
    rejection: { label: string; detail: string | null } | null;
    templateLabel: string | null;
    imageUrl: string | null;
    fullImageUrl: string | null;
    textCheckIssues: number;
    /** "17 Sept, 09:04" in the app timezone. */
    createdLabel: string;
  }>;
  delivery: {
    status: string;
    scheduledForLabel: string;
    attempts: number;
    lastAttemptLabel: string | null;
    sentAtLabel: string | null;
    failureReason: string | null;
    failurePermanent: boolean;
    pinnedVersionNumber: number | null;
  } | null;
}

/** The drawer's versions and delivery record for one day. Read-only. */
export async function loadBoardDayDetailsAction(campaignId: string, dayId: string): Promise<ActionResult<BoardDayDetailsView>> {
  try {
    const details = await loadBoardDayDetails(prisma, uuid.parse(campaignId), uuid.parse(dayId));
    const timeZone = getAppTimeZone();
    const when = (date: Date) => formatDisplayDateTime(date, timeZone);
    return {
      ok: true,
      data: {
        dayId: details.dayId,
        dayNumber: details.dayNumber,
        content: details.content,
        versions: details.versions.map((version) => ({
          id: version.id,
          versionNumber: version.versionNumber,
          source: version.source,
          approvalStatus: version.approvalStatus,
          active: version.active,
          current: version.current,
          rejection: version.rejection,
          templateLabel: version.templateLabel,
          imageUrl: version.imageUrl,
          fullImageUrl: version.fullImageUrl,
          textCheckIssues: version.textCheckIssues,
          createdLabel: when(version.createdAt),
        })),
        delivery: details.delivery
          ? {
              status: details.delivery.status,
              scheduledForLabel: when(details.delivery.scheduledFor),
              attempts: details.delivery.attempts,
              lastAttemptLabel: details.delivery.lastAttemptAt ? when(details.delivery.lastAttemptAt) : null,
              sentAtLabel: details.delivery.sentAt ? when(details.delivery.sentAt) : null,
              failureReason: details.delivery.failureReason,
              failurePermanent: details.delivery.failurePermanent,
              pinnedVersionNumber: details.delivery.pinnedVersionNumber,
            }
          : null,
      },
    };
  } catch (error) {
    return toFailure(error, 'Loading the day');
  }
}
