import { DeliveryStatus } from '@prisma/client';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  AlertTriangle,
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  Clock,
  FolderOpen,
  Palette,
  ShieldAlert,
  Sparkles,
  Upload,
} from 'lucide-react';

import { CalendarImportPanel } from '@/components/admin/CalendarImportPanel';
import { ClientControls } from '@/components/admin/ClientControls';
import { PageHeader } from '@/components/admin/PageHeader';
import { QueueLedger, type QueueEntry } from '@/components/admin/QueueLedger';
import { SeedCalendarButton } from '@/components/admin/SeedCalendarButton';
import { StatTile } from '@/components/admin/StatTile';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { optionalEnv } from '@/lib/env';
import {
  describeImageSize,
  photoIsUpscaledAt,
  resolveImageSizePreset,
} from '@/lib/image-sizes';
import { prisma } from '@/lib/prisma';
import { queueSelect, toQueueEntry } from '@/lib/queue-entry';
import {
  formatDisplayDate,
  formatDisplayDateTime,
  getAppTimeZone,
  zonedDayRange,
} from '@/lib/time';
import { parseBrandGuideline } from '@/lib/types/brand';

export const dynamic = 'force-dynamic';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TIMELINE_LIMIT = 24;
const FAILURE_LIMIT = 8;

