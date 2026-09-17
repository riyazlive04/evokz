import type { TemplateMappingMode } from '@prisma/client';

import { effectiveTemplateId } from '@/lib/campaign/model';

/**
 * Campaign template mapping — the pure rules of Phase 3.
 *
 * Decides which template each campaign day uses. No database, no
 * network, no poster: `template-mapping-service.ts` loads rows into these shapes
 * and writes the results back, and `npm run check:campaign-mapping` pins every
 * rule here without a database.
 *
 * Storage is Phase 1's, unchanged: `ContentCalendar.posterTemplateId` is the
 * operator's selection (MANUAL) and `suggestedTemplateId` the mapper's (AUTO).
 * Auto Map only ever writes the suggestion, so a manual selection cannot be
 * overwritten by construction — the planner never produces a write for a day
 * that has one. `effectiveTemplateId` (model.ts) still decides which counts.
 */

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export type MappingSource = 'AUTO' | 'MANUAL';

/** One template as the mapper sees it. */
export interface MappingTemplate {
  id: string;
  label: string;
  categoryId: string;
  isActive: boolean;
  /**
   * Width ÷ height of the template image, measured at upload. 0 means
   * unmeasured: it fits any campaign, ranked after a measured match.
   */
  aspect: number;
}

/** One campaign day as the mapper sees it. */
export interface MappingDay {
  id: string;
  dayNumber: number;
  /**
   * The day's content type: its stored value, else the strategy's planned type
   * for that day number (`planContentTypes` is deterministic and is what the
   * generator will write), else null.
   */
  contentType: string | null;
  posterTemplateId: string | null;
  suggestedTemplateId: string | null;
}

export interface MappingTarget {
  /** The campaign's vertical. Templates from any other are never usable. */
  categoryId: string;
  mode: TemplateMappingMode;
  /** Width ÷ height of the client's output preset. */
  aspect: number;
  /** "9:16" — for messages. */
  aspectLabel: string;
}

// ---------------------------------------------------------------------------
// Compatibility
// ---------------------------------------------------------------------------

/** Two aspects within 2% of each other are the same shape (1080×1920 vs 1080×1918). */
export const ASPECT_TOLERANCE = 0.02;

export type AspectFit = 'match' | 'unmeasured' | 'mismatch';

export function aspectFit(templateAspect: number, targetAspect: number): AspectFit {
  if (!Number.isFinite(templateAspect) || templateAspect <= 0) return 'unmeasured';
  if (!Number.isFinite(targetAspect) || targetAspect <= 0) return 'match';
  return Math.abs(templateAspect / targetAspect - 1) <= ASPECT_TOLERANCE ? 'match' : 'mismatch';
}

export type TemplateBlocker = 'wrong-vertical' | 'inactive';

/**
 * Why a template may not be assigned to any day of this campaign, or null.
 *
 * There is no approval: an uploaded template is usable, and being active is the
 * only switch an admin has.
 */
export function templateBlocker(template: MappingTemplate, target: Pick<MappingTarget, 'categoryId'>): TemplateBlocker | null {
  if (template.categoryId !== target.categoryId) return 'wrong-vertical';
  if (!template.isActive) return 'inactive';
  return null;
}

/** Whether Auto Map may put this template on a day of this campaign. */
export function isAutoCompatible(template: MappingTemplate, target: MappingTarget): boolean {
  return templateBlocker(template, target) === null && aspectFit(template.aspect, target.aspect) !== 'mismatch';
}

const NAMED_ASPECTS: ReadonlyArray<readonly [string, number]> = [
  ['9:16', 9 / 16],
  ['2:3', 2 / 3],
  ['3:4', 3 / 4],
  ['4:5', 4 / 5],
  ['1:1', 1],
  ['5:4', 5 / 4],
  ['4:3', 4 / 3],
  ['3:2', 3 / 2],
  ['1.91:1', 1.91],
  ['16:9', 16 / 9],
];

