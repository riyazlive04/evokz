# Layout vocabulary backlog

*What to build next, and why. Written 2026-08-27, after the first authored spec
(`med-sm-16.json`) was rendered against the template it was written for.*

---

## Where we are

One template of fourteen — **Med-SM-16** — now draws from a spec written for it.
It renders correctly end to end: one logo, the client's own phone number, nothing
clipped, nothing overlapping, headline holding three lines with the accent on the
third.

The other thirteen still share `Evokz vertical card`, so thirteen of fourteen
posters still do not resemble their references. That is the largest open gap and
it is authoring work, not engineering — see §5.

Everything below came out of comparing the rendered Med-SM-16 against its
reference. Each item says what it is, where it goes, and what it costs.

---

## 1. Enable the backdrop that already exists

**Free. No code.**

`SubjectBackdrop` is built, tested and drawing in the right place — the call site
comment reads *"Behind everything, including the photograph it exists to
support."* It paints an ellipse anchored to the column floor, sized off the
column width, exactly for a figure standing in it.

`med-sm-16.json`'s photo cell never set `backdrop`, so it defaulted to `none`.

```json
"photoKind": "subject",
"backdrop": "blob",
```

**Known risk:** it paints in `theme.accent`, which for the test client is red. A
red disc behind a doctor on navy may read as loud rather than as depth. The
reference's glow is a soft *blue* — a tint of the ground, not the accent. If the
blob reads badly, that is the argument for §2 rather than a reason to drop it.

Do this first because it costs one preview to learn from.

---

## 2. Gradient ground — ATTEMPTED, DOES NOT WORK

**satori paints no gradient on this element. Superseded by §3.**

This was scoped as a one-line field on the claim that "satori supports
`linear-gradient` and `radial-gradient` natively — verified in the bundled
`satori@0.10.14`". That was not a verification: the strings are present in the
bundle, and a grep for a string is not a test.

Probed with a magenta tint so any gradient would be unmissable. Four renders,
none produced a pixel:

| Attempt | Result |
|---|---|
| `radial-gradient(circle at 50% 38%, …)` on the canvas root | nothing |
| Bare `radial-gradient(tint, ground)` | nothing |
| Same, with `backgroundColor` removed so it could not win | nothing |
| SVG `<defs><radialGradient>` referenced by `url(#…)` | nothing |

The last is the informative one: inline SVG demonstrably renders here — the curve
cap, the pulse rule and the subject backdrop all draw — so satori follows SVG but
does not resolve gradient definitions.

Everything was reverted; no `groundStyle` field shipped. A glow would need a
different mechanism — stacked translucent ellipses, or a gradient rasterised by
sharp into a data URI — and that is a build, not a field.

**Also: the blob was tried and did not fix the blandness.** A painted shape stops
the figure floating but leaves the poster reading as a figure on a panel. What the
references have behind their subject is a *place*, which is §3.

**Not** the same class as the heart mask or the 3D shield. Those need an arbitrary
vector path clipping a photograph, which no CSS expresses. This does not.

### Shape

Add a spec-level field beside `headlineCase` and `accentRuleStyle`:

```ts
export const LAYOUT_GROUND_STYLES = ['flat', 'glow'] as const;
groundStyle: layoutGroundStyleSchema.default('flat'),
```

`flat` is the default so every stored spec renders byte-identically.

`glow` paints the canvas with a radial gradient — a lightened tint of the ground
colour falling off to the ground colour itself. The tint should derive from
`PosterTheme`, never a literal, for the same reason fills are named and not hex:
one spec has to serve every client's brand.

### Where

- `src/lib/types/layout-spec.ts` — enum, schema field
- `src/lib/poster/layout-render.tsx` — the canvas root's `backgroundImage`
- `src/lib/poster/theme.ts` — derive the tint from the resolved ground

### Open question

Whether the glow should be positionable (behind the figure, as the reference has
it) or always centre-weighted. Start centre-weighted; a `glowAnchor` can follow if
it proves necessary.

---

## 3. Photo backdrop layer

**Medium. Doubles image spend. Build only after §2 is judged.**

A second generated image drawn *behind* the cut-out figure, giving a real
environment instead of a painted one. This is the strongest answer to blandness
and the only one that puts a hospital behind the doctor.

### Why it has to be a `backdrop` variant

`photoKind` is a **cell** property, not per-slot, so one cell cannot hold a scene
and a subject today. That is the actual blocker. Extending `backdrop` sidesteps it
cleanly, and the layer position is already correct.

The two-photo cap in `validateLayoutSpec` already exists — *"two is what the
pipeline can pay for"* — so the budget for this is anticipated.

### Shape

`LAYOUT_BACKDROPS` grows `none | blob` → `none | blob | scene`.

- `src/lib/types/layout-spec.ts` — enum value
- `src/lib/poster/photo-request.ts` — a `backdrop: 'scene'` cell emits a second
  request sized to the cell; `countPhotoSlots` counts it
- `src/lib/poster/layout-render.tsx` — draw it where `SubjectBackdrop` draws,
  `object-fit: cover`
- the photo cursor already assigns top-to-bottom, so ordering falls out

### Where the second prompt lives — decided: the sheet

**Not the spec.** A spec holds no strings by design: no copy, no hex, no URLs.
That invariant is what lets one spec serve every client and every day. A prompt is
content, so it belongs where content lives.

Add an optional sheet column beside `image prompt`:

```
background prompt
```

Absent means no backdrop is generated even if the spec asks for one — degrade to
`blob`, or to nothing. Per-day, authored by whoever writes the brief.

### Cost

Two fal calls per poster instead of one, sequential (rate limits are per key
across a sweep). Across a 30-day campaign per client this is the real price, and
it should be a deliberate choice per vertical rather than a default.

