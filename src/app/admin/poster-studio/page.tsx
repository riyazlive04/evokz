import React from 'react';
import { prisma } from '@/lib/prisma';
import { PosterStudioWorkspace } from '@/components/studio/poster-studio-workspace';

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
    <main className="min-h-screen bg-slate-950">
      <PosterStudioWorkspace initialClients={clients} initialHistory={history} />
    </main>
  );
}
