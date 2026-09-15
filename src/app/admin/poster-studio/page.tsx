import React from 'react';
import { Sparkles } from 'lucide-react';

import { PageHeader } from '@/components/admin/PageHeader';
import { PosterStudioWorkspace } from '@/components/studio/poster-studio-workspace';
import { getStudioImageQuality, STUDIO_IMAGE_MODEL } from '@/lib/ai/openai-images';
import {
  loadStudioHistory,
  toStudioDatabaseError,
  type StudioHistoryItem,
} from '@/lib/poster-studio/history';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export default async function PosterStudioPage() {
  // Settled separately so a missing studio table still leaves the client list
  // usable, and either failure is shown rather than rendered as an empty state.
  const [clientsResult, historyResult] = await Promise.allSettled([
    prisma.client.findMany({
      where: { isActive: true },
      select: { id: true, companyName: true },
      orderBy: { companyName: 'asc' },
    }),
    loadStudioHistory(),
  ]);

  const loadErrors: string[] = [];

  const clients = clientsResult.status === 'fulfilled' ? clientsResult.value : [];
  if (clientsResult.status === 'rejected') {
    const failure = toStudioDatabaseError(clientsResult.reason, 'Loading clients');
    console.error('[poster-studio-page]', failure.message, clientsResult.reason);
    loadErrors.push(failure.message);
  }

  const history: StudioHistoryItem[] = historyResult.status === 'fulfilled' ? historyResult.value : [];
  if (historyResult.status === 'rejected') {
    const failure = toStudioDatabaseError(historyResult.reason, 'Loading history');
    console.error('[poster-studio-page]', failure.message, historyResult.reason);
    loadErrors.push(failure.message);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Sparkles}
        eyebrow="AI Studio"
        title="AI Poster Studio"
        description="Generate marketing posters, guide them with a reference image, and make targeted edits or variations of existing designs."
      />
      <PosterStudioWorkspace
        clients={clients}
        initialHistory={history}
        loadErrors={loadErrors}
        model={STUDIO_IMAGE_MODEL}
        quality={getStudioImageQuality()}
      />
    </div>
  );
}
