'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

import { AlertTriangle, Lock } from 'lucide-react';

import type { ActionResult } from '@/app/admin/dashboard/actions';
import {
  approveCampaignDayPosterVersionAction,
  generateCampaignDayPosterAction,
  rejectCampaignDayPosterAction,
} from '@/app/admin/campaigns/actions';
import {
  changeCampaignDayTemplateAction,
  editCampaignDayPosterAction,
  fixCampaignDayPosterTextAction,
  loadTemplateEditorScreenAction,
  rewriteCampaignDayElementsAction,
  setCampaignDayLogoPlacementAction,
  updateCampaignDayElementsAction,
} from '@/app/admin/campaigns/clone-actions';
import { ConfirmDialog, type ConfirmRequest } from '@/components/campaign/board/board-ui';
import { BrandDetailsSection, ColoursLine, HiddenDetailsSection, PhotoSection } from '@/components/studio/template-editor/DetailsSections';
import { EditorSection, NoticeLine, type EditorNotice } from '@/components/studio/template-editor/editor-ui';
import { EditorTopBar, type SaveState } from '@/components/studio/template-editor/EditorTopBar';
import { PosterPreview, type PreviewTab } from '@/components/studio/template-editor/PosterPreview';
import { PosterChat, RejectPanel, TextCheckPanel, VersionsStrip } from '@/components/studio/template-editor/PosterReview';
import { TemplatePicker } from '@/components/studio/template-editor/TemplatePicker';
import { WordsSection, type FieldHandlers } from '@/components/studio/template-editor/WordsSection';
import { useAction } from '@/hooks/use-action';
import type { PosterRevisionResult } from '@/lib/campaign/clone-fix';
import {
  applyDraftEdits,
  approvalNotice,
  approveAction,
  chatAdditionsAtRisk,
  differsFromTemplate,
  draftEdits,
  draftFromElements,
  editorFields,
  editorStatusChip,
  elapsedSince,
  formatElapsed,
  groupEditorFields,
  hasUnsavedChanges,
  isConflictMessage,
  MAX_POSTER_CHANGE_LENGTH,
  MIN_POSTER_CHANGE_LENGTH,
  normalizeFieldText,
  normalizeImagePrompt,
  primaryActions,
  revisionAvailability,
  rewriteNotice,
  sameLogoPlacement,
  templateDefaults,
  textCheckView,
  type EditorDraft,
  type FieldDraft,
} from '@/lib/campaign/clone-editor-view';
import type { TemplateEditorScreen } from '@/lib/campaign/clone-editor-screen';
import type { TemplateChoice } from '@/lib/campaign/clone-template-change';
import { summarizeTemplateElements, type DayLogoPlacement } from '@/lib/types/template-elements';
import { cn } from '@/lib/utils';

/**
 * Poster Studio's template poster editor — the screen an admin uses for every
 * campaign poster (`/admin/poster-studio?campaignDay=<id>`).
 *
 * A campaign poster is its template, cloned, so the editor is a form over the
 * template's elements beside the poster they make:
 *
 *   top bar   back to the board (on this day's week), previous/next day, the
 *             day and its status, save state, Generate/Regenerate and Approve
 *   left      Template (Change), Words, Brand details (with logo placement),
 *             Other details, Photo, Colours — in the order the admin decides them
 *   right     Poster | Template preview (the template with the edited field's
 *             box highlighted), the text check with Fix text, Reject…, the
 *             poster chat, and the versions strip
 *
 * **Going back to an older version.** The versions strip is a choice, not a
 * gallery. Selecting v1 shows it and points the top bar at it — the button reads
 * "Approve v1" — and approving it makes v1 the day's active poster as well as
 * approving it (`approveCampaignDayPosterVersionAction`), so v1 is what the
 * client receives. The preview returns to the active view afterwards, which is
 * now v1. The chat, Fix text and the logo controls stay on the active version
 * throughout, and Reject stays with the day's own poster.
 *
 * **Changing a finished poster.** Two ways, and the editor is careful about
 * which costs money. The chat sends one instruction to the image model — two
 * minutes, billed, a new version — so its price is written under the box and it
 * sends without a dialog. "Apply logo placement" re-composites the poster's own
 * artwork with the mark where the admin put it: no model, nothing billed,
 * seconds, so it is not a long action and the form is never paused for it.
 *
 * **Saving.** Words save themselves: ~800 ms after typing stops, and at once when
 * a field loses focus (`updateCampaignDayElementsAction`, restating the revision
 * the form was loaded at). Only changed fields are sent, compared the way the
 * server stores them. A save refused because the day moved on (another tab, a
 * rewrite, a template change) reloads the day and says so rather than
 * overwriting. Everything that acts on the poster — Generate, Approve, Rewrite,
 * Change template, Fix text, the chat and Apply logo placement — saves pending
 * words first; the placement in particular, because it writes the same
 * `posterElements` document the words live in.
 *
 * **Long work.** Generating, fixing and editing take about two minutes on the
 * server and keep going if the page is left. While one runs the preview says so
 * with an elapsed timer. Started in another tab or by the queue, the day is re-read
 * every ten seconds and the form stays editable. Started from this tab, the form
 * and the ways out of the editor are paused until it answers: Next runs a page's
 * server actions one at a time, so a save made meanwhile would wait behind it,
 * and leaving would drop both.
 *
 * Every write is an existing server action with its own gate; after each one the
 * editor re-reads its view (`loadTemplateEditorScreenAction`) and calls
 * `router.refresh()`. Autosave neither revalidates nor refreshes — that would
 * re-render the whole route on every pause in typing — but re-reads the day once
 * when a save turns the current poster outdated, so Approve disappears, and
 * refreshes the router once when the editor is left after saving words.
 */

