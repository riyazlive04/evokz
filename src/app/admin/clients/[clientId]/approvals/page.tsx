import { DeliveryStatus } from '@prisma/client';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ArrowLeft, CheckCircle2, Clock, Eye, ImageOff, ThumbsUp } from 'lucide-react';

import { CampaignApprovalControls } from '@/components/admin/CampaignApprovalControls';
import { PageHeader } from '@/components/admin/PageHeader';
import { QueueLedger } from '@/components/admin/QueueLedger';
import { StatTile } from '@/components/admin/StatTile';
import { Button } from '@/components/ui/button';
import { prisma } from '@/lib/prisma';
import { queueSelect, toQueueEntry } from '@/lib/queue-entry';
import { getAppTimeZone } from '@/lib/time';

/**
 * Where a campaign is reviewed before any of it reaches a client.
 *
 * The whole run is rendered ahead of time and waits here. Nothing on this page
 * sends anything: approving a poster makes it eligible, and the dispatch sweep
 * releases it at the client's delivery minute on its own scheduled day. That
 * separation is the point — it keeps `cronTime` meaning "when the client hears
 * from us" rather than "when somebody finished reviewing".
 */

export const dynamic = 'force-dynamic';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Posters listed at once.
 *
 * A 365-day campaign fully rendered would otherwise put 365 Drive images on one
 * page. Approving works day by day and the list refills as rows clear, so a cap
 * costs nothing an operator would notice — and "Approve all" is not bounded by
 * it, since it works from the database rather than from what is on screen.
 */
const REVIEW_LIMIT = 60;

/** Wider than the scanning grid asks for: this is the deciding view. */
const REVIEW_THUMBNAIL_WIDTH = 1024;

export default async function ClientApprovalsPage({
  params,
}: {
  params: { clientId: string };
}) {
  if (!UUID_PATTERN.test(params.clientId)) notFound();

  const timeZone = getAppTimeZone();

  const client = await prisma.client.findUnique({
    where: { id: params.clientId },
    select: { id: true, companyName: true, cronTime: true, gDriveFolderId: true },
  });

  if (!client) notFound();

  const forClient = { clientId: client.id };

  const [awaitingRows, awaiting, approved, ungenerated, inFlight, delivered] =
    await Promise.all([
      prisma.contentCalendar.findMany({
        where: {
          ...forClient,
          deliveryStatus: DeliveryStatus.GENERATED,
          approvedAt: null,
        },
        orderBy: { dayNumber: 'asc' },
        take: REVIEW_LIMIT,
        select: queueSelect,
      }),
      prisma.contentCalendar.count({
        where: {
          ...forClient,
          deliveryStatus: DeliveryStatus.GENERATED,
          approvedAt: null,
        },
      }),
      prisma.contentCalendar.count({
        where: { ...forClient, approvedAt: { not: null } },
      }),
      // Days with no poster that nothing is currently working on.
      prisma.contentCalendar.count({
        where: {
          ...forClient,
          deliveryStatus: DeliveryStatus.PENDING,
          generationQueuedAt: null,
        },
      }),
      prisma.contentCalendar.count({
        where: {
          ...forClient,
          deliveryStatus: DeliveryStatus.PENDING,
          generationQueuedAt: { not: null },
        },
      }),
      prisma.contentCalendar.count({
        where: { ...forClient, deliveryStatus: DeliveryStatus.DELIVERED },
      }),
    ]);

  const entries = awaitingRows.map((row) =>
    toQueueEntry(row, timeZone, REVIEW_THUMBNAIL_WIDTH),
  );

  return (
    <>
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href={`/admin/clients/${client.id}`}>
          <ArrowLeft className="h-4 w-4" />
          Back to {client.companyName}
        </Link>
      </Button>

      <PageHeader
        icon={Eye}
        eyebrow={client.companyName}
        title="Approve posters"
        description={`Nothing here has been sent. Approving a poster releases it to deliver at ${client.cronTime} on its own scheduled day — it does not send it now. Regenerate replaces a poster you are not happy with and brings the replacement back to this page.`}
      />

      {!client.gDriveFolderId && (
        <p className="rounded-xl border border-danger/25 bg-danger/5 px-4 py-3 text-xs leading-relaxed text-danger-ink">
          {client.companyName} has no Drive vault, so every render will fail at the
          upload step. Repair the Drive folder on the client page before generating
          anything.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          icon={ThumbsUp}
          label="Awaiting approval"
          value={awaiting}
          hint="Rendered and waiting on you"
          tone={awaiting > 0 ? 'amber' : 'slate'}
        />
        <StatTile
          icon={CheckCircle2}
          label="Approved"
          value={approved}
          hint="Cleared to deliver on their day"
          tone="emerald"
        />
        <StatTile
          icon={ImageOff}
          label="Not generated"
          value={ungenerated}
          hint="Days with copy but no poster yet"
          tone={ungenerated > 0 ? 'brand' : 'slate'}
        />
        <StatTile
          icon={Clock}
          label="Delivered"
          value={delivered}
          hint="Already on the client's WhatsApp"
          tone="slate"
        />
      </div>

      <CampaignApprovalControls
        clientId={client.id}
        ungenerated={ungenerated}
        inFlight={inFlight}
        awaiting={awaiting}
      />

      <QueueLedger
        entries={entries}
        variant="review"
        emptyMessage={
          ungenerated > 0 || inFlight > 0
            ? 'Nothing to review yet. Generate the campaign above, then posters land here a few at a time as the dispatcher renders them.'
            : 'Everything generated for this client has been reviewed. Seed more days on the client page to extend the campaign.'
        }
      />

      {awaiting > entries.length && (
        <p className="text-center text-[11px] text-muted-foreground">
          Showing the first {entries.length} of {awaiting}. The rest appear as these
          clear — or use &ldquo;Approve all&rdquo;, which covers every one of them.
        </p>
      )}
    </>
  );
}
