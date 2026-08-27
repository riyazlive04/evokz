'use client';

import * as React from 'react';

import {
  ExternalLink,
  ImagePlus,
  Loader2,
  RefreshCw,
  SquareDashedMousePointer,
  Trash2,
  Upload,
} from 'lucide-react';

import {
  deleteVerticalTemplate,
  extractTemplateLayout,
  extractVerticalLayouts,
  renameVerticalTemplate,
  setTemplateLayoutApproval,
  setTemplateLayoutSpec,
  setTemplatePaletteSource,
  setTemplatePlateApproval,
  uploadTemplatePlate,
  uploadVerticalTemplate,
} from '@/app/admin/dashboard/actions';
import { PlateRegionEditor } from '@/components/admin/PlateRegionEditor';
import { Button } from '@/components/ui/button';
import { useAction } from '@/hooks/use-action';
import { MAX_TEMPLATES_PER_CATEGORY } from '@/lib/template-limits';

/**
 * Reference-poster library for one vertical, and the layout each one represents.
 *
 * The mapping is the point. An uploaded image on its own tells the renderer
 * nothing — satori composes from code and cannot replay a raster. What it can do
 * is use the layout an operator says a reference represents, which is what the
 * picker on each card records. Generation then draws that vertical's layouts from
 * this set, duplicates and all, so uploading eight diagonal references and two
 * curved ones produces campaigns in roughly that mix.
 *
 * Mapping happens here rather than during upload: a bulk selection gives no
 * opportunity to say which file is which, and the choice needs the image in front
 * of you.
 *
 * Uploads run one file per action call rather than one call carrying the whole
 * selection. Server Actions have a body limit, a batch of full-size posters
 * would breach it, and sequencing gives a per-file error — "poster-3.png is
 * 9 MB" — instead of one failure for the batch with nothing to act on.
 */

export interface VerticalTemplateRow {
  id: string;
  label: string;
  /** Gallery-sized, through the console's own authenticated proxy. */
  thumbnailUrl: string;
  /** The stored file at full size, through the same proxy. */
  viewUrl: string;
  width: number | null;
  height: number | null;
  /**
   * The template's own extracted geometry, pretty-printed, or null when
   * extraction has not run or produced nothing this build can read.
   *
   * Present even when the draft is structurally invalid — see `layoutProblems`.
   * A draft with two headlines is one edit away from correct, and hiding it
   * would hide the fix along with the fault.
   */
  layoutSpec: string | null;
  /** Why the draft cannot render yet. Empty when it is good to approve. */
  layoutProblems: string[];
  /**
   * Why this draft did not approve itself, though it renders.
   *
   * Distinct from `layoutProblems`, which is geometry the renderer refuses.
   * These are specs that draw a perfectly good-looking poster that is wrong —
   * the extractor contradicting its own reading, or a layout whose only flexible
   * band has nothing in it to hold the space open. An operator may still approve
   * past one by hand; the point is that nothing does it for them.
   */
  layoutRisks: string[];
  /** The model's band-by-band reading, or why there isn't one. */
  layoutReading: string | null;
  /** True once an operator has confirmed the spec against the template. */
  layoutApproved: boolean;
  /**
   * Whether this layout was written by hand rather than read from the image.
   *
   * Drives the confirmation on re-reading: replacing an authored spec with an
   * extraction is always a downgrade, so it takes a second click — the same
   * idiom deleting a template uses.
   */
  layoutAuthored: boolean;

  // ---- Clean plate ---------------------------------------------------------
  /** Whether a plate has been uploaded at all. */
  hasPlate: boolean;
  /** Photo regions measured from the plate's transparency. */
  plateRegions: number;
  /**
   * Text regions an operator has placed on the plate.
   *
   * Reported separately from `plateRegions` because the two come from different
   * places and fail differently: photo regions are measured and are right or
   * absent, while text regions are placed and are the reason a plate cannot be
   * approved — a plate with holes and no headline box is the state every plate
   * starts in.
   */
  plateTextRegions: number;
  /** The plate's region map, pretty-printed, for the JSON editor. */
  plateSpec: string | null;
  /** Why the plate cannot composite yet. Empty when it is good to approve. */
  plateProblems: string[];
  /** True once an operator has seen the plate composited and confirmed it. */
  plateApproved: boolean;
  /** Whether posters from this template keep the reference's own colours. */
  usesTemplatePalette: boolean;
}


