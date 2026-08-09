import { DeliveryStatus } from '@prisma/client';
import Link from 'next/link';

import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Gauge,
  ShieldAlert,
  Users,
  X,
} from 'lucide-react';

import { ClientRoster, type ClientRosterRow } from '@/components/admin/ClientRoster';
import { ImageKeyPanel } from '@/components/admin/ImageKeyPanel';
import { PageHeader } from '@/components/admin/PageHeader';
import { QueueLedger, type QueueEntry } from '@/components/admin/QueueLedger';
import { RetryFailedButton } from '@/components/admin/RetryFailedButton';
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
import { SpendPanel } from '@/components/admin/SpendPanel';
import { describeError, getFalEndpoint } from '@/lib/ai-pipeline';
import {
  loadCostReport,
  parseProvider,
  parseRange,
  type CostReport,
} from '@/lib/cost-report';
import { findUnsetIntegrationKeys } from '@/lib/env';
import { loadFalKeyStatus, type FalKeyStatus } from '@/lib/fal-credentials';
import { prisma } from '@/lib/prisma';
import { queueSelect, toQueueEntry } from '@/lib/queue-entry';
import {
  formatDisplayDate,
  formatDisplayDateTime,
  getAppTimeZone,
  zonedDayRange,
} from '@/lib/time';

/** Live operational console — never cached. */
export const dynamic = 'force-dynamic';

const UPCOMING_LIMIT = 24;
const FAILURE_LIMIT = 8;
/** Drill-down panels page in more rows than the always-on feeds above them. */
const DETAIL_LIMIT = 60;

/** Which counter the operator expanded, carried in `?view=`. */
const STAT_VIEWS = ['clients', 'today', 'delivered', 'failed'] as const;
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

