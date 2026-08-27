# Evokz ACE — poster generation: state, decisions and what remains

**Written 2026-08-26. Live at `e266c62`** on `main` (`github.com/riyazlive04/evokz`),
deployed to https://app.evokz.in.

This document covers the poster *rendering* layer specifically — what it does,
why it is built the way it is, what was tried and rejected, and what still
stands between the output and the reference templates. For the wider system see
[`PROJECT_KNOWLEDGE_BASE.md`](PROJECT_KNOWLEDGE_BASE.md); for deployment see
[`DEPLOY_VPS.md`](DEPLOY_VPS.md); for the design rules the renderer implements see
[`docs/creative-style-spec.md`](docs/creative-style-spec.md).

---

## 1. What Evokz is

A multi-tenant creative engine for a marketing agency. A client is provisioned,
an operator seeds a 365-day content calendar, and from then on — every day,
unattended, at that client's chosen minute — the system renders one finished
branded poster and delivers it to their WhatsApp.

The agency's staff never open a design tool. Clients never log in; they receive
images. There is exactly one human-facing surface, the internal admin console at
`/admin/*`.

---

## 2. The requirement

The bar, in the project's own words, is **"creatives that look designed, not
generated."** Not "an image gets sent" — a thing that could plausibly have come
from a designer.

Five rules follow from that, and every architectural decision below serves one
of them:

1. **The photograph carries no words.** Diffusion models cannot spell. Every
   readable mark — headline, phone number, website, feature labels — is
   composited afterwards as real vector type. A wrong phone number delivered
   daily is a refund.
2. **Every poster is drawn from a reference template** uploaded to that client's
   vertical. There is no built-in composition to fall back on; a vertical with no
   approved template fails the render loudly rather than inventing something.
3. **The output must resemble the template it came from.** This is why a
   template's own aspect ratio overrides the client's output preset.
4. **One template serves every tenant in the vertical**, recoloured to each
   client's brand.
5. **It must never fail silently.** The recurring fear throughout this codebase
   is *a poster that renders, looks deliberate, and is wrong* — a clipped
   headline, a missing contact bar, an empty coloured slab.

---

## 3. Technology stack

| Layer | Choice |
|---|---|
| Framework | Next.js 14.2.35 (App Router), React 18.3.1, TypeScript strict |
| Database | PostgreSQL 16 via Prisma 5.17 |
| Poster rendering | `satori` 0.10 (JSX → SVG) + `@resvg/resvg-js` 2.6 (SVG → PNG) |
| Image analysis | `sharp` 0.35 — pixel measurement, cut-outs, tinting |
| Photography | fal.ai — `fal-ai/flux/schnell` (diffusion), `fal-ai/birefnet/v2` (background removal) |
| Language models | OpenAI — `gpt-4o-mini` for copy, `gpt-4o` for vision |
| Storage | Google Drive (service account), one folder per client |
| Delivery | Evolution API (WhatsApp) |
| Payments | Razorpay webhook → auto-provisioning |
| Hosting | Hostinger VPS, Docker Compose: Caddy (TLS) + Next + Postgres |
| Styling | Tailwind + shadcn/ui |

**Rendering is satori + resvg directly, not `next/og`.** `ImageResponse` wraps
exactly these two libraries but its Node build cannot load on Windows — it
resolves its own wasm assets with `path.join` over a `file://` URL and throws
`TypeError: Invalid URL` at import time. That is local-development-only, which is
worse: the composition could not be previewed on the machine it is authored on.

**Deployment is `git pull` on the box, not push-to-deploy.** See `DEPLOY_VPS.md`
§10. Secrets live only on the VPS in `.env`; the repo is public and has never
contained credentials.

---

## 4. How a poster is made today

`runCreativePipeline` in `src/lib/ai-pipeline.ts` drives one calendar row:

1. **Resolve the layout** — `resolveDayLayout` picks the template the sheet
   pinned for that day, or walks the vertical's approved templates
   deterministically. Resolved *before* anything is bought, so a compose failure
   never bills for frames it throws away.
2. **Resolve the canvas** — the template's aspect wins; the client's preset only
   decides how many pixels.
3. **Size the photo requests** — from the layout's own geometry, so a wide band
   is not fed a portrait frame.
4. **Generate** — flux via fal.ai, sequentially. A `subject` cell is then passed
   through birefnet for background removal.
5. **Compose** — satori lays out the tree, resvg rasterises.
6. **Upload** to Drive, then **broadcast** on WhatsApp, gated on `approvedAt`.

### The two render paths

- **Grid** (`layout-render.tsx`) — rebuilds the poster from a `PosterLayoutSpec`:
  a stack of rows, each split into cells, each holding slots. **This is the path
  in use.**
