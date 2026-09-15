/**
 * Database checks for campaign template mapping (Phase 3).
 *
 * Runs `src/lib/campaign/template-mapping-service.ts`, the Phase 3 campaign
 * server actions and the template delete guard against the development
 * database. No poster is generated and no provider is called.
 *
 * How it stays harmless (the `check:calendar-scope` technique):
 *   - The app's shared Prisma client (`globalThis.prisma`) is replaced by a
 *     facade over ONE interactive transaction that is always rolled back; table
 *     row counts are compared before and after.
 *   - `fetch` is stubbed and counted, provider credentials are blanked, and the
 *     suite asserts zero network attempts.
 *   - Refuses to run unless DATABASE_URL is a local development database.
 *
 * Run: npm run check:campaign-mapping-db
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import { Prisma, PrismaClient } from '@prisma/client';

(globalThis as unknown as { AsyncLocalStorage: typeof AsyncLocalStorage }).AsyncLocalStorage = AsyncLocalStorage;

for (const key of ['OPENAI_API_KEY', 'FAL_KEY', 'EVOLUTION_API_KEY', 'EVOLUTION_API_URL', 'GOOGLE_PRIVATE_KEY', 'GOOGLE_SERVICE_ACCOUNT_EMAIL']) {
  process.env[key] = '';
}
let networkAttempts = 0;
globalThis.fetch = (async () => {
  networkAttempts += 1;
  throw new Error('network disabled by check:campaign-mapping-db');
}) as typeof fetch;

{
  let host = '';
  let database = '';
  try {
    const url = new URL(process.env.DATABASE_URL ?? '');
    host = url.hostname;
    database = url.pathname.replace(/^\//, '');
  } catch {
    // Refused below.
  }
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host) || !/dev/i.test(database)) {
    console.error(`Refusing to run: DATABASE_URL must be a local development database (got host "${host || '?'}", database "${database || '?'}").`);
    process.exit(2);
  }
  console.log(`database: ${database} @ ${host}`);
}

let bad = 0;
const t = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) bad += 1;
};
const section = (title: string) => console.log(`\n--- ${title} ${'-'.repeat(Math.max(0, 58 - title.length))}`);
const snapshot = (value: unknown) => JSON.stringify(value);

class Rollback extends Error {}

// ---- Transaction facade (see check-calendar-scope.ts) ------------------------

const realPrisma = new PrismaClient();
let activeTx: Prisma.TransactionClient | null = null;

const facade: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    if (prop === '$transaction') {
      return async (arg: unknown) => {
        if (Array.isArray(arg)) {
          const results: unknown[] = [];
          for (const operation of arg) results.push(await operation);
          return results;
        }
        if (typeof arg === 'function') return (arg as (tx: PrismaClient) => unknown)(facade);
        throw new Error('Unsupported $transaction argument');
      };
    }
    if (!activeTx) throw new Error('No active check transaction');
    const value = Reflect.get(activeTx, prop) as unknown;
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(activeTx) : value;
  },
});
(globalThis as unknown as { prisma: PrismaClient }).prisma = facade;

type AsyncStorage = { run<T>(store: object, fn: () => T): T };
let requestStore: AsyncStorage;
async function asAction<T>(work: () => Promise<T>): Promise<T> {
  return requestStore.run({ incrementalCache: {}, urlPathname: '/admin/check', isStaticGeneration: false }, work);
}

// ---------------------------------------------------------------------------

async function suite(): Promise<void> {
  const tx = facade;
  const { SAMPLE_LAYOUT_SPEC } = await import('@/lib/poster/sample-layout');
  const { isVersionCurrent } = await import('@/lib/campaign/model');
  const service = await import('@/lib/campaign/service');
  const mapping = await import('@/lib/campaign/template-mapping-service');
  const campaignActions = await import('@/app/admin/campaigns/actions');
  const dashboardActions = await import('@/app/admin/dashboard/actions');
  const { LEGACY_CALENDAR } = await import('@/lib/calendar-scope');
  const { CampaignDomainError, addPosterVersion, changeCampaignStatus, createCampaign, selectDayTemplate } = service;

  const noHtml = { htmlAspectFor: async () => null };
  async function expectDomainError(name: string, code: string, work: () => Promise<unknown>) {
    try {
      await work();
      t(name, false, 'succeeded but should have failed');
    } catch (error) {
      t(name, error instanceof CampaignDomainError && error.code === code, error instanceof Error ? error.message : String(error));
    }
  }

  const TZ = 'Asia/Kolkata';
  const start = new Date('2026-11-01T00:00:00+05:30');
  const base = Date.parse('2026-01-01T00:00:00Z');
  const portrait = { ...SAMPLE_LAYOUT_SPEC, aspect: 9 / 16 } as unknown as Prisma.InputJsonValue;
  const square = { ...SAMPLE_LAYOUT_SPEC, aspect: 1 } as unknown as Prisma.InputJsonValue;

  const plan30 = await tx.plan.create({ data: { name: 'check:map 30', durationDays: 30 } });
  const vertical = await tx.category.create({
    data: {
      name: 'check:map Vertical',
      contentStrategy: {
        pillars: [
          { key: 'educational', label: 'Educational', weight: 3, guidance: 'Teach.' },
          { key: 'tips', label: 'Tips', weight: 2, guidance: 'Advise.' },
          { key: 'promo', label: 'Promotional', weight: 1, guidance: 'Invite.', promotional: true },
        ],
      },
    },
  });
  const otherVertical = await tx.category.create({ data: { name: 'check:map Other vertical' } });
  const emptyVertical = await tx.category.create({ data: { name: 'check:map Empty vertical' } });

  let order = 0;
  const template = (label: string, data: Partial<Prisma.CategoryTemplateUncheckedCreateInput> = {}) =>
    tx.categoryTemplate.create({
      data: {
        categoryId: vertical.id,
        label: `check:map ${label}`,
        gDriveFileId: `fixture-map-${label}`,
        gDriveViewUrl: 'https://drive.invalid/t',
        mimeType: 'image/png',
        width: 1080,
        height: 1920,
        layoutSpec: portrait,
        layoutApprovedAt: new Date(base),
        createdAt: new Date(base + (order += 1) * 1000),
        ...data,
      },
    });
  const tA = await template('A');
  const tB = await template('B');
  const tC = await template('C promo', { contentTypes: ['promo'] });
  const tInactive = await template('Inactive', { isActive: false });
  const tDraft = await template('Draft', { layoutApprovedAt: null });
  const tSquare = await template('Square', { layoutSpec: square, width: 1080, height: 1080 });
  const tForeign = await template('Foreign', { categoryId: otherVertical.id });
  await template('Empty draft', { categoryId: emptyVertical.id, layoutApprovedAt: null });

  const client = (name: string, data: Partial<Prisma.ClientUncheckedCreateInput> = {}) =>
    tx.client.create({
      data: { companyName: `check:map ${name}`, whatsappNumber: '910000000321', startDate: start, endDate: start, planId: plan30.id, categoryId: vertical.id, isDemo: true, isActive: false, imageSizePreset: 'whatsapp-status', ...data },
    });
  const clientA = await client('A');
  const clientC = await client('C');
  const clientS = await client('Square', { imageSizePreset: 'instagram-square' });
  const clientE = await client('Empty', { categoryId: emptyVertical.id });
  const clientM = await client('Manual');
  const legacy = await client('Legacy');

  const campaignA = (await createCampaign(tx, { clientId: clientA.id, name: 'A', startDate: start, timeZone: TZ })).campaignId;
  const campaignC = (await createCampaign(tx, { clientId: clientC.id, name: 'C', startDate: start, timeZone: TZ })).campaignId;
  const campaignS = (await createCampaign(tx, { clientId: clientS.id, name: 'S', startDate: start, durationDays: 10, timeZone: TZ })).campaignId;
  const campaignE = (await createCampaign(tx, { clientId: clientE.id, name: 'E', startDate: start, durationDays: 5, timeZone: TZ })).campaignId;
  const campaignM = (await createCampaign(tx, { clientId: clientM.id, name: 'M', startDate: start, durationDays: 6, templateMappingMode: 'MANUAL', timeZone: TZ })).campaignId;

  await tx.contentCalendar.createMany({
    data: [
      { clientId: legacy.id, dayNumber: 1, scheduledDate: start, caption: 'Legacy 1', hashtags: '#l', imagePrompt: 'p', posterTemplateId: tA.id },
      { clientId: legacy.id, dayNumber: 2, scheduledDate: start, caption: 'Legacy 2', hashtags: '#l', imagePrompt: 'p' },
    ],
  });
  const legacyRows = () => tx.contentCalendar.findMany({ where: { clientId: legacy.id }, orderBy: { dayNumber: 'asc' } });
  const legacyBefore = snapshot(await legacyRows());
  const campaignRows = (campaignId: string) => tx.contentCalendar.findMany({ where: { campaignId }, orderBy: { dayNumber: 'asc' } });
  const campaignCBefore = snapshot(await campaignRows(campaignC));
  const day = async (campaignId: string, n: number) => (await service.findCampaignDay(tx, campaignId, n))!;
  const overview = (campaignId: string) => mapping.loadCampaignMappingOverview(tx, campaignId, noHtml);

  // =======================================================================
  section('auto map preview');
  // =======================================================================
  const beforePreview = snapshot(await campaignRows(campaignA));
  const p1 = await mapping.previewAutoMap(tx, campaignA, noHtml);
  const p2 = await mapping.previewAutoMap(tx, campaignA, noHtml);
  t('preview is deterministic (identical plan twice)', snapshot(p1.plan) === snapshot(p2.plan));
  t('preview writes nothing', snapshot(await campaignRows(campaignA)) === beforePreview);
  t('context holds the 30 campaign days and no legacy row', p1.context.days.length === 30);
  t('empty days use the strategy\'s planned content type', p1.context.days.every((d) => d.contentTypeSource === 'planned' && ['educational', 'tips', 'promo'].includes(d.contentType ?? '')));
  t('client output preset gives the 9:16 target', p1.context.target.aspectLabel === '9:16');
  t('all 30 days get a new mapping', p1.plan.counts.new === 30 && p1.plan.counts.unmapped === 0, snapshot(p1.plan.counts));
  const used = new Set(p1.plan.entries.map((entry) => entry.templateId));
  t('inactive, unapproved, wrong-shape and foreign templates are never chosen', ![tInactive.id, tDraft.id, tSquare.id, tForeign.id].some((id) => used.has(id)));
  const typeOf = new Map(p1.context.days.map((d) => [d.dayNumber, d.contentType]));
  t('the promo-tagged template lands only on promo days', p1.plan.entries.every((entry) => entry.templateId !== tC.id || typeOf.get(entry.dayNumber) === 'promo'));
  t('no template on two consecutive days', p1.plan.entries.every((entry, i, all) => i === 0 || entry.templateId !== all[i - 1]!.templateId));

  // =======================================================================
  section('apply auto map');
  // =======================================================================
  await expectDomainError('a stale fingerprint is refused', 'conflict', () => mapping.applyAutoMap(tx, campaignA, { ...noHtml, fingerprint: 'stale' }));
  t('…and writes nothing', snapshot(await campaignRows(campaignA)) === beforePreview);
  const mappedAt = new Date('2026-09-15T10:00:00Z');
  const applied = await mapping.applyAutoMap(tx, campaignA, { ...noHtml, fingerprint: p1.plan.fingerprint, now: mappedAt });
  t('apply writes 30 days and bumps 30 revisions', applied.daysWritten === 30 && applied.revisionsBumped === 30);
  const afterApply = await campaignRows(campaignA);
  t('suggestions stored exactly as previewed', afterApply.every((row) => row.suggestedTemplateId === p1.plan.entries[row.dayNumber - 1]!.templateId));
  t('AUTO mapping time recorded, no manual selection written', afterApply.every((row) => row.templateSuggestedAt?.getTime() === mappedAt.getTime() && row.posterTemplateId === null && row.templateSelectedAt === null));
  t('revision bumped once (effective template changed)', afterApply.every((row) => row.contentRevision === 2));
  const again = await mapping.previewAutoMap(tx, campaignA, noHtml);
  t('running Auto Map again with identical inputs changes nothing', again.plan.counts.keep === 30 && again.plan.counts.changes === 0);
  const noop = await mapping.applyAutoMap(tx, campaignA, { ...noHtml, fingerprint: again.plan.fingerprint });
  t('…and applying it writes nothing', noop.daysWritten === 0 && snapshot(await campaignRows(campaignA)) === snapshot(afterApply));

  // =======================================================================
  section('manual mapping');
  // =======================================================================
  {
    const d4 = await day(campaignA, 4);
    const other = d4.suggestedTemplateId === tA.id ? tB.id : tA.id;
    const selectedAt = new Date('2026-09-15T11:00:00Z');
    const r = await mapping.assignManualTemplates(tx, campaignA, { kind: 'days', dayNumbers: [4], templateId: other }, { ...noHtml, now: selectedAt });
    const after = await day(campaignA, 4);
    t('day 4 → manual template', r.changedDays.join() === '4' && after.posterTemplateId === other && after.templateSelectedAt?.getTime() === selectedAt.getTime());
    t('…the AUTO suggestion is kept beneath it, revision +1', after.suggestedTemplateId === d4.suggestedTemplateId && after.contentRevision === d4.contentRevision + 1);
    const repeat = await mapping.assignManualTemplates(tx, campaignA, { kind: 'days', dayNumbers: [4], templateId: other }, noHtml);
    t('assigning the same template again is a no-op (no duplicate mapping)', repeat.unchanged === 1 && repeat.changedDays.length === 0 && (await day(campaignA, 4)).contentRevision === after.contentRevision);
  }

  // =======================================================================
  section('bulk manual mapping');
  // =======================================================================
  {
    const before = await campaignRows(campaignA);
    const bulk = await mapping.assignManualTemplates(tx, campaignA, { kind: 'days', dayNumbers: [2, 5, 8, 11], templateId: tA.id }, noHtml);
    const after = await campaignRows(campaignA);
    t('days 2, 5, 8, 11 → template A', [2, 5, 8, 11].every((n) => after[n - 1]!.posterTemplateId === tA.id) && bulk.changedDays.join() === '2,5,8,11');
    const expectedBumps = [2, 5, 8, 11].filter((n) => before[n - 1]!.suggestedTemplateId !== tA.id).length;
    t('revision moves only where the effective template changed', bulk.revisionsBumped === expectedBumps && [2, 5, 8, 11].every((n) => after[n - 1]!.contentRevision === before[n - 1]!.contentRevision + (before[n - 1]!.suggestedTemplateId !== tA.id ? 1 : 0)));
    t('no other day changed', after.every((row, i) => [2, 5, 8, 11].includes(row.dayNumber) || snapshot(row) === snapshot(before[i])));

    const day22Type = (await mapping.loadMappingContext(tx, campaignA, noHtml)).days[21]!.contentType;
    const on22 = await mapping.assignManualTemplates(tx, campaignA, { kind: 'days', dayNumbers: [22], templateId: tC.id }, noHtml);
    t('the promo-tagged template on day 22 warns exactly when day 22 is not promo', (day22Type !== 'promo') === on22.warnings.some((w) => /not tagged/.test(w)), `${day22Type} ${snapshot(on22.warnings)}`);
    const range = await mapping.assignManualTemplates(tx, campaignA, { kind: 'range', fromDay: 20, toDay: 25, templateId: tB.id }, { ...noHtml, skipManual: true });
    const rangeRows = await campaignRows(campaignA);
    t('days 20–25 → template B, skipping the manual day 22', [20, 21, 23, 24, 25].every((n) => rangeRows[n - 1]!.posterTemplateId === tB.id) && rangeRows[21]!.posterTemplateId === tC.id && range.skippedManual === 1);

    const pattern = await mapping.assignManualTemplates(tx, campaignA, { kind: 'pattern', fromDay: 26, toDay: 30, templateIds: [tA.id, tB.id] }, noHtml);
    const patternRows = await campaignRows(campaignA);
    t('pattern A, B repeated over days 26–30', [tA.id, tB.id, tA.id, tB.id, tA.id].every((id, i) => patternRows[25 + i]!.posterTemplateId === id) && pattern.changedDays.join() === '26,27,28,29,30');

    const typeOfDay1 = (await mapping.loadMappingContext(tx, campaignA, noHtml)).days[0]!.contentType;
    const warned = await mapping.assignManualTemplates(tx, campaignA, { kind: 'days', dayNumbers: [1], templateId: tC.id }, noHtml);
    t('a manual choice of a differently tagged template is allowed and warned', typeOfDay1 === 'promo' ? warned.warnings.length === 0 : warned.warnings.some((w) => /not tagged/.test(w)), snapshot(warned.warnings));
    const shapeWarn = await mapping.assignManualTemplates(tx, campaignA, { kind: 'days', dayNumbers: [12], templateId: tSquare.id }, noHtml);
    t('a manual choice of a different shape is allowed and warned', shapeWarn.warnings.some((w) => /draws 1:1 posters, not 9:16/.test(w)), snapshot(shapeWarn.warnings));
    const d12 = await day(campaignA, 12);
    const cleared = await mapping.assignManualTemplates(tx, campaignA, { kind: 'days', dayNumbers: [12], templateId: null }, noHtml);
    const d12After = await day(campaignA, 12);
    t('clearing a manual template returns the day to its AUTO mapping', cleared.changedDays.join() === '12' && d12After.posterTemplateId === null && d12After.templateSelectedAt === null && d12After.suggestedTemplateId === d12.suggestedTemplateId && d12After.contentRevision === d12.contentRevision + 1);

    const snap = snapshot(await campaignRows(campaignA));
    await expectDomainError('a day listed twice is refused', 'invalid-input', () => mapping.assignManualTemplates(tx, campaignA, { kind: 'days', dayNumbers: [3, 3], templateId: tA.id }, noHtml));
    await expectDomainError('an inactive template is refused', 'template-not-assignable', () => mapping.assignManualTemplates(tx, campaignA, { kind: 'range', fromDay: 1, toDay: 30, templateId: tInactive.id }, noHtml));
    await expectDomainError('an unapproved template is refused', 'template-not-assignable', () => mapping.assignManualTemplates(tx, campaignA, { kind: 'days', dayNumbers: [3], templateId: tDraft.id }, noHtml));
    await expectDomainError('a template from another vertical is refused', 'template-not-assignable', () => mapping.assignManualTemplates(tx, campaignA, { kind: 'pattern', fromDay: 1, toDay: 4, templateIds: [tA.id, tForeign.id] }, noHtml));
    await expectDomainError('a day outside the campaign is refused', 'invalid-input', () => mapping.assignManualTemplates(tx, campaignA, { kind: 'days', dayNumbers: [31], templateId: tA.id }, noHtml));
    t('refused requests write nothing, not even partially', snapshot(await campaignRows(campaignA)) === snap);
  }

  // =======================================================================
  section('mixed mode: auto map again after manual changes');
  // =======================================================================
  {
    const before = await campaignRows(campaignA);
    const manualBefore = before.filter((row) => row.posterTemplateId).map((row) => [row.dayNumber, row.posterTemplateId, row.templateSelectedAt?.toISOString()]);
    for (const scope of ['fill', 'rebalance'] as const) {
      const preview = await mapping.previewAutoMap(tx, campaignA, { ...noHtml, scope });
      t(`${scope}: manual days are reported MANUAL and never written`, preview.plan.entries.filter((entry) => entry.outcome === 'manual').length === manualBefore.length && preview.plan.entries.every((entry) => entry.outcome !== 'manual' || (!entry.writesSuggestion && !entry.effectiveChanges)));
      await mapping.applyAutoMap(tx, campaignA, { ...noHtml, scope, fingerprint: preview.plan.fingerprint });
      const after = await campaignRows(campaignA);
      t(`${scope}: every manual selection survives the apply`, snapshot(after.filter((row) => row.posterTemplateId).map((row) => [row.dayNumber, row.posterTemplateId, row.templateSelectedAt?.toISOString()])) === snapshot(manualBefore));
    }
    const view = await overview(campaignA);
    t('summary marks AUTO and MANUAL per day', view.summary.manual === manualBefore.length && view.summary.auto === 30 - manualBefore.length && view.summary.unmapped === 0, snapshot({ ...view.summary, attention: view.summary.attention.length }));
  }

  // =======================================================================
  section('template deactivation');
  // =======================================================================
  {
    const before = await campaignRows(campaignA);
    const usesA = before.filter((row) => (row.posterTemplateId ?? row.suggestedTemplateId) === tA.id);
    const result = await mapping.setTemplateActive(tx, tA.id, false);
    t('deactivation reports the campaign days affected', result.campaignDaysAffected === usesA.length && usesA.length > 0, `${result.campaignDaysAffected} vs ${usesA.length}`);
    t('no campaign day is changed by deactivation', snapshot(await campaignRows(campaignA)) === snapshot(before));
    const view = await overview(campaignA);
    const flagged = view.summary.attention.filter((row) => row.issue.code === 'template-inactive');
    t('every affected day: "Template inactive — action required"', flagged.length === usesA.length && flagged.every((row) => row.issue.title === 'Template inactive — action required'));
    t('…and still shows its template (not silently replaced)', usesA.every((row) => view.states.get(row.id)!.templateId === tA.id));

    const preview = await mapping.previewAutoMap(tx, campaignA, noHtml);
    const manualOnA = preview.plan.entries.filter((entry) => entry.outcome === 'manual' && entry.templateId === tA.id);
    const autoOnA = preview.plan.entries.filter((entry) => entry.currentSource === 'AUTO' && entry.currentTemplateId === tA.id);
    t('Auto Map preview: manual days on it stay, with conflict and a suggested replacement', manualOnA.length > 0 && manualOnA.every((entry) => entry.conflict?.code === 'template-inactive' && entry.replacementTemplateId !== null && entry.replacementTemplateId !== tA.id && !entry.writesSuggestion));
    t('Auto Map preview: auto days on it are replaced, with the reason', autoOnA.length > 0 && autoOnA.every((entry) => entry.outcome === 'replace' && entry.conflict?.code === 'template-inactive'));

    // Race: someone maps one of those auto days by hand before the preview is applied.
    const raced = autoOnA[0]!.dayNumber;
    await mapping.assignManualTemplates(tx, campaignA, { kind: 'days', dayNumbers: [raced], templateId: tB.id }, noHtml);
    await expectDomainError('applying a preview after a manual change meanwhile is refused', 'conflict', () => mapping.applyAutoMap(tx, campaignA, { ...noHtml, fingerprint: preview.plan.fingerprint }));
    t('…and the manual change is intact', (await day(campaignA, raced)).posterTemplateId === tB.id);

    // Replacement workflow: a person replaces the manual days; Auto Map replaces the auto ones.
    const replacement = await mapping.assignManualTemplates(tx, campaignA, { kind: 'days', dayNumbers: manualOnA.map((entry) => entry.dayNumber), templateId: manualOnA[0]!.replacementTemplateId! }, noHtml);
    t('replacement applied to the manual days chosen', replacement.changedDays.join() === manualOnA.map((entry) => entry.dayNumber).join());
    const fresh = await mapping.previewAutoMap(tx, campaignA, noHtml);
    await mapping.applyAutoMap(tx, campaignA, { ...noHtml, fingerprint: fresh.plan.fingerprint });
    const settled = await overview(campaignA);
    t('after replacement nothing needs attention and nothing uses the inactive template', settled.summary.attention.length === 0 && [...settled.states.values()].every((state) => state.templateId !== tA.id), snapshot(settled.summary.attention));
    t('legacy days pinned to the deactivated template are untouched', snapshot(await legacyRows()) === legacyBefore);

    const refused = await asAction(() => dashboardActions.deleteVerticalTemplate(tB.id));
    t('deleting a template still mapped to campaign days is refused', !refused.ok && /campaign day/.test(refused.ok ? '' : refused.error) && (await tx.categoryTemplate.count({ where: { id: tB.id } })) === 1, refused.ok ? '' : refused.error);

    await tx.categoryTemplate.update({ where: { id: tC.id }, data: { layoutApprovedAt: null } });
    const unapproved = await overview(campaignA);
    const onC = [...unapproved.states.entries()].filter(([, state]) => state.templateId === tC.id);
    t('withdrawn approval: days on it need action ("not approved")', onC.length > 0 && unapproved.summary.attention.filter((row) => row.issue.code === 'template-unapproved').length === onC.length);
    await tx.categoryTemplate.update({ where: { id: tC.id }, data: { layoutApprovedAt: new Date(base) } });
    await mapping.setTemplateActive(tx, tA.id, true);
  }

  // =======================================================================
  section('poster versions are never touched');
  // =======================================================================
  {
    const d7 = await day(campaignA, 7);
    const version = await addPosterVersion(tx, { calendarDayId: d7.id, source: 'PIPELINE', imageDriveFileId: 'fixture-map-v1', imageMimeType: 'image/png', contentRevision: d7.contentRevision });
    const versionsBefore = snapshot(await tx.posterVersion.findMany({ where: { calendarDay: { campaignId: campaignA } }, orderBy: { id: 'asc' } }));
    const other = (d7.posterTemplateId ?? d7.suggestedTemplateId) === tA.id ? tB.id : tA.id;
    await mapping.assignManualTemplates(tx, campaignA, { kind: 'days', dayNumbers: [7], templateId: other }, noHtml);
    const after = await day(campaignA, 7);
    t('mapping change leaves versions and the active pointer as they were', snapshot(await tx.posterVersion.findMany({ where: { calendarDay: { campaignId: campaignA } }, orderBy: { id: 'asc' } })) === versionsBefore && after.activePosterVersionId === version.versionId);
    t('…and marks the poster outdated through the revision', !isVersionCurrent({ contentRevision: d7.contentRevision }, after));
  }

  // =======================================================================
  section('aspect ratio from the client output preset');
  // =======================================================================
  {
    const preview = await mapping.previewAutoMap(tx, campaignS, noHtml);
    t('a 1:1 client gets only the square template', preview.context.target.aspectLabel === '1:1' && preview.plan.entries.every((entry) => entry.templateId === tSquare.id));
    t('a lone compatible template repeats and says so', preview.plan.entries.slice(1).every((entry) => entry.repeatsPreviousDay));
    const result = await mapping.applyAutoMap(tx, campaignS, { ...noHtml, fingerprint: preview.plan.fingerprint });
    t('…and applying maps all 10 days to it', result.daysWritten === 10);
  }

  // =======================================================================
  section('no compatible template → unmapped');
  // =======================================================================
  {
    const view = await overview(campaignE);
    t('all 5 days unmapped, each needing attention with the reason', view.summary.unmapped === 5 && view.summary.attention.length === 5 && view.summary.attention.every((row) => row.issue.code === 'no-compatible-template' && /both active and approved/.test(row.issue.detail)), snapshot(view.summary.attention[0]));
    const preview = await mapping.previewAutoMap(tx, campaignE, noHtml);
    const result = await mapping.applyAutoMap(tx, campaignE, { ...noHtml, fingerprint: preview.plan.fingerprint });
    t('Auto Map assigns nothing incompatible', preview.plan.counts.unmapped === 5 && result.daysWritten === 0);
    await changeCampaignStatus(tx, campaignE, 'CANCELLED');
    await expectDomainError('a cancelled campaign refuses manual mapping', 'campaign-closed', () => mapping.assignManualTemplates(tx, campaignE, { kind: 'days', dayNumbers: [1], templateId: null }, noHtml));
    await expectDomainError('a cancelled campaign refuses Auto Map', 'campaign-closed', () => mapping.applyAutoMap(tx, campaignE, { ...noHtml, fingerprint: preview.plan.fingerprint }));
  }

  // =======================================================================
  section('MANUAL mode campaign');
  // =======================================================================
  {
    const preview = await mapping.previewAutoMap(tx, campaignM, noHtml);
    t('preview says applying switches the campaign to AUTO', preview.plan.switchesMode && preview.plan.counts.new === 6);
    const result = await mapping.applyAutoMap(tx, campaignM, { ...noHtml, fingerprint: preview.plan.fingerprint });
    const campaign = await tx.campaign.findUniqueOrThrow({ where: { id: campaignM } });
    t('apply switched the mode and mapped every day', result.switchedToAuto && campaign.templateMappingMode === 'AUTO' && (await overview(campaignM)).summary.auto === 6);
    const rows = await campaignRows(campaignM);
    const toManual = await mapping.changeTemplateMappingMode(tx, campaignM, 'MANUAL');
    const afterManual = await campaignRows(campaignM);
    t('switching to MANUAL keeps suggestions but they stop counting (revisions move)', toManual.daysAffected === 6 && afterManual.every((row, i) => row.suggestedTemplateId === rows[i]!.suggestedTemplateId && row.contentRevision === rows[i]!.contentRevision + 1) && (await overview(campaignM)).summary.unmapped === 6);
    t('switching to the same mode is a no-op', (await mapping.changeTemplateMappingMode(tx, campaignM, 'MANUAL')).changed === false);
  }

  // =======================================================================
  section('server actions');
  // =======================================================================
  {
    const preview = await asAction(() => campaignActions.previewAutoMapAction(campaignC, 'fill'));
    t('previewAutoMapAction returns the plan', preview.ok && preview.data.entries.length === 30 && preview.data.counts.new === 30);
    const apply = preview.ok ? await asAction(() => campaignActions.applyAutoMapAction(campaignC, { scope: 'fill', fingerprint: preview.data.fingerprint })) : null;
    t('applyAutoMapAction applies it', apply?.ok === true && apply.data.daysWritten === 30);
    const assign = await asAction(() => campaignActions.assignCampaignTemplatesAction(campaignC, { kind: 'range', fromDay: 1, toDay: 3, templateId: tB.id }));
    t('assignCampaignTemplatesAction maps a range', assign.ok && assign.data.changedDays.join() === '1,2,3');
    const refusedAction = await asAction(() => campaignActions.assignCampaignTemplatesAction(campaignC, { kind: 'days', dayNumbers: [4], templateId: tInactive.id }));
    t('…and reports a refusal as operator copy', !refusedAction.ok && /inactive/.test(refusedAction.ok ? '' : refusedAction.error));
    const tags = await asAction(() => campaignActions.setTemplateContentTypesAction(tB.id, ['promo', 'educational']));
    t('content types saved in strategy order', tags.ok && tags.data.contentTypes.join() === 'educational,promo');
    const badTag = await asAction(() => campaignActions.setTemplateContentTypesAction(tB.id, ['festival']));
    t('a content type outside the vertical strategy is refused', !badTag.ok);
    await tx.categoryTemplate.update({ where: { id: tB.id }, data: { contentTypes: [] } });
    const deactivate = await asAction(() => campaignActions.setTemplateActiveAction(tSquare.id, false));
    t('setTemplateActiveAction reports affected open-campaign days', deactivate.ok && deactivate.data.campaignDaysAffected >= 10);
    t('defaultHtmlAspectFor finds no authored template for a fixture label', (await mapping.defaultHtmlAspectFor('check:map A')) === null);
    const selected = await day(campaignC, 10);
    await selectDayTemplate(tx, selected.id, tA.id);
    t('Phase 1 selectDayTemplate now records when the selection was made', (await day(campaignC, 10)).templateSelectedAt !== null);
  }

  // =======================================================================
  section('campaign / client consistency and legacy isolation');
  // =======================================================================
  {
    const cRows = await campaignRows(campaignC);
    t('every day of a campaign stays on its own client', (await tx.contentCalendar.count({ where: { campaignId: campaignA, clientId: { not: clientA.id } } })) === 0 && cRows.every((row) => row.clientId === clientC.id));
    t('campaign C changed only through its own mapping calls (days 11–30 untouched by campaign A work)', cRows.slice(10).every((row, i) => {
      const original = JSON.parse(campaignCBefore)[10 + i];
      return row.posterTemplateId === original.posterTemplateId && row.theme === original.theme && row.headline === original.headline;
    }));
    t('legacy rows are byte-identical after every mapping operation', snapshot(await legacyRows()) === legacyBefore);
    const aRows = snapshot(await campaignRows(campaignA));
    const approveAll = await asAction(() => dashboardActions.approveAllCreatives(clientA.id));
    // A client whose calendar is all campaign days has nothing legacy to approve.
    const nothingLegacy = approveAll.ok ? approveAll.data.approved === 0 : approveAll.error === 'Nothing is waiting for approval.';
    t('legacy bulk approval still ignores mapped campaign days', nothingLegacy && snapshot(await campaignRows(campaignA)) === aRows, snapshot(approveAll));
    t('legacy calendar scope still excludes campaign days', (await tx.contentCalendar.count({ where: { clientId: clientA.id, ...LEGACY_CALENDAR } })) === 0);
  }
}

const TABLES = ['Client', 'Campaign', 'ContentCalendar', 'PosterVersion', 'Category', 'CategoryTemplate', 'Plan', 'UsageEvent'];
async function tableCounts(): Promise<string> {
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    const rows = await realPrisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM "${table}"`);
    counts[table] = Number(rows[0]?.n ?? -1);
  }
  return snapshot(counts);
}

async function main(): Promise<void> {
  const external = (await import(
    'next/dist/client/components/static-generation-async-storage.external.js'
  )) as unknown as { staticGenerationAsyncStorage: AsyncStorage };
  requestStore = external.staticGenerationAsyncStorage;

  const before = await tableCounts();
  try {
    await realPrisma.$transaction(
      async (tx) => {
        activeTx = tx;
        await suite();
        throw new Rollback();
      },
      { timeout: 300_000, maxWait: 10_000 },
    );
  } catch (error) {
    if (!(error instanceof Rollback)) {
      console.error('\nSuite aborted:', error);
      bad += 1;
    }
  } finally {
    activeTx = null;
  }

  section('after rollback');
  const after = await tableCounts();
  t('every table has exactly its original row count', before === after, after);
  t('no network call was attempted', networkAttempts === 0, String(networkAttempts));
  console.log(`\n${bad === 0 ? 'All campaign mapping database checks passed.' : `${bad} check(s) FAILED.`}`);
}

main()
  .catch((error) => {
    console.error(error);
    bad += 1;
  })
  .finally(async () => {
    await realPrisma.$disconnect();
    process.exit(bad === 0 ? 0 : 1);
  });