type BusyKind = 'generate' | 'fix' | 'edit' | 'logo' | 'approve' | 'reject' | 'rewrite' | 'template';
/**
 * The three that call the image model: about two minutes each, so the form is
 * paused for them. `logo` is deliberately not one — it composites the artwork
 * the day already has and takes seconds.
 */
type LongKind = 'generate' | 'fix' | 'edit';
/** What a save came to: sent, refused because the day moved on (reloaded and explained), failed, or nothing to send. */
type SaveOutcome = 'saved' | 'conflict' | 'error' | 'nothing';

const AUTOSAVE_DELAY_MS = 800;
const POLL_INTERVAL_MS = 10_000;
/** Locks under which a day's words can no longer matter: its poster went, or its day passed. */
const EDIT_LOCKS = new Set(['sent', 'sending', 'due', 'closed', 'past']);

/** Height of the console's own sticky header, so the editor's bar sticks just below it (as the board's does). */
function useConsoleHeaderHeight(): number {
  const [height, setHeight] = React.useState(0);
  React.useEffect(() => {
    const header = document.querySelector('body header');
    if (!header) return undefined;
    const update = () => setHeight(Math.round(header.getBoundingClientRect().height));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);
  return height;
}

function useElementHeight<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = React.useRef<T>(null);
  const [height, setHeight] = React.useState(0);
  React.useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const update = () => setHeight(Math.round(element.getBoundingClientRect().height));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, height];
}