/** "9:16", "1:1", or "0.70:1" for a shape with no common name; "unmeasured" for 0. */
export function describeAspect(aspect: number): string {
  if (!Number.isFinite(aspect) || aspect <= 0) return 'unmeasured';
  const named = NAMED_ASPECTS.find(([, value]) => Math.abs(aspect / value - 1) <= ASPECT_TOLERANCE);
  return named ? named[0] : `${aspect.toFixed(2)}:1`;
}

// ---------------------------------------------------------------------------
// A day's current mapping
// ---------------------------------------------------------------------------

export type MappingIssueCode =
  | 'template-wrong-vertical'
  | 'template-inactive'
  | 'template-missing'
  | 'aspect-mismatch'
  | 'no-compatible-template';

export interface MappingIssue {
  code: MappingIssueCode;
  /** `action` needs a person (or an Auto Map run); `warning` is a deliberate choice worth seeing. */
  severity: 'action' | 'warning';
  /** Short, e.g. "Template inactive — action required". */
  title: string;
  /** One sentence naming what is wrong and what to do. */
  detail: string;
}

export interface DayMappingState {
  /** The template this day's poster would be drawn from, or null. */
  templateId: string | null;
  source: MappingSource | null;
  /** An operator's selection that differs from a stored AUTO suggestion. */
  overridesAuto: boolean;
  /** A stored suggestion that MANUAL mode does not use. */
  ignoredSuggestionId: string | null;
  /** Problems with the current mapping (not `no-compatible-template`; see `diagnoseUnmapped`). */
  issues: MappingIssue[];
}

/**
 * The effective mapping of one day and what is wrong with it.
 *
 * Nothing here changes anything. In particular a deactivated template stays
 * assigned and is reported as needing action — replacing it is
 * always an explicit operator choice or an Auto Map run the operator previewed.
 */
export function dayMappingState(
  day: MappingDay,
  templatesById: ReadonlyMap<string, MappingTemplate>,
  target: MappingTarget,
): DayMappingState {
  const templateId = effectiveTemplateId(target.mode, day);
  const source: MappingSource | null = day.posterTemplateId ? 'MANUAL' : templateId ? 'AUTO' : null;
  const state: DayMappingState = {
    templateId,
    source,
    overridesAuto: Boolean(day.posterTemplateId && day.suggestedTemplateId && day.posterTemplateId !== day.suggestedTemplateId),
    ignoredSuggestionId: target.mode === 'MANUAL' && !day.posterTemplateId ? day.suggestedTemplateId : null,
    issues: [],
  };
  if (!templateId || !source) return state;

  const template = templatesById.get(templateId);
  if (!template) {
    state.issues.push({
      code: 'template-missing',
      severity: 'action',
      title: 'Template unavailable — action required',
      detail: 'The assigned template could not be found. Choose another.',
    });
    return state;
  }

  const name = `“${template.label}”`;
  const blocker = templateBlocker(template, target);
  if (blocker === 'wrong-vertical') {
    state.issues.push({
      code: 'template-wrong-vertical',
      severity: 'action',
      title: 'Template from another vertical — action required',
      detail: `${name} belongs to a different vertical from this campaign's. Choose a replacement.`,
    });
  } else if (blocker === 'inactive') {
    state.issues.push({
      code: 'template-inactive',
      severity: 'action',
      title: 'Template inactive — action required',
      detail: `${name} was deactivated. It stays assigned until you choose a replacement.`,
    });
  }

  // A person may pin a template that is the wrong shape on purpose; the mapper
  // never does, so on an AUTO mapping the same finding needs action.
  if (aspectFit(template.aspect, target.aspect) === 'mismatch') {
    state.issues.push({
      code: 'aspect-mismatch',
      severity: source === 'MANUAL' ? 'warning' : 'action',
      title: source === 'MANUAL' ? 'Different shape' : 'Different shape — action required',
      detail: `${name} is a ${describeAspect(template.aspect)} template; this client's output is ${target.aspectLabel}.`,
    });
  }
  return state;
}

