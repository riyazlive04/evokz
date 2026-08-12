import { DeliveryStatus } from '@prisma/client';
import Link from 'next/link';

import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Clock,
  FolderOpen,
  MonitorPlay,
  Palette,
  Zap,
} from 'lucide-react';

import { ClientControls } from '@/components/admin/ClientControls';
import { ClientDangerZone } from '@/components/admin/ClientDangerZone';
import { DemoCreativePanel } from '@/components/admin/DemoCreativePanel';
import {
  BrandIdentityCard,
  DemoSetupProgress,
  identityFields,
} from '@/components/admin/DemoSetupPanel';
import { CreateClientDialog } from '@/components/admin/CreateClientDialog';
import { PageHeader } from '@/components/admin/PageHeader';
import { QueueLedger } from '@/components/admin/QueueLedger';
import { SeedCalendarButton } from '@/components/admin/SeedCalendarButton';
import { StatTile } from '@/components/admin/StatTile';
import { DatabaseErrorState } from '@/components/admin/SystemNotices';
import BrandCanvasView from '@/components/brand/BrandCanvasView';
import { BrandTokenizerPanel } from '@/components/brand/BrandTokenizerPanel';
import { ManualBrandPanel } from '@/components/brand/ManualBrandPanel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { describeError } from '@/lib/ai-pipeline';
import { prisma } from '@/lib/prisma';
import { queueSelect, toQueueEntry } from '@/lib/queue-entry';
import { formatDisplayDate, getAppTimeZone } from '@/lib/time';
import { parseBrandGuideline } from '@/lib/types/brand';

/**
 * Demo workspace — a client detail page for throwaway tenants, plus an instant
 * creative panel that renders, stores on Drive, and WhatsApps on the spot
 * instead of waiting for the tenant's cron minute.
 *
 * Demo tenants are ordinary `Client` rows flagged `isDemo`, so every action and
 * component here is the same one the Clients section uses.
 */
export const dynamic = 'force-dynamic';

const ENTRY_LIMIT = 24;

