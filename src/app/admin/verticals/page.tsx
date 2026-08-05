import { Database } from 'lucide-react';

import { CategoryManager, type CategoryRow } from '@/components/admin/CategoryManager';
import { PageHeader } from '@/components/admin/PageHeader';
import { DatabaseErrorState } from '@/components/admin/SystemNotices';
import { Card, CardContent } from '@/components/ui/card';
import { describeError } from '@/lib/ai-pipeline';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export default async function AdminVerticalsPage() {
  let categories: CategoryRow[];
  try {
    categories = await loadCategories();
  } catch (error) {
    return <DatabaseErrorState message={describeError(error)} />;
  }

  return (
    <>
      <PageHeader
        icon={Database}
        eyebrow="Configuration"
        title="Vertical target ingestion"
        description="Niche industries used to steer creative direction. Each client is bound to exactly one vertical, which feeds the image prompt and copy stages. Open one to manage its reference templates."
      />

      <Card className="max-w-3xl">
        <CardContent className="pt-6">
          <CategoryManager categories={categories} />
        </CardContent>
      </Card>
    </>
  );
}

async function loadCategories(): Promise<CategoryRow[]> {
  const records = await prisma.category.findMany({
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      _count: { select: { clients: true, templates: true } },
    },
  });

  return records.map((category) => ({
    id: category.id,
    name: category.name,
    clientCount: category._count.clients,
    templateCount: category._count.templates,
  }));
}