export function VerticalTemplatePanel({
  categoryId,
  categoryName,
  templates,
  totalCount,
  standardLayoutName,
  rereadableCount,
}: {
  categoryId: string;
  categoryName: string;
  /** The current page of the library, not all of it. */
  templates: VerticalTemplateRow[];
  /** Every template in the vertical, across all pages. */
  totalCount: number;
  /**
   * The layout a new upload will be given, or null when the vertical still
   * extracts one from each image.
   *
   * Worth stating on the panel rather than leaving to be discovered: the two
   * behaviours differ in whether a vision model guesses at the geometry, and an
   * operator uploading a batch should know which they are getting before the
   * batch is up.
   */
  standardLayoutName: string | null;
  /**
   * How many of the vertical's templates a bulk re-read would actually touch.
   *
   * Everything else on this panel counts templates; this one counts the ones
   * without a hand-authored layout, because that is the only number the sweep
   * acts on. `extractVerticalLayouts` skips authored specs outright rather than
   * confirm past them, so in a vertical whose layouts were all applied from a
   * fixture — the normal state now — the sweep can only ever be a no-op. Without
   * this the button said "Re-read all 14?", spun, and came back "0 layout(s)
   * re-read": a refusal an operator can only read as a fault.
   */
  rereadableCount: number;
}) {
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [progress, setProgress] = React.useState<string | null>(null);
  const [problems, setProblems] = React.useState<string[]>([]);
  /**
   * Templates from this batch that uploaded fine and are not usable.
   *
   * Held in the panel rather than read off the cards, because the cards are the
   * problem: a batch of twenty-four puts the one bad reference somewhere down a
   * grid, and an operator who has just uploaded is looking at the button, not
   * the grid. Cleared when the next batch starts.
   */
  const [rejected, setRejected] = React.useState<
    { id: string; label: string; reasons: string[] }[]
  >([]);

  const upload = useAction(uploadVerticalTemplate);

  /*
   * Re-reading is the only action ever wanted for a whole vertical at once, so
   * it is the only one that belongs up here. Everything else on a template card
   * is about that template.
   */
  const rereadAll = useAction(extractVerticalLayouts);
  const [confirmAll, setConfirmAll] = React.useState(false);
  /**
   * The last sweep's summary.
   *
   * Held here rather than read off the action, which reports only pending and
   * error — the same reason `progress` and `rejected` above are local: what an
   * operator needs after a bulk run is what it did, and that outlives the call.
   */
  const [sweep, setSweep] = React.useState<{
    read: number;
    failed: number;
    skippedAuthored: string[];
  } | null>(null);

  React.useEffect(() => {
    if (!confirmAll) return;
    const timer = setTimeout(() => setConfirmAll(false), 5_000);
    return () => clearTimeout(timer);
  }, [confirmAll]);

  // Every template here has a hand-authored layout, so the sweep would skip all
  // of them. Named rather than inlined because both the button and the line
  // explaining it turn on the same fact.
  const nothingToReread = rereadableCount === 0;

  // Against the whole library, never the page. Sizing this to `templates.length`
  // would offer room for another twenty-four uploads on every page of a vertical
  // that is already full, and the action would refuse every one of them.
  const remaining = MAX_TEMPLATES_PER_CATEGORY - totalCount;
  const full = remaining <= 0;

  async function handleFiles(event: React.ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(event.target.files ?? []);
    if (chosen.length === 0) return;

    setProblems([]);
    setRejected([]);
    const failures: string[] = [];
    const held: { id: string; label: string; reasons: string[] }[] = [];
    // Only as many as the vertical can still hold; the action enforces the same
    // cap, but stopping here avoids a run of guaranteed failures.
    const queue = chosen.slice(0, Math.max(0, remaining));

    if (chosen.length > queue.length) {
      failures.push(
        `Only ${queue.length} of ${chosen.length} uploaded — ${categoryName} holds at most ${MAX_TEMPLATES_PER_CATEGORY}.`,
      );
    }

    for (const [index, file] of queue.entries()) {
      setProgress(`Uploading ${index + 1} of ${queue.length} — ${file.name}`);
      const body = new FormData();
      body.set('template', file);
      const result = await upload.run(categoryId, body);
      if (!result.ok) {
        failures.push(`${file.name}: ${result.error}`);
      } else if (!result.data.approved) {
        held.push({
          id: result.data.id,
          label: result.data.label,
          // An extraction that produced nothing at all reports no reasons, and
          // "held back, no reason given" is the one message this panel must
          // never show.
          reasons:
            result.data.reasons.length > 0
              ? result.data.reasons
              : ['no layout could be read from this image at all.'],
        });
      }
    }

    setProgress(null);
    setProblems(failures);
    setRejected(held);
    if (fileRef.current) fileRef.current.value = '';
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={fileRef}
          id="vertical-templates"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          onChange={handleFiles}
          disabled={upload.pending || full}
          className="hidden"
        />
        <Button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={upload.pending || full}
        >
          {upload.pending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Upload className="h-4 w-4" />
          )}
          Upload templates
        </Button>

        {totalCount > 0 && (
          <Button
            type="button"
            variant="ghost"
            /*
             * Confirmed once for the whole sweep, because it spends a vision
             * call per template and withdraws every approval it touches. Not a
             * confirmation about authored layouts — those are skipped outright,
             * since nobody pressing a bulk button is asking to discard them.
             */
            onClick={() => {
              if (!confirmAll) {
                setConfirmAll(true);
                return;
              }
              setConfirmAll(false);
              setSweep(null);
              void rereadAll.run(categoryId).then((outcome) => {
                if (outcome.ok) setSweep(outcome.data);
              });
            }}
            // Off when the sweep would skip every template. The action runs
            // fine and reports nothing done, which is the shape of a broken
            // button; the line below says why instead.
            disabled={rereadAll.pending || upload.pending || nothingToReread}
          >
            {rereadAll.pending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {/*
              Counted over what the sweep will touch, never over the library. A
              confirmation that says 14 and then reads 0 is worse than no
              confirmation: it teaches an operator that the button lies.
            */}
            {confirmAll ? `Re-read ${rereadableCount}?` : 'Re-read all layouts'}
          </Button>
        )}

        <span className="font-mono text-[11px] text-muted-foreground">
          {totalCount} / {MAX_TEMPLATES_PER_CATEGORY}
        </span>

        {progress && (
          <span className="text-[11px] text-muted-foreground">{progress}</span>
        )}
      </div>

      {/*
        The state of the vertical, stated up front rather than discovered by
        pressing the button.
      */}
      {totalCount > 0 && nothingToReread && (
        <p className="text-[11px] text-muted-foreground/70">
          Nothing to re-read: all {totalCount} layout{totalCount === 1 ? '' : 's'} here{' '}
          {totalCount === 1 ? 'was' : 'were'} written by hand, and a sweep leaves those
          alone — an extraction over an authored spec is always a downgrade. To replace
          one anyway, use <span className="text-foreground">Re-read this one</span> on its
          own card, which asks twice.
        </p>
      )}

      {totalCount > 0 && rereadableCount > 0 && rereadableCount < totalCount && (
        <p className="text-[11px] text-muted-foreground/70">
          {rereadableCount} of {totalCount} would be re-read. The other{' '}
          {totalCount - rereadableCount}{' '}
          {totalCount - rereadableCount === 1 ? 'is' : 'are'} hand-authored and will be
          left alone.
        </p>
      )}

      {sweep && (
        <p
          // Green is for a sweep that did something. One that read nothing, or
          // that failed on some, is not a success and must not be dressed as
          // one — that colour is why "0 layout(s) re-read" scanned as a
          // completed job.
          className={
            sweep.read > 0 && sweep.failed === 0
              ? 'text-[11px] text-success-ink'
              : 'text-[11px] text-warning-ink'
          }
        >
          {sweep.read} layout(s) re-read
          {sweep.failed > 0 ? `, ${sweep.failed} failed` : ''}
          {sweep.skippedAuthored.length > 0
            ? `. Left alone: ${sweep.skippedAuthored.join(', ')} — hand-authored or carrying this vertical's standard layout, and a sweep would replace them with an extraction. Use "Re-read this one" on a card to override.`
            : '.'}
        </p>
      )}

      {rereadAll.error && (
        <p role="alert" className="text-[11px] text-danger-ink">
          {rereadAll.error}
        </p>
      )}

      <p className="text-[11px] text-muted-foreground/70">
        PNG, JPEG or WebP · up to 6 MB each · select several at once. Stored in this
        vertical&apos;s Drive folder.
      </p>

      <p className="text-[11px] text-muted-foreground/70">
        {standardLayoutName ? (
          <>
            New uploads are given this vertical&apos;s standard layout,{' '}
            <span className="font-medium text-foreground">{standardLayoutName}</span>, and are
            ready to use immediately. No layout is read from the image.
          </>
        ) : (
          <>
            New uploads have their layout read from the image by a vision model, which
            estimates it. Give this vertical a standard layout to skip that.
          </>
        )}
      </p>

      {/* Said at the point of upload, because it changes what an upload *is*:
          a template whose layout reads cleanly starts generating for clients
          straight away, with nobody having looked at it. The render sweep is the
          only remaining check, so it is named here rather than buried. */}
      <p className="text-[11px] text-warning-ink">
        Uploads go live automatically when the layout reads cleanly — no approval
        step. Render the vertical afterwards (<code>npm run check:fleet</code>) and
        withdraw anything wrong.
      </p>

      {rejected.length > 0 && (
        <div className="space-y-2 rounded border border-warning-ink/40 bg-warning-ink/5 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-warning-ink">
            {rejected.length} of this batch did not go live
          </p>
          <p className="text-[11px] text-muted-foreground">
            These uploaded and are stored, but nothing will draw from them. Usually the
            file is the problem — a screenshot with browser chrome, a poster saved too
            small, the wrong export — so the fix is to delete it and upload a better one
            while you still have it open.
          </p>

          {rejected.map((template) => (
            <RejectedUpload
              key={template.id}
              template={template}
              onDeleted={() =>
                setRejected((current) => current.filter((row) => row.id !== template.id))
              }
            />
          ))}
        </div>
      )}

      {full && (
        <p className="text-[11px] text-warning-ink">
          {categoryName} is at the {MAX_TEMPLATES_PER_CATEGORY}-template limit. Delete one to add
          another.
        </p>
      )}

      {problems.length > 0 && (
        <ul role="alert" className="space-y-1">
          {problems.map((problem) => (
            <li key={problem} className="text-[11px] text-danger-ink">
              {problem}
            </li>
          ))}
        </ul>
      )}

      {templates.length === 0 ? (
        <p className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-10 text-center text-xs text-muted-foreground">
          <ImagePlus className="h-5 w-5 text-muted-foreground/60" />
          No reference templates for {categoryName} yet.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {templates.map((template) => (
            <TemplateCard key={template.id} template={template} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The shape a poster drawn from this template will actually be delivered at.
 *
 * Worth a line on every card because the client's "Creative output size" stopped
 * controlling shape: it sets the resolution, and the template sets the
 * proportions. Without this, an operator who picks "Feed landscape" and receives
 * a square poster has no way to see why — the setting they changed still says
 * landscape.
 *
 * Named shapes rather than pixels, because the pixel height depends on the
 * client's preset width and this card knows nothing about any client.
 */
function describeDelivery(width: number, height: number): string {
  const aspect = width / height;
  if (Math.abs(aspect - 1) < 0.02) return 'square';
  if (Math.abs(aspect - 0.5625) < 0.02) return '9:16';
  if (Math.abs(aspect - 0.8) < 0.02) return '4:5';
  return aspect > 1 ? `${aspect.toFixed(2)}:1 landscape` : `1:${(1 / aspect).toFixed(2)} portrait`;
}

function TemplateCard({ template }: { template: VerticalTemplateRow }) {
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const remove = useAction(deleteVerticalTemplate);
  const rename = useAction(renameVerticalTemplate);

  const [editingName, setEditingName] = React.useState(false);
  const [draftName, setDraftName] = React.useState(template.label);

  React.useEffect(() => {
    setDraftName(template.label);
  }, [template.label]);

  async function commitName() {
    if (draftName.trim() === template.label) {
      setEditingName(false);
      return;
    }
    const result = await rename.run(template.id, draftName);
    if (result.ok) setEditingName(false);
  }

  // Click twice to delete, matching the vertical list itself. A dialog for a
  // thumbnail an operator can re-upload in seconds is heavier than the risk.
  React.useEffect(() => {
    if (!confirmDelete) return undefined;
    const timer = setTimeout(() => setConfirmDelete(false), 4_000);
    return () => clearTimeout(timer);
  }, [confirmDelete]);

  return (
    <article className="overflow-hidden rounded-lg border border-border bg-background">
      <a
        href={template.viewUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="flex aspect-[3/4] items-center justify-center overflow-hidden bg-muted"
        aria-label={`Open ${template.label} full size`}
      >
        {/* A plain img: next/image would want to optimise a route that already
            returns a sized WebP, and it cannot help with a response that is
            private to this operator's session anyway. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={template.thumbnailUrl}
          alt={template.label}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
        />
      </a>

      <div className="flex items-center gap-2 px-3 py-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs text-foreground">{template.label}</span>
          <span className="block font-mono text-[10px] text-muted-foreground">
            {template.width && template.height
              ? `${template.width}×${template.height} · delivers ${describeDelivery(
                  template.width,
                  template.height,
                )}`
              : 'size unknown · delivers at the client’s output preset'}
          </span>
        </span>

        <Button
          size="icon"
          variant="ghost"
          onClick={() =>
            confirmDelete ? void remove.run(template.id) : setConfirmDelete(true)
          }
          disabled={remove.pending}
          aria-label={
            confirmDelete ? `Confirm delete ${template.label}` : `Delete ${template.label}`
          }
        >
          {remove.pending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Trash2
              className={`h-4 w-4 ${confirmDelete ? 'text-danger-ink' : ''}`}
            />
          )}
        </Button>
      </div>

      <div className="space-y-1.5 border-t border-border px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Name
          </span>
          {rename.pending && (
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
          )}
        </div>

        {/* The name is what a calendar sheet types to choose this layout, so it
            has to be editable — a filename is a poor thing to put in a
            spreadsheet three hundred times. */}
        {editingName ? (
          <input
            value={draftName}
            autoFocus
            onChange={(event) => setDraftName(event.target.value)}
            onBlur={() => void commitName()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void commitName();
              if (event.key === 'Escape') {
                setDraftName(template.label);
                setEditingName(false);
              }
            }}
            aria-label={`Name for ${template.label}`}
            className="w-full rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditingName(true)}
            className="w-full truncate rounded border border-transparent px-2 py-1 text-left text-xs text-foreground hover:border-border"
            title="Rename"
          >
            {template.label}
          </button>
        )}

        <p className="text-[10px] text-muted-foreground/70">
          Sheets choose this layout by typing this name. Renaming it means any sheet
          still using the old one will be rejected on its next import.
        </p>

        {rename.error && (
          <p role="alert" className="text-[10px] text-danger-ink">
            {rename.error}
          </p>
        )}
      </div>

      <LayoutReview template={template} />

      <PlateReview template={template} />

      {confirmDelete && !remove.pending && (
        <p className="px-3 pb-2 text-[10px] text-warning-ink">Click again to delete.</p>
      )}

      {remove.error && (
        <p role="alert" className="px-3 pb-2 text-[10px] text-danger-ink">
          {remove.error}
        </p>
      )}
    </article>
  );
}

/**
 * One upload that landed and cannot be used, with the reason and a way out.
 *
 * The delete is labelled and single-click, unlike the icon on the card, and both
 * of those are deliberate. The card's trash button guards against destroying a
 * template someone has been working on for a week, so it asks twice and says
 * nothing; this one acts on a file uploaded ten seconds ago that the panel has
 * just finished explaining is unusable, where a second click is friction
 * protecting nothing. The reason sits above it so the choice is informed rather
 * than obedient — some of these are worth keeping and correcting by hand.
 */
function RejectedUpload({
  template,
  onDeleted,
}: {
  template: { id: string; label: string; reasons: string[] };
  onDeleted: () => void;
}) {
  const remove = useAction(deleteVerticalTemplate);

  return (
    <div className="space-y-1.5 rounded border border-border bg-background p-2">
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-medium text-foreground">{template.label}</span>

        <Button
          size="sm"
          variant="outline"
          className="h-7 shrink-0 px-2 text-[10px]"
          disabled={remove.pending}
          onClick={async () => {
            const result = await remove.run(template.id);
            // Dropped from the list only once the row and its Drive file are
            // actually gone — a failed delete that vanished from the panel would
            // leave an unusable template in the vertical with nothing pointing
            // at it.
            if (result.ok) onDeleted();
          }}
        >
          {remove.pending ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <Trash2 className="mr-1 h-3 w-3" />
          )}
          Delete it
        </Button>
      </div>

      <ul className="list-disc space-y-0.5 pl-3.5 text-[11px] text-warning-ink">
        {template.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>

      <a
        href={`/api/poster/preview?templateId=${template.id}`}
        target="_blank"
        rel="noreferrer noopener"
        className="inline-block text-[11px] text-primary hover:underline"
      >
        See what it would draw
      </a>

      {remove.error && (
        <p role="alert" className="text-[11px] text-danger-ink">
          {remove.error}
        </p>
      )}
    </div>
  );
}

/**
 * The review gate for a template's extracted layout.
 *
 * This is the step that makes template-driven generation safe to ship. The
 * extractor is a vision model reading a JPEG: it is right most of the time and
 * confidently wrong the rest, and its confident mistakes are indistinguishable
 * from its correct answers on the database side. So a spec is inert until
 * somebody has seen it *rendered as a poster* — not as JSON, and not as the
 * model's own summary of what it saw, both of which read as plausible for a
 * layout that is subtly wrong.
 *
 * Hence the ordering here: the render link comes first and the JSON is folded
 * away. Approving without opening the render is possible, but the layout of this
 * panel should make it feel like skipping a step, because it is.
 */
function LayoutReview({ template }: { template: VerticalTemplateRow }) {
  const reread = useAction(extractTemplateLayout);
  const approve = useAction(setTemplateLayoutApproval);
  const save = useAction(setTemplateLayoutSpec);

  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(template.layoutSpec ?? '');

  /*
   * Re-reading an authored layout takes a second click.
   *
   * Replacing a hand-authored spec with an extraction is always a downgrade —
   * the authored one is a fixture rendered at every preset on every run, and it
   * cannot hold a vision model's confident mistake because no model produced it.
   * It is guarded rather than merely warned about because the loss was silent:
   * fourteen templates went back to a misread geometry in five minutes of
   * clicking, and nothing said so until the posters came out wrong.
   *
   * Same idiom as deleting a template, and reset on any other interaction so a
   * stale confirmation cannot be spent on a later click.
   */
  const [confirmReread, setConfirmReread] = React.useState(false);

  React.useEffect(() => {
    if (!confirmReread) return;
    const timer = setTimeout(() => setConfirmReread(false), 5_000);
    return () => clearTimeout(timer);
  }, [confirmReread]);

  const runReread = () => {
    if (template.layoutAuthored && !confirmReread) {
      setConfirmReread(true);
      return;
    }
    setConfirmReread(false);
    void reread.run(template.id, template.layoutAuthored);
  };

  // The server revalidation replaces the row; without this the textarea would
  // keep showing the pre-save text after a successful re-extract.
  React.useEffect(() => {
    setDraft(template.layoutSpec ?? '');
  }, [template.layoutSpec]);

  const busy = reread.pending || approve.pending || save.pending;
  const error = reread.error ?? approve.error ?? save.error;
  const broken = template.layoutProblems.length > 0;

  // A draft that needs fixing should open its editor without a second click —
  // the problems list above it is only actionable next to the thing it describes.
  React.useEffect(() => {
    if (broken) setEditing(true);
  }, [broken]);

  return (
    <div className="space-y-1.5 border-t border-border px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Template layout
        </span>
        {busy && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
      </div>

      {template.layoutSpec ? (
        <>
          <p
            className={`text-[10px] ${
              broken
                ? 'text-danger-ink'
                : template.layoutApproved
                  ? 'text-success-ink'
                  : 'text-warning-ink'
            }`}
          >
            {broken
              ? 'Needs a correction before it can render:'
              : template.layoutApproved
                ? 'Approved — this template’s own layout is in the rotation.'
                : template.layoutRisks.length > 0
                  ? 'Held back — this one did not approve itself. Render it before you decide:'
                  : 'Draft — not in the rotation. A clean extraction approves itself, so this one was either re-read or has a fault below.'}
          </p>

          {broken && (
            <ul className="list-disc space-y-0.5 pl-3.5 text-[10px] text-danger-ink">
              {template.layoutProblems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}

          {/* Only while it is unapproved. Once a human has approved past a risk
              the warning has been answered, and repeating it on every page load
              would train the operator to ignore the colour. */}
          {!template.layoutApproved && !broken && template.layoutRisks.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-3.5 text-[10px] text-warning-ink">
              {template.layoutRisks.map((risk) => (
                <li key={risk}>{risk}</li>
              ))}
            </ul>
          )}

          {/* Straight to the render route, which returns the PNG.
              /admin/poster-preview is the archetype gallery and has no notion of
              a template — pointing here at that page opened it and silently
              ignored the id, which reads as the button doing nothing. */}
          {!broken && (
            <a
              href={`/api/poster/preview?templateId=${encodeURIComponent(template.id)}`}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 text-[10px] font-medium text-foreground underline-offset-2 hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              See this template rendered
            </a>
          )}

          <div className="flex flex-wrap gap-1.5 pt-0.5">
            <Button
              size="sm"
              variant={template.layoutApproved ? 'ghost' : 'default'}
              className="h-7 px-2 text-[10px]"
              // A broken draft cannot be approved. The server refuses it too;
              // this only saves the round trip and the error message.
              disabled={busy || (broken && !template.layoutApproved)}
              onClick={() =>
                void approve.run(template.id, !template.layoutApproved)
              }
            >
              {template.layoutApproved ? 'Withdraw' : 'Approve layout'}
            </Button>

            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[10px]"
              disabled={busy}
              onClick={() => setEditing((open) => !open)}
            >
              {editing ? 'Close' : 'Edit'}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-[10px] text-muted-foreground/70">
            No layout read from this template yet. Until there is one, it falls back
            to the mapped layout above.
          </p>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-[10px]"
            disabled={busy}
            onClick={runReread}
          >
            Read layout
          </Button>
        </>
      )}


      {editing && (
        <div className="space-y-1.5 pt-1">
          {/*
            * The model's account of what it saw, and the control that replaces
            * it. Both were on the face of the card and both are noise there: a
            * vertical of a dozen templates became a wall of paragraphs and
            * buttons an operator had to read past. They belong with the editor,
            * which is where somebody is already looking at this one template in
            * particular.
            */}
          {template.layoutReading && (
            <p className="text-[10px] leading-snug text-muted-foreground/80">
              {template.layoutReading}
            </p>
          )}

          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-[10px]"
            disabled={busy}
            onClick={runReread}
          >
            {confirmReread ? 'Discard authored layout?' : 'Re-read this one'}
          </Button>

          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            rows={14}
            aria-label={`Layout spec for ${template.label}`}
            className="w-full rounded border border-border bg-muted/40 p-2 font-mono text-[10px] leading-tight text-foreground"
          />
          <div className="flex gap-1.5">
            <Button
              size="sm"
              className="h-7 px-2 text-[10px]"
              disabled={busy || draft === template.layoutSpec}
              onClick={async () => {
                const result = await save.run(template.id, draft);
                if (result.ok) setEditing(false);
              }}
            >
              Save layout
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[10px]"
              disabled={busy}
              onClick={() => {
                setDraft(template.layoutSpec ?? '');
                setEditing(false);
              }}
            >
              Discard
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground/70">
            Saving clears the approval — the layout has to be reviewed again.
          </p>
        </div>
      )}

      {error && (
        <p role="alert" className="text-[10px] text-danger-ink">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The clean plate: upload, review, approve.
 *
 * A plate changes what rendering *is* for this template. Without one the poster
 * is rebuilt from the extracted grid — band structure reproduced, every visual
 * treatment lost. With one the template's own artwork is the poster, the
 * generated photograph shows through the holes the operator cut, and the type is
 * drawn on top. The heart-shaped mask, the rounded feature cards, the curved
 * footer: preserved as pixels, because they are never described at all.
 *
 * Its own approval gate, beside the layout's rather than replacing it. The two
 * can be right and wrong independently, and withdrawing a plate has to drop the
 * template back to the grid without disturbing a spec that was fine.
 */
function PlateReview({ template }: { template: VerticalTemplateRow }) {
  const upload = useAction(uploadTemplatePlate);
  const approve = useAction(setTemplatePlateApproval);
  const palette = useAction(setTemplatePaletteSource);

  const inputRef = React.useRef<HTMLInputElement>(null);
  const [editing, setEditing] = React.useState(false);
  const busy = upload.pending || approve.pending || palette.pending;
  const error = upload.error ?? approve.error ?? palette.error;
  const broken = template.plateProblems.length > 0;
  // The state every plate starts in: holes measured, nowhere for the type to go.
  // Called out separately from `broken` because it is not a mistake to correct
  // but a step not yet taken, and the fix is one button rather than a list.
  const unplaced = template.hasPlate && template.plateTextRegions === 0;

  return (
    <div className="space-y-2 border-t border-border/60 px-3 py-2">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Clean plate
      </p>

      {!template.hasPlate ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          None. This template is rebuilt from its grid, so its masks, cards, curves and
          colours are not reproduced. Upload the artwork as a PNG with its own words erased
          and the photo areas made transparent.
        </p>
      ) : (
        <p
          className={
            template.plateApproved
              ? 'text-[11px] text-success-ink'
              : 'text-[11px] text-muted-foreground'
          }
        >
          {template.plateApproved
            ? `Approved — posters are composited onto this plate. ${template.plateRegions} photo region(s), ${template.plateTextRegions} text region(s).`
            : `Uploaded, not approved. ${template.plateRegions} photo region(s) measured, ${template.plateTextRegions} text region(s) placed. Posters still use the grid.`}
        </p>
      )}

      {unplaced && (
        <p className="text-[11px] leading-relaxed text-warning-ink">
          Nowhere for the copy to go yet. Open the regions editor and read them from the
          original — a plate with no headline region cannot be approved.
        </p>
      )}

      {broken && (
        <ul className="space-y-0.5 text-[11px] text-warning-ink">
          {template.plateProblems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}

      {template.hasPlate && (
        <a
          href={`/api/poster/preview?templateId=${template.id}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
        >
          <ExternalLink className="h-3 w-3" />
          See this template rendered
        </a>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          accept="image/png"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            const data = new FormData();
            data.set('plate', file);
            void upload.run(template.id, data);
            // Cleared so re-selecting the same file after a failed upload still
            // fires a change event.
            event.target.value = '';
          }}
        />

        <Button size="sm" variant="outline" disabled={busy} onClick={() => inputRef.current?.click()}>
          {upload.pending ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <Upload className="mr-1 h-3 w-3" />
          )}
          {template.hasPlate ? 'Replace plate' : 'Upload plate'}
        </Button>

        {template.hasPlate && (
          <Button
            size="sm"
            variant={unplaced ? 'default' : 'outline'}
            disabled={busy}
            onClick={() => setEditing(true)}
          >
            <SquareDashedMousePointer className="mr-1 h-3 w-3" />
            Place regions
          </Button>
        )}

        {template.hasPlate && (
          <Button
            size="sm"
            variant={template.plateApproved ? 'ghost' : 'default'}
            disabled={busy || (broken && !template.plateApproved)}
            onClick={() => void approve.run(template.id, !template.plateApproved)}
          >
            {template.plateApproved ? 'Withdraw plate' : 'Approve plate'}
          </Button>
        )}

        {template.hasPlate && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void palette.run(
                template.id,
                template.usesTemplatePalette ? 'client' : 'template',
              )
            }
          >
            {template.usesTemplatePalette ? "Colours: template's" : "Colours: client's brand"}
          </Button>
        )}
      </div>

      {error && <p className="text-[11px] text-destructive">{error}</p>}

      {/* Mounted only while open, so each session starts from the stored spec
          rather than from whatever the last one left in component state. */}
      {editing && (
        <PlateRegionEditor
          templateId={template.id}
          label={template.label}
          specJson={template.plateSpec}
          hasPlate={template.hasPlate}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}
