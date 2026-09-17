import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Activity, AlertTriangle, ArrowLeft, CalendarRange, CheckCircle2, CircleDashed, ClipboardCheck, ImageOff, Images, LayoutTemplate, PencilLine, Send } from 'lucide-react';

import { PageHeader } from '@/components/admin/PageHeader';
import { StatTile } from '@/components/admin/StatTile';
import { CampaignCalendar, type CampaignDayView } from '@/components/campaign/CampaignCalendar';
import { CampaignPosterGeneration, type PosterDayView } from '@/components/campaign/CampaignPosterGeneration';
import { CampaignDeliveryQueue, type DeliveryDayViewModel } from '@/components/campaign/CampaignDeliveryQueue';
import { CampaignHealthPanel, type HealthRow, type UsageView } from '@/components/campaign/CampaignHealthPanel';
import { CampaignReviewQueue, type ReviewDayView } from '@/components/campaign/CampaignReviewQueue';
import {
  CampaignTemplateMapping,
  type MappingDayView,
  type MappingTemplateView,
} from '@/components/campaign/CampaignTemplateMapping';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { resolveContentStrategy, SUGGESTED_TEMPLATE_TYPES } from '@/lib/campaign/content-strategy';
import { campaignAllowsChanges, isVersionCurrent } from '@/lib/campaign/model';
import { POSTER_STATE_LABELS } from '@/lib/campaign/poster-generation';
import { eligibilityFor, loadPosterOverview } from '@/lib/campaign/poster-generation-service';
import { APPROVAL_REFUSAL_MESSAGES, approvalRefusal, describeReadiness, isReviewFilter } from '@/lib/campaign/review';
import { describeDelivery, isDeliveryFilter } from '@/lib/campaign/delivery';
import { defaultDeliveryDeps, loadCampaignDeliveryOverview } from '@/lib/campaign/delivery-service';
import { loadCampaignHealth } from '@/lib/campaign/operations';
import { formatInr, formatUsd, microsToInr, microsToUsd } from '@/lib/pricing';
import { buildReview } from '@/lib/campaign/review-service';
import { aspectFit, describeAspect } from '@/lib/campaign/template-mapping';
import { prisma } from '@/lib/prisma';
import { describeDeliveryDays, formatDisplayDate, formatDisplayDateTime, getAppTimeZone } from '@/lib/time';

export const dynamic = 'force-dynamic';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Campaign calendar (Phase 2 content, Phase 3 mapping, Phase 4 posters, Phase 5
 * review and approval, Phase 6 delivery).
 *
 * Every day of the campaign with its content, template, poster and delivery.
 * Review and approval happen in `CampaignReviewQueue`, generation in
 * `CampaignPosterGeneration`, mapping in `CampaignTemplateMapping`, content in
 * `CampaignCalendar`, delivery in `CampaignDeliveryQueue`.
 *
 * This page itself sends nothing and books nothing: it only reads. The delivery
 * queue's own buttons call server actions, and each of those re-runs the whole
 * eligibility gate server-side before anything leaves.
 *
 * `?review=<filter>` and `?delivery=<filter>` open a queue on one filter, which
 * is what the client page's attention counts link to.
 */
