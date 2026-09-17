import { CampaignDeliveryStatus, CampaignStatus, DeliveryStatus, type Prisma } from '@prisma/client';
import Link from 'next/link';

import {
  AlertTriangle,
  CalendarRange,
  CheckCircle2,
  Gauge,
  ShieldAlert,
  Users,
  X,
} from 'lucide-react';

import { ClientRoster, type ClientRosterRow } from '@/components/admin/ClientRoster';
import { PageHeader } from '@/components/admin/PageHeader';
import { SpendPanel } from '@/components/admin/SpendPanel';
import { StatTile } from '@/components/admin/StatTile';
import { ConfigWarning, DatabaseErrorState } from '@/components/admin/SystemNotices';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  loadCostReport,
  parseProvider,
  parseRange,
  type CostReport,
} from '@/lib/cost-report';
import { findUnsetIntegrationKeys } from '@/lib/env';
import { describeError } from '@/lib/errors';
import { prisma } from '@/lib/prisma';
import { formatDisplayDate, formatDisplayDateTime, getAppTimeZone } from '@/lib/time';

/** Live operational console — never cached. */
export const dynamic = 'force-dynamic';

/** Rows a drill-down lists at once. */
const DETAIL_LIMIT = 60;

/** Which counter the operator expanded, carried in `?view=`. */
const STAT_VIEWS = ['clients', 'failed'] as const;
type StatView = (typeof STAT_VIEWS)[number];

function parseView(raw: string | string[] | undefined): StatView | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return STAT_VIEWS.includes(value as StatView) ? (value as StatView) : null;
}

/** Spend-filter params, so toggling a counter does not reset the spend panel. */
function spendParams(search: DashboardSearchParams): URLSearchParams {
  const params = new URLSearchParams();
  const single = (raw: string | string[] | undefined) =>
    Array.isArray(raw) ? raw[0] : raw;

  const range = single(search.range);
  const client = single(search.spendClient);
  const provider = single(search.spendProvider);
  if (range) params.set('range', range);
  if (client) params.set('spendClient', client);
  if (provider) params.set('spendProvider', provider);
  return params;
}

function tileHref(
  view: StatView,
  activeView: StatView | null,
  search: DashboardSearchParams,
): string {
  const params = spendParams(search);
  if (activeView !== view) params.set('view', view);
  const query = params.toString();
  return query ? `/admin/dashboard?${query}` : '/admin/dashboard';
}

interface DashboardSearchParams {
  view?: string | string[];
  range?: string | string[];
  spendClient?: string | string[];
  spendProvider?: string | string[];
}

/**
 * A client's sends: campaign days whose delivery went out, plus the delivered
 * history of the retired daily poster maker (calendar rows with no campaign).
 * The two never overlap — a campaign day's delivery lives on `CampaignDelivery`,
 * never on `ContentCalendar.deliveryStatus`.
 */
const SENT_CALENDAR_ROW: Prisma.ContentCalendarWhereInput = {
  OR: [
    { delivery: { is: { status: CampaignDeliveryStatus.SENT } } },
    { campaignId: null, deliveryStatus: DeliveryStatus.DELIVERED },
  ],
};