/** Whether a day's current mapping needs a person. */
export function needsAction(state: DayMappingState): boolean {
  return state.issues.some((issue) => issue.severity === 'action');
}

/**
 * Why no template could be automatically mapped to this day, or null when at
 * least one is compatible. The narrowest failing rule is named, so the fix is
 * obvious: upload or activate a template, or add one of the right shape.
 */
export function diagnoseUnmapped(
  templates: readonly MappingTemplate[],
  target: MappingTarget,
): MappingIssue | null {
  const inVertical = templates.filter((template) => template.categoryId === target.categoryId);
  const usable = inVertical.filter((template) => templateBlocker(template, target) === null);
  const shaped = usable.filter((template) => aspectFit(template.aspect, target.aspect) !== 'mismatch');
  if (shaped.length > 0) return null;

  let detail: string;
  if (inVertical.length === 0) {
    detail = 'This vertical has no templates yet.';
  } else if (usable.length === 0) {
    detail = `None of the vertical's ${inVertical.length} template(s) is active.`;
  } else {
    const shapes = [...new Set(usable.map((template) => describeAspect(template.aspect)))].join(', ');
    detail = `No active template is ${target.aspectLabel} (available: ${shapes}).`;
  }
  return { code: 'no-compatible-template', severity: 'action', title: 'No compatible template', detail };
}

// ---------------------------------------------------------------------------
// Auto Map
// ---------------------------------------------------------------------------

/**
 * `fill` keeps every AUTO mapping that is still valid and maps only the days
 * without one (or whose one became invalid). `rebalance` also re-picks valid
 * AUTO mappings — for a vertical that has gained templates since the last run.
 * Neither ever touches a MANUAL selection.
 */
export type AutoMapScope = 'fill' | 'rebalance';

export type AutoMapOutcome =
  /** An operator's selection. Never changed by Auto Map. */
  | 'manual'
  /** Already mapped to this template; nothing changes. */
  | 'keep'
  /** Unmapped today; gets a template. */
  | 'new'
  /** An AUTO mapping replaced by a different template. */
  | 'replace'
  /** No compatible template; stays (or becomes) unmapped. */
  | 'unmapped';

export interface AutoMapEntry {
  dayId: string;
  dayNumber: number;
  outcome: AutoMapOutcome;
  /** Effective template before applying, under the campaign's current mode. */
  currentTemplateId: string | null;
  currentSource: MappingSource | null;
  /** Effective template after applying (the campaign is AUTO after an apply). */
  templateId: string | null;
  /** `suggestedTemplateId` after applying. */
  suggestedTemplateId: string | null;
  /** What was wrong with the current mapping, when that is why it changes — or, on a manual day, why it needs a person. */
  conflict: MappingIssue | null;
  /** On a manual day in conflict: what Auto Map would choose. Shown, never applied. */
  replacementTemplateId: string | null;
  /** On an unmapped day: why. */
  unmappedReason: MappingIssue | null;
  /** The chosen template repeats the previous day because nothing else compatible was left. */
  repeatsPreviousDay: boolean;
  /** Applying writes `suggestedTemplateId` on this row. */
  writesSuggestion: boolean;
  /** Applying changes the day's effective template (and so its `contentRevision`). */
  effectiveChanges: boolean;
}

export interface AutoMapPlan {
  scope: AutoMapScope;
  /** Applying switches a MANUAL campaign to AUTO, because suggestions only count under AUTO. */
  switchesMode: boolean;
  entries: AutoMapEntry[];
  counts: Record<AutoMapOutcome, number> & { conflicts: number; changes: number };
  /** Identifies exactly the writes this plan makes; apply refuses if a fresh plan differs. */
  fingerprint: string;
}

