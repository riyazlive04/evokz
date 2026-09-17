import { CampaignDeliveryStatus, DeliveryStatus } from '@prisma/client';
import { Users } from 'lucide-react';

import { ClientMatrix, type ClientRow } from '@/components/admin/ClientMatrix';
import { CreateClientDialog } from '@/components/admin/CreateClientDialog';
import { PageHeader } from '@/components/admin/PageHeader';
import { DatabaseErrorState } from '@/components/admin/SystemNotices';
import { Card, CardContent } from '@/components/ui/card';
import { describeError } from '@/lib/errors';
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
        description="Every client, its plan window and the delivery time its new campaigns start from. Delivery times are editable inline; select a company to open its detail view."
      >
        <CreateClientDialog
          plans={data.planOptions}
          categories={data.categoryOptions}
          timeZone={timeZone}
        />
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
  const [clientRecords, planRecords, categoryRecords, sentGroups] =
    await Promise.all([
      prisma.client.findMany({
        // Demo tenants are listed too, badged: the demo workspace that used to
        // hold them is retired, and this is now the only place to manage one.
        orderBy: [{ isDemo: 'asc' }, { isActive: 'desc' }, { createdAt: 'desc' }],
        select: {
          id: true,
          companyName: true,
          whatsappNumber: true,
          cronTime: true,
          startDate: true,
          endDate: true,
          isActive: true,
          gDriveFolderId: true,
          isDemo: true,
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
      // Sends per client: campaign days whose delivery went out, plus the
      // delivered history of the retired daily poster maker (rows with no
      // campaign). A campaign day never uses `deliveryStatus`, so no overlap.
      prisma.contentCalendar.groupBy({
        by: ['clientId'],
        where: {
          OR: [
            { delivery: { is: { status: CampaignDeliveryStatus.SENT } } },
            { campaignId: null, deliveryStatus: DeliveryStatus.DELIVERED },
          ],
        },
        _count: { _all: true },
      }),
    ]);

  const sentByClient = new Map(
    sentGroups.map((group) => [group.clientId, group._count._all]),
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
        isDemo: client.isDemo,
        deliveredCount: sentByClient.get(client.id) ?? 0,
        totalDays: client.plan.durationDays,
      }),
    ),
    planOptions: planRecords,
    categoryOptions: categoryRecords,
  };
}