export default async function CampaignCalendarPage({
  params,
  searchParams,
}: {
  params: { clientId: string; campaignId: string };
  searchParams?: { review?: string | string[]; delivery?: string | string[] };
}) {
  if (!UUID_PATTERN.test(params.clientId) || !UUID_PATTERN.test(params.campaignId)) notFound();

  const campaign = await prisma.campaign.findFirst({
    where: { id: params.campaignId, clientId: params.clientId },
    select: {
      id: true,
      name: true,
      status: true,
      startDate: true,
      endDate: true,
      durationDays: true,
      deliveryDays: true,
      deliveryTime: true,
      templateMappingMode: true,
      client: { select: { id: true, companyName: true } },
      plan: { select: { name: true } },
      category: { select: { id: true, name: true, contentStrategy: true } },
      days: {
        orderBy: { dayNumber: 'asc' },
        select: {
          id: true,
          dayNumber: true,
          scheduledDate: true,
          contentStatus: true,
          contentIssues: true,
          contentType: true,
          theme: true,
          headline: true,
          supportingText: true,
          cta: true,
          caption: true,
          hashtags: true,
          imagePrompt: true,
          suggestedTemplateType: true,
          contentRevision: true,
          activePosterVersion: { select: { contentRevision: true } },
        },
      },
    },
  });
  if (!campaign) notFound();

  const timeZone = getAppTimeZone();
  const { strategy, source } = resolveContentStrategy(campaign.category.contentStrategy);
  const dateFormat = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone });

  /*
   * Posters (Phase 4, which also carries the Phase 3 template mapping), delivery
   * (Phase 6) and health (Phase 7) are mutually independent reads of the same
   * campaign, so they run together rather than one after another (Phase 7 §22).
   */
  const [posters, delivery, health] = await Promise.all([
    loadPosterOverview(prisma, campaign.id, { timeZone }),
    loadCampaignDeliveryOverview(prisma, campaign.id, defaultDeliveryDeps({ timeZone })),
    loadCampaignHealth(prisma, campaign.id, { timeZone }),
  ]);
  const mapping = posters.mapping;

  const quietReasons = new Set(['campaign-not-active', 'campaign-closed', 'unsupported-aspect', 'brand-canvas-unavailable', 'already-generated']);
  const windowDays: PosterDayView[] = posters.days
    .filter((day) => day.inWindow)
    .map((day) => {
      const lastFailed = day.generationStatus === 'FAILED' && day.errorMessage;
      let note: string | null = null;
      if (day.state === 'failed' && lastFailed) note = day.errorMessage;
      else if (day.activeVersion && lastFailed) note = `Last regeneration failed: ${day.errorMessage}`;
      else if (day.state === 'outdated') note = 'Content or template changed after this poster was made.';
      else if (!day.upcoming.eligible && !quietReasons.has(day.upcoming.reason) && day.upcoming.reason !== 'generating') note = day.upcoming.message;
      return {
        id: day.id,
        dayNumber: day.dayNumber,
        dateLabel: dateFormat.format(day.scheduledDate),
        headline: day.headline,
        templateLabel: day.templateLabel,
        templateSource: day.mapping.source,
        state: day.state,
        stateLabel: POSTER_STATE_LABELS[day.state],
        note,
        generating: day.generating,
        active: day.activeVersion
          ? { versionId: day.activeVersion.id, versionNumber: day.activeVersion.versionNumber, generationId: day.activeVersion.studioGenerationId }
          : null,
        versionCount: day.versionCount,
        canGenerate: eligibilityFor(posters, day, 'missing', true).eligible,
        canRegenerate: Boolean(day.activeVersion) && eligibilityFor(posters, day, 'regenerate', true).eligible,
      };
    });
  const posterBlockers = [
    posters.campaign.status === 'DRAFT' || posters.campaign.status === 'PAUSED'
      ? `The campaign is ${posters.campaign.status.toLowerCase()} — activate it to generate posters.`
      : null,
    posters.brandCanvas.available ? null : `Brand Canvas unavailable — ${posters.brandCanvas.reason}.`,
    posters.studioAspect ? null : `This client's ${posters.targetAspectLabel} output is not a Poster Studio format (9:16, 1:1 or 16:9).`,
  ].filter((blocker): blocker is string => blocker !== null);
  const windowLabel = `${formatDisplayDate(posters.window.start, timeZone)} → ${formatDisplayDate(new Date(posters.window.end.getTime() - 1), timeZone)} · ${posters.studioAspect ?? posters.targetAspectLabel} posters · ${posters.campaign.approvalPolicy === 'AUTO_APPROVE' ? 'approved automatically' : 'manual approval'}`;

  // ---- Health and the needs-attention queue (Phase 7) --------------------------
  const basePath = `/admin/clients/${campaign.client.id}/campaigns/${campaign.id}`;
  const healthRows: HealthRow[] = [
    { label: 'Content', done: health.content.done, total: health.content.total, href: '?review=all', note: health.content.needsReview > 0 ? `${health.content.needsReview} need review` : undefined },
    { label: 'Templates', done: health.templates.done, total: health.templates.total, href: '?review=unmapped', note: health.templates.unmapped > 0 ? `${health.templates.unmapped} unmapped` : undefined },
    { label: 'Posters', done: health.posters.done, total: health.posters.total, href: '?review=all', note: `next ${posters.window.days} days` },
    { label: 'Approved', done: health.posters.approved, total: health.posters.total, href: '?review=needs-review', note: health.posters.needsApproval > 0 ? `${health.posters.needsApproval} awaiting review` : undefined },
    { label: 'Delivered', done: health.delivery.sent, total: health.delivery.total, href: '?delivery=sent', note: health.delivery.failed > 0 ? `${health.delivery.failed} failed` : undefined },
  ];
  const usageView: UsageView = {
    generations: health.usage.generations,
    estimatedCost: health.usage.costUsdMicros > 0 ? `${formatUsd(microsToUsd(health.usage.costUsdMicros))} · ${formatInr(microsToInr(health.usage.costUsdMicros))}` : null,
    unpriced: health.usage.unpriced,
    messages: health.usage.messages,
  };

  // ---- Review and approval (Phase 5), from the overview already loaded --------
  const review = buildReview(posters);
  const requestedFilter = typeof searchParams?.review === 'string' ? searchParams.review : '';
  const reviewDays: ReviewDayView[] = review.days.map((day) => ({
    dayId: day.dayId,
    dayNumber: day.dayNumber,
    dateLabel: dateFormat.format(day.dateLabel),
    headline: day.headline,
    contentTypeLabel: day.contentTypeLabel,
    templateLabel: day.templateLabel,
    templateSource: day.templateSource,
    state: day.state,
    stateLabel: day.stateLabel,
    generationId: day.generationId,
    versionNumber: day.versionNumber,
    versionCount: day.versionCount,
    rejection: day.rejection,
    warning: day.warning,
    canApprove: day.canApprove,
    approvalRefusal: day.canApprove ? null : (APPROVAL_REFUSAL_MESSAGES[approvalRefusal(day, campaign.status) ?? 'no-poster'] ?? null),
    inWindow: day.inWindow,
    unmapped: day.unmapped,
    activeVersionId: day.activeVersion?.id ?? null,
  }));

  // ---- Delivery (Phase 6) ------------------------------------------------------
  // Read-only: this page never books or sends. The queue's own buttons do, and
  // each goes through the server-side gate. Loaded above, with the rest.
  const requestedDeliveryFilter = typeof searchParams?.delivery === 'string' ? searchParams.delivery : '';
  const deliveryDays: DeliveryDayViewModel[] = delivery.days.map((day) => ({
    dayId: day.dayId,
    dayNumber: day.dayNumber,
    dateLabel: dateFormat.format(day.scheduledDate),
    headline: day.headline,
    generationId: day.generationId,
    versionNumber: day.versionNumber,
    approvalStatus: day.approvalStatus,
    status: day.status,
    statusLabel: day.statusLabel,
    scheduledForLabel: day.scheduledFor ? formatDisplayDateTime(day.scheduledFor, timeZone) : null,
    attempts: day.attempts,
    lastAttemptLabel: day.lastAttemptAt ? formatDisplayDateTime(day.lastAttemptAt, timeZone) : null,
    sentAtLabel: day.sentAt ? formatDisplayDateTime(day.sentAt, timeZone) : null,
    providerMessageId: day.providerMessageId,
    failureReason: day.failureReason,
    failurePermanent: day.failurePermanent,
    refusal: day.refusal,
    canSendNow: day.canSendNow,
    canRetry: day.canRetry,
    canCancel: day.canCancel,
  }));

  // ---- Template mapping --------------------------------------------------------
  const templateLabels = new Map(mapping.context.templates.map((template) => [template.id, template.label]));
  const pillarLabel = (key: string) => strategy.pillars.find((pillar) => pillar.key === key)?.label ?? key;
  const mappingTemplates: MappingTemplateView[] = mapping.context.templates.map((template) => ({
    id: template.id,
    label: template.label,
    thumbnailUrl: `/api/templates/${template.id}/thumbnail?w=160`,
    isActive: template.isActive,
    inVertical: template.categoryId === campaign.category.id,
    aspectLabel: describeAspect(template.aspect),
    aspectFit: aspectFit(template.aspect, mapping.context.target.aspect),
    autoDays: mapping.usage.get(template.id)?.auto ?? 0,
    manualDays: mapping.usage.get(template.id)?.manual ?? 0,
  }));
  const scheduledDates = new Map(campaign.days.map((day) => [day.id, day.scheduledDate]));
  const mappingDays: MappingDayView[] = mapping.context.days.map((day) => {
    const state = mapping.states.get(day.id)!;
    return {
      dayNumber: day.dayNumber,
      dateLabel: dateFormat.format(scheduledDates.get(day.id) ?? campaign.startDate),
      contentTypeLabel: day.contentType ? pillarLabel(day.contentType) : null,
      contentTypePlanned: day.contentTypeSource === 'planned',
      templateId: state.templateId,
      source: state.source,
      overridesAuto: state.overridesAuto,
      ignoredSuggestionId: state.ignoredSuggestionId,
      issues: state.issues,
      unmappedReason: mapping.unmappedReasons.get(day.id)?.detail ?? null,
    };
  });

  const days: CampaignDayView[] = campaign.days.map((day) => ({
    id: day.id,
    dayNumber: day.dayNumber,
    dateLabel: dateFormat.format(day.scheduledDate),
    contentStatus: day.contentStatus ?? 'NOT_GENERATED',
    contentIssues: day.contentIssues,
    contentType: day.contentType,
    theme: day.theme,
    headline: day.headline,
    supportingText: day.supportingText,
    cta: day.cta,
    caption: day.caption,
    hashtags: day.hashtags,
    imagePrompt: day.imagePrompt,
    suggestedTemplateType: day.suggestedTemplateType,
    suggestedTemplateTypeLabel:
      day.suggestedTemplateType && day.suggestedTemplateType in SUGGESTED_TEMPLATE_TYPES
        ? SUGGESTED_TEMPLATE_TYPES[day.suggestedTemplateType as keyof typeof SUGGESTED_TEMPLATE_TYPES]
        : null,
    contentRevision: day.contentRevision,
    ...(() => {
      const state = mapping.states.get(day.id);
      const issue = state?.issues.find((candidate) => candidate.severity === 'action');
      return {
        templateLabel: state?.templateId ? (templateLabels.get(state.templateId) ?? null) : null,
        templateSource: state?.source ?? null,
        templateIssue: issue?.title ?? (mapping.unmappedReasons.has(day.id) ? 'No compatible template' : null),
      };
    })(),
    poster: !day.activePosterVersion
      ? 'none'
      : isVersionCurrent(day.activePosterVersion, day)
        ? 'current'
        : 'outdated',
  }));

  const count = (status: CampaignDayView['contentStatus']) => days.filter((day) => day.contentStatus === status).length;
  const ready = count('READY');
  const needsReview = count('NEEDS_REVIEW');
  const notGenerated = count('NOT_GENERATED');
  const postersOutdated = days.filter((day) => day.poster === 'outdated').length;

  return (
    <>
      <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit">
        <Link href={`/admin/clients/${campaign.client.id}`}>
          <ArrowLeft className="h-4 w-4" />
          {campaign.client.companyName}
        </Link>
      </Button>

      <PageHeader
        icon={CalendarRange}
        eyebrow={`${campaign.plan.name} · ${campaign.category.name} · ${campaign.templateMappingMode === 'AUTO' ? 'Auto' : 'Manual'} template mapping`}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {campaign.name}
            <Badge variant="slate">{campaign.status}</Badge>
          </span>
        }
        description={`${campaign.durationDays}-day campaign · ${formatDisplayDate(campaign.startDate, timeZone)} → ${formatDisplayDate(campaign.endDate, timeZone)} · ${describeDeliveryDays(campaign.deliveryDays)} at ${campaign.deliveryTime}`}
      />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile icon={CheckCircle2} label="Content ready" value={ready} hint={`of ${campaign.durationDays} days`} tone="emerald" />
        <StatTile icon={PencilLine} label="Needs review" value={needsReview} hint="Flagged by validation" tone={needsReview > 0 ? 'amber' : 'slate'} />
        <StatTile icon={CircleDashed} label="Not generated" value={notGenerated} hint="Empty day slots" tone="slate" />
        <StatTile
          icon={postersOutdated > 0 ? AlertTriangle : ImageOff}
          label="Posters outdated"
          value={postersOutdated}
          hint="Content changed after the poster was made"
          tone={postersOutdated > 0 ? 'amber' : 'slate'}
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-brand-to" />
            Campaign health
          </CardTitle>
          <CardDescription>
            Where this campaign stands, and everything that needs a decision — each one a link to the day that needs it.
            AI spend is estimated from recorded tokens and the configured rate card, never from a provider invoice.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CampaignHealthPanel
            rows={healthRows}
            usage={usageView}
            attention={health.attention}
            attentionTotal={health.attention.length}
            basePath={basePath}
            queued={health.posters.queued}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ClipboardCheck className="h-4 w-4 text-brand-to" />
            Campaign review
          </CardTitle>
          <CardDescription>
            Every day&apos;s content, template and poster in one queue, with the decisions: approve the poster that
            represents the day, or send it back with a reason and edit or regenerate it. An outdated, rejected or failed
            poster is never approved. Approving makes a day deliverable; the delivery card below is what sends it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CampaignReviewQueue
            campaignId={campaign.id}
            closed={!campaignAllowsChanges(campaign.status)}
            days={reviewDays}
            summary={review.summary}
            readiness={{ ...review.readiness, description: describeReadiness(review.readiness, posters.window.days) }}
            windowDays={posters.window.days}
            initialFilter={isReviewFilter(requestedFilter) ? requestedFilter : 'all'}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Send className="h-4 w-4 text-brand-to" />
            Delivery
          </CardTitle>
          <CardDescription>
            {describeDelivery(delivery.summary)} Only an approved, current poster is ever sent, each day is sent at most
            once, and the campaign must be active. Every button here is checked again on the server before anything
            leaves.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CampaignDeliveryQueue
            campaignId={campaign.id}
            days={deliveryDays}
            summary={delivery.summary}
            recipient={delivery.recipient}
            whatsappConfigured={delivery.whatsappConfigured}
            mediaConfigured={delivery.mediaConfigured}
            deliveryTime={delivery.campaign.deliveryTime}
            campaignActive={campaign.status === 'ACTIVE'}
            initialFilter={isDeliveryFilter(requestedDeliveryFilter) ? requestedDeliveryFilter : 'all'}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Images className="h-4 w-4 text-brand-to" />
            Poster generation
          </CardTitle>
          <CardDescription>
            Posters are made only for the next {posters.window.days} days, one at a time, with the AI Poster Studio pipeline:
            the day&apos;s content, its mapped template as the reference, and the client&apos;s Brand Canvas footer. Every
            batch asks for confirmation first. Changing content or a template marks a poster outdated — it is never
            regenerated automatically. Nothing is sent to WhatsApp.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CampaignPosterGeneration
            campaignId={campaign.id}
            status={campaign.status}
            closed={!campaignAllowsChanges(campaign.status)}
            windowLabel={windowLabel}
            windowDays={posters.window.days}
            summary={posters.summary}
            days={windowDays}
            durationDays={campaign.durationDays}
            blockers={posterBlockers}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LayoutTemplate className="h-4 w-4 text-brand-to" />
            Template mapping
          </CardTitle>
          <CardDescription>
            Which template each day&apos;s poster is generated from. Auto Map picks active templates that fit this
            client&apos;s {mapping.context.target.aspectLabel} output, and never changes a manual choice. Templates and
            their prompts are managed on the{' '}
            <Link href={`/admin/verticals/${campaign.category.id}`} className="underline underline-offset-2">
              {campaign.category.name} vertical
            </Link>
            .
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CampaignTemplateMapping
            campaignId={campaign.id}
            mode={campaign.templateMappingMode}
            closed={!campaignAllowsChanges(campaign.status)}
            targetAspectLabel={mapping.context.target.aspectLabel}
            templates={mappingTemplates}
            days={mappingDays}
            summary={{
              total: mapping.summary.total,
              mapped: mapping.summary.mapped,
              auto: mapping.summary.auto,
              manual: mapping.summary.manual,
              overridden: mapping.summary.overridden,
              unmapped: mapping.summary.unmapped,
            }}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Content calendar</CardTitle>
          <CardDescription>
            AI writes content, not posters. Generation runs 30 days per request, never replaces written days
            unless you choose regenerate, and leaves templates and posters untouched. Content types follow the{' '}
            <Link href={`/admin/verticals/${campaign.category.id}`} className="underline underline-offset-2">
              {source === 'vertical' ? `${campaign.category.name} content strategy` : 'default content strategy'}
            </Link>
            .
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CampaignCalendar
            campaignId={campaign.id}
            durationDays={campaign.durationDays}
            days={days}
            pillars={strategy.pillars.map((pillar) => ({ key: pillar.key, label: pillar.label }))}
            closed={!campaignAllowsChanges(campaign.status)}
          />
        </CardContent>
      </Card>
    </>
  );
}
