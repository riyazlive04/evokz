/**
 * Fixture suite for Poster Studio's template poster editor view model
 * (src/lib/campaign/clone-editor-view.ts): how elements become form sections,
 * what counts as an unsaved change, the soft length guide, the status chip and
 * actions, the text check list, previous/next day and the editor's links — plus
 * the pure prompt helpers of "Fix text" and "Small change"
 * (src/lib/campaign/clone-fix.ts).
 *
 * Pure: no database, no network, no provider.
 *
 * Run: npm run check:clone-editor-view
 */
import { BOARD_STATUSES } from '@/lib/campaign/board';
import {
  adjacentDays,
  applyDraftEdits,
  approvalNotice,
  brandCanvasHref,
  campaignBoardHref,
  differsFromTemplate,
  draftEdits,
  draftFromElements,
  editorFields,
  editorStatusChip,
  elapsedSince,
  formatElapsed,
  groupEditorFields,
  groupTitle,
  hasUnsavedChanges,
  isConflictMessage,
  isFieldDirty,
  lengthGuide,
  normalizeFieldText,
  normalizeImagePrompt,
  primaryActions,
  revisionAvailability,
  rewriteNotice,
  templateDefaults,
  templateEditorHref,
  textCheckView,
  type EditorDraft,
} from '@/lib/campaign/clone-editor-view';
import {
  buildCloneEditPrompt,
  buildCloneTextFixPrompt,
  normalizePosterChangeInstruction,
  textFixCorrections,
} from '@/lib/campaign/clone-fix';
import { CampaignDomainError } from '@/lib/campaign/service';
import {
  cloneTemplateElements,
  MAX_ELEMENT_TEXT,
  type TemplateElement,
  type TemplateElementsDoc,
  type TextCheckResult,
} from '@/lib/types/template-elements';

let bad = 0;
const t = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) bad += 1;
};
const section = (title: string) => console.log(`\n--- ${title} ${'-'.repeat(Math.max(0, 58 - title.length))}`);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const element = (
  id: string,
  kind: TemplateElement['kind'],
  text: string | null,
  box: [number, number, number, number],
  extra: { group?: string | null; description?: string } = {},
): TemplateElement => ({
  id,
  kind,
  text,
  box: { x: box[0], y: box[1], w: box[2], h: box[3] },
  group: extra.group ?? null,
  description: extra.description ?? null,
});

const TEMPLATE_ID = '11111111-1111-4111-8111-111111111111';

/** A doctor's poster: no brandName or tagline of its own, so the person name and credential bind. */
const doc: TemplateElementsDoc = {
  version: 1,
  width: 1080,
  height: 1350,
  model: 'fixture',
  elements: [
    element('e1', 'logo', null, [0.62, 0.02, 0.36, 0.1], { description: 'kidney mark' }),
    element('e2', 'headline', 'CARE BEYOND TREATMENT', [0.05, 0.15, 0.45, 0.2]),
    element('e3', 'subheadline', 'Expert urology care with compassion.', [0.05, 0.43, 0.3, 0.06]),
    element('e4', 'feature', 'Personalized Care', [0.15, 0.55, 0.2, 0.04], { group: 'features' }),
    element('e5', 'feature', 'Advanced Technology', [0.15, 0.64, 0.2, 0.04], { group: 'features' }),
    element('e6', 'feature', 'Trusted Support', [0.15, 0.73, 0.2, 0.04], { group: 'features' }),
    element('e7', 'photo', null, [0.35, 0.1, 0.65, 0.75], { description: 'doctor talking to a patient' }),
    element('e8', 'cta', 'Book an Appointment Today', [0.05, 0.88, 0.25, 0.03]),
    element('e9', 'phone', '+91 80907 20161', [0.05, 0.92, 0.25, 0.03]),
    element('e10', 'address', 'Peerzadiguda', [0.05, 0.95, 0.2, 0.03]),
    element('e11', 'personName', 'Dr. HARI SHANKAR SINGH', [0.36, 0.9, 0.4, 0.04]),
    element('e12', 'credential', 'M.B.B.S, M.S, M.Ch, Dr NB Urology', [0.36, 0.95, 0.4, 0.03]),
    element('e13', 'credential', 'Reg No. 30435', [0.36, 0.87, 0.15, 0.02]),
    element('e14', 'photo', null, [0.8, 0.78, 0.2, 0.22], { description: 'doctor portrait' }),
    element('e15', 'badge', 'NEW', [0.9, 0.5, 0.06, 0.04]),
  ],
};

