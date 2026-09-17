import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ArrowLeft, CalendarRange, FolderOpen, Palette } from 'lucide-react';

import { ClientAssignment } from '@/components/admin/ClientAssignment';
import { ClientControls } from '@/components/admin/ClientControls';
import { ClearLegacyCalendarButton, ClientDangerZone } from '@/components/admin/ClientDangerZone';
import { EditClientDialog } from '@/components/admin/EditClientDialog';
import { PageHeader } from '@/components/admin/PageHeader';
import { CreateCampaignForm } from '@/components/campaign/CreateCampaignForm';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { loadClientCampaignAttention, type CampaignAttentionSummary } from '@/lib/campaign/operations';
import { optionalEnv } from '@/lib/env';
import { describeImageSize, resolveImageSizePreset } from '@/lib/image-sizes';
import { prisma } from '@/lib/prisma';
import {
  describeDeliveryDays,
  formatDisplayDate,
  formatDisplayDateTime,
  getAppTimeZone,
  zonedDayRange,
} from '@/lib/time';
import { parseBrandGuideline } from '@/lib/types/brand';

export const dynamic = 'force-dynamic';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One client: who they are, the defaults their campaigns start from, and the
 * campaigns themselves.
 *
 * Everything about posters and sending lives on a campaign's board — this page
 * only lists campaigns and creates them.
 */
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
  const { end: tomorrowStart } = zonedDayRange(now, timeZone);

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

  const [planOptions, categoryOptions, campaigns, olderDayGroups] = await Promise.all([
    prisma.plan.findMany({
      orderBy: { durationDays: 'asc' },
      select: { id: true, name: true, durationDays: true },
    }),
    prisma.category.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    prisma.campaign.findMany({
      where: { clientId: client.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, status: true, startDate: true, endDate: true, durationDays: true },
    }),
    // Calendar rows that belong to no campaign — left behind by the retired
    // daily poster maker. They still hold their day numbers, and a client holds
    // one calendar at a time, so a new campaign cannot reuse those numbers.
    prisma.contentCalendar.groupBy({
      by: ['deliveryStatus'],
      where: { clientId: client.id, campaignId: null },
      _count: { _all: true },
      _min: { dayNumber: true },
    }),
  ]);

  // Unsent older days (PENDING, FAILED) can be cleared; generated or delivered
  // ones are history and stay, still holding their day numbers.
  let clearableOlderDays = 0;
  let keptOlderDays = 0;
  let firstKeptDay: number | null = null;
  for (const group of olderDayGroups) {
    if (group.deliveryStatus === 'PENDING' || group.deliveryStatus === 'FAILED') {
      clearableOlderDays += group._count._all;
    } else {
      keptOlderDays += group._count._all;
      const lowest = group._min.dayNumber;
      if (lowest !== null) firstKeptDay = Math.min(firstKeptDay ?? lowest, lowest);
    }
  }
  const olderDays = clearableOlderDays + keptOlderDays;

  /*
   * Unresolved work per campaign, so each row links straight to the filtered
   * board instead of leaving an operator to page through 365 days. One query for
   * every campaign this client has, derived from the same poster states the
   * board shows.
   */
  let campaignAttention = new Map<string, CampaignAttentionSummary>();
  try {
    campaignAttention = await loadClientCampaignAttention(prisma, client.id);
  } catch (error) {
    console.error('[client-page] could not load campaign attention counts', error);
  }

  const totalDays = client.plan.durationDays;
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
        description={`Onboarded ${formatDisplayDateTime(client.createdAt, timeZone)} · new campaigns deliver at ${client.cronTime} ${timeZone}`}
      >
        <EditClientDialog
          clientId={client.id}
          companyName={client.companyName}
          whatsappNumber={client.whatsappNumber}
        />
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

      {/* ---- Identity + operations ---- */}
      <section className="grid gap-6 xl:grid-cols-[1fr_1.1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Tenant record</CardTitle>
            <CardDescription>
              Provisioning facts written at onboarding. The logo, contact details and colours
              posters use are edited on the brand canvas.
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
              <Fact label="Delivery time">
                <span className="font-mono">{client.cronTime}</span>{' '}
                <span className="text-muted-foreground">
                  · {describeDeliveryDays(client.deliveryDays)}
                </span>
              </Fact>
              <Fact label="Plan window">
                <span className="font-mono">
                  {formatDisplayDate(client.startDate, timeZone)} →{' '}
                  {formatDisplayDate(client.endDate, timeZone)}
                </span>
              </Fact>
              <Fact
                label="Size without a template"
                title={`${sizePreset.label} · ${describeImageSize(sizePreset)}`}
              >
                {sizePreset.label}
                {client.imageSizePreset === null && (
                  <span className="text-muted-foreground"> (default)</span>
                )}{' '}
                <span className="font-mono text-[11px] text-muted-foreground">
                  {sizePreset.width}×{sizePreset.height}
                </span>
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
                  <span className="text-warning-ink">Not set — add one on the brand canvas</span>
                )}
              </Fact>
              <Fact label="Contact details">
                <span className="font-mono text-[11px]">
                  {client.displayPhone ?? `+${client.whatsappNumber} (derived)`}
                  {client.websiteUrl ? ` · ${client.websiteUrl}` : ' · no website'}
                </span>
              </Fact>
              <Fact label="Brand colours">
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
                  <span className="text-muted-foreground">None — posters keep template colours</span>
                )}
              </Fact>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Operations</CardTitle>
            <CardDescription>
              Delivery time, weekdays, plan and vertical are the defaults a new campaign starts
              from. A campaign keeps its own once it is created — pause or resume sending from
              its board.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
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
            />
          </CardContent>
        </Card>
      </section>

      {/* ---- Campaigns ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CalendarRange className="h-4 w-4 text-brand-to" />
            Campaigns
          </CardTitle>
          <CardDescription>
            A new campaign fills its days from {client.category.name}&apos;s active templates. Open
            one to generate, approve, move and send its posters.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {campaigns.length > 0 && (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {campaigns.map((campaign) => {
                const attention = campaignAttention.get(campaign.id);
                const boardHref = `/admin/clients/${client.id}/campaigns/${campaign.id}`;
                const attentionLinks = attention
                  ? ([
                      ['needs-approval', 'need approval', attention.needsReview],
                      ['attention', 'need attention', attention.rejected + attention.outdated],
                      ['failed', 'failed', attention.failed],
                    ] as const).filter(([, , value]) => value > 0)
                  : [];
                return (
                  <li key={campaign.id} className="space-y-1 px-3 py-2.5">
                    <Link
                      href={boardHref}
                      className="-mx-3 -my-2.5 flex flex-wrap items-center justify-between gap-3 px-3 py-2.5 transition-colors hover:bg-accent"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-foreground">{campaign.name}</span>
                        <span className="block font-mono text-[11px] text-muted-foreground">
                          {formatDisplayDate(campaign.startDate, timeZone)} → {formatDisplayDate(campaign.endDate, timeZone)} ·{' '}
                          {campaign.durationDays} days
                        </span>
                      </span>
                      <Badge variant="slate">{campaign.status}</Badge>
                    </Link>

                    {/* Unresolved work, each count a link into that board filter. */}
                    {attentionLinks.length > 0 && (
                      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-[11px]">
                        {attentionLinks.map(([status, label, value]) => (
                          <Link
                            key={status}
                            href={`${boardHref}?status=${status}`}
                            className="text-warning-ink underline underline-offset-2 hover:text-foreground"
                          >
                            {value} {label}
                          </Link>
                        ))}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {olderDays > 0 && (
            <p className="text-[11px] text-muted-foreground">
              {olderDays} older calendar day(s) from before campaigns still hold this client&apos;s day
              numbers, so a new campaign cannot use those days.
              {clearableOlderDays > 0 &&
                ` ${clearableOlderDays} of them were never sent and can be cleared.`}
              {keptOlderDays > 0 &&
                (firstKeptDay === null || firstKeptDay <= 1
                  ? ` ${keptOlderDays} were generated or delivered and must be kept as history. They include day 1, so no new campaign can be created for this client.`
                  : ` ${keptOlderDays} were generated or delivered and must be kept as history. They start at day ${firstKeptDay}, so a new campaign can have at most ${firstKeptDay - 1} content day(s)${clearableOlderDays > 0 ? ' once the unsent days are cleared' : ''}.`)}
            </p>
          )}
          <ClearLegacyCalendarButton clientId={client.id} clearableDays={clearableOlderDays} />
          <CreateCampaignForm
            clientId={client.id}
            defaultName={`${client.companyName} · ${client.plan.name}`}
            defaultStartDate={toDateInputValue(tomorrowStart, timeZone)}
            planDurationDays={totalDays}
          />
        </CardContent>
      </Card>

      {/* ---- Destructive actions, last and visually separated ---- */}
      <ClientDangerZone clientId={client.id} companyName={client.companyName} />
    </>
  );
}

/** YYYY-MM-DD of an instant in the app timezone, for a date input. */
function toDateInputValue(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
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
