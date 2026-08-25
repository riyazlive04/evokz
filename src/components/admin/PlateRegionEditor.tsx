'use client';

import * as React from 'react';

import { Loader2, Plus, Sparkles, Trash2, X } from 'lucide-react';

import {
  extractTemplatePlateRegions,
  resampleTemplateRegionInk,
  setTemplatePlateSpec,
} from '@/app/admin/dashboard/actions';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useAction } from '@/hooks/use-action';
import type { PlateSlot } from '@/lib/types/plate-spec';

/**
 * Places the day's copy on a clean plate, by dragging boxes over the artwork.
 *
 * **The plate path's missing half.** A plate's photo regions are measured from
 * its own transparency and need no operator at all; its text regions have
 * nothing to measure, because the words are erased from the plate by definition.
 * Before this, `plateSpec.text` was written empty at upload and never written
 * again, so every plate failed validation on "found 0 headlines" and no plate
 * could be approved — the compositing path was complete and unreachable.
 *
 * **Direct manipulation rather than a JSON editor, and that is not a
 * preference.** A region map is six or seven boxes of normalised coordinates,
 * and a vertical is twenty templates: typed by hand that is several hundred
 * numbers whose only feedback is a re-render. Dragging a box over the artwork
 * answers "is the headline in the right place" in the same gesture that sets it.
 * The JSON is still here, folded away, because a spec is stored as JSON and
 * anything this panel cannot express — a headline bled off the edge, an emphasis
 * pattern — must remain reachable.
 *
 * The AI pass is a starting point, not an answer: `extractTemplatePlateRegions`
 * proposes the boxes from the reference and this is where they get corrected.
 * Nothing here approves anything — approval lives on the card, behind a render.
 */

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/*
 * The spec is held as a plain object rather than parsed with the Zod schema.
 *
 * `plate-spec.ts` pulls Zod in with it, and this is a client component: importing
 * the schema to validate what the operator is dragging would ship a parser to
 * the browser to re-derive what the server checks anyway on save. The types are
 * imported — `import type` is erased — so the shape still cannot drift silently.
 */
type Align = 'start' | 'center' | 'end';

interface TextRegion {
  slot: PlateSlot;
  x: number;
  y: number;
  w: number;
  h: number;
  align: Align;
  valign: Align;
  color: string | null;
}

interface PhotoRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: 'scene' | 'subject';
  fit: 'cover' | 'contain';
}

interface PlateSpec {
  version: 1;
  name: string;
  aspect: number;
  photos: PhotoRegion[];
  text: TextRegion[];
  featureCount: number;
  featureStyle: 'labelAndBody' | 'labelOnly';
  ctaShape: 'pill' | 'rounded' | 'square';
  headlineEmphasis: string[];
  headlineCase: 'upper' | 'sentence';
}

/**
 * Every slot a plate can position, in the order they are offered.
 *
 * A `Record` keyed by `PlateSlot` rather than an array, so removing a slot from
 * the vocabulary fails the build here instead of quietly dropping a button.
 * Reading order — top of a poster to bottom — because that is the order an
 * operator places them in.
 */
const SLOT_LABELS: Record<PlateSlot, string> = {
  logo: 'Logo',
  eyebrow: 'Eyebrow',
  headline: 'Headline',
  body: 'Body',
  features: 'Features',
  cta: 'Button',
  contact: 'Contact',
};

const SLOT_ORDER = Object.keys(SLOT_LABELS) as PlateSlot[];

const ALIGNS: Align[] = ['start', 'center', 'end'];

/** What each alignment does, in the words an operator would use. */
const ALIGN_LABELS: Record<Align, string> = { start: 'Left', center: 'Centre', end: 'Right' };
const VALIGN_LABELS: Record<Align, string> = { start: 'Top', center: 'Middle', end: 'Bottom' };

/** Three decimals, matching what the extractor is asked for. */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * How far outside the plate a box may be dragged.
 *
 * Not zero, because the schema allows a box to run past an edge and a headline
 * bleeding off the right is a real design. Not the schema's full ±1 either: a
 * box dragged a whole poster away is a slip, and being unable to drag it back
 * into view is worse than the restriction.
 */