export default async function AdminDashboardPage({
  searchParams,
}: {
  searchParams: DashboardSearchParams;
}) {
  const timeZone = getAppTimeZone();
  const now = new Date();
  const view = parseView(searchParams.view);

  const spendClient = Array.isArray(searchParams.spendClient)
    ? searchParams.spendClient[0]
    : searchParams.spendClient;

  let data: DashboardData;
  let detail: DetailData | null = null;
  let costReport: CostReport;
  try {
    [data, costReport] = await Promise.all([
      loadDashboardData(),
      loadCostReport(
        {
          range: parseRange(searchParams.range),
          clientId: spendClient ?? null,
          provider: parseProvider(searchParams.spendProvider),
        },
        now,
      ),
    ]);
    if (view) {
      detail = await loadDetail({ view, timeZone });
    }
  } catch (error) {
    return <DatabaseErrorState message={describeError(error)} />;
  }

  return (
    <>
      <PageHeader
        icon={Gauge}
        eyebrow="Operations"
        title="Overview"
        description={`Snapshot taken ${formatDisplayDateTime(now, timeZone)}. Counters cover every client — select one to break it down. Posters are generated, approved and sent from each campaign's board.`}
      >
        <Button asChild variant="outline" size="sm">
          <Link href="/admin/clients">
            <Users className="h-4 w-4" />
            Manage clients
          </Link>
        </Button>
      </PageHeader>

      <ConfigWarning missing={findUnsetIntegrationKeys()} />

      {/* ---- Operational counters ---- */}
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          icon={Users}
          label="Active clients"
          value={data.activeClients}
          hint={`${data.totalClients} total onboarded`}
          href={tileHref('clients', view, searchParams)}
          active={view === 'clients'}
        />
        <StatTile
          icon={CalendarRange}
          label="Active campaigns"
          value={data.activeCampaigns}
          hint={`${data.scheduledDeliveries} poster${data.scheduledDeliveries === 1 ? '' : 's'} booked to send`}
          tone="amber"
        />
        <StatTile
          icon={CheckCircle2}
          label="Sent"
          value={data.sentDeliveries}
          hint="Posters delivered to WhatsApp, including days from before campaigns"
          tone="emerald"
        />
        <StatTile
          icon={AlertTriangle}
          label="Failed deliveries"
          value={data.failedDeliveries}
          hint="Retry or cancel them from the campaign board"
          tone={data.failedDeliveries > 0 ? 'red' : 'slate'}
          href={tileHref('failed', view, searchParams)}
          active={view === 'failed'}
        />
      </section>

      {/* ---- Drill-down for the selected counter ---- */}
      {detail && <DetailPanel detail={detail} />}

      {/* ---- Cost & credit consumption ---- */}
      <SpendPanel report={costReport} viewParam={view} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Drill-down panel
// ---------------------------------------------------------------------------

function DetailPanel({ detail }: { detail: DetailData }) {
  const truncated = detail.total > detail.shown;

  return (
    <Card className="border-brand-to/30">
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2">
            <detail.icon className="h-4 w-4 text-brand-to" />
            {detail.title}
          </CardTitle>
          <CardDescription>
            {detail.description}
            {truncated && ` Showing the first ${detail.shown} of ${detail.total}.`}
          </CardDescription>
        </div>
        <Button asChild variant="ghost" size="sm">
          <Link href="/admin/dashboard" scroll={false}>
            <X className="h-4 w-4" />
            Close
          </Link>
        </Button>
      </CardHeader>
      <CardContent>
        {detail.kind === 'clients' ? (
          <ClientRoster clients={detail.clients} />
        ) : (
          <FailedDeliveryTable rows={detail.rows} />
        )}
      </CardContent>
    </Card>
  );
}

function FailedDeliveryTable({ rows }: { rows: FailedDeliveryRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border bg-muted/60 px-4 py-10 text-center text-xs text-muted-foreground">
        No failed deliveries. Every booked campaign poster that was due went out.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Client</TableHead>
            <TableHead>Campaign</TableHead>
            <TableHead className="w-28">Day</TableHead>
            <TableHead>Reason</TableHead>
            <TableHead className="w-40 text-right">Last attempt</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="text-xs text-foreground">{row.companyName}</TableCell>
              <TableCell>
                <Link
                  href={row.boardHref}
                  className="text-xs font-medium text-foreground underline-offset-4 decoration-primary/40 transition-colors duration-200 hover:underline hover:decoration-primary"
                >
                  {row.campaignName}
                </Link>
              </TableCell>
              <TableCell className="whitespace-nowrap font-mono text-[11px] text-muted-foreground">
                Day {row.dayNumber} · {row.dateLabel}
              </TableCell>
              <TableCell className="max-w-md text-[11px] text-danger-ink">
                {row.failureReason ?? 'No reason recorded'}
              </TableCell>
              <TableCell className="whitespace-nowrap text-right font-mono text-[11px] text-muted-foreground">
                {row.lastAttemptLabel ?? '—'}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

interface DashboardData {
  activeClients: number;
  totalClients: number;
  activeCampaigns: number;
  scheduledDeliveries: number;
  sentDeliveries: number;
  failedDeliveries: number;
}

interface DetailShell {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  /** Rows rendered; compared against `total` to flag a truncated panel. */
  shown: number;
  total: number;
}

interface FailedDeliveryRow {
  id: string;
  companyName: string;
  campaignName: string;
  boardHref: string;
  dayNumber: number;
  dateLabel: string;
  failureReason: string | null;
  lastAttemptLabel: string | null;
}

type DetailData =
  | (DetailShell & { kind: 'clients'; clients: ClientRosterRow[] })
  | (DetailShell & { kind: 'failed'; rows: FailedDeliveryRow[] });

async function loadDashboardData(): Promise<DashboardData> {
  const [
    totalClients,
    activeClients,
    activeCampaigns,
    scheduledDeliveries,
    sentDeliveries,
    failedDeliveries,
  ] = await Promise.all([
    prisma.client.count(),
    prisma.client.count({ where: { isActive: true } }),
    prisma.campaign.count({ where: { status: CampaignStatus.ACTIVE } }),
    prisma.campaignDelivery.count({ where: { status: CampaignDeliveryStatus.SCHEDULED } }),
    // Same definition as the roster, client list and cost report, so totals agree.
    prisma.contentCalendar.count({ where: SENT_CALENDAR_ROW }),
    prisma.campaignDelivery.count({ where: { status: CampaignDeliveryStatus.FAILED } }),
  ]);

  return {
    activeClients,
    totalClients,
    activeCampaigns,
    scheduledDeliveries,
    sentDeliveries,
    failedDeliveries,
  };
}

/**
 * Loads the rows behind one counter.
 *
 * Only runs when a tile is expanded, so the default dashboard keeps its
 * original query cost.
 */
async function loadDetail({
  view,
  timeZone,
}: {
  view: StatView;
  timeZone: string;
}): Promise<DetailData> {
  if (view === 'clients') {
    const [clientRecords, sentGroups] = await Promise.all([
      prisma.client.findMany({
        orderBy: [{ isActive: 'desc' }, { companyName: 'asc' }],
        select: {
          id: true,
          companyName: true,
          whatsappNumber: true,
          cronTime: true,
          startDate: true,
          endDate: true,
          isActive: true,
          gDriveFolderId: true,
          plan: { select: { name: true, durationDays: true } },
          category: { select: { name: true } },
        },
      }),
      prisma.contentCalendar.groupBy({
        by: ['clientId'],
        where: SENT_CALENDAR_ROW,
        _count: { _all: true },
      }),
    ]);

    const sentByClient = new Map(
      sentGroups.map((group) => [group.clientId, group._count._all]),
    );

    const clients = clientRecords.map(
      (client): ClientRosterRow => ({
        id: client.id,
        companyName: client.companyName,
        whatsappNumber: client.whatsappNumber,
        planName: client.plan.name,
        categoryName: client.category.name,
        cronTime: client.cronTime,
        windowLabel: `${formatDisplayDate(client.startDate, timeZone)} → ${formatDisplayDate(
          client.endDate,
          timeZone,
        )}`,
        isActive: client.isActive,
        hasDriveFolder: Boolean(client.gDriveFolderId),
        deliveredCount: sentByClient.get(client.id) ?? 0,
        totalDays: client.plan.durationDays,
      }),
    );

    return {
      kind: 'clients',
      icon: Users,
      title: 'Client roster',
      description: 'Every client, live first. Paused clients still count toward the onboarded total.',
      clients,
      shown: clients.length,
      total: clients.length,
    };
  }

  const where = { status: CampaignDeliveryStatus.FAILED };
  const [records, total] = await Promise.all([
    prisma.campaignDelivery.findMany({
      where,
      orderBy: [{ lastAttemptAt: 'desc' }, { scheduledFor: 'desc' }],
      take: DETAIL_LIMIT,
      select: {
        id: true,
        failureReason: true,
        lastAttemptAt: true,
        campaign: {
          select: { id: true, name: true, clientId: true, client: { select: { companyName: true } } },
        },
        calendarDay: { select: { dayNumber: true, scheduledDate: true } },
      },
    }),
    prisma.campaignDelivery.count({ where }),
  ]);

  const rows = records.map(
    (record): FailedDeliveryRow => ({
      id: record.id,
      companyName: record.campaign.client.companyName,
      campaignName: record.campaign.name,
      boardHref: `/admin/clients/${record.campaign.clientId}/campaigns/${record.campaign.id}?status=failed`,
      dayNumber: record.calendarDay.dayNumber,
      dateLabel: formatDisplayDate(record.calendarDay.scheduledDate, timeZone),
      failureReason: record.failureReason,
      lastAttemptLabel: record.lastAttemptAt
        ? formatDisplayDateTime(record.lastAttemptAt, timeZone)
        : null,
    }),
  );

  return {
    kind: 'failed',
    icon: ShieldAlert,
    title: 'Failed deliveries',
    description:
      'Campaign posters whose WhatsApp send failed, most recent first. Open the campaign to retry or cancel each one.',
    rows,
    shown: rows.length,
    total,
  };
}