export default async function ClientDetailPage({
  params,
}: {
  params: { clientId: string };
}) {
  // A malformed id would otherwise reach Postgres as an invalid uuid literal
  // and surface as a 500 rather than a 404.
  if (!UUID_PATTERN.test(params.clientId)) notFound();

  const timeZone = getAppTimeZone();
  const now = new Date();
  const { start: todayStart } = zonedDayRange(now, timeZone);

  const client = await prisma.client.findUnique({
    where: { id: params.clientId },
    select: {
      id: true,
      companyName: true,
      whatsappNumber: true,
      cronTime: true,
      startDate: true,
      endDate: true,
      isActive: true,
      monthlyBudgetInr: true,
      gDriveFolderId: true,
      imageSizePreset: true,
      brandGuideline: true,
      logoUrl: true,
      displayPhone: true,
      websiteUrl: true,
      createdAt: true,
      plan: { select: { name: true, durationDays: true } },
      category: { select: { name: true } },
    },
  });

  if (!client) notFound();

  const [statusGroups, failureRecords, upcomingRecords, seededRows] = await Promise.all([
    prisma.contentCalendar.groupBy({
      by: ['deliveryStatus'],
      where: { clientId: client.id },
      _count: { _all: true },
    }),
    prisma.contentCalendar.findMany({
      where: { clientId: client.id, deliveryStatus: DeliveryStatus.FAILED },
      orderBy: { updatedAt: 'desc' },
      take: FAILURE_LIMIT,
      select: queueSelect,
    }),
    prisma.contentCalendar.findMany({
      where: { clientId: client.id, scheduledDate: { gte: todayStart } },
      orderBy: [{ scheduledDate: 'asc' }, { dayNumber: 'asc' }],
      take: TIMELINE_LIMIT,
      select: queueSelect,
    }),
    // Day-number map for the bulk importer's dry run. Two integer columns over
    // at most 365 rows, so it is cheaper than it looks and lets the panel show
    // which days a sheet would create, replace, or bounce off.
    prisma.contentCalendar.findMany({
      where: { clientId: client.id },
      orderBy: { dayNumber: 'asc' },
      select: { dayNumber: true, deliveryStatus: true },
    }),
  ]);

  const statusCounts: Record<DeliveryStatus, number> = {
    [DeliveryStatus.PENDING]: 0,
    [DeliveryStatus.GENERATED]: 0,
    [DeliveryStatus.DELIVERED]: 0,
    [DeliveryStatus.FAILED]: 0,
  };
  for (const group of statusGroups) {
    statusCounts[group.deliveryStatus] = group._count._all;
  }

  const calendarCount = Object.values(statusCounts).reduce((sum, n) => sum + n, 0);
  const totalDays = client.plan.durationDays;

  const seededDays = seededRows.map((row) => row.dayNumber);
  // An import may rewrite PENDING and FAILED copy but not a day whose asset has
  // already been rendered or sent — the creative on Drive would no longer match.
  const lockedDays = seededRows
    .filter(
      (row) =>
        row.deliveryStatus === DeliveryStatus.GENERATED ||
        row.deliveryStatus === DeliveryStatus.DELIVERED,
    )
    .map((row) => row.dayNumber);

  const delivered = statusCounts[DeliveryStatus.DELIVERED];
  const progressPercent =
    totalDays > 0 ? Math.min(100, Math.round((delivered / totalDays) * 100)) : 0;

  // Campaign-over clients have nothing scheduled ahead of today; fall back to
  // the tail of the calendar so the page is never empty for them.
  let timeline: QueueEntry[] = upcomingRecords.map((entry) => toQueueEntry(entry, timeZone));
  let timelineIsHistory = false;
  if (timeline.length === 0 && calendarCount > 0) {
    const recent = await prisma.contentCalendar.findMany({
      where: { clientId: client.id },
      orderBy: [{ scheduledDate: 'desc' }, { dayNumber: 'desc' }],
      take: TIMELINE_LIMIT,
      select: queueSelect,
    });
    timeline = recent.map((entry) => toQueueEntry(entry, timeZone));
    timelineIsHistory = true;
  }

  const brand = parseBrandGuideline(client.brandGuideline);
  const sizePreset = resolveImageSizePreset(
    client.imageSizePreset,
    optionalEnv('FAL_IMAGE_SIZE', ''),
  );
  const driveUrl = client.gDriveFolderId
    ? `https://drive.google.com/drive/folders/${client.gDriveFolderId}`
    : null;

  return (
    <>
      <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit">
        <Link href="/admin/clients">
          <ArrowLeft className="h-4 w-4" />
          All clients
        </Link>
      </Button>

      <PageHeader
        eyebrow={`${client.plan.name} · ${client.category.name}`}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {client.companyName}
            <Badge variant={client.isActive ? 'emerald' : 'slate'}>
              {client.isActive ? 'Live' : 'Paused'}
            </Badge>
          </span>
        }
        description={`Onboarded ${formatDisplayDateTime(client.createdAt, timeZone)} · dispatching at ${client.cronTime} ${timeZone}`}
      >
        <Button asChild variant="outline" size="sm">
          <Link href={`/admin/clients/${client.id}/brand`}>
            <Palette className="h-4 w-4" />
            Brand canvas
          </Link>
        </Button>
        {driveUrl && (
          <Button asChild variant="outline" size="sm">
            <a href={driveUrl} target="_blank" rel="noreferrer noopener">
              <FolderOpen className="h-4 w-4" />
              Drive vault
            </a>
          </Button>
        )}
      </PageHeader>

      {/* ---- Delivery counters ---- */}
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          icon={CheckCircle2}
          label="Delivered"
          value={delivered}
          hint={`of ${totalDays} campaign days`}
          tone="emerald"
        />
        <StatTile
          icon={Clock}
          label="Pending"
          value={statusCounts[DeliveryStatus.PENDING]}
          hint="Queued, not yet generated"
          tone="amber"
        />
        <StatTile
          icon={Sparkles}
          label="Generated"
          value={statusCounts[DeliveryStatus.GENERATED]}
          hint="Asset in Drive, send incomplete"
        />
        <StatTile
          icon={AlertTriangle}
          label="Failed"
          value={statusCounts[DeliveryStatus.FAILED]}
          hint="Awaiting manual intervention"
          tone={statusCounts[DeliveryStatus.FAILED] > 0 ? 'red' : 'slate'}
        />
      </section>

      {/* ---- Identity + operations ---- */}
      <section className="grid gap-6 xl:grid-cols-[1fr_1.1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Tenant record</CardTitle>
            <CardDescription>
              Provisioning facts written at onboarding. Plan and vertical are fixed for the
              life of the campaign.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
              <Fact label="WhatsApp">
                <span className="font-mono">+{client.whatsappNumber}</span>
              </Fact>
              <Fact label="Plan">
                {client.plan.name}{' '}
                <span className="text-muted-foreground">({totalDays} days)</span>
              </Fact>
              <Fact label="Vertical">{client.category.name}</Fact>
              <Fact label="Delivery minute">
                <span className="font-mono">{client.cronTime}</span>
              </Fact>
              <Fact label="Campaign start">
                <span className="font-mono">
                  {formatDisplayDate(client.startDate, timeZone)}
                </span>
              </Fact>
              <Fact label="Campaign end">
                <span className="font-mono">
                  {formatDisplayDate(client.endDate, timeZone)}
                </span>
              </Fact>
              <Fact
                label="Output size"
                title={`${sizePreset.label} · ${describeImageSize(sizePreset)}`}
              >
                {sizePreset.label}
                {client.imageSizePreset === null && (
                  <span className="text-muted-foreground"> (default)</span>
                )}{' '}
                <span className="font-mono text-[11px] text-muted-foreground">
                  {sizePreset.width}×{sizePreset.height}
                </span>
                {photoIsUpscaledAt(sizePreset) && (
                  <span className="text-[11px] text-amber-600"> · soft photo</span>
                )}
              </Fact>
              <Fact label="Drive folder">
                {client.gDriveFolderId ? (
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {client.gDriveFolderId}
                  </span>
                ) : (
                  <span className="text-red-600">Not provisioned</span>
                )}
              </Fact>
              <Fact label="Poster logo">
                {client.logoUrl ? (
                  <span className="text-emerald-600">On file</span>
                ) : (
                  <span className="text-amber-600">
                    Wordmark fallback — add one on the brand canvas
                  </span>
                )}
              </Fact>
              <Fact label="Contact bar">
                <span className="font-mono text-[11px]">
                  {client.displayPhone ?? `+${client.whatsappNumber} (derived)`}
                  {client.websiteUrl ? ` · ${client.websiteUrl}` : ' · no website'}
                </span>
              </Fact>
              <Fact label="Brand tokens">
                {brand.colors.length > 0 ? (
                  <span className="flex items-center gap-2">
                    {brand.colors.length} colour{brand.colors.length === 1 ? '' : 's'}
                    <span className="flex gap-1">
                      {brand.colors.slice(0, 5).map((color) => (
                        <span
                          key={`${color.role}-${color.hex}`}
                          className="h-3.5 w-3.5 rounded-full border border-border"
                          style={{ backgroundColor: color.hex }}
                          title={`${color.role}: ${color.hex}`}
                        />
                      ))}
                    </span>
                  </span>
                ) : (
                  <span className="text-amber-600">Not extracted</span>
                )}
              </Fact>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Operations</CardTitle>
            <CardDescription>
              Calendar coverage is {calendarCount}/{totalDays} days seeded. Delivery progress
              tracks DELIVERED rows against the plan duration.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>Delivery progress</span>
                <span className="font-mono">
                  {delivered}/{totalDays} sent · {progressPercent}%
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-gradient-brand transition-all duration-500"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>

            <ClientControls
              clientId={client.id}
              companyName={client.companyName}
              cronTime={client.cronTime}
              isActive={client.isActive}
              hasDriveFolder={Boolean(client.gDriveFolderId)}
              timeZone={timeZone}
              monthlyBudgetInr={client.monthlyBudgetInr}
              imageSizePreset={client.imageSizePreset}
            />

            {calendarCount < totalDays && (
              <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
                <SeedCalendarButton
                  clientId={client.id}
                  companyName={client.companyName}
                  calendarCount={calendarCount}
                  totalDays={totalDays}
                />
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      {/* ---- Operator-authored content ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="h-4 w-4 text-brand-to" />
            Bulk content import
          </CardTitle>
          <CardDescription>
            Write the theme, caption, hashtags, and image prompt yourself instead of asking the
            generator for them, then load the sheet here. Imported days dispatch exactly like
            generated ones and cost nothing to write. The poster&apos;s text layer is the one
            thing still generated — it is derived from each imported day on first render.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CalendarImportPanel
            clientId={client.id}
            companyName={client.companyName}
            totalDays={totalDays}
            seededDays={seededDays}
            lockedDays={lockedDays}
          />
        </CardContent>
      </Card>

      {/* ---- Failures first: they need a human ---- */}
      {failureRecords.length > 0 && (
        <Card className="border-red-500/25">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-red-600">
              <ShieldAlert className="h-4 w-4" />
              Failed deliveries
            </CardTitle>
            <CardDescription>
              Re-send reuses the stored Drive asset when one exists; regenerate re-bills the
              image stage.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <QueueLedger
              entries={failureRecords.map((entry) => toQueueEntry(entry, timeZone))}
            />
          </CardContent>
        </Card>
      )}

      {/* ---- Calendar timeline ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-brand-to" />
            {timelineIsHistory ? 'Recent calendar entries' : 'Upcoming calendar entries'}
          </CardTitle>
          <CardDescription>
            {timelineIsHistory
              ? `Nothing scheduled from today onward — showing the most recent ${timeline.length} of ${calendarCount} entries.`
              : `Next ${timeline.length} of ${calendarCount} seeded entries, previewed from Google Drive.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <QueueLedger entries={timeline} />
        </CardContent>
      </Card>
    </>
  );
}

function Fact({
  label,
  children,
  /** Hover text, for facts the truncating `dd` may clip. */
  title,
}: {
  label: string;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <div className="min-w-0 space-y-0.5">
      <dt className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        {label}
      </dt>
      <dd className="truncate text-sm text-foreground" title={title}>
        {children}
      </dd>
    </div>
  );
}
