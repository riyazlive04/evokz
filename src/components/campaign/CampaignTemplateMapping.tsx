'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

import { AlertTriangle, ArrowRight, Check, GripVertical, Hand, Loader2, Repeat, Search, Wand2, X } from 'lucide-react';

import {
  applyAutoMapAction,
  assignCampaignTemplatesAction,
  changeTemplateMappingModeAction,
  previewAutoMapAction,
  type AutoMapPreview,
  type AutoMapPreviewEntry,
} from '@/app/admin/campaigns/actions';
import { badgeVariants } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAction } from '@/hooks/use-action';
import { describeDays } from '@/lib/campaign/template-mapping';
import { cn } from '@/lib/utils';

export interface MappingTemplateView {
  id: string;
  label: string;
  thumbnailUrl: string;
  isActive: boolean;
  approved: boolean;
  /** In the campaign's vertical. */
  inVertical: boolean;
  aspectLabel: string;
  aspectFit: 'match' | 'unmeasured' | 'mismatch';
  contentTypeLabels: string[];
  autoDays: number;
  manualDays: number;
}

export interface MappingIssueView {
  code: string;
  severity: 'action' | 'warning';
  title: string;
  detail: string;
}

export interface MappingDayView {
  dayNumber: number;
  dateLabel: string;
  contentTypeLabel: string | null;
  /** The content type is the strategy's plan, not written content yet. */
  contentTypePlanned: boolean;
  templateId: string | null;
  source: 'AUTO' | 'MANUAL' | null;
  overridesAuto: boolean;
  ignoredSuggestionId: string | null;
  issues: MappingIssueView[];
  unmappedReason: string | null;
}

export interface MappingSummaryView {
  total: number;
  mapped: number;
  auto: number;
  manual: number;
  overridden: number;
  unmapped: number;
}

type Panel = 'none' | 'auto' | 'manual';
type DayFilter = 'all' | 'unmapped' | 'attention' | 'manual' | 'auto';
type PreviewFilter = 'changes' | 'conflicts' | 'unmapped' | 'manual' | 'all';

const OUTCOME: Record<AutoMapPreviewEntry['outcome'], { label: string; variant: 'default' | 'secondary' | 'outline' | 'slate' | 'amber' | 'emerald' }> = {
  new: { label: 'New', variant: 'emerald' },
  replace: { label: 'Replaced', variant: 'amber' },
  keep: { label: 'Kept', variant: 'slate' },
  manual: { label: 'Manual · untouched', variant: 'outline' },
  unmapped: { label: 'Unmapped', variant: 'amber' },
};

type TagVariant = 'default' | 'secondary' | 'outline' | 'slate' | 'amber' | 'emerald';

/**
 * `Badge`'s look as a span. Badge renders a div, which is invalid inside the
 * paragraphs, buttons and labels this component puts status chips in.
 */
function Tag({ variant, className, children }: { variant: TagVariant; className?: string; children: React.ReactNode }) {
  return <span className={cn(badgeVariants({ variant }), className)}>{children}</span>;
}

/** AUTO / MANUAL, as the operator reads it on every mapped day. */
export function MappingSourceBadge({ source }: { source: 'AUTO' | 'MANUAL' | null }) {
  if (source === 'MANUAL') return <Tag variant="default">Manual</Tag>;
  if (source === 'AUTO') return <Tag variant="secondary">Auto</Tag>;
  return <Tag variant="slate">Unmapped</Tag>;
}

/**
 * Template mapping for one campaign (Phase 3): which approved template each day
 * uses. Auto Map is previewed before anything is written; manual mapping is a
 * "match the following" board — days on one side, templates on the other — with
 * drag-and-drop on desktop and select → select → apply everywhere, so touch
 * devices never depend on dragging. Nothing here generates a poster.
 */