/**
 * Plans Auto Map. Deterministic: identical inputs give an identical plan, with
 * no randomness anywhere — ties break on usage, then on how long ago a template
 * was last used, then on template order (`templates` in upload order).
 *
 * For each day that is eligible, in day order, only compatible templates are
 * considered — active, same vertical, a shape that fits. Those are hard rules.
 * Among them, ranked:
 *
 *   1. not the previous day's or the next fixed day's template (a repeat is
 *      unnecessary while any other compatible template exists);
 *   2. a measured matching shape before an unmeasured one;
 *   3. fewest days already using it in this campaign;
 *   4. least recently used;
 *   5. upload order.
 *
 * A day with no compatible template is left unmapped with the reason — an
 * incompatible template is never assigned to fill a gap.
 */
export function planAutoMap(input: {
  days: readonly MappingDay[];
  /** The vertical's templates, in upload order, plus any template a day references. */
  templates: readonly MappingTemplate[];
  target: MappingTarget;
  scope?: AutoMapScope;
}): AutoMapPlan {
  const scope = input.scope ?? 'fill';
  const { target } = input;
  const days = [...input.days].sort((a, b) => a.dayNumber - b.dayNumber);
  const byId = new Map(input.templates.map((template) => [template.id, template]));
  const order = new Map(input.templates.map((template, index) => [template.id, index]));
  const candidatesPool = input.templates.filter((template) => template.categoryId === target.categoryId);

  // A day is eligible unless it has a manual selection, or (under `fill`) an
  // AUTO suggestion that is still compatible with it.
  const keepsSuggestion = (day: MappingDay): boolean => {
    if (scope === 'rebalance' || !day.suggestedTemplateId) return false;
    const template = byId.get(day.suggestedTemplateId);
    return template !== undefined && isAutoCompatible(template, target);
  };

  // Templates whose day is settled before the walk: manual selections and kept suggestions.
  const fixed = new Map<number, string>();
  for (const day of days) {
    if (day.posterTemplateId) fixed.set(day.dayNumber, day.posterTemplateId);
    else if (keepsSuggestion(day)) fixed.set(day.dayNumber, day.suggestedTemplateId!);
  }

  const usage = new Map<string, number>();
  for (const templateId of fixed.values()) usage.set(templateId, (usage.get(templateId) ?? 0) + 1);
  const lastUsed = new Map<string, number>();

  const rank = (previous: string | null, next: string | null): MappingTemplate[] =>
    candidatesPool
      .filter((template) => isAutoCompatible(template, target))
      .map((template) => ({
        template,
        key: [
          template.id === previous || template.id === next ? 1 : 0,
          aspectFit(template.aspect, target.aspect) === 'match' ? 0 : 1,
          usage.get(template.id) ?? 0,
          lastUsed.get(template.id) ?? Number.NEGATIVE_INFINITY,
          order.get(template.id) ?? Number.MAX_SAFE_INTEGER,
        ],
      }))
      .sort((a, b) => {
        for (let index = 0; index < a.key.length; index += 1) {
          if (a.key[index] !== b.key[index]) return a.key[index]! - b.key[index]!;
        }
        return 0;
      })
      .map((entry) => entry.template);

  const entries: AutoMapEntry[] = [];
  let previousTemplate: string | null = null;
  let previousDayNumber: number | null = null;

  days.forEach((day, index) => {
    const state = dayMappingState(day, byId, target);
    const adjacentPrevious = previousDayNumber === day.dayNumber - 1 ? previousTemplate : null;
    const nextDay = days[index + 1];
    const nextFixed = nextDay && nextDay.dayNumber === day.dayNumber + 1 ? (fixed.get(nextDay.dayNumber) ?? null) : null;

    const base = {
      dayId: day.id,
      dayNumber: day.dayNumber,
      currentTemplateId: state.templateId,
      currentSource: state.source,
      replacementTemplateId: null as string | null,
      unmappedReason: null as MappingIssue | null,
      repeatsPreviousDay: false,
    };

    if (day.posterTemplateId) {
      const conflict = state.issues.find((issue) => issue.severity === 'action') ?? null;
      entries.push({
        ...base,
        outcome: 'manual',
        templateId: day.posterTemplateId,
        suggestedTemplateId: day.suggestedTemplateId,
        conflict,
        replacementTemplateId: conflict ? (rank(adjacentPrevious, nextFixed)[0]?.id ?? null) : null,
        writesSuggestion: false,
        effectiveChanges: false,
      });
      previousTemplate = day.posterTemplateId;
    } else {
      let chosen: string | null;
      if (keepsSuggestion(day)) {
        chosen = day.suggestedTemplateId;
      } else {
        chosen = rank(adjacentPrevious, nextFixed)[0]?.id ?? null;
        if (chosen) usage.set(chosen, (usage.get(chosen) ?? 0) + 1);
      }

      const current = state.templateId;
      const outcome: AutoMapOutcome = chosen === null ? 'unmapped' : current === null ? 'new' : current === chosen ? 'keep' : 'replace';
      // The reason a current AUTO mapping had to go, when it did.
      const conflict = state.source === 'AUTO' && current !== chosen ? (state.issues[0] ?? null) : null;

      entries.push({
        ...base,
        outcome,
        templateId: chosen,
        suggestedTemplateId: chosen,
        conflict,
        unmappedReason: chosen === null ? diagnoseUnmapped(input.templates, target) : null,
        repeatsPreviousDay: chosen !== null && chosen === adjacentPrevious && !keepsSuggestion(day),
        writesSuggestion: chosen !== day.suggestedTemplateId,
        effectiveChanges: chosen !== current,
      });
      previousTemplate = chosen;
    }

    previousDayNumber = day.dayNumber;
    if (previousTemplate) lastUsed.set(previousTemplate, day.dayNumber);
  });

  const counts = { manual: 0, keep: 0, new: 0, replace: 0, unmapped: 0, conflicts: 0, changes: 0 };
  for (const entry of entries) {
    counts[entry.outcome] += 1;
    if (entry.conflict) counts.conflicts += 1;
    if (entry.writesSuggestion || entry.effectiveChanges) counts.changes += 1;
  }

  const switchesMode = target.mode === 'MANUAL';
  return {
    scope,
    switchesMode,
    entries,
    counts,
    fingerprint: fingerprintOf(
      [
        target.mode,
        ...entries
          .filter((entry) => entry.writesSuggestion || entry.effectiveChanges)
          .map((entry) => `${entry.dayId}:${entry.suggestedTemplateId ?? '-'}:${entry.effectiveChanges ? 1 : 0}`),
      ].join('|'),
    ),
  };
}

