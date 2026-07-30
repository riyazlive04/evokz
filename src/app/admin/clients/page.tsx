import { DeliveryStatus } from '@prisma/client';
import { Users } from 'lucide-react';

import { ClientMatrix, type ClientRow } from '@/components/admin/ClientMatrix';
import { CreateClientDialog } from '@/components/admin/CreateClientDialog';
import { PageHeader } from '@/components/admin/PageHeader';
import { DatabaseErrorState } from '@/components/admin/SystemNotices';
import { Card, CardContent } from '@/components/ui/card';
import { describeError } from '@/lib/ai-pipeline';
import { prisma } from '@/lib/prisma';
import { formatDisplayDate, getAppTimeZone } from '@/lib/time';

export const dynamic = 'force-dynamic';

export default async function AdminClientsPage() {
  const timeZone = getAppTimeZone();

  let data: ClientsData;
  try {
    data = await loadClients(timeZone);
  } catch (error) {
    return <DatabaseErrorState message={describeError(error)} />;
  }

  return (
    <>
      <PageHeader
        icon={Users}
        eyebrow="Tenants"
        title="Client matrix"
        description="Every tenant, its campaign window, and its per-client dispatch minute. Delivery times are editable inline; select a company to open its detail view."
      >
        <CreateClientDialog plans={data.planOptions} categories={data.categoryOptions} />
      </PageHeader>

      <Card>
        <CardContent className="pt-6">
          <ClientMatrix clients={data.clients} timeZone={timeZone} />
        </CardContent>
      </Card>
    </>
  );
}

interface ClientsData {
  clients: ClientRow[];
  planOptions: Array<{ id: string; name: string; durationDays: number }>;
  categoryOptions: Array<{ id: string; name: string }>;
}

async function loadClients(timeZone: string): Promise<ClientsData> {
  const [clientRecords, planRecords, categoryRecords, deliveredGroups, calendarGroups] =
    await Promise.all([
      prisma.client.findMany({
        // Demo tenants live in their own section; mixing them into the matrix
        // would put a prospect's throwaway record next to paying campaigns.
        where: { isDemo: false },
        orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
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
      prisma.plan.findMany({
        orderBy: { durationDays: 'asc' },
        select: { id: true, name: true, durationDays: true },
      }),
      prisma.category.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      }),
      prisma.contentCalendar.groupBy({
        by: ['clientId'],
        where: { deliveryStatus: DeliveryStatus.DELIVERED },
        _count: { _all: true },
      }),
      // Total seeded rows per client, any status — drives the "calendar not
      // written yet" prompt in the matrix.
      prisma.contentCalendar.groupBy({
        by: ['clientId'],
        _count: { _all: true },
      }),
    ]);

  const deliveredByClient = new Map(
    deliveredGroups.map((group) => [group.clientId, group._count._all]),
  );
  const calendarByClient = new Map(
    calendarGroups.map((group) => [group.clientId, group._count._all]),
  );

  return {
    clients: clientRecords.map(
      (client): ClientRow => ({
        id: client.id,
        companyName: client.companyName,
        whatsappNumber: client.whatsappNumber,
        planName: client.plan.name,
        categoryName: client.category.name,
        cronTime: client.cronTime,
        startDateLabel: formatDisplayDate(client.startDate, timeZone),
        endDateLabel: formatDisplayDate(client.endDate, timeZone),
        isActive: client.isActive,
        hasDriveFolder: Boolean(client.gDriveFolderId),
        deliveredCount: deliveredByClient.get(client.id) ?? 0,
        calendarCount: calendarByClient.get(client.id) ?? 0,
        totalDays: client.plan.durationDays,
      }),
    ),
    planOptions: planRecords,
    categoryOptions: categoryRecords,
  };
}