- **Plate** (`plate-render.tsx`) — composites the template's own artwork with new
  type dropped into it. Built, working, and **stood down** for the reason in §6.

---

## 5. What changed on 2026-08-26

Fourteen commits, `db0004e` → `e266c62`. In the order they were found:

### Type was coloured for surfaces that were never painted

`ContactBar` was asked for `variant="accent"` *and* `transparent` together —
colours derived from a gold field, and that field then not drawn. Near-black type
on navy artwork. Separately, `groundForRegion` returned the theme's *light*
ground unconditionally and the sampled ink only reached `text`, leaving `muted`
— which `BodyCopy` reads — light-ground on every plate.

**Fixed** by measuring: `sampleRegionSurface` reads the plate under each region
and the ground is built from it. A sampled colour is contrast-checked before it
is trusted. Measured per render rather than stored, so it reached the existing
library without regenerating anything.

### The extractor was never measuring

`extractPlateRegions` asked gpt-4o for each block's box to three decimal places.
Across the live library, **59 of 60 stored boxes had every coordinate on a 0.05
grid**, and the 240 numbers took 22 distinct values. Its own stored reading said
*"five horizontal bands… split about 50% each"* — describing a poster, not
measuring one.

Those boxes placed the type **and** built the erase mask, so one bad estimate
both misplaced the words and cleared the wrong artwork.

**Fixed** by splitting the job: `detectTextBlocks` measures blocks from the
pixels, then `labelTextBlocks` shows the model those boxes drawn and numbered on
the reference and asks only what each one holds. It never states a coordinate.

### The rest

| Fix | Commit |
|---|---|
| Keep a slot's lines together; refuse two slots printed over each other | `619bffb` |
| Drop a stray region instead of refusing the whole plate | `bcaf653` |
| Sample a measured region's ink; erase the template's own brand mark | `86d99ad` |
| Author the vertical-card layout rather than recover it | `c5bb829` |
| Apply it to a vertical and stand the plate down | `9026926` |
| Stop "Read layout" silently discarding an authored one | `57eff9f` |
| Warn at import which rows will not draw as written | `6763cb4` |
| Recolour a keyed-out logo instead of putting a square behind it | `19cb7d5` |
| One "Re-read all" button; quieten the template cards | `7c153cf` |
| Give a vertical a standard layout new uploads inherit | `d6a3a96` |

---

## 6. Approaches tried, and why each failed

**Do not re-attempt these without new information.** Each was built, run against
production, and measured.

### A reference template is a photograph of a design

Flattening to a JPEG destroys three things: what sits behind the words, which
pixels are background versus element, and every shape as a shape. Nothing can
recover them, so anything reading a layout back out of the image is *inferring* —
and a wrong inference looks exactly like a right one.

### 1. Clean-plate cloning — failed

Erase the reference's words with `fal-ai/bria/eraser`, composite new type into
the hole.

The eraser is **generative**: it reconstructs what it thinks belongs there rather
than cutting. A mask that covers part of a word leaves the rest as its reference,
so it fills the gap with more letter-shapes. Delivered posters carried `CIDU`
beside a headline, `MEDIVNI` and `OuIsev` where service labels had been, and a
phone number as `nnccapci30`.

This is unfixable in principle — asking a model to imagine missing pixels *is*
the mechanism. Tested repeatedly by the owner and ruled out.

### 2. Structure extraction and repainting — failed

Measure the reference's panels from pixels and repaint them in their own colours.
Deterministic, no generative step.

Two algorithms were written and both failed:

- *Region growing* — flood-fill colour regions, fit a rectangle to each. The fill
  wanders across gradients and soft edges, so regions came back as blobs filling
  a third of their bounding box. Repainted as a column of lozenges.
- *Row-band profiling* — model the poster as a stack of horizontal bands. Nine
  fragmentary panels, twelve regions rejected as too textured, background
  misidentified. Repainted as grey stripes.

These designs are overlapping rounded panels, vertical gradients and soft-edged
photography occupying half the width. They are not decomposable into rectangles.
The code was deleted.

### 3. Asking a vision model for geometry — failed

See §5. It does not measure.

### What works: restating

**Write the design down as data instead of recovering it.** A spec infers
nothing: `heightFraction: 0.09` does not estimate the contact bar, it *is* the
contact bar. Same input, same output, every render, asserted at five presets by
`check:layouts` on every run.

This is only available because **Evokz authors its own templates** — seven
verticals sharing one design, known before any file exists. For genuinely foreign
references the three failures above still apply.

`scripts/fixtures/evokz-vertical-card.json` is that spec: four rows, the second
split 64/36 into a copy column and a figure column. Words come from the sheet,
colours from the client's `brandGuideline`, the photograph from fal per day.