export default async function AdminDemoPage({
  searchParams,
}: {
  searchParams: { tenant?: string | string[] };
}) {
  const timeZone = getAppTimeZone();
  const requested = Array.isArray(searchParams.tenant)
    ? searchParams.tenant[0]
    : searchParams.tenant;

  let tenants: DemoTenant[];
  let planOptions: Array<{ id: string; name: string; durationDays: number }>;
  let categoryOptions: Array<{ id: string; name: string }>;
  try {
    [tenants, planOptions, categoryOptions] = await Promise.all([
      loadDemoTenants(),
      prisma.plan.findMany({
        orderBy: { durationDays: 'asc' },
        select: { id: true, name: true, durationDays: true },
      }),
      prisma.category.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    ]);
  } catch (error) {
    return <DatabaseErrorState message={describeError(error)} />;
  }

  const active = tenants.find((tenant) => tenant.id === requested) ?? tenants[0] ?? null;

  return (
    <>
      <PageHeader
        icon={MonitorPlay}
        eyebrow="Sales"
        title="Demo workspace"
        description="A throwaway tenant with every client capability, wired for live demos: generate a creative and it lands on WhatsApp immediately. Excluded from the dispatch sweep, so nothing here ever sends on its own."
      >
        <CreateClientDialog
          plans={planOptions}
          categories={categoryOptions}
          timeZone={timeZone}
          demo
        />
      </PageHeader>

      {tenants.length === 0 ? (
        <EmptyState blocked={planOptions.length === 0 || categoryOptions.length === 0} />
      ) : (
        <>
          {tenants.length > 1 && (
            <TenantSwitcher tenants={tenants} activeId={active?.id ?? null} />
          )}
          {active && <TenantWorkspace tenant={active} timeZone={timeZone} />}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

async function TenantWorkspace({
  tenant,
  timeZone,
}: {
  tenant: DemoTenant;
  timeZone: string;
}) {
  const [statusGroups, entryRecords] = await Promise.all([
    prisma.contentCalendar.groupBy({
      by: ['deliveryStatus'],
      where: { clientId: tenant.id },
      _count: { _all: true },
    }),
    prisma.contentCalendar.findMany({
      where: { clientId: tenant.id },
      // Newest first: on a demo the row you just fired is the one you want to see.
      orderBy: [{ scheduledDate: 'desc' }, { dayNumber: 'desc' }],
      take: ENTRY_LIMIT,
      select: queueSelect,
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

  const totalEntries = Object.values(statusCounts).reduce((sum, n) => sum + n, 0);

  // Only rows inside the plan's 1..N range count toward calendar coverage —
  // instant sends are appended past the end and must not hide the seed button.
  const seededDays = await prisma.contentCalendar.count({
    where: { clientId: tenant.id, dayNumber: { lte: tenant.totalDays } },
  });

  const brand = parseBrandGuideline(tenant.brandGuideline);
  const driveUrl = tenant.gDriveFolderId
    ? `https://drive.google.com/drive/folders/${tenant.gDriveFolderId}`
    : null;

  const identity = identityFields(tenant);
  const missingIdentity = identity.filter((field) => !field.value).map((f) => f.label);

  return (
    <>
      <DemoSetupProgress
        identityComplete={missingIdentity.length === 0}
        hasBrandTokens={brand.colors.length > 0}
        hasCalendar={totalEntries > 0}
      />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-warning/30 bg-warning/[0.07] p-4 text-xs text-warning-ink">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span className="font-medium">
          Sends from this section are real: Flux.1 is billed, the asset is written to Drive,
          and WhatsApp delivers to +{tenant.whatsappNumber} immediately.
        </span>
      </div>

      <BrandIdentityCard
        tenantId={tenant.id}
        companyName={tenant.companyName}
        fields={identity}
      />

      {/* ---- Tenant summary ---- */}
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          icon={CheckCircle2}
          label="Delivered"
          value={statusCounts[DeliveryStatus.DELIVERED]}
          hint={`${totalEntries} entries on this tenant`}
          tone="emerald"
        />
        <StatTile
          icon={Clock}
          label="Pending"
          value={statusCounts[DeliveryStatus.PENDING]}
          hint="Written, not yet rendered"
          tone="amber"
        />
        <StatTile
          icon={CalendarClock}
          label="Calendar days"
          value={`${seededDays}/${tenant.totalDays}`}
          hint={`${tenant.planName} · ${tenant.categoryName}`}
        />
        <StatTile
          icon={AlertTriangle}
          label="Failed"
          value={statusCounts[DeliveryStatus.FAILED]}
          hint="Inspect the card for the stage"
          tone={statusCounts[DeliveryStatus.FAILED] > 0 ? 'red' : 'slate'}
        />
      </section>

      {/* ---- Instant creative: the demo headline act ---- */}
      <Card className="border-brand-to/30">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-brand-to" />
            Instant creative
          </CardTitle>
          <CardDescription>
            Write the post yourself, then render → Drive → WhatsApp in one action. The row is
            appended after day {tenant.totalDays}, so it never disturbs the seeded calendar.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DemoCreativePanel
            clientId={tenant.id}
            companyName={tenant.companyName}
            whatsappNumber={tenant.whatsappNumber}
            hasDriveFolder={Boolean(tenant.gDriveFolderId)}
            missingIdentity={missingIdentity}
          />
        </CardContent>
      </Card>

      {/* ---- Tenant record + operations ---- */}
      <section className="grid gap-6 xl:grid-cols-[1fr_1.1fr]">
        <Card>
          <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
            <div className="space-y-1">
              <CardTitle className="flex flex-wrap items-center gap-3">
                {tenant.companyName}
                <Badge variant={tenant.isActive ? 'emerald' : 'slate'}>
                  {tenant.isActive ? 'Live' : 'Paused'}
                </Badge>
                <Badge variant="amber">Demo</Badge>
              </CardTitle>
              <CardDescription>
                Same shape as a paying tenant — plan, vertical, campaign window, Drive vault.
              </CardDescription>
            </div>
            {driveUrl && (
              <Button asChild variant="outline" size="sm">
                <a href={driveUrl} target="_blank" rel="noreferrer noopener">
                  <FolderOpen className="h-4 w-4" />
                  Drive vault
                </a>
              </Button>
            )}
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
              <Fact label="WhatsApp">
                <span className="font-mono">+{tenant.whatsappNumber}</span>
              </Fact>
              <Fact label="Plan">
                {tenant.planName}{' '}
                <span className="text-muted-foreground">({tenant.totalDays} days)</span>
              </Fact>
              <Fact label="Vertical">{tenant.categoryName}</Fact>
              <Fact label="Delivery minute">
                <span className="font-mono">{tenant.cronTime}</span>{' '}
                <span className="text-muted-foreground">(cron skips demos)</span>
              </Fact>
              <Fact label="Campaign start">
                <span className="font-mono">
                  {formatDisplayDate(tenant.startDate, timeZone)}
                </span>
              </Fact>
              <Fact label="Campaign end">
                <span className="font-mono">{formatDisplayDate(tenant.endDate, timeZone)}</span>
              </Fact>
              <Fact label="Drive folder">
                {tenant.gDriveFolderId ? (
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {tenant.gDriveFolderId}
                  </span>
                ) : (
                  <span className="text-danger-ink">Not provisioned</span>
                )}
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
              Every client control, unchanged. “Generate N days” writes AI copy for the
              calendar; each card can then be sent on demand.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <ClientControls
              clientId={tenant.id}
              companyName={tenant.companyName}
              cronTime={tenant.cronTime}
              isActive={tenant.isActive}
              hasDriveFolder={Boolean(tenant.gDriveFolderId)}
              timeZone={timeZone}
              monthlyBudgetInr={tenant.monthlyBudgetInr}
              imageSizePreset={tenant.imageSizePreset}
            />

            {seededDays < tenant.totalDays && (
              <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
                <SeedCalendarButton
                  clientId={tenant.id}
                  companyName={tenant.companyName}
                  calendarCount={seededDays}
                  totalDays={tenant.totalDays}
                  hasBrandTokens={brand.colors.length > 0}
                />
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      {/* ---- Brand tokens, inline: a demo runs off one page ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Palette className="h-4 w-4 text-brand-to" />
            Brand canvas
          </CardTitle>
          <CardDescription>
            Paste the prospect&apos;s website copy below and extract tokens live — the palette
            then steers every calendar day and image prompt.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <BrandCanvasView
            clientData={{
              id: tenant.id,
              companyName: tenant.companyName,
              brandGuideline: tenant.brandGuideline,
              categoryName: tenant.categoryName,
              gDriveFolderId: tenant.gDriveFolderId,
            }}
          />
          <BrandTokenizerPanel
            clientId={tenant.id}
            companyName={tenant.companyName}
            hasTokens={brand.colors.length > 0}
          />
          <ManualBrandPanel
            clientId={tenant.id}
            companyName={tenant.companyName}
            guideline={brand}
          />
        </CardContent>
      </Card>

      {/* ---- Entries ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-brand-to" />
            Demo entries
          </CardTitle>
          <CardDescription>
            Most recent {Math.min(ENTRY_LIMIT, totalEntries)} of {totalEntries}, newest first.
            Send now, regenerate, or drop a failed row.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <QueueLedger
            entries={entryRecords.map((entry) => toQueueEntry(entry, timeZone))}
            emptyMessage="Nothing generated yet. Use “Instant creative” above for a one-off, or “Generate N days” to write a full calendar."
          />
        </CardContent>
      </Card>

      {/* ---- Destructive actions, last and visually separated ----
          Demo tenants are the ones most likely to be thrown away, so this
          matters more here than on a paying client — and demo tenants are not
          listed in the client matrix, so this page is their only route to it. */}
      <ClientDangerZone
        clientId={tenant.id}
        companyName={tenant.companyName}
        kind="demo tenant"
        returnTo="/admin/demo"
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

// ---------------------------------------------------------------------------
// Tenant selection
// ---------------------------------------------------------------------------

function TenantSwitcher({
  tenants,
  activeId,
}: {
  tenants: DemoTenant[];
  activeId: string | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        Tenant
      </span>
      {tenants.map((tenant) => {
        const active = tenant.id === activeId;
        return (
          <Link
            key={tenant.id}
            href={`/admin/demo?tenant=${tenant.id}`}
            aria-current={active ? 'true' : undefined}
            className={
              active
                ? 'rounded-full border border-brand-to/50 bg-brand-to/10 px-3 py-1 text-xs font-medium text-foreground'
                : 'rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition-colors duration-200 hover:border-brand-to/40 hover:text-foreground'
            }
          >
            {tenant.companyName}
          </Link>
        );
      })}
    </div>
  );
}

function EmptyState({ blocked }: { blocked: boolean }) {
  return (
    <Card className="border-dashed">
      <CardContent className="space-y-2 py-12 text-center">
        <MonitorPlay className="mx-auto h-8 w-8 text-muted-foreground/50" />
        <p className="text-sm font-medium text-foreground">No demo tenant yet</p>
        <p className="mx-auto max-w-md text-xs text-muted-foreground">
          {blocked
            ? 'Create at least one plan and one vertical first — a demo tenant is provisioned from the same inputs as a client.'
            : 'Create one with “New demo tenant” above. Use your own WhatsApp number the first time: every send from this section is real.'}
        </p>
      </CardContent>
    </Card>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <dt className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        {label}
      </dt>
      <dd className="truncate text-sm text-foreground">{children}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

interface DemoTenant {
  id: string;
  companyName: string;
  whatsappNumber: string;
  cronTime: string;
  startDate: Date;
  endDate: Date;
  isActive: boolean;
  monthlyBudgetInr: number | null;
  imageSizePreset: string | null;
  gDriveFolderId: string | null;
  brandGuideline: unknown;
  // Poster identity. Real columns on Client, not part of brandGuideline — the
  // tokenizer rewrites that JSON wholesale and an uploaded logo must survive it.
  logoUrl: string | null;
  websiteUrl: string | null;
  displayPhone: string | null;
  brandTagline: string | null;
  planName: string;
  totalDays: number;
  categoryName: string;
}

async function loadDemoTenants(): Promise<DemoTenant[]> {
  const records = await prisma.client.findMany({
    where: { isDemo: true },
    orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      companyName: true,
      whatsappNumber: true,
      cronTime: true,
      startDate: true,
      endDate: true,
      isActive: true,
      monthlyBudgetInr: true,
      imageSizePreset: true,
      gDriveFolderId: true,
      brandGuideline: true,
      logoUrl: true,
      websiteUrl: true,
      displayPhone: true,
      brandTagline: true,
      plan: { select: { name: true, durationDays: true } },
      category: { select: { name: true } },
    },
  });

  return records.map((record) => ({
    id: record.id,
    companyName: record.companyName,
    whatsappNumber: record.whatsappNumber,
    cronTime: record.cronTime,
    startDate: record.startDate,
    endDate: record.endDate,
    isActive: record.isActive,
    monthlyBudgetInr: record.monthlyBudgetInr,
    imageSizePreset: record.imageSizePreset,
    gDriveFolderId: record.gDriveFolderId,
    brandGuideline: record.brandGuideline,
    logoUrl: record.logoUrl,
    websiteUrl: record.websiteUrl,
    displayPhone: record.displayPhone,
    brandTagline: record.brandTagline,
    planName: record.plan.name,
    totalDays: record.plan.durationDays,
    categoryName: record.category.name,
  }));
}