/** cyrb53 — a stable 53-bit string hash. Identifies a plan; not a security boundary. */
export function fingerprintOf(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// ---------------------------------------------------------------------------
// Manual and bulk mapping
// ---------------------------------------------------------------------------

/** How an operator names the days a manual mapping applies to. */
export type ManualAssignment =
  /** One template (or null to clear) on the listed days: "Day 2, 5, 8, 11 → T4". */
  | { kind: 'days'; dayNumbers: number[]; templateId: string | null }
  /** One template (or null to clear) on a span: "Days 1–30 → T2". */
  | { kind: 'range'; fromDay: number; toDay: number; templateId: string | null }
  /** Templates in turn across a span: "T1 → day 1, T2 → day 2, T3 → day 3, repeat". */
  | { kind: 'pattern'; fromDay: number; toDay: number; templateIds: string[] };

export const MAX_PATTERN_TEMPLATES = 50;

export type ExpandedAssignment =
  | { ok: true; items: Array<{ dayNumber: number; templateId: string | null }> }
  | { ok: false; error: string };

/** The per-day writes an assignment means, validated against the campaign's length. */
export function expandManualAssignment(assignment: ManualAssignment, durationDays: number): ExpandedAssignment {
  const inCampaign = (n: number) => Number.isInteger(n) && n >= 1 && n <= durationDays;

  if (assignment.kind === 'days') {
    if (assignment.dayNumbers.length === 0) return { ok: false, error: 'Select at least one day.' };
    const seen = new Set<number>();
    for (const n of assignment.dayNumbers) {
      if (!inCampaign(n)) return { ok: false, error: `Day ${n} is not in this ${durationDays}-day campaign.` };
      if (seen.has(n)) return { ok: false, error: `Day ${n} is listed twice.` };
      seen.add(n);
    }
    return {
      ok: true,
      items: [...seen].sort((a, b) => a - b).map((dayNumber) => ({ dayNumber, templateId: assignment.templateId })),
    };
  }

  if (!inCampaign(assignment.fromDay) || !inCampaign(assignment.toDay) || assignment.fromDay > assignment.toDay) {
    return { ok: false, error: `Choose a range within days 1–${durationDays}.` };
  }
  const span = Array.from({ length: assignment.toDay - assignment.fromDay + 1 }, (_, i) => assignment.fromDay + i);

  if (assignment.kind === 'range') {
    return { ok: true, items: span.map((dayNumber) => ({ dayNumber, templateId: assignment.templateId })) };
  }

  if (assignment.templateIds.length === 0) return { ok: false, error: 'Choose the templates to repeat.' };
  if (assignment.templateIds.length > MAX_PATTERN_TEMPLATES) {
    return { ok: false, error: `A pattern repeats at most ${MAX_PATTERN_TEMPLATES} templates.` };
  }
  return {
    ok: true,
    items: span.map((dayNumber, index) => ({
      dayNumber,
      templateId: assignment.templateIds[index % assignment.templateIds.length]!,
    })),
  };
}

/** "day 4", "days 1–30", "days 2, 5, 8", "days 1, 3, 5, 7, 9 and 57 more". */
export function describeDays(dayNumbers: readonly number[]): string {
  const sorted = [...new Set(dayNumbers)].sort((a, b) => a - b);
  if (sorted.length === 0) return 'no days';
  if (sorted.length === 1) return `day ${sorted[0]}`;
  const contiguous = sorted.every((n, i) => i === 0 || n === sorted[i - 1]! + 1);
  if (contiguous) return `days ${sorted[0]}–${sorted[sorted.length - 1]}`;
  return sorted.length <= 6 ? `days ${sorted.join(', ')}` : `days ${sorted.slice(0, 5).join(', ')} and ${sorted.length - 5} more`;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export interface MappingSummary {
  total: number;
  mapped: number;
  auto: number;
  manual: number;
  /** Manual selections that replaced a different AUTO suggestion. */
  overridden: number;
  unmapped: number;
  /** Days needing a person, in day order, with the first reason. */
  attention: Array<{ dayNumber: number; issue: MappingIssue }>;
}

export function summarizeMapping(
  rows: ReadonlyArray<{ dayNumber: number; state: DayMappingState; unmappedReason: MappingIssue | null }>,
): MappingSummary {
  const summary: MappingSummary = { total: rows.length, mapped: 0, auto: 0, manual: 0, overridden: 0, unmapped: 0, attention: [] };
  for (const row of [...rows].sort((a, b) => a.dayNumber - b.dayNumber)) {
    if (row.state.templateId) {
      summary.mapped += 1;
      if (row.state.source === 'MANUAL') summary.manual += 1;
      else summary.auto += 1;
    } else {
      summary.unmapped += 1;
    }
    if (row.state.overridesAuto) summary.overridden += 1;
    const issue = row.state.issues.find((candidate) => candidate.severity === 'action') ?? row.unmappedReason;
    if (issue) summary.attention.push({ dayNumber: row.dayNumber, issue });
  }
  return summary;
}
