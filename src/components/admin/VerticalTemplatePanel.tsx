'use client';

import * as React from 'react';

import { ExternalLink, ImagePlus, Loader2, Trash2, Upload } from 'lucide-react';

import {
  deleteVerticalTemplate,
  extractTemplateLayout,
  renameVerticalTemplate,
  setTemplateLayoutApproval,
  setTemplateLayoutSpec,
  uploadVerticalTemplate,
} from '@/app/admin/dashboard/actions';
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
  /** The model's band-by-band reading, or why there isn't one. */
  layoutReading: string | null;
  /** True once an operator has confirmed the spec against the template. */
  layoutApproved: boolean;
}


export function VerticalTemplatePanel({
  categoryId,
  categoryName,
  templates,
  totalCount,
}: {
  categoryId: string;
  categoryName: string;
  /** The current page of the library, not all of it. */
  templates: VerticalTemplateRow[];
  /** Every template in the vertical, across all pages. */
  totalCount: number;
}) {
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [progress, setProgress] = React.useState<string | null>(null);
  const [problems, setProblems] = React.useState<string[]>([]);

  const upload = useAction(uploadVerticalTemplate);

  // Against the whole library, never the page. Sizing this to `templates.length`
  // would offer room for another twenty-four uploads on every page of a vertical
  // that is already full, and the action would refuse every one of them.
  const remaining = MAX_TEMPLATES_PER_CATEGORY - totalCount;
  const full = remaining <= 0;

  async function handleFiles(event: React.ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(event.target.files ?? []);
    if (chosen.length === 0) return;

    setProblems([]);
    const failures: string[] = [];
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
      if (!result.ok) failures.push(`${file.name}: ${result.error}`);
    }

    setProgress(null);
    setProblems(failures);
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

        <span className="font-mono text-[11px] text-muted-foreground">
          {totalCount} / {MAX_TEMPLATES_PER_CATEGORY}
        </span>

        {progress && (
          <span className="text-[11px] text-muted-foreground">{progress}</span>
        )}
      </div>

      <p className="text-[11px] text-muted-foreground/70">
        PNG, JPEG or WebP · up to 6 MB each · select several at once. Stored in this
        vertical&apos;s Drive folder.
      </p>

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
              ? `${template.width}×${template.height}`
              : 'size unknown'}
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
                : 'Draft — not used for generation until you approve it.'}
          </p>

          {broken && (
            <ul className="list-disc space-y-0.5 pl-3.5 text-[10px] text-danger-ink">
              {template.layoutProblems.map((problem) => (
                <li key={problem}>{problem}</li>
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
              onClick={() => void reread.run(template.id)}
            >
              Re-read
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
            onClick={() => void reread.run(template.id)}
          >
            Read layout
          </Button>
        </>
      )}

      {template.layoutReading && (
        <p className="text-[10px] leading-snug text-muted-foreground/80">
          {template.layoutReading}
        </p>
      )}

      {editing && (
        <div className="space-y-1.5 pt-1">
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
