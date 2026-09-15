import Link from 'next/link';
import { notFound } from 'next/navigation';

import { AlertTriangle, ArrowLeft, CalendarRange, CheckCircle2, CircleDashed, ImageOff, LayoutTemplate, PencilLine } from 'lucide-react';

import { PageHeader } from '@/components/admin/PageHeader';
import { StatTile } from '@/components/admin/StatTile';
import { CampaignCalendar, type CampaignDayView } from '@/components/campaign/CampaignCalendar';
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
import { aspectFit, describeAspect } from '@/lib/campaign/template-mapping';
import { loadCampaignMappingOverview } from '@/lib/campaign/template-mapping-service';
import { prisma } from '@/lib/prisma';
import { describeDeliveryDays, formatDisplayDate, getAppTimeZone } from '@/lib/time';

export const dynamic = 'force-dynamic';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Campaign calendar (Phase 2 content, Phase 3 template mapping).
 *
 * Every day of the campaign with its content state and its template. Content
 * work happens in `CampaignCalendar`, mapping in `CampaignTemplateMapping`;
 * nothing on this page renders a poster or sends a message.
 */
export default async function CampaignCalendarPage({
  params,
}: {
  params: { clientId: string; campaignId: string };
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

  // ---- Template mapping --------------------------------------------------------
  const mapping = await loadCampaignMappingOverview(prisma, campaign.id);
  const templateLabels = new Map(mapping.context.templates.map((template) => [template.id, template.label]));
  const pillarLabel = (key: string) => strategy.pillars.find((pillar) => pillar.key === key)?.label ?? key;
  const mappingTemplates: MappingTemplateView[] = mapping.context.templates.map((template) => ({
    id: template.id,
    label: template.label,
    thumbnailUrl: `/api/templates/${template.id}/thumbnail?w=160`,
    isActive: template.isActive,
    approved: template.approved,
    inVertical: template.categoryId === campaign.category.id,
    aspectLabel: describeAspect(template.aspect),
    aspectFit: aspectFit(template.aspect, mapping.context.target.aspect),
    contentTypeLabels: template.contentTypes.map(pillarLabel),
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
            <LayoutTemplate className="h-4 w-4 text-brand-to" />
            Template mapping
          </CardTitle>
          <CardDescription>
            Which approved template each day&apos;s poster will be drawn from. Auto Map picks active, approved templates
            that fit the day&apos;s content type and this client&apos;s {mapping.context.target.aspectLabel} output, and
            never changes a manual choice. Templates, their status and content types are managed on the{' '}
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