export default async function AdminDashboardPage({
  searchParams,
}: {
  searchParams: DashboardSearchParams;
}) {
  const timeZone = getAppTimeZone();
  const now = new Date();
  const { start: todayStart, end: todayEnd } = zonedDayRange(now, timeZone);
  const view = parseView(searchParams.view);

  const spendClient = Array.isArray(searchParams.spendClient)
    ? searchParams.spendClient[0]
    : searchParams.spendClient;

  let data: DashboardData;
  let detail: DetailData | null = null;
  let costReport: CostReport;
  let falKeyStatus: FalKeyStatus;
  try {
    [data, costReport, falKeyStatus] = await Promise.all([
      loadDashboardData({ todayStart, todayEnd, timeZone }),
      loadCostReport(
        {
          range: parseRange(searchParams.range),
          clientId: spendClient ?? null,
          provider: parseProvider(searchParams.spendProvider),
        },
        now,
      ),
      loadFalKeyStatus(),
    ]);
    if (view) {
      detail = await loadDetail({ view, todayStart, todayEnd, timeZone });
    }
  } catch (error) {
    return <DatabaseErrorState message={describeError(error)} />;
  }

  return (
    <>
      <PageHeader
        icon={Gauge}
        eyebrow="Operations"
        title="Dispatch overview"
        description={`Snapshot taken ${formatDisplayDateTime(now, timeZone)}. Counters cover every tenant — select one to break it down; the queue feed previews the next scheduled sends.`}
      >
        <Button asChild variant="outline" size="sm">
          <Link href="/admin/clients">
            <Users className="h-4 w-4" />
            Manage clients
          </Link>
        </Button>
      </PageHeader>

      {/* An operator key supersedes FAL_KEY entirely, so listing it as unset
          would be a permanent false alarm on a correctly configured box. */}
      <ConfigWarning
        missing={findUnsetIntegrationKeys(falKeyStatus.configured ? ['FAL_KEY'] : [])}
      />

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
          icon={CalendarClock}
          label="Due today"
          value={data.pendingToday}
          hint="PENDING entries scheduled today"
          tone="amber"
          href={tileHref('today', view, searchParams)}
          active={view === 'today'}
        />
        <StatTile
          icon={CheckCircle2}
          label="Delivered"
          value={data.statusCounts[DeliveryStatus.DELIVERED]}
          hint="All-time WhatsApp sends"
          tone="emerald"
          href={tileHref('delivered', view, searchParams)}
          active={view === 'delivered'}
        />
        <StatTile
          icon={AlertTriangle}
          label="Failed"
          value={data.statusCounts[DeliveryStatus.FAILED]}
          hint="Awaiting manual intervention"
          tone={data.statusCounts[DeliveryStatus.FAILED] > 0 ? 'red' : 'slate'}
          href={tileHref('failed', view, searchParams)}
          active={view === 'failed'}
        />
      </section>

      {/* ---- Drill-down for the selected counter ---- */}
      {detail && <DetailPanel detail={detail} />}

      {/* ---- Cost & credit consumption ---- */}
      <SpendPanel report={costReport} viewParam={view} />

      {/* ---- Failures first: they need a human ---- */}
      {/* Suppressed while the failed drill-down is open — same rows, twice. */}
      {view !== 'failed' && data.failures.length > 0 && (
        <Card className="border-danger/25">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-danger-ink">
              <ShieldAlert className="h-4 w-4" />
              Failed deliveries
            </CardTitle>
            <CardDescription>
              Most recent {data.failures.length} failure
              {data.failures.length === 1 ? '' : 's'}. Re-send reuses the stored Drive asset
              when one exists; delete drops an entry you do not intend to chase.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <RetryFailedButton
              failedCount={data.statusCounts[DeliveryStatus.FAILED]}
            />
            <QueueLedger entries={data.failures} />
          </CardContent>
        </Card>
      )}

      {/* ---- Upcoming queue ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-brand-to" />
            Event queue feed
          </CardTitle>
          <CardDescription>
            Next {UPCOMING_LIMIT} scheduled entries across all clients, previewed from their
            Google Drive assets.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <QueueLedger entries={data.upcoming} />
        </CardContent>
      </Card>

      {/* ---- Image generation key ---- */}
      <ImageKeyPanel status={falKeyStatus} endpoint={getFalEndpoint()} />
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
          <QueueLedger entries={detail.entries} emptyMessage={detail.emptyMessage} />
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

interface DashboardData {
  upcoming: QueueEntry[];
  failures: QueueEntry[];
  statusCounts: Record<DeliveryStatus, number>;
  activeClients: number;
  totalClients: number;
  pendingToday: number;
}

interface DetailShell {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  /** Rows rendered; compared against `total` to flag a truncated panel. */
  shown: number;
  total: number;
}

type DetailData =
  | (DetailShell & { kind: 'clients'; clients: ClientRosterRow[] })
  | (DetailShell & { kind: 'queue'; entries: QueueEntry[]; emptyMessage: string });

async function loadDashboardData({
  todayStart,
  todayEnd,
  timeZone,
}: {
  todayStart: Date;
  todayEnd: Date;
  timeZone: string;
}): Promise<DashboardData> {
  const [
    totalClients,
    activeClients,
    upcomingRecords,
    failureRecords,
    statusGroups,
    pendingToday,
  ] = await Promise.all([
    prisma.client.count(),
    prisma.client.count({ where: { isActive: true } }),
    prisma.contentCalendar.findMany({
      where: {
        scheduledDate: { gte: todayStart },
        deliveryStatus: { not: DeliveryStatus.FAILED },
      },
      orderBy: [{ scheduledDate: 'asc' }, { dayNumber: 'asc' }],
      take: UPCOMING_LIMIT,
      select: queueSelect,
    }),
    prisma.contentCalendar.findMany({
      where: { deliveryStatus: DeliveryStatus.FAILED },
      orderBy: { updatedAt: 'desc' },
      take: FAILURE_LIMIT,
      select: queueSelect,
    }),
    prisma.contentCalendar.groupBy({
      by: ['deliveryStatus'],
      _count: { _all: true },
    }),
    prisma.contentCalendar.count({
      where: {
        scheduledDate: { gte: todayStart, lt: todayEnd },
        deliveryStatus: DeliveryStatus.PENDING,
      },
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

  return {
    upcoming: upcomingRecords.map((entry) => toQueueEntry(entry, timeZone)),
    failures: failureRecords.map((entry) => toQueueEntry(entry, timeZone)),
    statusCounts,
    activeClients,
    totalClients,
    pendingToday,
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
  todayStart,
  todayEnd,
  timeZone,
}: {
  view: StatView;
  todayStart: Date;
  todayEnd: Date;
  timeZone: string;
}): Promise<DetailData> {
  if (view === 'clients') {
    const [clientRecords, deliveredGroups] = await Promise.all([
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
        where: { deliveryStatus: DeliveryStatus.DELIVERED },
        _count: { _all: true },
      }),
    ]);

    const deliveredByClient = new Map(
      deliveredGroups.map((group) => [group.clientId, group._count._all]),
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
        deliveredCount: deliveredByClient.get(client.id) ?? 0,
        totalDays: client.plan.durationDays,
      }),
    );

    return {
      kind: 'clients',
      icon: Users,
      title: 'Client roster',
      description:
        'Every tenant, live first. Paused rows still count toward the onboarded total but are skipped by the dispatch sweep.',
      clients,
      shown: clients.length,
      total: clients.length,
    };
  }

  const where =
    view === 'today'
      ? {
          scheduledDate: { gte: todayStart, lt: todayEnd },
          deliveryStatus: DeliveryStatus.PENDING,
        }
      : {
          deliveryStatus:
            view === 'delivered' ? DeliveryStatus.DELIVERED : DeliveryStatus.FAILED,
        };

  const orderBy =
    view === 'today'
      ? ([{ scheduledDate: 'asc' }, { dayNumber: 'asc' }] as const)
      : ([{ updatedAt: 'desc' }] as const);

  const [records, total] = await Promise.all([
    prisma.contentCalendar.findMany({
      where,
      orderBy: [...orderBy],
      take: DETAIL_LIMIT,
      select: queueSelect,
    }),
    prisma.contentCalendar.count({ where }),
  ]);

  const entries = records.map((entry) => toQueueEntry(entry, timeZone));
  const shell = DETAIL_COPY[view];

  return {
    kind: 'queue',
    ...shell,
    entries,
    shown: entries.length,
    total,
  };
}

const DETAIL_COPY = {
  today: {
    icon: CalendarClock,
    title: 'Due today',
    description:
      'PENDING entries whose scheduled date falls today. Each fires at its client’s delivery minute — or immediately, via “Send now”.',
    emptyMessage: 'Nothing pending for today. Every entry scheduled today has already run.',
  },
  delivered: {
    icon: CheckCircle2,
    title: 'Delivered',
    description: 'Every creative that reached WhatsApp, most recent first.',
    emptyMessage: 'No deliveries yet. The first send will appear here.',
  },
  failed: {
    icon: ShieldAlert,
    title: 'Failed deliveries',
    description:
      'Entries the pipeline could not complete, most recent first. Re-send reuses the stored Drive asset when one exists; delete drops an entry you do not intend to chase.',
    emptyMessage: 'No failures. Every entry the pipeline touched went through.',
  },
} as const satisfies Record<
  Exclude<StatView, 'clients'>,
  {
    icon: React.ComponentType<{ className?: string }>;
    title: string;
    description: string;
    emptyMessage: string;
  }
>;
