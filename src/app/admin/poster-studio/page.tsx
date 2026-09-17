import React from 'react';
import { AlertTriangle, Sparkles } from 'lucide-react';

import { PageHeader } from '@/components/admin/PageHeader';
import { PosterStudioWorkspace } from '@/components/studio/poster-studio-workspace';
import { TemplatePosterEditor } from '@/components/studio/TemplatePosterEditor';
import { getStudioImageQuality, STUDIO_IMAGE_MODEL } from '@/lib/ai/openai-images';
import { loadTemplateEditorScreen, type TemplateEditorLoad } from '@/lib/campaign/clone-editor-screen';
import { loadCampaignDayStudioContext, type CampaignDayStudioContext } from '@/lib/campaign/poster-generation-service';
import { CampaignDomainError } from '@/lib/campaign/service';
import {
  loadStudioHistory,
  studioHistorySelect,
  toStudioDatabaseError,
  toStudioHistoryItem,
  type StudioHistoryItem,
} from '@/lib/poster-studio/history';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

/**
 * Generating, fixing or changing a campaign poster is one high-quality image call
 * of about two minutes, made by a server action posted to this page.
 */
export const maxDuration = 300;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * AI Poster Studio.
 *
 * Opened from a campaign day (`?campaignDay=<id>`) whose template has been read,
 * it is the **template poster editor** (`TemplatePosterEditor`): the day's cloned
 * template as a form beside its poster, with its own top bar — so neither the
 * studio header nor the campaign-day banner is shown. Any other campaign day (no
 * template, or a template not read yet) opens the studio workspace with the
 * campaign-day banner as before, and says why; so does the studio on its own.
 */
export default async function PosterStudioPage({
  searchParams,
}: {
  searchParams?: { campaignDay?: string | string[] };
}) {
  const campaignDayParam = typeof searchParams?.campaignDay === 'string' ? searchParams.campaignDay : null;
  const validDayId = campaignDayParam !== null && UUID_PATTERN.test(campaignDayParam) ? campaignDayParam : null;

  // ---- A campaign day with a read template: the template poster editor ----------
  let editorLoad: TemplateEditorLoad | null = null;
  if (validDayId) {
    try {
      editorLoad = await loadTemplateEditorScreen(prisma, validDayId);
    } catch (error) {
      // A missing or non-campaign row falls through to the studio, which says so.
      if (!(error instanceof CampaignDomainError)) console.error('[poster-studio-page] template editor', error);
    }
  }
  if (editorLoad?.kind === 'editor') {
    return <TemplatePosterEditor key={editorLoad.screen.day.id} initial={editorLoad.screen} />;
  }
  const templateNote =
    editorLoad?.kind === 'unread'
      ? `Template not read yet — open the vertical and press Read now. Day ${editorLoad.dayNumber} uses “${editorLoad.templateLabel}”; its poster editor opens once the template is read.`
      : null;

  // Settled separately so a missing studio table still leaves the client list
  // usable, and either failure is shown rather than rendered as an empty state.
  const [clientsResult, historyResult, campaignDayResult] = await Promise.allSettled([
    prisma.client.findMany({
      where: { isActive: true },
      select: { id: true, companyName: true },
      orderBy: { companyName: 'asc' },
    }),
    loadStudioHistory(),
    validDayId ? loadCampaignDayStudioContext(prisma, validDayId) : Promise.resolve(null),
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
      {templateNote && (
        <p role="status" className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-warning-ink">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {templateNote}
        </p>
      )}
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
