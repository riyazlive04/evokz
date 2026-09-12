import React from 'react';
import { Sparkles } from 'lucide-react';

import { PageHeader } from '@/components/admin/PageHeader';
import { PosterStudioWorkspace } from '@/components/studio/poster-studio-workspace';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export default async function PosterStudioPage() {
  let clients: Array<{ id: string; companyName: string }> = [];
  let history: any[] = [];

  try {
    clients = await prisma.client.findMany({
      where: { isActive: true },
      select: { id: true, companyName: true },
      orderBy: { companyName: 'asc' },
    });

    history = await prisma.posterStudioGeneration.findMany({
      orderBy: { createdAt: 'desc' },
      take: 24,
    });
  } catch (error) {
    console.warn('[poster-studio-page] Database query fallback:', error);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Sparkles}
        eyebrow="AI Studio"
        title="AI Poster Studio"
        description="Design studio-grade marketing posters, reference-guided layouts, and natural language edits."
      />
      <PosterStudioWorkspace initialClients={clients} initialHistory={history} />
    </div>
  );
}
