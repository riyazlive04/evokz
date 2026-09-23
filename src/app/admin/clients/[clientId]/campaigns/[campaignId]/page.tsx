import { notFound } from 'next/navigation';

import { CampaignBoard } from '@/components/campaign/board/CampaignBoard';
import type { BoardDayView, BoardView } from '@/components/campaign/board/types';
import { BOARD_STATUS_LABELS, parseBoardQuery, SLOT_LOCK_LABELS } from '@/lib/campaign/board';
import { CampaignDomainError } from '@/lib/campaign/service';
import { loadCampaignBoard } from '@/lib/campaign/board-service';
import { DELIVERY_STATUS_LABELS, deliveryClock } from '@/lib/campaign/delivery';
import { prisma } from '@/lib/prisma';
import { describeDeliveryDays, formatDisplayDate, formatDisplayDateTime, getAppTimeZone } from '@/lib/time';

export const dynamic = 'force-dynamic';
// Server actions posted from this page run under its limit: the card's Generate
// and the bulk bar's one-poster-at-a-time runner each make a high-quality clone
// plus its text check, and Send now calls WhatsApp. The default would cut them off.
export const maxDuration = 300;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The campaign board — one screen for a whole campaign.
 *
 * A week-paged board of day columns, one poster card per day, with the header's
 * counters as filters. It replaces the six stacked sections this page used to
 * render (health, review, delivery, poster generation, template mapping and the
 * content calendar), which are retired.
 *
 * **One load.** `loadCampaignBoard` reads the campaign and its days once and
 * derives every card with the phases' own rules. This page only formats dates
 * in the app timezone for the client board.
 *
 * The page itself writes nothing. Every button calls a server action that
 * re-runs its phase's gate server-side: generation eligibility, approval, the
 * delivery gate (which is also what books an approved day), the move lock.
 *
 * URL: `?week=` (page, 1-based; absent = the page with today), `?status=`
 * (a board status), `?q=` (headline or day number). The old `?review=` and
 * `?delivery=` links still open the matching status.
 */
export default async function CampaignBoardPage({
  params,
  searchParams,
}: {
  params: { clientId: string; campaignId: string };
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  if (!UUID_PATTERN.test(params.clientId) || !UUID_PATTERN.test(params.campaignId)) notFound();

  const timeZone = getAppTimeZone();
  const query = parseBoardQuery(searchParams);

  let board;
  try {
    board = await loadCampaignBoard(prisma, params.campaignId, { ...query, timeZone });
  } catch (error) {
    if (error instanceof CampaignDomainError && error.code === 'not-found') notFound();
    throw error;
  }
  // The campaign must belong to the client in the URL.
  if (board.client.id !== params.clientId) notFound();

  // Posters left waiting by a bulk run whose tab closed; the bulk bar offers to resume them.
  const queuedCount = await prisma.contentCalendar.count({ where: { campaignId: board.campaign.id, generationStatus: 'QUEUED' } });

  const dateFormat = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone });

  const days: BoardDayView[] = board.days.map((day) => ({
    id: day.id,
    dayNumber: day.dayNumber,
    dateLabel: dateFormat.format(day.scheduledDate),
    isToday: day.isToday,
    headline: day.headline,
    template: day.template ? { label: day.template.label, thumbnailUrl: day.template.thumbnailUrl } : null,
    poster: day.activeVersion
      ? {
          versionId: day.activeVersion.id,
          versionNumber: day.activeVersion.versionNumber,
          imageUrl: day.activeVersion.imageUrl,
          approvalStatus: day.activeVersion.approvalStatus,
          current: day.activeVersion.current,
          source: day.activeVersion.source,
        }
      : null,
    textCheckIssues: day.textCheckIssues,
    status: day.status,
    statusLabel: BOARD_STATUS_LABELS[day.status],
    delivery: day.delivery
      ? {
          status: day.delivery.status,
          statusLabel: DELIVERY_STATUS_LABELS[day.delivery.status],
          timeLabel: deliveryClock(day.delivery.sentAt ?? day.delivery.scheduledFor, timeZone),
          whenLabel: formatDisplayDateTime(day.delivery.sentAt ?? day.delivery.scheduledFor, timeZone),
          attempts: day.delivery.attempts,
          failureReason: day.delivery.failureReason,
          failurePermanent: day.delivery.failurePermanent,
          pinnedToActive: day.delivery.pinnedToActive,
        }
      : null,
    lock: day.lock,
    lockLabel: day.lock ? SLOT_LOCK_LABELS[day.lock] : null,
    note: day.note,
    actions: day.actions,
    message: day.message,
  }));

  const view: BoardView = {
    campaignId: board.campaign.id,
    campaignName: board.campaign.name,
    clientId: board.client.id,
    clientName: board.client.companyName,
    categoryName: board.campaign.categoryName,
    status: board.campaign.status,
    approvalPolicy: board.campaign.approvalPolicy,
    closed: board.campaign.closed,
    datesLabel: `${formatDisplayDate(board.campaign.startDate, timeZone)} → ${formatDisplayDate(board.campaign.endDate, timeZone)}`,
    scheduleLabel: `${board.campaign.durationDays} days · ${describeDeliveryDays(board.campaign.deliveryDays)} at ${board.campaign.deliveryTime}`,
    counts: board.counts,
    filter: board.query.status,
    q: board.query.q,
    mode: board.mode,
    page: board.page,
    totalDays: board.totalDays,
    queuedCount,
    days,
    warnings: board.warnings,
  };

  return <CampaignBoard board={view} />;
}