// ===========================================================================
section('fields and groups');
// ===========================================================================
{
  const fields = editorFields(doc);
  const byId = new Map(fields.map((field) => [field.id, field]));
  t('every element is a field, in reading order', same(fields.map((field) => field.id), doc.elements.map((item) => item.id)));
  t('content kinds are words; the photo is a photo', byId.get('e2')?.category === 'content' && byId.get('e15')?.category === 'content' && byId.get('e7')?.category === 'photo');
  t('logo and phone are brand, bound to their Brand Canvas field', byId.get('e1')?.category === 'brand' && byId.get('e1')?.binding === 'logo' && byId.get('e9')?.binding === 'phone');
  t('fallback bindings: the first person name prints the business name, the first credential the tagline', byId.get('e11')?.category === 'brand' && byId.get('e11')?.binding === 'companyName' && byId.get('e12')?.binding === 'tagline');
  t('a second credential and the address stay hidden details', byId.get('e13')?.category === 'hidden' && byId.get('e10')?.category === 'hidden' && byId.get('e13')?.binding === null);
  t('labels number repeated kinds', byId.get('e5')?.label === 'Feature 2' && byId.get('e2')?.label === 'Headline');

  const groups = groupEditorFields(doc);
  t('words: standalone fields and one Features group where the first feature reads', same(groups.words.map((group) => group.title ?? group.fields[0]!.id), ['e2', 'e3', 'Features', 'e8', 'e15']));
  t('…the group holds the three features in order', same(groups.words[2]?.fields.map((field) => field.id), ['e4', 'e5', 'e6']));
  t('brand, hidden and photo sections', same(groups.brand.map((f) => f.id), ['e1', 'e9', 'e11', 'e12']) && same(groups.hidden.map((f) => f.id), ['e10', 'e13']) && same(groups.photos.map((f) => f.id), ['e7', 'e14']));

  const lone: TemplateElementsDoc = { ...doc, elements: [element('e1', 'feature', 'Only one', [0, 0, 0.1, 0.1]), element('e2', 'text', 'A', [0, 0.2, 0.1, 0.1], { group: 'Contact_Details' }), element('e3', 'text', 'B', [0, 0.3, 0.1, 0.1], { group: 'contact_details' })] };
  const loneGroups = groupEditorFields(lone);
  t('a lone feature is a plain field; a named group of two is titled', loneGroups.words[0]?.title === null && loneGroups.words[1]?.title === 'Contact details' && loneGroups.words[1]?.fields.length === 2, JSON.stringify(loneGroups.words.map((g) => g.title)));
  t('group titles', groupTitle('features') === 'Features' && groupTitle('call-to_action') === 'Call to action' && groupTitle('  ') === 'Group');
}

