import { Layers } from 'lucide-react';

import { PageHeader } from '@/components/admin/PageHeader';
import { PlanManager, type PlanRow } from '@/components/admin/PlanManager';
import { DatabaseErrorState } from '@/components/admin/SystemNotices';
import { Card, CardContent } from '@/components/ui/card';
import { describeError } from '@/lib/ai-pipeline';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export default async function AdminPlansPage() {
  let plans: PlanRow[];
  try {
    plans = await loadPlans();
  } catch (error) {
    return <DatabaseErrorState message={describeError(error)} />;
  }

  return (
    <>
      <PageHeader
        icon={Layers}
        eyebrow="Configuration"
        title="Plan subscription manager"
        description="Campaign packages. Duration drives each client's end date at onboarding and caps how many ContentCalendar days can be seeded. The fee is the full-campaign price and feeds the margin column on the dashboard's spend panel — leave it blank and margin reads as unknown rather than zero."
      />

      <Card>
        <CardContent className="pt-6">
          <PlanManager plans={plans} />
        </CardContent>
      </Card>
    </>
  );
}

async function loadPlans(): Promise<PlanRow[]> {
  const records = await prisma.plan.findMany({
    orderBy: { durationDays: 'asc' },
    select: {
      id: true,
      name: true,
      durationDays: true,
      priceInr: true,
      _count: { select: { clients: true } },
    },
  });

  return records.map((plan) => ({
    id: plan.id,
    name: plan.name,
    durationDays: plan.durationDays,
    priceInr: plan.priceInr,
    clientCount: plan._count.clients,
  }));
}