export function TemplatePosterEditor({ initial }: { initial: TemplateEditorScreen }) {
  const router = useRouter();
  const dayId = initial.day.id;
  const headerOffset = useConsoleHeaderHeight();
  const [topBarRef, topBarHeight] = useElementHeight<HTMLDivElement>();

  // ---- The day, as last read ----------------------------------------------------
  const [screen, setScreenState] = React.useState(initial);
  const screenRef = React.useRef(initial);
  const writeScreen = React.useCallback((next: TemplateEditorScreen) => {
    screenRef.current = next;
    setScreenState(next);
  }, []);

  const doc = screen.template.doc;
  const fields = React.useMemo(() => editorFields(doc), [doc]);
  const groups = React.useMemo(() => groupEditorFields(doc), [doc]);
  const defaults = React.useMemo(() => templateDefaults(doc, screen.template.id, screen.brand.companyName), [doc, screen.template.id, screen.brand.companyName]);
  const labels = React.useMemo(() => new Map(fields.map((field) => [field.id, field.label])), [fields]);
  const fieldsRef = React.useRef(fields);
  React.useEffect(() => {
    fieldsRef.current = fields;
  }, [fields]);

  // ---- The form: what is typed, and what the server has ---------------------------
  const [draft, setDraftState] = React.useState<EditorDraft>(() => draftFromElements(initial.template.doc, initial.elements));
  const [prompt, setPromptState] = React.useState(initial.day.imagePrompt);
  const draftRef = React.useRef(draft);
  const promptRef = React.useRef(prompt);
  const savedRef = React.useRef({ draft, prompt, revision: initial.day.contentRevision });
  const writeDraft = React.useCallback((next: EditorDraft) => {
    draftRef.current = next;
    setDraftState(next);
  }, []);
  const writePrompt = React.useCallback((next: string) => {
    promptRef.current = next;
    setPromptState(next);
  }, []);

  const [saveState, setSaveState] = React.useState<SaveState>('idle');
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const timerRef = React.useRef<number | null>(null);
  const flightRef = React.useRef<Promise<SaveOutcome> | null>(null);
  /** A Generate, Fix text or Small change from this tab is running: typing is not taken, polls and leaving wait. */
  const longRef = React.useRef(false);
  /** An autosave changed the day since the router was last refreshed (autosave does not revalidate). */
  const wroteRef = React.useRef(false);
  const pollingRef = React.useRef(false);

  const [focusedId, setFocusedId] = React.useState<string | null>(null);
  const [previewTab, setPreviewTab] = React.useState<PreviewTab>(initial.activeVersion ? 'poster' : 'template');
  const [viewVersionId, setViewVersionId] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<EditorNotice | null>(null);
  const [confirm, setConfirm] = React.useState<ConfirmRequest | null>(null);
  const [busy, setBusy] = React.useState<{ kind: BusyKind; startedAt: number } | null>(null);

  // ---- The poster chat ------------------------------------------------------------
  const chatRef = React.useRef<HTMLTextAreaElement>(null);
  /** What this tab's running change asked for, and what the last one that failed said. */
  const [chatSent, setChatSent] = React.useState('');
  const [chatFailure, setChatFailure] = React.useState<{ message: string; billed: boolean } | null>(null);

  // ---- Logo placement -------------------------------------------------------------
  const savedLogo = screen.elements.logo ?? null;
  const [logoDraft, setLogoDraft] = React.useState<DayLogoPlacement | null>(savedLogo);
  const [logoOpen, setLogoOpen] = React.useState(false);
  // The controls follow the day: a placement applied here, or saved in another
  // tab, becomes what they show. Typing is not at stake — there is nothing to lose.
  const seenLogo = React.useRef(savedLogo);
  React.useEffect(() => {
    if (sameLogoPlacement(seenLogo.current, savedLogo)) return;
    seenLogo.current = savedLogo;
    setLogoDraft(savedLogo);
  }, [savedLogo]);

  const { run: runLoad } = useAction(loadTemplateEditorScreenAction);
  const { run: runUpdate } = useAction(updateCampaignDayElementsAction);
  const { run: runGenerate } = useAction(generateCampaignDayPosterAction);
  const { run: runApprove } = useAction(approveCampaignDayPosterVersionAction);
  const reject = useAction(rejectCampaignDayPosterAction);
  const { run: runRewrite } = useAction(rewriteCampaignDayElementsAction);
  const { run: runChangeTemplate } = useAction(changeCampaignDayTemplateAction);
  const { run: runFix } = useAction(fixCampaignDayPosterTextAction);
  const { run: runEdit } = useAction(editCampaignDayPosterAction);
  const { run: runPlaceLogo } = useAction(setCampaignDayLogoPlacementAction);

  const isUnsaved = React.useCallback(
    () => timerRef.current !== null || flightRef.current !== null || hasUnsavedChanges(fieldsRef.current, savedRef.current, { draft: draftRef.current, prompt: promptRef.current }),
    [],
  );

  /**
   * Re-reads the day. The form is replaced by the server's words when asked to,
   * when the template changed, or when the day moved on and nothing is pending
   * here; otherwise the admin's unsaved typing is kept (and its save will say if
   * it conflicts).
   */
  const reload = React.useCallback(
    async (options: { resetDraft: boolean }): Promise<TemplateEditorScreen | null> => {
      const result = await runLoad(dayId);
      if (!result.ok) {
        setNotice({ tone: 'danger', lines: [result.error] });
        return null;
      }
      if (result.data.kind !== 'editor') {
        // The template went away or is no longer read: the page says what to do.
        router.refresh();
        return null;
      }
      const next = result.data.screen;
      const previous = screenRef.current;
      writeScreen(next);
      const pending = isUnsaved();
      if (options.resetDraft || next.template.id !== previous.template.id || (!pending && next.day.contentRevision !== savedRef.current.revision)) {
        if (timerRef.current !== null) {
          window.clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        const fresh = draftFromElements(next.template.doc, next.elements);
        savedRef.current = { draft: fresh, prompt: next.day.imagePrompt, revision: next.day.contentRevision };
        writeDraft(fresh);
        writePrompt(next.day.imagePrompt);
        setSaveState('idle');
        setSaveError(null);
      }
      return next;
    },
    [dayId, isUnsaved, router, runLoad, writeDraft, writePrompt, writeScreen],
  );
  const reloadRef = React.useRef(reload);
  React.useEffect(() => {
    reloadRef.current = reload;
  }, [reload]);

  /** Sends whatever the server does not have yet. 'saved' and 'nothing' mean nothing is left unsaved. */
  const save = React.useCallback(async (): Promise<SaveOutcome> => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    while (flightRef.current) await flightRef.current;

    const base = savedRef.current;
    const edits = draftEdits(fieldsRef.current, base.draft, draftRef.current);
    const nextPrompt = promptRef.current;
    const promptChanged = normalizeImagePrompt(nextPrompt) !== normalizeImagePrompt(base.prompt);
    if (edits.length === 0 && !promptChanged) {
      setSaveState((state) => (state === 'dirty' || state === 'error' ? 'idle' : state));
      setSaveError(null);
      return 'nothing';
    }

    const flight = (async (): Promise<SaveOutcome> => {
      setSaveState('saving');
      const result = await runUpdate(dayId, { values: edits, ...(promptChanged ? { imagePrompt: nextPrompt } : {}) }, base.revision);
      if (result.ok) {
        if (result.data.changed) wroteRef.current = true;
        savedRef.current = {
          draft: applyDraftEdits(base.draft, edits),
          prompt: promptChanged ? nextPrompt : base.prompt,
          revision: result.data.contentRevision,
        };
        setSaveError(null);
        const stillDirty = hasUnsavedChanges(fieldsRef.current, savedRef.current, { draft: draftRef.current, prompt: promptRef.current });
        setSaveState(stillDirty ? 'dirty' : 'saved');
        if (result.data.revisionBumped) {
          const current = screenRef.current;
          writeScreen({ ...current, day: { ...current.day, contentRevision: result.data.contentRevision } });
          // The poster on show no longer matches its words: re-read so its status and Approve follow.
          if (current.activeVersion?.current) void reloadRef.current({ resetDraft: false });
        }
        return 'saved';
      }
      if (isConflictMessage(result.error)) {
        await reloadRef.current({ resetDraft: true });
        setNotice({
          tone: 'warning',
          lines: ['This day was changed somewhere else (another tab, a rewrite or a template change), so your last change was not saved. The latest words are loaded — make the change again.'],
        });
        return 'conflict';
      }
      setSaveError(result.error);
      setSaveState('error');
      return 'error';
    })();

    flightRef.current = flight;
    let saved = false;
    try {
      const outcome = await flight;
      saved = outcome === 'saved';
      return outcome;
    } finally {
      flightRef.current = null;
      // Typing that arrived during a successful save goes out on its own
      // schedule. After a failure nothing is retried by itself — the admin's next
      // keystroke, a blur or "Retry" does — so a refusal is never hammered.
      if (saved && timerRef.current === null && hasUnsavedChanges(fieldsRef.current, savedRef.current, { draft: draftRef.current, prompt: promptRef.current })) {
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null;
          void saveRef.current();
        }, AUTOSAVE_DELAY_MS);
      }
    }
  }, [dayId, runUpdate, writeScreen]);
  const saveRef = React.useRef(save);
  React.useEffect(() => {
    saveRef.current = save;
  }, [save]);

  const scheduleSave = React.useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    setSaveState((state) => (state === 'saving' ? state : 'dirty'));
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void saveRef.current();
    }, AUTOSAVE_DELAY_MS);
  }, []);

  // Leaving with words not yet on the server: warn on a reload or close, and send them (best effort) on an in-app
  // navigation. Autosave does not revalidate, so once the day's words changed here the router is refreshed on the
  // way out and the page left to (the board, another day) is not served from its cache.
  React.useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!isUnsaved()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const refreshIfWritten = () => {
        if (wroteRef.current) router.refresh();
      };
      if (isUnsaved()) void saveRef.current().then(refreshIfWritten, refreshIfWritten);
      else refreshIfWritten();
    };
  }, [isUnsaved, router]);

  const handlers: FieldHandlers = React.useMemo(
    () => ({
      onChange: (id: string, patch: Partial<FieldDraft>) => {
        if (longRef.current) return;
        const before = draftRef.current[id] ?? { text: '', removed: false };
        writeDraft({ ...draftRef.current, [id]: { ...before, ...patch } });
        scheduleSave();
      },
      onFocus: (id: string) => setFocusedId(id),
      onBlur: () => {
        void saveRef.current();
      },
    }),
    [scheduleSave, writeDraft],
  );

  // ---- Status -------------------------------------------------------------------
  const day = screen.day;
  const active = screen.activeVersion;
  const longRunning = busy !== null && (busy.kind === 'generate' || busy.kind === 'fix' || busy.kind === 'edit') ? busy : null;
  const generating = screen.generation.inProgress || longRunning !== null;
  const actionBusy = busy !== null;
  const formLocked = screen.campaign.closed || (screen.status.lock !== null && EDIT_LOCKS.has(screen.status.lock));
  const chip = generating ? { label: longRunning?.kind === 'fix' ? 'Fixing text' : longRunning?.kind === 'edit' ? 'Changing' : 'Generating', tone: 'secondary' as const } : editorStatusChip({ status: screen.status.board, posterState: screen.status.posterState });
  const primary = primaryActions({ flags: screen.actions, hasPoster: active !== null, generating, busy: actionBusy });
  const viewed = viewVersionId ? (screen.versions.find((version) => version.id === viewVersionId) ?? null) : null;
  const viewingOlder = viewVersionId !== null && viewVersionId !== active?.id;
  // Which version the top bar's Approve acts on: the one on show, so choosing v1
  // and pressing "Approve v1" makes v1 the day's poster again.
  const approve = approveAction({
    active: active ? { id: active.id, versionNumber: active.versionNumber } : null,
    viewed: viewed ? { id: viewed.id, versionNumber: viewed.versionNumber, approvalStatus: viewed.approvalStatus, current: viewed.current, hasArtwork: viewed.imageUrl !== null } : null,
    approveActive: primary.approve,
    campaignStatus: screen.campaign.status,
    generating,
    busy: actionBusy,
    lock: screen.status.lock,
  });
  const revision = revisionAvailability({
    campaignStatus: screen.campaign.status,
    poster: active ? { current: active.current, hasArtwork: active.imageUrl !== null, textCheck: active.textCheck } : null,
    generating,
    busy: actionBusy,
    lock: screen.status.lock,
    viewingOlder,
  });
  const checkView = textCheckView(active?.textCheck ?? null);
  const shownWords = fields.some((field) => field.category === 'content' && !draft[field.id]?.removed && normalizeFieldText(draft[field.id]?.text) !== null);
  /** Instructions the chat put on this poster that a new one would not have — quoted back before Regenerate. */
  const atRisk = React.useMemo(() => chatAdditionsAtRisk(screen.versions), [screen.versions]);

  // Elapsed time of the running attempt: the server's start when it is generating, else this tab's.
  // Starts from the load instant, not the clock, so the server and browser render the same text.
  const [nowMs, setNowMs] = React.useState(() => Date.parse(initial.loadedAt));
  React.useEffect(() => {
    if (!generating) return undefined;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [generating]);
  const queued = screen.generation.inProgress && screen.generation.status === 'QUEUED' && longRunning === null;
  const elapsed = elapsedSince(screen.generation.status === 'GENERATING' ? screen.generation.startedAt : null, nowMs, longRunning?.startedAt ?? null);
  const workLabel = longRunning?.kind === 'fix' ? 'Fixing text' : longRunning?.kind === 'edit' ? 'Applying your change' : 'Generating poster';
  // Announced once (it stays the same for the whole run); the ticking timer is shown beside it, outside the live region.
  const generatingStatus = queued ? 'Waiting in the generation queue…' : `${workLabel}…`;
  const generatingTimer = queued ? null : `${formatElapsed(elapsed)} (usually about 2 minutes)`;
  const pausedReason = longRunning ? 'Editing is paused until this poster finishes — about 2 minutes.' : null;
  const formDisabled = formLocked || longRunning !== null;

  // While a poster is being made elsewhere (another tab, the queue), keep this view current; when it lands, refresh
  // the route. Not while this tab's own long action runs — a poll would only wait behind it — and never two at once.
  const pollActive = screen.generation.inProgress && longRunning === null;
  React.useEffect(() => {
    if (!pollActive) return undefined;
    const timer = window.setInterval(() => {
      if (longRef.current || pollingRef.current) return;
      pollingRef.current = true;
      void reloadRef.current({ resetDraft: false }).finally(() => {
        pollingRef.current = false;
      });
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [pollActive]);
  const wasInProgress = React.useRef(screen.generation.inProgress);
  React.useEffect(() => {
    if (wasInProgress.current && !screen.generation.inProgress && longRunning === null) {
      setPreviewTab('poster');
      setViewVersionId(null);
      router.refresh();
    }
    wasInProgress.current = screen.generation.inProgress;
  }, [screen.generation.inProgress, longRunning, router]);

  // ---- Actions -----------------------------------------------------------------
  async function saveFirst(): Promise<boolean> {
    const outcome = await save();
    if (outcome === 'saved' || outcome === 'nothing') return true;
    // A conflict has already reloaded the day and said why; only a failure needs saying here.
    if (outcome === 'error') setNotice({ tone: 'danger', lines: ['Your latest words could not be saved, so nothing else was done. Retry the save first.'] });
    return false;
  }

  /**
   * Starts Generate, Fix text or Small change. Typing stops being taken first, so the save flushed here is the
   * last one until the action answers (a save sent meanwhile would only queue behind it); the form shows as paused
   * at once. Resolves false, un-paused, when the words could not be saved.
   */
  async function beginLongAction(kind: LongKind): Promise<boolean> {
    longRef.current = true;
    setBusy({ kind, startedAt: Date.now() });
    if (await saveFirst()) {
      setBusy({ kind, startedAt: Date.now() });
      return true;
    }
    longRef.current = false;
    setBusy(null);
    return false;
  }

  function endLongAction() {
    longRef.current = false;
    setBusy(null);
  }

  async function afterWrite(options: { resetDraft: boolean }) {
    await reload(options);
    router.refresh();
    wroteRef.current = false;
  }

  async function navigate(href: string) {
    // Leaving now would drop this tab's running action and its answer.
    if (longRef.current) return;
    // A conflict already reloaded the day and lost those words, so there is nothing left to keep the admin here for.
    if ((await save()) === 'error') {
      setNotice({ tone: 'danger', lines: ['Your latest words could not be saved. Retry the save, or reload the page to discard them.'] });
      return;
    }
    router.push(href);
  }

  function generatePoster() {
    const hasPoster = active !== null;
    const go = async () => {
      if (!(await beginLongAction('generate'))) return;
      setNotice(null);
      setPreviewTab('poster');
      setViewVersionId(null);
      const result = await runGenerate(screen.campaign.id, dayId, { mode: primary.generate.mode, explicit: true });
      endLongAction();
      await afterWrite({ resetDraft: false });
      if (!result.ok) return setNotice({ tone: 'danger', lines: [result.error] });
      const outcome = result.data;
      setNotice({ tone: outcome.outcome === 'generated' ? 'success' : outcome.outcome === 'failed' ? 'danger' : 'warning', lines: [outcome.message] });
    };
    if (!hasPoster) {
      void go();
      return;
    }
    setConfirm({
      title: `Make a new poster for day ${day.dayNumber}?`,
      body: (
        <>
          <p>One high-quality AI image generation, billed to this client — about two minutes.</p>
          <p>The new version replaces the current poster and needs approval again (unless auto-approve is on). The current one stays in the versions.</p>
          {/* A chat-added footer exists only in this poster's pixels — nothing on the day records it, so a new poster cannot carry it over. */}
          {atRisk.length > 0 && (
            <p>
              {atRisk.length === 1 ? 'What you asked for in the chat' : `The ${atRisk.length} changes you asked for in the chat`} — {atRisk.map((line) => `“${line}”`).join(', ')} — are not part of
              the template, so the new poster will not have them.
            </p>
          )}
        </>
      ),
      confirmLabel: 'Regenerate',
      onConfirm: () => {
        void go();
      },
    });
  }

  /**
   * Approves the version on show. When it is not the day's active one the same
   * server action makes it active first, so "Approve v1" ends with v1 both
   * approved and the poster delivery sends; the preview then returns to the
   * active view, which is now v1.
   */
  function approvePoster() {
    const target = approve.target;
    if (!target) return;
    const go = async () => {
      if (!(await saveFirst())) return;
      setBusy({ kind: 'approve', startedAt: Date.now() });
      const result = await runApprove(dayId, target.versionId);
      setBusy(null);
      if (result.ok) setViewVersionId(null);
      await afterWrite({ resetDraft: false });
      if (!result.ok) return setNotice({ tone: 'danger', lines: [result.error] });
      const told = approvalNotice(
        day.dayNumber,
        result.data.booking,
        screen.campaign.status === 'ACTIVE',
        result.data.activated ? { versionNumber: result.data.versionNumber } : null,
      );
      setNotice({ tone: told.tone, lines: [told.text] });
    };
    if (screen.status.lock === 'closed' && screen.campaign.status === 'ACTIVE') {
      setConfirm({
        title: target.activates ? `Use v${target.versionNumber} for day ${day.dayNumber} now?` : `Approve day ${day.dayNumber} now?`,
        body: (
          <>
            <p>Today&apos;s delivery time has already passed.</p>
            {target.activates && <p>v{target.versionNumber} becomes this day&apos;s poster, in place of the one it uses now.</p>}
            <p>Approving books it straight away, so it will be sent to the client&apos;s WhatsApp within a minute.</p>
          </>
        ),
        confirmLabel: target.activates ? `Approve v${target.versionNumber} and send` : 'Approve and send',
        tone: 'destructive',
        onConfirm: go,
      });
      return;
    }
    void go();
  }

  async function rejectPoster(input: { reason: string; detail: string }): Promise<boolean> {
    if (!active) return false;
    setBusy({ kind: 'reject', startedAt: Date.now() });
    const result = await reject.run(dayId, active.id, input);
    setBusy(null);
    await afterWrite({ resetDraft: false });
    if (!result.ok) return false;
    setNotice({ tone: 'warning', lines: [`Sent back: ${result.data.note}. The poster is kept — fix its text, make a small change, or regenerate it.`] });
    return true;
  }

  function rewriteWords() {
    setConfirm({
      title: 'Rewrite this poster’s words?',
      body: (
        <>
          <p>One short AI text call writes fresh wording for every shown text, each close to its template length. Words you typed are replaced.</p>
          <p>The business name, phone, website and logo are not changed.</p>
        </>
      ),
      confirmLabel: 'Rewrite',
      onConfirm: async () => {
        if (!(await saveFirst())) return;
        setBusy({ kind: 'rewrite', startedAt: Date.now() });
        const result = await runRewrite(dayId);
        setBusy(null);
        await afterWrite({ resetDraft: true });
        if (!result.ok) return setNotice({ tone: 'danger', lines: [result.error] });
        setNotice(rewriteNotice(result.data, labels));
      },
    });
  }

  function chooseTemplate(choice: TemplateChoice) {
    const go = async () => {
      if (!(await saveFirst())) return;
      setBusy({ kind: 'template', startedAt: Date.now() });
      const result = await runChangeTemplate(dayId, choice.id, savedRef.current.revision);
      setBusy(null);
      await afterWrite({ resetDraft: true });
      if (!result.ok) {
        const conflict = isConflictMessage(result.error);
        return setNotice({ tone: conflict ? 'warning' : 'danger', lines: [result.error, ...(conflict ? ['The latest version of this day is loaded.'] : [])] });
      }
      setPreviewTab('template');
      setNotice({
        tone: 'success',
        lines: [`Template changed to “${result.data.templateLabel}”. The words are now that template’s${active ? ' — the poster is outdated until you generate a new one' : ''}.`],
      });
    };
    const edited = differsFromTemplate(fields, defaults, draftRef.current);
    if (!edited && !active) {
      void go();
      return;
    }
    setConfirm({
      title: `Use “${choice.label}” for day ${day.dayNumber}?`,
      body: (
        <>
          {edited && <p>The words you changed on this day are replaced by the new template&apos;s.</p>}
          {active && <p>The current poster becomes outdated until you generate a new one.</p>}
          <p>Your photo description is kept.</p>
        </>
      ),
      confirmLabel: 'Change template',
      onConfirm: go,
    });
  }

  async function revisePoster(kind: 'fix' | 'edit', call: () => Promise<ActionResult<PosterRevisionResult>>): Promise<boolean> {
    if (!(await beginLongAction(kind))) return false;
    setNotice(null);
    setPreviewTab('poster');
    setViewVersionId(null);
    const result = await call();
    endLongAction();
    await afterWrite({ resetDraft: false });
    if (!result.ok) {
      setNotice({ tone: 'danger', lines: [result.error] });
      return false;
    }
    if (result.data.outcome === 'revised') {
      setNotice({ tone: result.data.textCheckIssues ? 'warning' : 'success', lines: [result.data.message] });
      return true;
    }
    setNotice({ tone: 'danger', lines: [result.data.message] });
    return false;
  }

  function fixText() {
    const count = checkView.issues.length;
    setConfirm({
      title: 'Fix the text on this poster?',
      body: (
        <>
          <p>
            One high-quality AI image edit, billed to this client, that corrects only the {count} {count === 1 ? 'difference' : 'differences'} the text check found and keeps
            everything else. About two minutes.
          </p>
          <p>The result is a new version{screen.campaign.approvalPolicy === 'AUTO_APPROVE' ? '' : ' that needs approval'}; the current one stays in the versions.</p>
          {/* The check compares the render against the day's Words, so anything the chat typed onto the poster reads as a difference to correct away. */}
          {atRisk.length > 0 && <p>Anything you added through the chat is not in the Words fields, so fixing the text may remove it.</p>}
        </>
      ),
      confirmLabel: 'Fix text',
      onConfirm: () => {
        void revisePoster('fix', () => runFix(dayId));
      },
    });
  }

  /**
   * The chat's own send: no confirm dialog. The price is written permanently
   * under the box (`POSTER_CHAT_COST`), so a dialog would only be a second place
   * to read it — and the first Sirah campaign's admin never found the panel that
   * hid behind one. Every other billed action keeps its confirm, because none of
   * them states its price where the button is.
   */
  async function sendPosterChange(instruction: string): Promise<boolean> {
    if (!(await beginLongAction('edit'))) return false;
    setNotice(null);
    setChatFailure(null);
    setChatSent(instruction);
    setPreviewTab('poster');
    setViewVersionId(null);
    const result = await runEdit(dayId, instruction);
    endLongAction();
    await afterWrite({ resetDraft: false });
    if (!result.ok) {
      // `!result.ok` means the server threw rather than returned — and every
      // throw this action can make (`editCampaignDayPoster` / `revisePoster`,
      // clone-fix.ts) happens before the claim or before the paid image call,
      // so it is never billed. A failure *after* spend is never thrown: it is
      // caught inside `revisePoster` and comes back as `outcome: 'failed'`
      // with its own computed `billed`, handled below. Guessing "billed" from
      // the refusal's wording (a previous version of this code did) silently
      // mis-scored messages that did not happen to match its pattern — e.g. a
      // too-short instruction ("Describe the change you want in a few
      // words.") read as billed although nothing was ever sent to the model.
      setChatFailure({ message: result.error, billed: false });
      return false;
    }
    if (result.data.outcome === 'revised') {
      setNotice({ tone: result.data.textCheckIssues ? 'warning' : 'success', lines: [result.data.message] });
      return true;
    }
    setChatFailure({ message: result.data.message, billed: result.data.billed });
    return false;
  }

  /**
   * "Apply logo placement": the poster re-composited from its own artwork with
   * the mark where the admin put it. Words are saved first — the placement lives
   * on the day's `posterElements`, and this writes that document.
   */
  async function applyLogoPlacement() {
    if (!(await saveFirst())) return;
    setNotice(null);
    setBusy({ kind: 'logo', startedAt: Date.now() });
    const result = await runPlaceLogo(dayId, logoDraft);
    setBusy(null);
    // The draft is the admin's, not the server's: it is left exactly as it is.
    await afterWrite({ resetDraft: false });
    if (!result.ok) return setNotice({ tone: 'danger', lines: [result.error] });
    if (result.data.outcome === 'failed') return setNotice({ tone: 'danger', lines: [result.data.message] });
    setNotice({ tone: 'success', lines: [result.data.message] });
  }

  // ---- View ----------------------------------------------------------------------
  // An older version on show is a choice, not a dead end: the note says what
  // approving it would do, or why it cannot be used. "Back to v3" in the versions
  // strip is the way back.
  const posterView = viewed
    ? {
        imageUrl: viewed.imageUrl,
        fullImageUrl: viewed.fullImageUrl,
        label: `Day ${day.dayNumber} poster, version ${viewed.versionNumber}`,
        note: `Viewing v${viewed.versionNumber}. ${
          approve.target?.activates ? 'Approve it to make it the poster that is sent.' : (approve.reason ?? 'It is the poster this day already uses.')
        }`,
      }
    : active
      ? {
          imageUrl: active.imageUrl,
          fullImageUrl: active.fullImageUrl,
          label: `Day ${day.dayNumber} poster, version ${active.versionNumber}`,
          note: active.current ? null : 'Outdated — the words or template changed after this poster was made.',
        }
      : null;

  const generateReason = generating || actionBusy
    ? null
    : screen.campaign.status !== 'ACTIVE' && !screen.campaign.closed
      ? `The campaign is ${screen.campaign.status.toLowerCase()} — activate it on the board to generate posters.`
      : (screen.status.note?.text ?? screen.status.lockLabel);
  const templateReason = formLocked
    ? (screen.status.lockLabel ?? 'This campaign is closed.')
    : generating
      ? 'A poster is being made for this day.'
      : actionBusy
        ? 'Wait for the current action to finish.'
        : null;
  const rewriteReason = formLocked ? templateReason : generating || actionBusy ? templateReason : !shownWords ? 'There are no shown words to rewrite.' : null;
  const noteVisible = screen.status.note && !generating && !notice;

  // The logo preview takes the poster frame over while the controls are open, and
  // draws on the artwork BEFORE the logo was composited — the finished poster
  // already carries one, and a second drawn over it would be a lie in two marks.
  const logoBoxes = React.useMemo(() => doc.elements.filter((element) => element.kind === 'logo').map((element) => element.box), [doc]);
  const logoPreview =
    logoOpen && viewed === null && active?.rawImageUrl && screen.brand.logoTrimmedUrl && logoBoxes.length > 0
      ? { rawImageUrl: active.rawImageUrl, logoUrl: screen.brand.logoTrimmedUrl, boxes: logoBoxes, placement: logoDraft }
      : null;

  return (
    <div className="space-y-4">
      <div
        ref={topBarRef}
        role="region"
        aria-label="Poster"
        className="z-30 -mx-4 border-b border-border bg-background/95 px-4 pb-3 pt-2 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:-mx-8 sm:px-8 md:sticky"
        style={{ top: headerOffset }}
      >
        <EditorTopBar
          screen={screen}
          chip={chip}
          saveState={saveState}
          saveError={saveError}
          onRetrySave={() => void save()}
          generate={{ label: primary.generate.label, enabled: primary.generate.enabled, reason: generateReason, onClick: generatePoster }}
          approve={{
            visible: approve.target !== null || busy?.kind === 'approve',
            // While the approval runs the target is gone (the editor is busy), so the
            // label holds on to the version on show rather than snapping to the active one.
            label: approve.target?.label ?? `Approve v${viewed?.versionNumber ?? active?.versionNumber ?? ''}`,
            onClick: approvePoster,
          }}
          busyKind={busy?.kind ?? null}
          leavePausedReason={longRunning ? 'Wait until this poster finishes — about 2 minutes.' : null}
          onNavigate={(href) => void navigate(href)}
        />
      </div>

      {notice && <NoticeLine notice={notice} onDismiss={() => setNotice(null)} />}
      {noteVisible && (
        <NoticeLine notice={{ tone: screen.status.note!.tone === 'danger' ? 'danger' : 'warning', lines: [screen.status.note!.text] }} />
      )}
      {formLocked && (
        <p className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-[12px] text-muted-foreground">
          <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {screen.campaign.closed ? 'This campaign is closed, so its posters can no longer change.' : `${screen.status.lockLabel} Its words can no longer change.`}
        </p>
      )}

      <div className="grid items-start gap-5 lg:grid-cols-[420px_minmax(0,1fr)]">
        {/* ---- Form ---- */}
        <div className="order-2 min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 text-card-foreground lg:order-1">
          <EditorSection id="editor-template" title="Template">
            <TemplatePicker
              dayId={dayId}
              template={{ ...screen.template, summary: summarizeTemplateElements(doc) }}
              disabledReason={templateReason}
              pending={busy?.kind === 'template'}
              onChoose={chooseTemplate}
            />
          </EditorSection>

          {pausedReason ? (
            <p className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-[11px] text-muted-foreground">
              <Lock className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
              {pausedReason}
            </p>
          ) : (
            generating && (
              <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-2.5 py-1.5 text-[11px] text-warning-ink">
                <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
                A poster is being made from the words saved when it started. You can keep editing — changes apply to the next generation.
              </p>
            )
          )}

          <WordsSection
            groups={groups.words}
            draft={draft}
            defaults={defaults}
            focusedId={focusedId}
            disabled={formDisabled}
            handlers={handlers}
            rewrite={{ enabled: rewriteReason === null, pending: busy?.kind === 'rewrite', reason: rewriteReason, onClick: rewriteWords }}
          />
          <BrandDetailsSection
            fields={groups.brand}
            draft={draft}
            brand={screen.brand}
            brandCanvasHref={screen.links.brandCanvas}
            disabled={formDisabled}
            linkPausedReason={pausedReason}
            handlers={handlers}
            onNavigate={(href) => void navigate(href)}
            logo={
              active
                ? {
                    saved: savedLogo,
                    draft: logoDraft,
                    onDraft: setLogoDraft,
                    open: logoOpen,
                    onOpenChange: setLogoOpen,
                    availability: revision.logo,
                    pending: busy?.kind === 'logo',
                    onApply: () => void applyLogoPlacement(),
                  }
                : null
            }
          />
          <HiddenDetailsSection fields={groups.hidden} draft={draft} focusedId={focusedId} disabled={formDisabled} handlers={handlers} />
          <PhotoSection
            photos={groups.photos}
            prompt={prompt}
            disabled={formDisabled}
            onChange={(value) => {
              if (longRef.current) return;
              writePrompt(value);
              scheduleSave();
            }}
            onFocus={() => setFocusedId(groups.photos[0]?.id ?? null)}
            onBlur={() => void save()}
            onGoToChat={
              active
                ? () => {
                    chatRef.current?.focus();
                    chatRef.current?.scrollIntoView({ block: 'center' });
                  }
                : undefined
            }
          />
          <ColoursLine colourMode={screen.colourMode} colors={screen.brand.colors} />
        </div>

        {/* ---- Preview ---- */}
        <div
          className={cn(
            'order-1 min-w-0 space-y-3 lg:order-2',
            // Sticky beside the form on desktop, scrolling on its own when taller than the screen.
            'lg:sticky lg:top-[var(--editor-top)] lg:max-h-[calc(100dvh-var(--editor-top)-0.5rem)] lg:overflow-y-auto lg:pb-2',
            '[--frame-h:46dvh] lg:[--frame-h:62dvh]',
          )}
          style={{ '--editor-top': `${headerOffset + topBarHeight + 16}px` } as React.CSSProperties}
        >
          <PosterPreview
            tab={previewTab}
            onTabChange={setPreviewTab}
            aspect={{ width: doc.width, height: doc.height }}
            poster={posterView}
            template={{ imageUrl: screen.template.imageUrl, label: screen.template.label }}
            fields={fields}
            draft={draft}
            focusedId={focusedId}
            generating={generating && viewed === null ? { label: generatingStatus, timer: generatingTimer } : null}
            logoPreview={logoPreview}
          />
          {generating && (
            <p className="text-center text-[11px] text-muted-foreground lg:hidden">
              <span role="status">{generatingStatus}</span>
              {generatingTimer && <span> {generatingTimer}</span>}
            </p>
          )}

          <TextCheckPanel
            view={checkView}
            hasPoster={active !== null && !generating}
            viewingOlder={viewed !== null}
            fix={revision.fix}
            pending={busy?.kind === 'fix'}
            onFix={fixText}
          />

          {/* Kept mounted while its own rejection runs, so the form and its error stay put. */}
          {active && viewed === null && (primary.reject || busy?.kind === 'reject') && (
            <RejectPanel versionNumber={active.versionNumber} pending={reject.pending} error={reject.error} onReject={rejectPoster} />
          )}
          {/* Sending a poster back is about the one the client would receive, and only the
              active version is ever sent — so it is not offered for an older one on show. */}
          {active && viewed !== null && primary.reject && (
            <p className="text-[11px] text-muted-foreground">
              Reject&hellip; acts on the day&apos;s own poster (v{active.versionNumber}), so it is not offered while v{viewed.versionNumber} is on show.
            </p>
          )}

          {/* Mounted for any poster, so the box never disappears; only sending is gated, and it says why. */}
          {active && (
            <PosterChat
              inputRef={chatRef}
              availability={revision.edit}
              maxLength={MAX_POSTER_CHANGE_LENGTH}
              minLength={MIN_POSTER_CHANGE_LENGTH}
              brand={screen.brand}
              running={longRunning?.kind === 'edit' ? { instruction: chatSent, timer: generatingTimer } : null}
              failure={chatFailure}
              onSend={sendPosterChange}
              onDismissFailure={() => setChatFailure(null)}
            />
          )}

          <VersionsStrip versions={screen.versions} selectedId={viewVersionId} onSelect={setViewVersionId} />
        </div>
      </div>

      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