// ===========================================================================
section('draft, defaults and dirty detection');
// ===========================================================================
{
  const fields = editorFields(doc);
  const clone = cloneTemplateElements(doc, TEMPLATE_ID, { businessName: 'Sirah Clinic' });
  const draft = draftFromElements(doc, clone);
  t('the draft starts from the day’s values; brand fields and photos carry no words', draft.e2?.text === 'CARE BEYOND TREATMENT' && draft.e9?.text === '' && draft.e7?.text === '' && draft.e10?.removed === true && draft.e13?.removed === true);
  const defaults = templateDefaults(doc, TEMPLATE_ID, 'Sirah Clinic');
  t('defaults equal a fresh clone', same(defaults, draft));

  t('text normalises like the server: collapsed, trimmed, capped, empty is null', normalizeFieldText('  Hello   world ') === 'Hello world' && normalizeFieldText('   ') === null && normalizeFieldText('x'.repeat(MAX_ELEMENT_TEXT + 20))?.length === MAX_ELEMENT_TEXT);
  t('image prompt normalises like the server', normalizeImagePrompt('  a   nurse ') === 'a nurse' && normalizeImagePrompt(null) === '');

  const whitespaceOnly: EditorDraft = { ...draft, e2: { text: 'CARE  BEYOND TREATMENT ', removed: false } };
  t('a whitespace-only change is not an edit', draftEdits(fields, draft, whitespaceOnly).length === 0 && !isFieldDirty(fields[1]!, draft, whitespaceOnly));

  const next: EditorDraft = {
    ...draft,
    e2: { text: 'SMILES MADE SIMPLE', removed: false },
    e5: { text: 'Advanced Technology', removed: true },
    e6: { text: '', removed: false },
    e9: { text: '', removed: true },
    e10: { text: '5 New Street', removed: false },
  };
  const edits = draftEdits(fields, draft, next);
  t(
    'edits: new words, a removal, an emptied field (null), a hidden brand field, an address given a value',
    same(edits, [
      { id: 'e2', text: 'SMILES MADE SIMPLE' },
      { id: 'e5', removed: true },
      { id: 'e6', text: null },
      { id: 'e9', removed: true },
      { id: 'e10', text: '5 New Street', removed: false },
    ]),
    JSON.stringify(edits),
  );
  const brandWords: EditorDraft = { ...draft, e9: { text: '999', removed: false }, e7: { text: 'a nurse', removed: false } };
  t('words are never sent for a brand field or a photo', draftEdits(fields, draft, brandWords).length === 0);

  const applied = applyDraftEdits(draft, edits);
  t('applying the edits gives the new baseline', draftEdits(fields, applied, next).length === 0 && applied.e6?.text === '' && applied.e10?.removed === false);
  t('unsaved changes include the image prompt', hasUnsavedChanges(fields, { draft, prompt: '' }, { draft, prompt: 'a nurse ' }) && !hasUnsavedChanges(fields, { draft, prompt: 'a nurse' }, { draft, prompt: ' a  nurse' }));
  t('differs from template: an edit does, the fresh clone does not', differsFromTemplate(fields, defaults, next) && !differsFromTemplate(fields, defaults, draft));
}

// ===========================================================================
section('length guide');
// ===========================================================================
{
  const exact = lengthGuide('Advanced Technology', 'Advanced Technology');
  t('the count and the template length', exact.count === 19 && exact.templateLength === 19 && !exact.over);
  const limit = lengthGuide('x'.repeat(22), 'Advanced Technology');
  t('+20% is allowed (floor of 22.8)', limit.softLimit === 22 && !limit.over);
  t('beyond +20% warns', lengthGuide('x'.repeat(23), 'Advanced Technology').over);
  t('whitespace does not count twice', lengthGuide('  a   b  ', 'ab').count === 3);
  t('no template words: no guide', lengthGuide('anything', null).templateLength === null && !lengthGuide('anything', '').over);
}

// ===========================================================================
section('status chip and actions');
// ===========================================================================
{
  const labels = BOARD_STATUSES.map((status) => editorStatusChip({ status, posterState: 'not-generated' }).label);
  t('every board status has a chip', labels.every(Boolean) && same(labels.slice(0, 6), ['Draft', 'Generating', 'Needs approval', 'Approved', 'Scheduled', 'Sent']), JSON.stringify(labels));
  t('attention says what it is', editorStatusChip({ status: 'attention', posterState: 'outdated' }).label === 'Outdated' && editorStatusChip({ status: 'attention', posterState: 'rejected' }).tone === 'destructive' && editorStatusChip({ status: 'attention', posterState: 'needs-attention' }).label === 'Needs attention');

  const flags = { canGenerate: true, canRegenerate: false, canApprove: false, canReject: false };
  const first = primaryActions({ flags, hasPoster: false, generating: false, busy: false });
  t('no poster: Generate poster, missing mode', first.generate.label === 'Generate poster' && first.generate.mode === 'missing' && first.generate.enabled && !first.approve);
  const again = primaryActions({ flags: { canGenerate: false, canRegenerate: true, canApprove: true, canReject: true }, hasPoster: true, generating: false, busy: false });
  t('a poster: Regenerate, regenerate mode; Approve and Reject when offered', again.generate.label === 'Regenerate' && again.generate.mode === 'regenerate' && again.generate.enabled && again.approve && again.reject);
  const running = primaryActions({ flags: { canGenerate: true, canRegenerate: true, canApprove: true, canReject: true }, hasPoster: true, generating: true, busy: false });
  t('nothing is offered while a poster is being made', !running.generate.enabled && !running.approve && !running.reject);
  t('…or while another action runs', !primaryActions({ flags: { canGenerate: true, canRegenerate: true, canApprove: true, canReject: true }, hasPoster: false, generating: false, busy: true }).generate.enabled);
  t('a flag the server did not give is not offered', !primaryActions({ flags: { ...flags, canGenerate: false }, hasPoster: false, generating: false, busy: false }).generate.enabled);
}

