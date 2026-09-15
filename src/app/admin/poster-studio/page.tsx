import React from 'react';
import { Sparkles } from 'lucide-react';

import { PageHeader } from '@/components/admin/PageHeader';
import { PosterStudioWorkspace } from '@/components/studio/poster-studio-workspace';
import { getStudioImageQuality, STUDIO_IMAGE_MODEL } from '@/lib/ai/openai-images';
import { loadCampaignDayStudioContext, type CampaignDayStudioContext } from '@/lib/campaign/poster-generation-service';
import {
  loadStudioHistory,
  studioHistorySelect,
  toStudioDatabaseError,
  toStudioHistoryItem,
  type StudioHistoryItem,
} from '@/lib/poster-studio/history';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function PosterStudioPage({
  searchParams,
}: {
  searchParams?: { campaignDay?: string | string[] };
}) {
  const campaignDayParam = typeof searchParams?.campaignDay === 'string' ? searchParams.campaignDay : null;

  // Settled separately so a missing studio table still leaves the client list
  // usable, and either failure is shown rather than rendered as an empty state.
  const [clientsResult, historyResult, campaignDayResult] = await Promise.allSettled([
    prisma.client.findMany({
      where: { isActive: true },
      select: { id: true, companyName: true },
      orderBy: { companyName: 'asc' },
    }),
    loadStudioHistory(),
    campaignDayParam && UUID_PATTERN.test(campaignDayParam)
      ? loadCampaignDayStudioContext(prisma, campaignDayParam)
      : Promise.resolve(null),
  ]);

  const loadErrors: string[] = [];

  let clients = clientsResult.status === 'fulfilled' ? clientsResult.value : [];
  if (clientsResult.status === 'rejected') {
    const failure = toStudioDatabaseError(clientsResult.reason, 'Loading clients');
    console.error('[poster-studio-page]', failure.message, clientsResult.reason);
    loadErrors.push(failure.message);
  }

  let history: StudioHistoryItem[] = historyResult.status === 'fulfilled' ? historyResult.value : [];
  if (historyResult.status === 'rejected') {
    const failure = toStudioDatabaseError(historyResult.reason, 'Loading history');
    console.error('[poster-studio-page]', failure.message, historyResult.reason);
    loadErrors.push(failure.message);
  }

  // ---- Opened from a campaign day ---------------------------------------------
  let campaignDay: CampaignDayStudioContext | null = null;
  if (campaignDayParam) {
    campaignDay = campaignDayResult.status === 'fulfilled' ? campaignDayResult.value : null;
    if (!campaignDay) {
      if (campaignDayResult.status === 'rejected') console.error('[poster-studio-page] campaign day', campaignDayResult.reason);
      loadErrors.push('That campaign day could not be found, so the studio opened on its own.');
    } else {
      // The campaign's client may be paused; it still has to be selectable here.
      if (!clients.some((client) => client.id === campaignDay!.clientId)) {
        clients = [...clients, { id: campaignDay.clientId, companyName: campaignDay.companyName }].sort((a, b) =>
          a.companyName.localeCompare(b.companyName),
        );
      }
      // The day's poster may be older than the latest History page.
      const sourceId = campaignDay.activeGenerationId;
      if (sourceId && !history.some((item) => item.id === sourceId)) {
        const row = await prisma.posterStudioGeneration
          .findUnique({ where: { id: sourceId }, select: studioHistorySelect })
          .catch(() => null);
        if (row) history = [toStudioHistoryItem(row), ...history];
      }
    }
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
        campaignDay={campaignDay}
      />
    </div>
  );
}