export function CampaignTemplateMapping({
  campaignId,
  mode,
  closed,
  targetAspectLabel,
  templates,
  days,
  summary,
}: {
  campaignId: string;
  mode: 'AUTO' | 'MANUAL';
  closed: boolean;
  targetAspectLabel: string;
  templates: MappingTemplateView[];
  days: MappingDayView[];
  summary: MappingSummaryView;
}) {
  const router = useRouter();
  const preview = useAction(previewAutoMapAction);
  const apply = useAction(applyAutoMapAction);
  const assign = useAction(assignCampaignTemplatesAction);
  const switchMode = useAction(changeTemplateMappingModeAction);

  const [panel, setPanel] = React.useState<Panel>('none');
  const [plan, setPlan] = React.useState<AutoMapPreview | null>(null);
  const [rebalance, setRebalance] = React.useState(false);
  const [previewFilter, setPreviewFilter] = React.useState<PreviewFilter>('changes');
  const [dayFilter, setDayFilter] = React.useState<DayFilter>('all');
  const [selectedTemplate, setSelectedTemplate] = React.useState<string | null>(null);
  const [selectedDays, setSelectedDays] = React.useState<Set<number>>(() => new Set());
  const [patternMode, setPatternMode] = React.useState(false);
  const [pattern, setPattern] = React.useState<string[]>([]);
  const [skipManual, setSkipManual] = React.useState(false);
  const [fromText, setFromText] = React.useState('1');
  const [toText, setToText] = React.useState(String(summary.total));
  const [dragOverDay, setDragOverDay] = React.useState<number | null>(null);
  const [confirmMode, setConfirmMode] = React.useState(false);
  const [notice, setNotice] = React.useState<{ tone: 'success' | 'warning'; lines: string[] } | null>(null);
  const [replacements, setReplacements] = React.useState<Record<string, string>>({});

  const byId = React.useMemo(() => new Map(templates.map((template) => [template.id, template])), [templates]);
  const assignable = React.useMemo(() => templates.filter((template) => template.inVertical && template.isActive && template.approved), [templates]);
  const attentionDays = days.filter((day) => day.issues.some((issue) => issue.severity === 'action') || day.unmappedReason);
  const ignoredSuggestions = days.filter((day) => day.ignoredSuggestionId).length;
  const labelOf = (id: string | null) => (id ? (byId.get(id)?.label ?? 'Unknown template') : null);
  const busy = preview.pending || apply.pending || assign.pending || switchMode.pending;

  const from = Number(fromText);
  const to = Number(toText);
  const rangeValid = Number.isInteger(from) && Number.isInteger(to) && from >= 1 && to <= summary.total && from <= to;

  // ---- Auto Map ---------------------------------------------------------------

  async function openPreview(nextRebalance = rebalance) {
    setNotice(null);
    setPanel('auto');
    setPlan(null);
    const result = await preview.run(campaignId, nextRebalance ? 'rebalance' : 'fill');
    if (result.ok) {
      setPlan(result.data);
      setPreviewFilter(result.data.counts.changes > 0 ? 'changes' : 'all');
    }
  }

  async function applyPlan() {
    if (!plan) return;
    const result = await apply.run(campaignId, { scope: plan.scope, fingerprint: plan.fingerprint });
    if (!result.ok) return;
    setNotice({
      tone: 'success',
      lines: [
        `Auto Map applied: ${result.data.daysWritten} day(s) updated.${result.data.switchedToAuto ? ' The campaign now uses Auto mapping.' : ''}`,
        ...(plan.counts.unmapped > 0 ? [`${plan.counts.unmapped} day(s) stay unmapped — see Needs attention.`] : []),
      ],
    });
    setPlan(null);
    setPanel('none');
    router.refresh();
  }

  const previewRows = plan
    ? plan.entries.filter((entry) => {
        if (previewFilter === 'all') return true;
        if (previewFilter === 'changes') return entry.outcome === 'new' || entry.outcome === 'replace' || (entry.outcome === 'unmapped' && entry.currentTemplateId !== null);
        if (previewFilter === 'conflicts') return entry.conflict !== null;
        return entry.outcome === previewFilter;
      })
    : [];

  // ---- Manual mapping ---------------------------------------------------------

  function openManual(filter: DayFilter = 'all', preselect: number[] = []) {
    setNotice(null);
    setPanel('manual');
    setDayFilter(filter);
    setSelectedDays(new Set(preselect));
  }

  async function assignTo(dayNumbers: number[], templateId: string | null) {
    if (dayNumbers.length === 0) return;
    setNotice(null);
    const result = await assign.run(campaignId, { kind: 'days', dayNumbers, templateId }, { skipManual });
    if (!result.ok) return;
    reportManual(result.data, templateId);
    setSelectedDays(new Set());
    router.refresh();
  }

  async function applyPattern() {
    if (!rangeValid || pattern.length === 0) return;
    setNotice(null);
    const result = await assign.run(campaignId, { kind: 'pattern', fromDay: from, toDay: to, templateIds: pattern }, { skipManual });
    if (!result.ok) return;
    reportManual(result.data, pattern[0]!);
    router.refresh();
  }

  function reportManual(data: { changedDays: number[]; unchanged: number; skippedManual: number; warnings: string[] }, templateId: string | null) {
    const lines = [
      data.changedDays.length === 0
        ? 'Nothing changed — those days already had that mapping.'
        : templateId
          ? `Manual template set on ${describeDays(data.changedDays)}.`
          : `Manual template cleared on ${describeDays(data.changedDays)}.`,
    ];
    if (data.skippedManual > 0) lines.push(`${data.skippedManual} day(s) kept their existing manual template.`);
    lines.push(...data.warnings);
    setNotice({ tone: data.warnings.length > 0 ? 'warning' : 'success', lines });
  }

  function toggleDay(dayNumber: number) {
    setSelectedDays((current) => {
      const next = new Set(current);
      if (next.has(dayNumber)) next.delete(dayNumber);
      else next.add(dayNumber);
      return next;
    });
  }

  function chooseTemplate(id: string) {
    if (patternMode) setPattern((current) => [...current, id]);
    else setSelectedTemplate((current) => (current === id ? null : id));
  }

  const visibleDays = days.filter((day) => {
    switch (dayFilter) {
      case 'unmapped':
        return day.templateId === null;
      case 'attention':
        return day.issues.some((issue) => issue.severity === 'action') || day.unmappedReason !== null;
      case 'manual':
        return day.source === 'MANUAL';
      case 'auto':
        return day.source === 'AUTO';
      default:
        return true;
    }
  });

  function onDrop(event: React.DragEvent, dayNumber: number) {
    event.preventDefault();
    setDragOverDay(null);
    const templateId = event.dataTransfer.getData('application/x-evokz-template');
    if (!templateId) return;
    // Dropping onto a selected day maps the whole selection; otherwise just that day.
    const targets = selectedDays.has(dayNumber) && selectedDays.size > 1 ? [...selectedDays] : [dayNumber];
    void assignTo(targets, templateId);
  }

  // ---- Needs attention groups -------------------------------------------------

  const templateGroups = new Map<string, { templateId: string; title: string; detail: string; dayNumbers: number[] }>();
  const reasonGroups = new Map<string, { title: string; detail: string; dayNumbers: number[] }>();
  for (const day of attentionDays) {
    const issue = day.issues.find((candidate) => candidate.severity === 'action');
    if (issue && day.templateId) {
      const key = `${day.templateId}|${issue.code}`;
      const group = templateGroups.get(key) ?? { templateId: day.templateId, title: issue.title, detail: issue.detail, dayNumbers: [] };
      group.dayNumbers.push(day.dayNumber);
      templateGroups.set(key, group);
    } else if (day.unmappedReason) {
      const group = reasonGroups.get(day.unmappedReason) ?? { title: 'No compatible template', detail: day.unmappedReason, dayNumbers: [] };
      group.dayNumbers.push(day.dayNumber);
      reasonGroups.set(day.unmappedReason, group);
    }
  }
  const defaultReplacement = (excluded: string) =>
    assignable.find((template) => template.id !== excluded && template.aspectFit !== 'mismatch')?.id ?? assignable.find((template) => template.id !== excluded)?.id ?? '';

  const error = preview.error ?? apply.error ?? assign.error ?? switchMode.error;

  return (
    <div className="space-y-4">
      {/* ---- Summary and mode ---- */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="text-sm text-foreground">
          <span className="font-semibold">{summary.mapped}</span> of {summary.total} days mapped
        </p>
        <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <Tag variant="secondary">Auto {summary.auto}</Tag>
          <Tag variant="default">Manual {summary.manual}</Tag>
          <Tag variant={summary.unmapped > 0 ? 'amber' : 'slate'}>Unmapped: {summary.unmapped} {summary.unmapped === 1 ? 'day' : 'days'}</Tag>
          {summary.overridden > 0 && <span>{summary.overridden} manual override(s) of an auto mapping</span>}
        </span>
        <span className="text-[11px] text-muted-foreground">Client output: {targetAspectLabel}</span>

        <div className="flex flex-wrap items-center gap-1.5 sm:ml-auto">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Mapping mode</span>
          {!confirmMode ? (
            <Button size="sm" variant="outline" disabled={closed || busy} onClick={() => setConfirmMode(true)}>
              {mode === 'AUTO' ? 'Auto' : 'Manual'} · change
            </Button>
          ) : (
            <span className="flex flex-wrap items-center gap-1.5 rounded-md border border-warning/30 bg-warning/5 px-2 py-1 text-[11px] text-warning-ink">
              {mode === 'AUTO'
                ? `Switch to Manual? Auto mappings on ${summary.auto} day(s) stop counting (they are kept, not deleted).`
                : `Switch to Auto? Stored auto mappings on ${ignoredSuggestions} day(s) take effect.`}
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  setConfirmMode(false);
                  const result = await switchMode.run(campaignId, mode === 'AUTO' ? 'MANUAL' : 'AUTO');
                  if (result.ok) router.refresh();
                }}
              >
                Switch to {mode === 'AUTO' ? 'Manual' : 'Auto'}
              </Button>
              <Button size="icon" variant="ghost" onClick={() => setConfirmMode(false)} aria-label="Cancel mode change">
                <X className="h-4 w-4" />
              </Button>
            </span>
          )}
        </div>
      </div>

      {/* ---- Actions ---- */}
      {!closed ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => void openPreview()} disabled={busy}>
            {preview.pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
            Auto Map
          </Button>
          <Button size="sm" variant={panel === 'manual' ? 'secondary' : 'outline'} onClick={() => (panel === 'manual' ? setPanel('none') : openManual())} disabled={busy}>
            <Hand className="h-4 w-4" />
            Manual Map
          </Button>
          <Button size="sm" variant="outline" onClick={() => openManual('attention')} disabled={busy || attentionDays.length + summary.unmapped === 0}>
            <Search className="h-4 w-4" />
            Review Unmapped ({summary.unmapped})
          </Button>
          <p className="text-[11px] text-muted-foreground">Maps templates only — no poster is generated.</p>
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">This campaign is closed; its template mapping is read-only.</p>
      )}

      {notice && (
        <div role="status" className={cn('space-y-0.5 rounded-md border px-3 py-2 text-[12px]', notice.tone === 'success' ? 'border-success/30 bg-success/5 text-success-ink' : 'border-warning/30 bg-warning/5 text-warning-ink')}>
          {notice.lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="text-[12px] text-danger-ink">
          {error}
          {apply.error && (
            <Button size="sm" variant="link" className="h-auto px-1 py-0 text-[12px]" onClick={() => void openPreview()}>
              Preview again
            </Button>
          )}
        </p>
      )}

      {/* ---- Needs attention ---- */}
      {attentionDays.length > 0 && (
        <section aria-label="Needs attention" className="space-y-2 rounded-lg border border-warning/30 bg-warning/5 p-3">
          <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-warning-ink">
            <AlertTriangle className="h-3.5 w-3.5" />
            Needs attention · {attentionDays.length} {attentionDays.length === 1 ? 'day' : 'days'}
          </h3>
          <ul className="space-y-2">
            {[...templateGroups.entries()].map(([key, group]) => {
              const replacement = replacements[key] ?? defaultReplacement(group.templateId);
              return (
                <li key={key} className="space-y-1.5 rounded-md border border-border bg-background p-2.5">
                  <p className="text-[12px] text-foreground">
                    <span className="font-semibold capitalize">{describeDays(group.dayNumbers)}</span> — {group.title}
                  </p>
                  <p className="text-[11px] text-muted-foreground">{group.detail}</p>
                  {!closed && (
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="text-[11px] text-muted-foreground" htmlFor={`replace-${key}`}>
                        Replace with
                      </label>
                      <select
                        id={`replace-${key}`}
                        value={replacement}
                        onChange={(event) => setReplacements((current) => ({ ...current, [key]: event.target.value }))}
                        className="h-8 min-w-0 max-w-full rounded-md border border-input bg-background px-2 text-[12px]"
                      >
                        {assignable.length === 0 && <option value="">No active, approved template</option>}
                        {assignable
                          .filter((template) => template.id !== group.templateId)
                          .map((template) => (
                            <option key={template.id} value={template.id}>
                              {template.label}
                              {template.aspectFit === 'mismatch' ? ` (${template.aspectLabel})` : ''}
                            </option>
                          ))}
                      </select>
                      <Button size="sm" variant="outline" disabled={busy || !replacement} onClick={() => void assignTo(group.dayNumbers, replacement)}>
                        Replace on {group.dayNumbers.length} {group.dayNumbers.length === 1 ? 'day' : 'days'}
                      </Button>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => openManual('attention', group.dayNumbers)}>
                        Review
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
            {[...reasonGroups.values()].map((group) => (
              <li key={group.detail} className="space-y-1 rounded-md border border-border bg-background p-2.5">
                <p className="text-[12px] text-foreground">
                  <span className="font-semibold capitalize">{describeDays(group.dayNumbers)}</span> — {group.title}
                </p>
                <p className="text-[11px] text-muted-foreground">{group.detail}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ---- Auto Map preview ---- */}
      {panel === 'auto' && (
        <section aria-label="Auto Map preview" className="space-y-3 rounded-lg border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground">Auto Map preview</h3>
            <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <input
                type="checkbox"
                checked={rebalance}
                disabled={busy}
                onChange={(event) => {
                  setRebalance(event.target.checked);
                  void openPreview(event.target.checked);
                }}
              />
              Also re-balance existing auto mappings
            </label>
          </div>

          {preview.pending && (
            <p className="flex items-center gap-2 text-[12px] text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Planning…
            </p>
          )}

          {plan && (
            <>
              <p className="text-[11px] text-muted-foreground">
                Nothing is saved until you apply. Manual templates are never changed. A day with no compatible template stays unmapped.
              </p>
              {plan.switchesMode && (
                <p className="rounded-md border border-warning/30 bg-warning/5 px-2.5 py-1.5 text-[11px] text-warning-ink">
                  This campaign uses Manual mapping. Applying switches it to Auto, so auto mappings fill the days that have no manual template.
                </p>
              )}

              <div className="flex flex-wrap gap-1.5">
                {(
                  [
                    ['changes', `Changes (${plan.counts.changes})`],
                    ['conflicts', `Conflicts (${plan.counts.conflicts})`],
                    ['unmapped', `Unmapped (${plan.counts.unmapped})`],
                    ['manual', `Manual (${plan.counts.manual})`],
                    ['all', `All (${plan.entries.length})`],
                  ] as const
                ).map(([value, label]) => (
                  <Button key={value} size="sm" variant={previewFilter === value ? 'secondary' : 'ghost'} onClick={() => setPreviewFilter(value)}>
                    {label}
                  </Button>
                ))}
              </div>
              <p className="flex flex-wrap gap-1.5 text-[11px]">
                <Tag variant="emerald">New {plan.counts.new}</Tag>
                <Tag variant="amber">Replaced {plan.counts.replace}</Tag>
                <Tag variant="slate">Kept {plan.counts.keep}</Tag>
                <Tag variant="outline">Manual untouched {plan.counts.manual}</Tag>
                <Tag variant={plan.counts.unmapped > 0 ? 'amber' : 'slate'}>Unmapped {plan.counts.unmapped}</Tag>
              </p>

              <ol className="max-h-[28rem] divide-y divide-border overflow-y-auto rounded-md border border-border">
                {previewRows.map((entry) => (
                  <li key={entry.dayNumber} className="space-y-1 px-3 py-2" data-preview-day={entry.dayNumber}>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
                      <span className="w-14 shrink-0 font-semibold text-foreground">Day {entry.dayNumber}</span>
                      {entry.outcome === 'manual' || entry.outcome === 'keep' ? (
                        <span className="min-w-0 truncate text-foreground">{labelOf(entry.templateId)}</span>
                      ) : (
                        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <span className="truncate text-muted-foreground">{labelOf(entry.currentTemplateId) ?? 'Unmapped'}</span>
                          <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                          <span className={cn('truncate', entry.templateId ? 'font-medium text-foreground' : 'text-warning-ink')}>{labelOf(entry.templateId) ?? 'Unmapped'}</span>
                        </span>
                      )}
                      <Tag variant={OUTCOME[entry.outcome].variant}>{OUTCOME[entry.outcome].label}</Tag>
                    </div>
                    {entry.conflict && (
                      <p className="flex items-start gap-1.5 text-[11px] text-warning-ink">
                        <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                        {entry.conflict.title}: {entry.conflict.detail}
                      </p>
                    )}
                    {entry.replacementTemplateId && (
                      <p className="text-[11px] text-muted-foreground">Suggested replacement: {labelOf(entry.replacementTemplateId)} — not applied; choose it under Needs attention.</p>
                    )}
                    {entry.unmappedReason && <p className="text-[11px] text-warning-ink">{entry.unmappedReason}</p>}
                    {entry.repeatsPreviousDay && <p className="text-[11px] text-muted-foreground">Same as the previous day — no other compatible template is available.</p>}
                  </li>
                ))}
                {previewRows.length === 0 && <li className="px-3 py-6 text-center text-[12px] text-muted-foreground">Nothing in this view.</li>}
              </ol>

              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => void applyPlan()} disabled={busy || (plan.counts.changes === 0 && !plan.switchesMode)}>
                  {apply.pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  Apply Auto Map ({plan.counts.changes} {plan.counts.changes === 1 ? 'change' : 'changes'})
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setPlan(null); setPanel('none'); }} disabled={apply.pending}>
                  Cancel
                </Button>
              </div>
            </>
          )}
        </section>
      )}

      {/* ---- Manual "match the following" ---- */}
      {panel === 'manual' && !closed && (
        <section aria-label="Manual Map" className="space-y-3 rounded-lg border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground">Manual Map</h3>
            <p className="text-[11px] text-muted-foreground">
              <span className="font-semibold text-foreground">1</span> Select a template ·{' '}
              <span className="font-semibold text-foreground">2</span> Select days ·{' '}
              <span className="font-semibold text-foreground">3</span> Apply. On a desktop you can also drag a template onto a day.
            </p>
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_19rem]">
            {/* Templates: first on a phone (step 1), beside the days on a desktop. */}
            <aside aria-label="Available templates" className="order-1 min-w-0 space-y-2 lg:order-2 lg:sticky lg:top-4 lg:self-start">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Templates</h4>
                <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={patternMode}
                    onChange={(event) => {
                      setPatternMode(event.target.checked);
                      setPattern([]);
                    }}
                  />
                  <Repeat className="h-3 w-3" /> Repeat pattern
                </label>
              </div>
              <ul className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2 lg:max-h-[32rem] lg:grid-cols-1 lg:overflow-y-auto lg:pr-1">
                {templates.filter((template) => template.inVertical).map((template) => {
                  const usable = template.isActive && template.approved;
                  const chosen = patternMode ? pattern.includes(template.id) : selectedTemplate === template.id;
                  return (
                    <li key={template.id}>
                      <button
                        type="button"
                        disabled={!usable || busy}
                        aria-pressed={chosen}
                        aria-label={`Template ${template.label}`}
                        draggable={usable}
                        onDragStart={(event) => {
                          event.dataTransfer.setData('application/x-evokz-template', template.id);
                          event.dataTransfer.effectAllowed = 'copy';
                        }}
                        onClick={() => chooseTemplate(template.id)}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-md border p-1.5 text-left transition-colors',
                          chosen ? 'border-primary bg-primary/15' : 'border-border hover:bg-accent/60',
                          !usable && 'cursor-not-allowed opacity-60',
                        )}
                      >
                        {usable && <GripVertical className="hidden h-4 w-4 shrink-0 text-muted-foreground lg:block" />}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={template.thumbnailUrl} alt="" loading="lazy" decoding="async" className="h-12 w-9 shrink-0 rounded-sm bg-muted object-cover" />
                        <span className="min-w-0 flex-1 space-y-0.5">
                          <span className="block truncate text-[12px] font-medium text-foreground">{template.label}</span>
                          <span className="block truncate text-[10px] text-muted-foreground">
                            {template.aspectLabel} · {template.contentTypeLabels.length > 0 ? template.contentTypeLabels.join(', ') : 'any content'}
                          </span>
                          <span className="flex flex-wrap gap-1">
                            {!template.isActive && <Tag variant="slate" className="px-1.5 text-[9px]">Inactive</Tag>}
                            {!template.approved && <Tag variant="slate" className="px-1.5 text-[9px]">Not approved</Tag>}
                            {usable && template.aspectFit === 'mismatch' && <Tag variant="amber" className="px-1.5 text-[9px]">Different shape</Tag>}
                            {(template.autoDays > 0 || template.manualDays > 0) && (
                              <span className="text-[10px] text-muted-foreground">{template.autoDays + template.manualDays} day(s)</span>
                            )}
                          </span>
                        </span>
                        {chosen && <Check className="h-4 w-4 shrink-0 text-brand-to" />}
                      </button>
                    </li>
                  );
                })}
                {templates.filter((template) => template.inVertical).length === 0 && (
                  <li className="text-[12px] text-muted-foreground">This vertical has no templates yet.</li>
                )}
              </ul>
            </aside>

            {/* Days */}
            <div className="order-2 min-w-0 space-y-2 lg:order-1">
              <div className="flex flex-wrap gap-1.5">
                {(
                  [
                    ['all', `All (${days.length})`],
                    ['unmapped', `Unmapped (${summary.unmapped})`],
                    ['attention', `Needs attention (${attentionDays.length})`],
                    ['manual', `Manual (${summary.manual})`],
                    ['auto', `Auto (${summary.auto})`],
                  ] as const
                ).map(([value, label]) => (
                  <Button key={value} size="sm" variant={dayFilter === value ? 'secondary' : 'ghost'} onClick={() => setDayFilter(value)}>
                    {label}
                  </Button>
                ))}
              </div>

              <div className="flex flex-wrap items-end gap-2">
                <Button size="sm" variant="outline" onClick={() => setSelectedDays(new Set(visibleDays.map((day) => day.dayNumber)))}>
                  Select shown ({visibleDays.length})
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSelectedDays(new Set())} disabled={selectedDays.size === 0}>
                  Clear selection
                </Button>
                <span className="flex items-end gap-1.5">
                  <span className="space-y-1">
                    <label htmlFor="map-from" className="block text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                      From day
                    </label>
                    <Input id="map-from" type="number" min={1} max={summary.total} value={fromText} onChange={(event) => setFromText(event.target.value)} className="h-8 w-20" />
                  </span>
                  <span className="space-y-1">
                    <label htmlFor="map-to" className="block text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                      To day
                    </label>
                    <Input id="map-to" type="number" min={1} max={summary.total} value={toText} onChange={(event) => setToText(event.target.value)} className="h-8 w-20" />
                  </span>
                  {!patternMode && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!rangeValid}
                      onClick={() => setSelectedDays(new Set(Array.from({ length: to - from + 1 }, (_, i) => from + i)))}
                    >
                      Select days {rangeValid ? `${from}–${to}` : ''}
                    </Button>
                  )}
                </span>
              </div>

              <ol className="max-h-[36rem] divide-y divide-border overflow-y-auto rounded-md border border-border">
                {visibleDays.map((day) => {
                  const selected = selectedDays.has(day.dayNumber);
                  const issue = day.issues.find((candidate) => candidate.severity === 'action') ?? day.issues[0];
                  return (
                    <li
                      key={day.dayNumber}
                      data-map-day={day.dayNumber}
                      onDragOver={(event) => {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = 'copy';
                        if (dragOverDay !== day.dayNumber) setDragOverDay(day.dayNumber);
                      }}
                      onDragLeave={() => setDragOverDay((current) => (current === day.dayNumber ? null : current))}
                      onDrop={(event) => onDrop(event, day.dayNumber)}
                      className={cn(selected && 'bg-accent/60', dragOverDay === day.dayNumber && 'bg-primary/15 ring-1 ring-inset ring-primary')}
                    >
                      <label className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-1 px-3 py-2">
                        <input type="checkbox" checked={selected} onChange={() => toggleDay(day.dayNumber)} className="mt-1 h-4 w-4" aria-label={`Select day ${day.dayNumber}`} />
                        <span className="min-w-0 space-y-1">
                          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span className="text-[12px] font-semibold text-foreground">Day {day.dayNumber}</span>
                            <span className="font-mono text-[10px] text-muted-foreground">{day.dateLabel}</span>
                            {day.contentTypeLabel && (
                              <span className="text-[10px] text-muted-foreground">
                                {day.contentTypeLabel}
                                {day.contentTypePlanned ? ' (planned)' : ''}
                              </span>
                            )}
                          </span>
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className={cn('min-w-0 truncate text-[12px]', day.templateId ? 'text-foreground' : 'text-muted-foreground')}>
                              Template: {labelOf(day.templateId) ?? 'not assigned'}
                            </span>
                            <MappingSourceBadge source={day.source} />
                            {day.overridesAuto && <span className="text-[10px] text-muted-foreground">overrides auto</span>}
                          </span>
                          {day.ignoredSuggestionId && (
                            <span className="block text-[10px] text-muted-foreground">Auto suggestion {labelOf(day.ignoredSuggestionId)} is not used in Manual mode.</span>
                          )}
                          {issue && (
                            <span className={cn('flex items-start gap-1 text-[11px]', issue.severity === 'action' ? 'text-warning-ink' : 'text-muted-foreground')}>
                              <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                              {issue.title}
                            </span>
                          )}
                          {day.unmappedReason && (
                            <span className="flex items-start gap-1 text-[11px] text-warning-ink">
                              <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                              No compatible template — {day.unmappedReason}
                            </span>
                          )}
                        </span>
                      </label>
                    </li>
                  );
                })}
                {visibleDays.length === 0 && <li className="px-3 py-6 text-center text-[12px] text-muted-foreground">No days in this view.</li>}
              </ol>
            </div>
          </div>

          {/* Step 3 — kept in reach at the bottom of a phone screen. */}
          <div className="sticky bottom-0 z-10 space-y-2 rounded-md border border-border bg-background/95 p-2.5 shadow-sm backdrop-blur">
            {patternMode ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[12px] text-foreground">Pattern:</span>
                {pattern.length === 0 && <span className="text-[12px] text-muted-foreground">tap templates in order</span>}
                {pattern.map((id, index) => (
                  <Tag key={`${id}-${index}`} variant="outline" className="normal-case tracking-normal">
                    {index + 1}. {labelOf(id)}
                    <button type="button" aria-label={`Remove ${labelOf(id)} from pattern`} onClick={() => setPattern((current) => current.filter((_, i) => i !== index))}>
                      <X className="h-3 w-3" />
                    </button>
                  </Tag>
                ))}
                <Button size="sm" onClick={() => void applyPattern()} disabled={busy || pattern.length === 0 || !rangeValid}>
                  {assign.pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Repeat className="h-4 w-4" />}
                  Repeat across days {rangeValid ? `${from}–${to}` : ''}
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 text-[12px] text-foreground">
                  {selectedTemplate ? <span className="font-medium">{labelOf(selectedTemplate)}</span> : <span className="text-muted-foreground">No template selected</span>}{' '}
                  → {selectedDays.size} {selectedDays.size === 1 ? 'day' : 'days'} selected
                </span>
                <Button size="sm" onClick={() => void assignTo([...selectedDays], selectedTemplate)} disabled={busy || !selectedTemplate || selectedDays.size === 0}>
                  {assign.pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  Apply to {selectedDays.size} {selectedDays.size === 1 ? 'day' : 'days'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void assignTo([...selectedDays], null)} disabled={busy || selectedDays.size === 0}>
                  Clear manual template
                </Button>
              </div>
            )}
            <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <input type="checkbox" checked={skipManual} onChange={(event) => setSkipManual(event.target.checked)} />
              Keep days that already have a manual template
            </label>
          </div>
        </section>
      )}
    </div>
  );
}