// ===========================================================================
section('text check and revisions');
// ===========================================================================
const check = (items: TextCheckResult['items'], leftovers: string[] = []): TextCheckResult => ({ checkedAt: '2026-09-17T10:00:00.000Z', model: 'fixture', ok: items.every((item) => item.match) && leftovers.length === 0, items, leftovers });
{
  t('no check: none', textCheckView(null).state === 'none');
  t('all matched: ok', textCheckView(check([{ elementId: 'e2', label: 'Headline', expected: 'A', found: 'A', match: true }])).state === 'ok');
  const view = textCheckView(check([{ elementId: 'e2', label: 'Headline', expected: 'CARE', found: 'CAER', match: false }, { elementId: 'e3', label: 'Sub-headline', expected: 'x', found: 'x', match: true }], ['Dr. HARI SHANKAR SINGH']));
  t('issues: mismatches, then leftovers', view.state === 'issues' && view.issues.length === 2 && view.issues[0]?.label === 'Headline' && view.issues[1]?.leftover === true && view.issues[1]?.found === 'Dr. HARI SHANKAR SINGH');

  const poster = { current: true, hasArtwork: true, textCheck: check([{ elementId: 'e2', label: 'Headline', expected: 'CARE', found: 'CAER', match: false }]) };
  const ready = revisionAvailability({ campaignStatus: 'ACTIVE', poster, generating: false, busy: false });
  t('an active campaign, a current generated poster with a difference: both enabled', ready.fix.enabled && ready.edit.enabled && ready.fix.reason === null);
  t('a correct poster: fix refused, edit allowed', !revisionAvailability({ campaignStatus: 'ACTIVE', poster: { ...poster, textCheck: check([]) }, generating: false, busy: false }).fix.enabled && revisionAvailability({ campaignStatus: 'ACTIVE', poster: { ...poster, textCheck: check([]) }, generating: false, busy: false }).edit.enabled);
  const reasons = [
    revisionAvailability({ campaignStatus: 'PAUSED', poster, generating: false, busy: false }).edit.reason,
    revisionAvailability({ campaignStatus: 'ACTIVE', poster: null, generating: false, busy: false }).edit.reason,
    revisionAvailability({ campaignStatus: 'ACTIVE', poster: { ...poster, hasArtwork: false }, generating: false, busy: false }).edit.reason,
    revisionAvailability({ campaignStatus: 'ACTIVE', poster: { ...poster, current: false }, generating: false, busy: false }).fix.reason,
    revisionAvailability({ campaignStatus: 'ACTIVE', poster, generating: true, busy: false }).fix.reason,
    revisionAvailability({ campaignStatus: 'ACTIVE', poster: { ...poster, textCheck: null }, generating: false, busy: false }).fix.reason,
  ];
  t('each refusal says why', reasons.every((reason) => typeof reason === 'string' && reason.length > 5) && /outdated/.test(reasons[3]!) && /Activate/.test(reasons[0]!), JSON.stringify(reasons));
  const locked = (['sent', 'sending', 'past'] as const).map((lock) => revisionAvailability({ campaignStatus: 'ACTIVE', poster, generating: false, busy: false, lock }));
  t('a sent, sending or past day offers neither Fix text nor Small change, and says why', locked.every((entry) => !entry.fix.enabled && !entry.edit.enabled && /can no longer change/.test(entry.edit.reason ?? '')), JSON.stringify(locked.map((entry) => entry.edit.reason)));
  t('a due or closed day, or no lock, still offers them', (['due', 'closed', null] as const).every((lock) => revisionAvailability({ campaignStatus: 'ACTIVE', poster, generating: false, busy: false, lock }).edit.enabled));
}

