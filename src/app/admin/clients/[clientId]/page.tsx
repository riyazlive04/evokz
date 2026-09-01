import { DeliveryStatus } from '@prisma/client';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  AlertTriangle,
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  Clock,
  Eye,
  FolderOpen,
  Palette,
  ShieldAlert,
  Sparkles,
  Upload,
} from 'lucide-react';

import { CalendarImportPanel } from '@/components/admin/CalendarImportPanel';
import { ManualTemplateUploadDialog } from '@/components/admin/ManualTemplateUploadDialog';
import { ClientControls } from '@/components/admin/ClientControls';
import { ClientDangerZone } from '@/components/admin/ClientDangerZone';
import { EditClientDialog } from '@/components/admin/EditClientDialog';
import { PageHeader } from '@/components/admin/PageHeader';
import { ClientAssignment } from '@/components/admin/ClientAssignment';
import { QueueLedger, type QueueEntry } from '@/components/admin/QueueLedger';
import { RetryFailedButton } from '@/components/admin/RetryFailedButton';
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
  describeDeliveryDays,
  formatDisplayDate,
  formatDisplayDateTime,
  getAppTimeZone,
  toTimeString,
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
  const { start: todayStart, end: tomorrowStart } = zonedDayRange(now, timeZone);

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
      planId: true,
      categoryId: true,
      deliveryDays: true,
      plan: { select: { name: true, durationDays: true } },
      category: { select: { name: true } },
    },
  });

  if (!client) notFound();

  const [
    statusGroups,
    awaitingApproval,
    failureRecords,
    upcomingRecords,
    seededRows,
    planOptions,
    categoryOptions,
    approvedTemplates,
  ] = await Promise.all([
    prisma.contentCalendar.groupBy({
      by: ['deliveryStatus'],
      where: { clientId: client.id },
      _count: { _all: true },
    }),
    // Not derivable from the status groups: approval is a separate axis, and a
    // GENERATED row is either mid-send-delay or waiting on a human with no way to
    // tell the two apart from the status alone.
    prisma.contentCalendar.count({
      where: {
        clientId: client.id,
        deliveryStatus: DeliveryStatus.GENERATED,
        approvedAt: null,
      },
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
    prisma.plan.findMany({
      orderBy: { durationDays: 'asc' },
      select: { id: true, name: true, durationDays: true },
    }),
    prisma.category.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    // The layouts a sheet may name for this client, served by
    // @@index([categoryId, layoutApprovedAt]). Cheap, and it is what lets the
    // importer reject a misspelt template before anything is written — and what
    // fills the template column in the downloadable CSV with names that exist.
    prisma.categoryTemplate.findMany({
      where: { categoryId: client.categoryId, layoutApprovedAt: { not: null } },
      orderBy: { label: 'asc' },
      select: { id: true, label: true },
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

  /*
   * Whether this client's delivery minute has already gone by today.
   *
   * Named once and used twice — for the manual uploader's date floor and for the
   * sentence that explains it — because those two disagreeing is exactly the bug
   * that would make the explanation worse than none at all.
   */
  const todayIsSpent = toTimeString(now, timeZone) >= client.cronTime;

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
        <EditClientDialog
          clientId={client.id}
          companyName={client.companyName}
          whatsappNumber={client.whatsappNumber}
        />
        <Button
          asChild
          variant={awaitingApproval > 0 ? 'default' : 'outline'}
          size="sm"
        >
          <Link href={`/admin/clients/${client.id}/approvals`}>
            <Eye className="h-4 w-4" />
            {awaitingApproval > 0 ? `Approve ${awaitingApproval}` : 'Approvals'}
          </Link>
        </Button>
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
          hint={
            awaitingApproval > 0
              ? `${awaitingApproval} waiting on approval`
              : 'Asset in Drive, approved and scheduled'
          }
          tone={awaitingApproval > 0 ? 'amber' : 'brand'}
          href={`/admin/clients/${client.id}/approvals`}
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
              Provisioning facts written at onboarding. Plan and vertical can be changed
              from Operations — a shorter plan is refused while calendar days fall beyond
              it.
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
                <span className="font-mono">{client.cronTime}</span>{' '}
                <span className="text-muted-foreground">
                  · {describeDeliveryDays(client.deliveryDays)}
                </span>
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
                  <span className="text-[11px] text-warning-ink"> · soft photo</span>
                )}
              </Fact>
              <Fact label="Drive folder">
                {client.gDriveFolderId ? (
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {client.gDriveFolderId}
                  </span>
                ) : (
                  <span className="text-danger-ink">Not provisioned</span>
                )}
              </Fact>
              <Fact label="Poster logo">
                {client.logoUrl ? (
                  <span className="text-success-ink">On file</span>
                ) : (
                  <span className="text-warning-ink">
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
                  <span className="text-warning-ink">Not extracted</span>
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
                  className="h-full rounded-full bg-primary transition-all duration-500"
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

            <ClientAssignment
              clientId={client.id}
              planId={client.planId}
              categoryId={client.categoryId}
              deliveryDays={client.deliveryDays}
              plans={planOptions}
              categories={categoryOptions}
              hasCalendar={calendarCount > 0}
            />

            {calendarCount < totalDays && (
              <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
                <SeedCalendarButton
                  clientId={client.id}
                  companyName={client.companyName}
                  calendarCount={calendarCount}
                  totalDays={totalDays}
                  hasBrandTokens={brand.colors.length > 0}
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
            Two ways in, and they are not the same thing. <strong>Import a sheet</strong> to write
            the theme, caption, hashtags and image prompt yourself instead of asking the generator
            for them — those days still get a poster drawn for them here, from a template the sheet
            names, so the vertical needs an approved layout. <strong>Upload templates</strong> is
            the other one: finished posters made elsewhere, which are stored and scheduled as they
            are. Nothing is drawn, no template is involved, and no approval is needed afterwards.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CalendarImportPanel
            clientId={client.id}
            companyName={client.companyName}
            totalDays={totalDays}
            seededDays={seededDays}
            lockedDays={lockedDays}
            templates={approvedTemplates}
            categoryName={client.category.name}
            manualUploadAction={
              <ManualTemplateUploadDialog
                clientId={client.id}
                companyName={client.companyName}
                totalDays={totalDays}
                seededDays={seededDays}
                startDate={client.startDate.toISOString()}
                endDate={client.endDate.toISOString()}
                deliveryDays={client.deliveryDays}
                timeZone={timeZone}
                /*
                 * The same floor `storeManualPoster` applies server-side: today,
                 * unless this client's delivery minute has already gone by, in
                 * which case tomorrow. Computed here rather than in the browser
                 * because the app timezone is a server fact — a console open in
                 * another zone would otherwise preview a day the sweep will
                 * never look at.
                 */
                notBefore={(todayIsSpent ? tomorrowStart : todayStart).toISOString()}
                cronTime={client.cronTime}
                todayIsSpent={todayIsSpent}
              />
            }
          />
        </CardContent>
      </Card>

      {/* ---- Failures first: they need a human ---- */}
      {failureRecords.length > 0 && (
        <Card className="border-danger/25">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-danger-ink">
              <ShieldAlert className="h-4 w-4" />
              Failed deliveries
            </CardTitle>
            <CardDescription>
              Re-send reuses the stored Drive asset when one exists; regenerate re-bills the
              image stage.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <RetryFailedButton
              clientId={client.id}
              failedCount={statusCounts[DeliveryStatus.FAILED]}
            />
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

      {/* ---- Destructive actions, last and visually separated ---- */}
      <ClientDangerZone
        clientId={client.id}
        companyName={client.companyName}
        clearableDays={
          statusCounts[DeliveryStatus.PENDING] + statusCounts[DeliveryStatus.FAILED]
        }
        lockedDays={
          statusCounts[DeliveryStatus.GENERATED] + statusCounts[DeliveryStatus.DELIVERED]
        }
      />
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