---

## §3 COST — read before enabling on any vertical

**A `scene` backdrop doubles the diffusion spend of every poster that draws it.**

Recorded here rather than in passing, because the decision is per-vertical and
compounds across every client on that vertical for as long as the spec is live.

### The arithmetic

| | Frames per poster | fal calls |
|---|---|---|
| Spec with one `photo` slot | 1 | 1 |
| Same spec, `backdrop: "scene"` | 2 | **2** |

Calls are **sequential, not parallel** — fal rate limits are per key across a
whole sweep, so a backdrop also roughly doubles the wall-clock of the generate
stage. A 30-client sweep that took ten minutes takes twenty.

Per campaign, per client:

- 30-day campaign, one poster a day: **30 → 60** image generations
- Ten clients on that vertical: **300 → 600**
- Subject cells pay `removeBackground` on top, unchanged — the backdrop is a
  `scene` and is never matted

### What is *not* doubled

Poster composition, Drive upload, WhatsApp delivery, and the copy model. Only the
image calls. `recordImageUsage` is called for the backdrop exactly as for the slot
frame, so both appear in `UsageEvent` and the per-client budget already sees them
— no separate ledger is needed to find this in the bill.

### Where the spend stops

- A day whose sheet has **no `backgroundPrompt`** generates nothing extra and
  degrades to the painted `blob`. The column is opt-in per row, so a vertical can
  carry the spec and only spend on the days that want it.
- The two-photo cap still holds: `countPhotoSlots` counts a scene backdrop, so a
  spec cannot ask for two photo slots *and* a backdrop.

### The recommendation

Turn it on per vertical, deliberately, and only where the flat ground is actually
hurting. It is not a default. A vertical whose designs are colour-field posters
gains nothing from it and pays the same doubled bill.


---

## 4. Feature treatment

**Small. Cosmetic. Lowest value on this list — do it last or not at all.**

Two differences from the reference, both hardcoded in `slots.tsx`:

- **Labels are uppercase**; the reference sets them sentence case. `headlineCase`
  exists for exactly this on the headline; features have no equivalent. Would need
  `featureCase: 'upper' | 'sentence'`, defaulting to `upper`.
- **A divider is drawn under each feature**; the reference has none. Would need a
  `featureDivider: boolean` or a style enum.

At full size these read as a deliberate treatment rather than as errors. Recorded
so the decision is explicit, not because it is urgent.

---

## 5. The remaining twelve Medicals specs

**The largest open gap. Authoring, not engineering.**

Thirteen templates still hold `Evokz vertical card`. Grouped by design:

| Templates | Skeleton | `photoKind` |
|---|---|---|
| SM-8, SM-4, SM-3 | headline left · list left · figure right | `subject` |
| SM-1 | same + services panel (5 items) + footer band | `subject` |
| SM-17 | same, feature cards with body + CTA pill | `subject` |
| SM-14 | centred headline · list left · photo right | `scene` |
| SM-5, SM-6, SM-13, SM-11 | centred headline · centred hero · horizontal strip | `scene` |
| SM-7 | dark · headline left · full-bleed scene | `scene` |
| **SM-15, SM-12** | centred, **heart mask / 3D shield** | blocked — see §7 |

One spec file each, applied with `--labels`. Roughly an hour apiece.

**Setting `photoKind` correctly per design is what makes the sheet's briefs valid
again.** `scene` passes the brief through verbatim with no standing-person suffix
and no background removal, so "clinic corridor, no people" and "hands only" become
perfectly good briefs for the ten templates that use scenes.

---

## 6. Overlay spec shape

**Experiment. Informs §5.**

The reference gets a wide figure *and* an unwrapped headline because its cut-out
**overlaps** the text. Cells tile, so a two-cell split cannot reproduce that —
measured: 56/44 and 60/40 both wrap `EXPERT CARE / FOR A / HEALTHIER YOU`, and
only 64/36 fits, at the cost of a narrower figure.

The renderer already has `isOverlay`: a cell holding a `scene` photo plus text
draws the photo as the cell background under a 0.55-alpha scrim. Worth authoring
one spec this way to see whether it reads better than the split, because six
Family B templates are centred-hero designs that need it.

No code expected. If it works, it changes how §5's specs are written.

---

## 7. Blocked on artwork

**SM-15** (heart-shaped image mask) and **SM-12** (3D shield). Both need the
background exported from the source file as a **transparent PNG**; the spec then
positions type over it. Two minutes of a designer's time each, and no
reconstruction step for anything to go wrong in.

Also minor: the decorative rules flanking the reference's strapline.

---

## 8. Not on this list, deliberately

**The plate path.** `renderPlateSpec` and its defects are intact but dormant — no
template holds an approved plate. Repairing it (heights for six slots, the
`ContactBar` double inset, the labeller's self-contradicting prompt, the dead
`headlineLineCount`, writing the missing `findSurvivingText`) is real work sitting
on top of an eraser that reconstructs rather than cuts. Do it only if plates are
going to be used again.

**Four verticals with no templates.** Automation and Software, Individuals,
Interiors and Real estate carry a `defaultLayoutSpec` but have zero templates
uploaded, so generation for a client there fails at compose with
`no-approved-templates`. Two of the three active clients sit in two of them. One
reference upload each is enough — the spec is inherited with no vision call.

---

## Suggested order

1. **§1 blob** — free, one preview, tells you whether depth-behind-figure helps
2. **§2 gradient** — small, matches what the reference actually has
3. **§6 overlay** — one spec, no code, decides how §5 gets written
4. **§5 authoring** — the bulk of the remaining value
5. **§3 photo backdrop** — only if §2 leaves it still flat
6. **§4 feature treatment** — last, if at all

§7 runs in parallel the moment a designer can export two PNGs.