**Restated layouts cannot overlap.** Rows are flex children of a column, so
placement is sequential and there is no coordinate to get wrong. Overflow
compresses the `flex` row — floored at 12% — rather than colliding. The overlap
validator in `validatePlateSpec` exists for the plate path only.

---

## 7. What is lagging — to match the templates exactly

Four gaps, in the order they cost the most.

### 7.1 The sheet does not suit the layout — **content, not code**

`checkRowFit` reports **9 warnings across the 7 live rows**:

- **Five days have two-line headlines** where the layout's emphasis pattern is
  three lines long, so the accent colour the design is built around never
  appears.
- **Four days' image briefs do not describe a standing person.** The layout
  composites a background-removed cut-out, so a brief saying *"no people in
  frame"*, *"hands only"* or *"seated at a desk"* yields an empty or partial
  figure. One day rendered with no photograph at all.

**Fix:** rewrite the sheet. Three-line headlines with the payoff last; briefs
reading *one person, standing, full body, plain background*. The importer now
lists the failing rows before anything is generated.

### 7.2 No background texture

The reference templates carry a darkened workplace photograph behind everything.
The restated spec is flat dark.

A full-bleed photograph behind the *whole* poster is not expressible in the grid
vocabulary — rows stack, they do not layer. It needs a renderer change, and a
second fal render per poster, roughly doubling image spend. **Deliberately not
built; a decision rather than an oversight.**

### 7.3 Artwork the renderer cannot draw

A spec can say rows, columns, fills, gradients, rounded panels and the eight
slots. It cannot say *heart-shaped mask* or *3D shield*.

For templates built around such artwork — the heart template, the shield template
— restating alone is not enough.

**The agreed shape, not yet built:** supply that artwork as a **transparent PNG**
per template and place it in a photo region. Two minutes of a designer's time,
and — crucially — nothing is erased, so nothing can be hallucinated. This is not
a clean plate; it is the artwork the design already owns.

### 7.4 Every poster now draws the same composition

One spec across all 24 templates, so days differ by words and photograph but not
by layout. The original library had a heart template, a doctor template, a
stethoscope template — that variety is gone.

**Fix:** author one spec per distinct design and map templates to it. About an
hour each, most of it rendering and adjusting.

---

## 8. Operational state

All seven verticals carry `Evokz vertical card` as their standard layout, so any
new upload inherits it — no vision call, no estimate, approved by construction.

| Vertical | Templates | Authored | Approved |
|---|---|---|---|
| Medicals | 14 | 14 | 14 |
| Contructions *(sic — the name has a typo)* | 9 | 9 | 9 |
| Restaurants and cafes | 1 | 1 | 1 |
| Interiors, Individuals, Real estate, Automation and Software | 0 | 0 | 0 |

`layoutAuthoredAt` protects an authored layout: the console's "Read layout"
refuses on the first click and confirms on the second, and "Re-read all layouts"
skips authored templates outright. This matters — fourteen templates were
silently re-extracted over an authored layout in five minutes of clicking before
the guard existed.

**Not yet verified end to end:** no poster has been generated since the last
several fixes. One clean run — new client, brand colours, corrected sheet row,
regenerate day 1 — is the outstanding acceptance test.

---

## 9. Commands

```bash
# Give a vertical its standard layout (and make new uploads inherit it)
npm run layout:apply -- <vertical> scripts/fixtures/evokz-vertical-card.json <snapshotDir>

# Regression suites — no network, no spend
npm run check:layouts     # every fixture at every preset, plus the headline fitter
npm run check:plate       # plate compositing, colour grounds, logo treatment
npm run check:import      # sheet parsing and conflict modes

# Against a database
npm run check:fleet       # renders every stored spec in every vertical
npm run plate:measure -- <outDir> --vertical <name>   # what a plate read would store

# Undo
npm run template:snapshot -- restore <snapshotDir>/<label>.json
```

Rendering a template without spending anything:

```
https://app.evokz.in/api/poster/preview?templateId=<id>
  &palette=template|client   # compare the designer's colours against the brand
  &clientId=<id>&day=2       # a real client's copy and logo
```

---

## 10. Reading order for whoever inherits this

1. `docs/creative-style-spec.md` §7 — what a layout spec is and why it is a flex
   tree rather than absolute boxes.
2. `src/lib/poster/render.tsx` — the composition entry point; its header explains
   the satori/resvg choice.
3. `src/lib/types/layout-spec.ts` — the vocabulary, and the invariant that at
   least one row must be `flex`.
4. `scripts/fixtures/evokz-vertical-card.json` — the design, as data.
5. The fourteen commit messages from `db0004e` to `e266c62`. Each carries the
   measurement that justified it; they are the cheapest way to understand why
   the code is shaped as it is.