// ===========================================================================
section('fix and small-change prompts');
// ===========================================================================
{
  const result = check(
    [
      { elementId: 'e4', label: 'Feature 1', expected: 'Personal Care', found: 'Persnal Care', match: false },
      { elementId: 'e8', label: 'Call to action', expected: 'Book Today', found: null, match: false },
      { elementId: 'e2', label: 'Headline', expected: 'SMILES MADE SIMPLE', found: 'CARE BEYOND TREATMENT', match: false },
      { elementId: 'e3', label: 'Sub-headline', expected: 'ok', found: 'ok', match: true },
    ],
    ['Care Beyond Treatment', 'Peerzadiguda'],
  );
  const lines = textFixCorrections(result, doc);
  t('a misread place: change the found text to exactly the expected', lines[0] === 'Feature 1 (middle left): change the text "Persnal Care" to exactly "Personal Care".', lines[0]);
  t('nothing legible: write the exact words in that place', /^Call to action \(bottom left\): this text must read exactly "Book Today"\./.test(lines[1] ?? ''), lines[1]);
  t('a leftover that is the found text of a correction is not listed again', !lines.some((line) => /Erase "Care Beyond Treatment"/i.test(line)), JSON.stringify(lines));
  t('another leftover: erase it and close the space, located by the template', lines[lines.length - 1] === 'Erase "Peerzadiguda" (bottom left) and close the space naturally.', lines[lines.length - 1]);
  t('matched places are not listed', lines.length === 4);
  const elsewhere = textFixCorrections(check([{ elementId: 'e3', label: 'Sub-headline', expected: 'Kind care.', found: 'Kind care.', match: true }], ['Expert urology care with compassion.']), doc);
  t('a leftover of a replaced element whose place reads right is not pointed at that place', elsewhere[0] === 'Erase "Expert urology care with compassion." and close the space naturally.', elsewhere[0]);

  const prompt = buildCloneTextFixPrompt({ corrections: lines, orientation: 'vertical 4:5', hasLogoBox: true });
  t('the fix prompt numbers the corrections and keeps everything else', /Correct these 4 texts:\n1\. Feature 1/.test(prompt) && /keep everything else exactly as it is/.test(prompt) && /photographs and the people in them/.test(prompt));
  t('…keeps the logo space empty and the frame', /logo stays clean and empty/.test(prompt) && /Output frame: vertical 4:5/.test(prompt));
  t('…and without a logo box says nothing about one', !/logo stays clean/.test(buildCloneTextFixPrompt({ corrections: lines.slice(0, 1), orientation: 'square 1:1', hasLogoBox: false })) && /Correct this text:/.test(buildCloneTextFixPrompt({ corrections: lines.slice(0, 1), orientation: 'square 1:1', hasLogoBox: false })));

  const edit = buildCloneEditPrompt({ instruction: '  make the   background lighter ', orientation: 'vertical 4:5', hasLogoBox: true });
  t('the edit prompt carries the instruction, collapsed', edit.includes('Make this change:\n\nmake the background lighter\n\n'));
  t('…changes nothing else, keeps the words exactly, adds no branding', /change nothing else/.test(edit) && /every text \(the same words, spelling/.test(edit) && /Do not add any logos/.test(edit) && /logo stays clean and empty/.test(edit));

  t('an instruction is collapsed', normalizePosterChangeInstruction('  make it   warmer ') === 'make it warmer');
  const refused = (value: string) => {
    try {
      normalizePosterChangeInstruction(value);
      return false;
    } catch (error) {
      return error instanceof CampaignDomainError && error.code === 'invalid-input';
    }
  };
  t('too short or too long is refused', refused(' a ') && refused('x'.repeat(501)) && !refused('x'.repeat(500)));
}

// ===========================================================================
section('navigation, links and words for the admin');
// ===========================================================================
{
  const days = [{ id: 'd5', dayNumber: 5 }, { id: 'd3', dayNumber: 3 }, { id: 'd9', dayNumber: 9 }, { id: 'd4', dayNumber: 4 }];
  const around = adjacentDays(days, 4);
  t('previous and next are the nearest days either side', around.prev?.id === 'd3' && around.next?.id === 'd5');
  t('the first and last day have one side only', adjacentDays(days, 3).prev === null && adjacentDays(days, 9).next === null && adjacentDays(days, 9).prev?.id === 'd5');
  t('a gap in day numbers is stepped over', adjacentDays([{ id: 'a', dayNumber: 1 }, { id: 'b', dayNumber: 7 }], 3).next?.id === 'b');

  t('back to the board opens the week holding the day', campaignBoardHref('c1', 'k1', 1) === '/admin/clients/c1/campaigns/k1?week=1' && campaignBoardHref('c1', 'k1', 7) === '/admin/clients/c1/campaigns/k1?week=1' && campaignBoardHref('c1', 'k1', 8) === '/admin/clients/c1/campaigns/k1?week=2' && campaignBoardHref('c1', 'k1', 365) === '/admin/clients/c1/campaigns/k1?week=53');
  t('the editor link', templateEditorHref('abc') === '/admin/poster-studio?campaignDay=abc');
  const brand = brandCanvasHref('c1', templateEditorHref('abc'));
  t('Brand Canvas returns to the editor (an /admin/ path, encoded)', brand === '/admin/clients/c1/brand?return=%2Fadmin%2Fposter-studio%3FcampaignDay%3Dabc' && decodeURIComponent(brand.split('return=')[1]!).startsWith('/admin/'));

  t('elapsed time', formatElapsed(0) === '0:00' && formatElapsed(72) === '1:12' && formatElapsed(723.9) === '12:03' && formatElapsed(-5) === '0:00' && formatElapsed(Number.NaN) === '0:00');
  const now = Date.parse('2026-09-17T10:02:12.000Z');
  t('elapsed from the server’s start, else this tab’s', elapsedSince('2026-09-17T10:01:00.000Z', now, null) === 72 && elapsedSince(null, now, now - 5_000) === 5 && elapsedSince(null, now, null) === 0);

  t('approval: booked', approvalNotice(4, { result: 'booked', whenLabel: 'Thu 18 Sept 09:03', immediate: false, refusal: null }, true).text === 'Day 4 approved. Booked for Thu 18 Sept 09:03.');
  t('approval: due now warns', approvalNotice(4, { result: 'booked', whenLabel: '09:00 today', immediate: true, refusal: null }, true).tone === 'warning');
  t('approval: not booked says why', approvalNotice(4, { result: 'refused', whenLabel: null, immediate: false, refusal: 'WhatsApp is not configured.' }, true).text === 'Day 4 approved. Not booked: WhatsApp is not configured.');
  t('approval: already approved', approvalNotice(4, null, true).text === 'Day 4 approved.');

  const labels = new Map([['e4', 'Feature 1'], ['e8', 'Call to action']]);
  const rewritten = rewriteNotice({ rewritten: ['e2', 'e3'], kept: ['e4', 'e8'] }, labels);
  t('rewrite: counts and names the kept fields', rewritten.lines[0] === 'Rewrote 2 texts.' && rewritten.lines[1] === 'Kept their words (no rewrite fitted): Feature 1, Call to action.' && rewritten.tone === 'warning');
  t('rewrite: all rewritten is a success', rewriteNotice({ rewritten: ['e2'], kept: [] }, labels).tone === 'success');

  t('conflict messages are recognised', isConflictMessage('This day was changed by someone else. Reload it and try again.') && isConflictMessage('This day changed or started generating meanwhile. Reload it and try again.') && !isConflictMessage('The campaign is CANCELLED.') && !isConflictMessage(null));
}

console.log(`\n${bad === 0 ? 'All template poster editor view checks passed.' : `${bad} check(s) FAILED.`}`);
process.exit(bad === 0 ? 0 : 1);