const OUT_OF_BOUNDS = 0.25;
const MIN_SIZE = 0.02;

function defaultBox(slot: PlateSlot): TextRegion {
  /*
   * A new box lands where that slot usually lives, not at the origin.
   *
   * Every box starts wrong and gets dragged; starting it in the right half of
   * the poster makes that one drag instead of two. The values are conventions,
   * not measurements — a contact strip at the bottom, a logo at the top.
   */
  const placements: Record<PlateSlot, [number, number, number, number]> = {
    logo: [0.08, 0.05, 0.35, 0.08],
    eyebrow: [0.08, 0.16, 0.5, 0.05],
    headline: [0.08, 0.22, 0.6, 0.18],
    body: [0.08, 0.42, 0.55, 0.12],
    features: [0.08, 0.56, 0.84, 0.18],
    cta: [0.08, 0.78, 0.3, 0.08],
    contact: [0.08, 0.9, 0.84, 0.07],
  };

  const [x, y, w, h] = placements[slot];
  return { slot, x, y, w, h, align: 'start', valign: 'start', color: null };
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

interface DragState {
  mode: 'move' | 'resize';
  index: number;
  pointerX: number;
  pointerY: number;
  origin: { x: number; y: number; w: number; h: number };
}

export function PlateRegionEditor({
  templateId,
  label,
  specJson,
  hasPlate,
  onClose,
}: {
  templateId: string;
  label: string;
  /** The stored spec, pretty-printed by the page. Null when none parses. */
  specJson: string | null;
  hasPlate: boolean;
  onClose: () => void;
}) {
  const save = useAction(setTemplatePlateSpec);
  const propose = useAction(extractTemplatePlateRegions);
  const resample = useAction(resampleTemplateRegionInk);

  const [spec, setSpec] = React.useState<PlateSpec | null>(() => readSpec(specJson));
  const [selected, setSelected] = React.useState<number | null>(null);
  const [surface, setSurface] = React.useState<'plate' | 'reference'>('plate');
  const [showJson, setShowJson] = React.useState(false);
  /*
   * The JSON panel's edit buffer, and nothing else.
   *
   * Deliberately not a second copy of the spec kept in step with the boxes: a
   * half-typed edit has to be allowed to be unparseable, so it cannot be
   * derived, and mirroring every drag into it would give two sources of truth
   * for the same object with no rule for which wins. Seeded when the panel is
   * opened, read only while it is open — see `payload`.
   */
  const [json, setJson] = React.useState('');
  const [reading, setReading] = React.useState<string | null>(null);
  const [problems, setProblems] = React.useState<string[]>([]);
  const [dirty, setDirty] = React.useState(false);

  const surfaceRef = React.useRef<HTMLDivElement>(null);
  const dragRef = React.useRef<DragState | null>(null);

  const busy = save.pending || propose.pending || resample.pending;

  // Every mutation goes through here so nothing can change the spec without
  // marking it unsaved — the one bug that would lose an operator's placement.
  const update = React.useCallback((next: PlateSpec) => {
    setSpec(next);
    setDirty(true);
  }, []);

  const updateRegion = React.useCallback(
    (index: number, patch: Partial<TextRegion>) => {
      setSpec((current) => {
        if (!current) return current;
        const text = current.text.map((region, i) =>
          i === index ? { ...region, ...patch } : region,
        );
        return { ...current, text };
      });
      setDirty(true);
    },
    [],
  );

  /*
   * Pointer handling lives on the window, not on the box.
   *
   * A box being resized shrinks away from under the cursor, and a box being
   * dragged quickly is left behind by it; listeners bound to the box itself stop
   * receiving moves the moment either happens, and the box sticks halfway
   * through the gesture. The window sees every move until the button is
   * released.
   */
  React.useEffect(() => {
    function move(event: PointerEvent) {
      const drag = dragRef.current;
      const element = surfaceRef.current;
      if (!drag || !element) return;

      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      const dx = (event.clientX - drag.pointerX) / rect.width;
      const dy = (event.clientY - drag.pointerY) / rect.height;

      if (drag.mode === 'move') {
        updateRegion(drag.index, {
          x: round3(clamp(drag.origin.x + dx, -OUT_OF_BOUNDS, 1)),
          y: round3(clamp(drag.origin.y + dy, -OUT_OF_BOUNDS, 1)),
        });
      } else {
        updateRegion(drag.index, {
          w: round3(clamp(drag.origin.w + dx, MIN_SIZE, 1 + OUT_OF_BOUNDS)),
          h: round3(clamp(drag.origin.h + dy, MIN_SIZE, 1 + OUT_OF_BOUNDS)),
        });
      }
    }

    function up() {
      dragRef.current = null;
    }

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [updateRegion]);

  function startDrag(event: React.PointerEvent, index: number, mode: 'move' | 'resize') {
    /*
     * One editor at a time.
     *
     * The JSON panel holds its own buffer — it has to, since a half-typed edit
     * must be allowed to be unparseable — and a box dragged while that buffer is
     * open would change the spec underneath text the operator is about to save,
     * losing the drag. Freezing the boxes while the panel is open is the only
     * version of this with one answer to "what gets saved".
     */
    if (showJson) return;
    if (!spec) return;
    const region = spec.text[index];
    if (!region) return;

    // Stops the resize handle's own press from also starting a move on the box
    // underneath it.
    event.stopPropagation();
    event.preventDefault();

    setSelected(index);
    dragRef.current = {
      mode,
      index,
      pointerX: event.clientX,
      pointerY: event.clientY,
      origin: { x: region.x, y: region.y, w: region.w, h: region.h },
    };
  }

  function addRegion(slot: PlateSlot) {
    if (!spec) return;
    update({ ...spec, text: [...spec.text, defaultBox(slot)] });
    setSelected(spec.text.length);
  }

  function removeRegion(index: number) {
    if (!spec) return;
    update({ ...spec, text: spec.text.filter((_, i) => i !== index) });
    setSelected(null);
  }

  /**
   * What "Save" posts.
   *
   * The open JSON panel wins, because an operator who typed into it expects
   * that text to be what is saved — including the parts the boxes cannot
   * express. Closed, the boxes are the only truth there is.
   */
  function payload(): string {
    if (showJson) return json;
    return spec ? JSON.stringify(spec, null, 2) : '';
  }

  async function commit() {
    const result = await save.run(templateId, payload());
    if (!result.ok) return;
    setProblems(result.data.problems);
    setDirty(false);
  }

  async function runProposal() {
    const result = await propose.run(templateId);
    if (!result.ok) return;
    const next = readSpec(result.data.spec);
    if (next) {
      setSpec(next);
      if (showJson) setJson(result.data.spec);
    }
    setReading(result.data.reading);
    setProblems(result.data.problems);
    setSelected(null);
    // The action already wrote what it proposed, so there is nothing unsaved —
    // marking it dirty here would make "Save" look required before the operator
    // has changed anything.
    setDirty(false);
  }

  const present = new Set(spec?.text.map((region) => region.slot) ?? []);
  const selectedRegion = selected !== null ? (spec?.text[selected] ?? null) : null;
  /*
   * Whether the preview will actually draw the plate.
   *
   * Only the headline rule is checked, not the whole of `validatePlateSpec` —
   * that lives on the server with the schema, and duplicating it here would give
   * two answers to drift apart. Exactly one headline is the condition every
   * unfinished map fails, and the rest come back from the save.
   */
  const composable = (spec?.text.filter((region) => region.slot === 'headline').length ?? 0) === 1;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>Place regions — {label}</DialogTitle>
          <DialogDescription>
            Drag a box to where that block of copy sits on the artwork. The box is the
            space the copy is allowed, not the size of the words in the reference —
            copy that runs longer grows downward from the top edge.
          </DialogDescription>
        </DialogHeader>

        {!hasPlate || !spec ? (
          <p className="text-sm text-muted-foreground">
            Upload a clean plate first. The regions are stored on the plate, and its
            transparency is what fixes the photo areas they sit around.
          </p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
            {/* ---- The artwork, with the boxes over it ---- */}
            <div className="space-y-2">
              <div className="flex items-center gap-1.5">
                {(['plate', 'reference'] as const).map((option) => (
                  <Button
                    key={option}
                    size="sm"
                    variant={surface === option ? 'default' : 'outline'}
                    className="h-7 px-2 text-[11px]"
                    onClick={() => setSurface(option)}
                  >
                    {option === 'plate' ? 'Clean plate' : 'Original'}
                  </Button>
                ))}
                <span className="ml-1 text-[11px] text-muted-foreground">
                  {surface === 'plate'
                    ? 'What will be printed.'
                    : 'The words you are replacing — line the boxes up against these.'}
                </span>
              </div>

              <div
                ref={surfaceRef}
                className="relative mx-auto w-fit select-none rounded border border-border"
                style={{
                  /*
                   * A checkerboard, in fixed greys rather than theme tokens on
                   * purpose: it stands for "nothing is painted here", and a
                   * transparency swatch that changed colour with the console's
                   * theme would read as part of the artwork.
                   */
                  backgroundImage:
                    'repeating-conic-gradient(#d8d8d8 0% 25%, #f4f4f4 0% 50%)',
                  backgroundSize: '16px 16px',
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- a Drive-proxied
                    template of unknown dimensions; next/image would want a loader and a
                    size it cannot know, for an image only an operator ever sees. */}
                <img
                  src={`/api/templates/${templateId}/thumbnail?w=900${
                    surface === 'plate' ? '&plate=1' : ''
                  }`}
                  alt={`${label} ${surface}`}
                  className="block max-h-[58vh] w-auto max-w-full"
                  draggable={false}
                />

                {/* Photo regions, drawn but not editable: they are measured from
                    the plate's own transparency, and an operator who could drag
                    one would be overriding a fact with an estimate. Shown because
                    a text box placed across a photo hole is the mistake this
                    editor exists to catch. */}
                {spec.photos.map((photo, index) => (
                  <div
                    key={`photo-${index}`}
                    className="pointer-events-none absolute border-2 border-dashed border-primary/70"
                    style={{
                      left: `${photo.x * 100}%`,
                      top: `${photo.y * 100}%`,
                      width: `${photo.w * 100}%`,
                      height: `${photo.h * 100}%`,
                    }}
                  >
                    <span className="absolute left-0 top-0 bg-primary px-1 text-[10px] font-medium text-primary-foreground">
                      photo {index + 1}
                    </span>
                  </div>
                ))}

                {spec.text.map((region, index) => (
                  <div
                    key={`${region.slot}-${index}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`${SLOT_LABELS[region.slot]} region`}
                    onPointerDown={(event) => startDrag(event, index, 'move')}
                    onFocus={() => setSelected(index)}
                    onKeyDown={(event) => {
                      if (showJson) return;
                      // Arrow keys nudge. A box a hair out of line is the common
                      // final correction, and a mouse cannot reliably move one
                      // half a percent.
                      const step = event.shiftKey ? 0.01 : 0.002;
                      const moves: Record<string, [number, number]> = {
                        ArrowLeft: [-step, 0],
                        ArrowRight: [step, 0],
                        ArrowUp: [0, -step],
                        ArrowDown: [0, step],
                      };
                      const move = moves[event.key];
                      if (!move) return;
                      event.preventDefault();
                      updateRegion(index, {
                        x: round3(clamp(region.x + move[0], -OUT_OF_BOUNDS, 1)),
                        y: round3(clamp(region.y + move[1], -OUT_OF_BOUNDS, 1)),
                      });
                    }}
                    className={`absolute border-2 ${showJson ? 'cursor-default' : 'cursor-move'} ${
                      selected === index
                        ? 'border-brand-to bg-brand-to/20'
                        : 'border-foreground/50 bg-foreground/5 hover:border-foreground'
                    }`}
                    style={{
                      left: `${region.x * 100}%`,
                      top: `${region.y * 100}%`,
                      width: `${region.w * 100}%`,
                      height: `${region.h * 100}%`,
                    }}
                  >
                    <span
                      className={`absolute left-0 top-0 whitespace-nowrap px-1 text-[10px] font-medium ${
                        selected === index
                          ? 'bg-brand-to text-background'
                          : 'bg-foreground/70 text-background'
                      }`}
                    >
                      {SLOT_LABELS[region.slot]}
                    </span>
                    <span
                      role="presentation"
                      onPointerDown={(event) => startDrag(event, index, 'resize')}
                      className="absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-se-resize rounded-sm border border-background bg-brand-to"
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* ---- Inspector ---- */}
            <div className="space-y-3 text-xs">
              <div className="space-y-1.5">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Add a region
                </p>
                <div className="flex flex-wrap gap-1">
                  {SLOT_ORDER.filter((slot) => !present.has(slot)).map((slot) => (
                    <Button
                      key={slot}
                      size="sm"
                      variant="outline"
                      className="h-6 px-1.5 text-[10px]"
                      disabled={busy}
                      onClick={() => addRegion(slot)}
                    >
                      <Plus className="mr-0.5 h-2.5 w-2.5" />
                      {SLOT_LABELS[slot]}
                    </Button>
                  ))}
                  {present.size === SLOT_ORDER.length && (
                    <span className="text-[10px] text-muted-foreground">
                      Every slot is placed.
                    </span>
                  )}
                </div>
              </div>

              {selectedRegion && selected !== null ? (
                <div className="space-y-2 rounded border border-border p-2">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{SLOT_LABELS[selectedRegion.slot]}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-1.5"
                      disabled={busy}
                      onClick={() => removeRegion(selected)}
                      aria-label={`Remove the ${SLOT_LABELS[selectedRegion.slot]} region`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>

                  <AlignRow
                    title="Text"
                    labels={ALIGN_LABELS}
                    value={selectedRegion.align}
                    onChange={(align) => updateRegion(selected, { align })}
                  />
                  <AlignRow
                    title="Sits"
                    labels={VALIGN_LABELS}
                    value={selectedRegion.valign}
                    onChange={(valign) => updateRegion(selected, { valign })}
                  />

                  <div className="grid grid-cols-4 gap-1">
                    {(['x', 'y', 'w', 'h'] as const).map((axis) => (
                      <label key={axis} className="space-y-0.5">
                        <span className="block text-[10px] uppercase text-muted-foreground">
                          {axis}
                        </span>
                        <input
                          type="number"
                          step={0.1}
                          value={Math.round(selectedRegion[axis] * 1000) / 10}
                          onChange={(event) => {
                            const percent = Number.parseFloat(event.target.value);
                            if (!Number.isFinite(percent)) return;
                            updateRegion(selected, { [axis]: round3(percent / 100) });
                          }}
                          className="w-full rounded border border-border bg-background px-1 py-0.5 text-[10px]"
                        />
                      </label>
                    ))}
                  </div>

                  {/* The sampled ink colour. Only read when the template is set
                      to keep its own palette, which is what a plate normally
                      wants — see `paletteSource`.

                      Re-samplable because the colour was measured where the
                      proposal put the box, and the box has since been dragged:
                      a headline nudged up off a photograph keeps the
                      photograph's grey until this is pressed. */}
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={resample.pending}
                      onClick={async () => {
                        const result = await resample.run(templateId, {
                          x: selectedRegion.x,
                          y: selectedRegion.y,
                          w: selectedRegion.w,
                          h: selectedRegion.h,
                        });
                        if (result.ok) updateRegion(selected, { color: result.data.color });
                      }}
                      className="text-[10px] text-muted-foreground underline-offset-2 hover:underline"
                      title="Read the colour out of the original, under this box"
                    >
                      {resample.pending ? 'Ink…' : 'Ink ⟳'}
                    </button>
                    <input
                      type="color"
                      value={selectedRegion.color ?? '#000000'}
                      onChange={(event) =>
                        updateRegion(selected, { color: event.target.value })
                      }
                      aria-label="Ink colour for this region"
                      className="h-6 w-8 rounded border border-border bg-background"
                    />
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {selectedRegion.color ?? "client's brand"}
                    </span>
                    {selectedRegion.color && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-5 px-1 text-[10px]"
                        onClick={() => updateRegion(selected, { color: null })}
                      >
                        <X className="h-2.5 w-2.5" />
                      </Button>
                    )}
                  </div>
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  Select a box to set its alignment and colour.
                </p>
              )}

              <TypeSettings spec={spec} onChange={update} disabled={busy} />
            </div>
          </div>
        )}

        {reading && (
          <details className="rounded border border-border p-2 text-[11px]">
            <summary className="cursor-pointer text-muted-foreground">
              What the model saw
            </summary>
            <p className="pt-1 leading-snug text-muted-foreground">{reading}</p>
          </details>
        )}

        {problems.length > 0 && (
          <ul className="space-y-0.5 text-[11px] text-warning-ink">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}

        {(save.error || propose.error || resample.error) && (
          <p role="alert" className="text-[11px] text-danger-ink">
            {save.error ?? propose.error ?? resample.error}
          </p>
        )}

        {showJson && (
          <p className="text-[11px] text-muted-foreground">
            The boxes are frozen while this is open — edit here, or close it and drag.
          </p>
        )}

        {showJson && (
          <textarea
            value={json}
            onChange={(event) => {
              setJson(event.target.value);
              setDirty(true);
              // Adopted only when it parses, so a half-typed edit does not blank
              // the boxes the operator is looking at.
              const next = readSpec(event.target.value);
              if (next) setSpec(next);
            }}
            spellCheck={false}
            rows={12}
            aria-label={`Plate spec for ${label}`}
            className="w-full rounded border border-border bg-muted/40 p-2 font-mono text-[10px] leading-tight"
          />
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={busy || !hasPlate || !spec} onClick={() => void commit()}>
            {save.pending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
            Save regions
          </Button>

          <Button
            variant="outline"
            disabled={busy || !hasPlate}
            onClick={() => void runProposal()}
          >
            {propose.pending ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <Sparkles className="mr-1 h-3 w-3" />
            )}
            {spec?.text.length ? 'Re-read from original' : 'Read regions from original'}
          </Button>

          {/* The preview falls back to the grid for a spec that does not parse,
              silently — `loadTemplatePlate` returns null and the poster still
              renders, just not from the plate. Offering the link in that state
              would send an operator to look at the wrong render and conclude the
              plate is broken. The missing headline is the state every new plate
              is in and the one worth naming. */}
          {composable ? (
            <a
              href={`/api/poster/preview?templateId=${templateId}`}
              target="_blank"
              rel="noreferrer noopener"
              className="text-[11px] text-primary hover:underline"
            >
              See it composited
            </a>
          ) : (
            <span className="text-[11px] text-muted-foreground">
              Place a headline region to composite.
            </span>
          )}

          <Button
            variant="ghost"
            className="ml-auto"
            onClick={() => {
              // Seeded from the boxes on the way in, so the panel always opens on
              // what is actually on screen rather than on a stale buffer.
              if (!showJson && spec) setJson(JSON.stringify(spec, null, 2));
              setShowJson((value) => !value);
            }}
          >
            {showJson ? 'Hide JSON' : 'JSON'}
          </Button>
        </div>

        <p className="text-[11px] text-muted-foreground">
          {dirty
            ? 'Unsaved changes.'
            : 'Saved. Saving clears the approval — composite it once more before approving.'}
        </p>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function AlignRow({
  title,
  labels,
  value,
  onChange,
}: {
  title: string;
  labels: Record<Align, string>;
  value: Align;
  onChange: (value: Align) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="w-8 text-[10px] text-muted-foreground">{title}</span>
      {ALIGNS.map((align) => (
        <Button
          key={align}
          size="sm"
          variant={value === align ? 'default' : 'outline'}
          className="h-6 flex-1 px-1 text-[10px]"
          onClick={() => onChange(align)}
        >
          {labels[align]}
        </Button>
      ))}
    </div>
  );
}

/**
 * The handful of settings that shape the copy rather than place it.
 *
 * Here rather than on the card because they are read against the artwork — how
 * many feature items the plate has room for is a question you answer by looking
 * at the plate, and the answer is what stops four label-only cards being drawn
 * as three labelled paragraphs.
 */
function TypeSettings({
  spec,
  onChange,
  disabled,
}: {
  spec: PlateSpec;
  onChange: (next: PlateSpec) => void;
  disabled: boolean;
}) {
  const selectClass =
    'w-full rounded border border-border bg-background px-1 py-0.5 text-[10px] text-foreground';

  return (
    <div className="space-y-1.5 rounded border border-border p-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        How the copy is set
      </p>

      <label className="block space-y-0.5">
        <span className="text-[10px] text-muted-foreground">Feature items</span>
        <select
          value={spec.featureCount}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...spec, featureCount: Number.parseInt(event.target.value, 10) })
          }
          className={selectClass}
        >
          {[2, 3, 4].map((count) => (
            <option key={count} value={count}>
              {count}
            </option>
          ))}
        </select>
      </label>

      <label className="block space-y-0.5">
        <span className="text-[10px] text-muted-foreground">Feature style</span>
        <select
          value={spec.featureStyle}
          disabled={disabled}
          onChange={(event) =>
            onChange({
              ...spec,
              featureStyle: event.target.value as PlateSpec['featureStyle'],
            })
          }
          className={selectClass}
        >
          <option value="labelAndBody">Label and sentence</option>
          <option value="labelOnly">Label only</option>
        </select>
      </label>

      <label className="block space-y-0.5">
        <span className="text-[10px] text-muted-foreground">Button shape</span>
        <select
          value={spec.ctaShape}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...spec, ctaShape: event.target.value as PlateSpec['ctaShape'] })
          }
          className={selectClass}
        >
          <option value="pill">Pill</option>
          <option value="rounded">Rounded</option>
          <option value="square">Square</option>
        </select>
      </label>

      <label className="block space-y-0.5">
        <span className="text-[10px] text-muted-foreground">Headline case</span>
        <select
          value={spec.headlineCase}
          disabled={disabled}
          onChange={(event) =>
            onChange({
              ...spec,
              headlineCase: event.target.value as PlateSpec['headlineCase'],
            })
          }
          className={selectClass}
        >
          <option value="upper">CAPITALS</option>
          <option value="sentence">Sentence case</option>
        </select>
      </label>

      <p className="text-[10px] text-muted-foreground/70">
        Headline lines:{' '}
        {spec.headlineEmphasis.length > 0
          ? spec.headlineEmphasis.join(', ')
          : 'not measured — the copy decides'}
        . Edit in JSON.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Reads the stored JSON into the editor's own shape.
 *
 * Lenient on purpose — the server is the validator, and this only has to know
 * enough to draw boxes. Null for anything it cannot draw, which the panel
 * reports as "no region map yet" rather than rendering an empty editor over a
 * spec that is actually there.
 */
function readSpec(json: string | null): PlateSpec | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Partial<PlateSpec>;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.text)) return null;
    return {
      version: 1,
      name: typeof parsed.name === 'string' ? parsed.name : 'plate',
      aspect: typeof parsed.aspect === 'number' ? parsed.aspect : 0,
      photos: Array.isArray(parsed.photos) ? parsed.photos : [],
      text: parsed.text,
      featureCount: typeof parsed.featureCount === 'number' ? parsed.featureCount : 3,
      featureStyle: parsed.featureStyle === 'labelOnly' ? 'labelOnly' : 'labelAndBody',
      ctaShape:
        parsed.ctaShape === 'rounded' || parsed.ctaShape === 'square'
          ? parsed.ctaShape
          : 'pill',
      headlineEmphasis: Array.isArray(parsed.headlineEmphasis) ? parsed.headlineEmphasis : [],
      headlineCase: parsed.headlineCase === 'sentence' ? 'sentence' : 'upper',
    };
  } catch {
    return null;
  }
}
