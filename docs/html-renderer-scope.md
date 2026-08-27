# HTML renderer — scope, with one template authored

*Written 2026-08-27, against HEAD `28444dd`. The decision this exists for: whether
to migrate all 24 templates. Nothing here routes a live poster — the HTML path is
reachable only from the preview route and `check:templates` until a template file
is added.*

---

## What was built

| | |
|---|---|
| Render seam | `renderPoster` keeps its signature; one new optional field selects the path |
| Template format | one self-contained `.html` file, four data attributes, a JSON manifest |
| Chromium | Playwright pinned to `1.62.1` → Chromium `151.0.7922.34` |
| Fonts | two variable faces bundled as base64, no network at render |
| Verification | `npm run check:templates` — lint, render, byte-identity, hostile copy |
| Example | **Med-SM-15**, the heart mask |

`npx tsc --noEmit` is clean. Every existing check still passes — `check:layouts`,
`check:risk`, `check:fleet`, `check:plate`, `check:import` — plus the new
`check:templates`. The production image builds, and Chromium launches and renders
inside it.

---

## 1. The seam

`RenderPosterInput` gains one optional field:

```ts
templateLabel?: string;
```

and `renderPoster` opens with:

```ts
const template = await findHtmlTemplateFor(input.templateLabel);
if (template) return renderViaTemplate(input, template);
```

That is the whole switch. `findHtmlTemplateFor` matches a `CategoryTemplate.label`
against the manifests of the registered template files, so **a template migrates
by adding a file** — no migration, no column, no flag, and no effect on the other
twenty-three. It also means the path is dormant on merge: no current caller passes
`templateLabel` except the preview route, which passes it only when a file claims
that label.

What `renderViaTemplate` does *not* do is most of what the spec path does:

- **No theme.** Colours are hardcoded in the template's CSS, so
  `resolvePosterTheme` and its contrast correction have nothing to decide.
- **No metrics.** No 940×1568 reference grid; the stylesheet is the geometry.
- **No `assertRenderableCanvas`.** That guard exists because `@resvg/resvg-js`
  panics in Rust and kills the Node process. Chromium is a child process — a page
  that cannot lay out gives a bad poster or a timeout, both ordinary errors on one
  row.
- **No `tintLogoInk`.** A template knows its own ground at authoring time, so the
  light/dark swap is one CSS line and the sharp round-trip goes away.

`resolvePosterCanvas` is reused unchanged; the manifest supplies the aspect.

**Files:** `src/lib/poster/html/{template,fill,render,typefaces,browser}.ts`,
`src/lib/poster/templates/med-sm-15.html`, `scripts/check-templates.ts`,
`scripts/refresh-poster-fonts.mjs`, `scripts/assert-renderer-assets.mjs`.

---

## 2. Template format

One `.html` file. Markup and all of its CSS, colours inline. No `<html>`, `<head>`
or reset — the renderer wraps it, so a fix to the reset reaches all 24 rather than
24 copies drifting apart.

The entire substitution vocabulary is four attributes:

| | |
|---|---|
| `data-slot="name"` | this element's `textContent` becomes the named string |
| `data-image="name"` | an `<img>`/SVG `<image>` gets its source; anything else a `background-image` |
| `data-repeat="name"` | a `<template>` cloned once per item in the named array |
| `data-when="name"` | the element is dropped unless the condition holds |

Plus one layout attribute, `data-fit`, covered in §7.

Two rules make the whole thing work:

- **A slot element is empty in the file.** Enforced by the lint (§6). This is what
  makes "does this template hardcode any words?" a one-line check.
- **Absent or empty removes the element** rather than leaving it blank. An unset
  eyebrow and a client with no website both collapse their own row.

Per-item styling without giving templates any logic: a repeat item carries a
`mark`, which lands as a `data-*` attribute on the clone root. The accented
headline line is `{ accent: 'true' }` in TypeScript and `[data-accent]` in CSS.
*Which* line is accented stays a code decision; *what accented looks like* stays a
design decision.

The manifest is a `<script type="application/json" id="poster-manifest">` block
inside the file, so the template is one artefact. It carries what the pipeline
needs before a browser exists: the label it draws, its aspect, its reference
width, its feature-card count, and one entry per photo frame — kind, role, and the
pixel box measured off the reference. `resolveTemplatePhotoRequests` scales those
to the real canvas. Unlike `resolveSpecPhotoRequests`, nothing is estimated: a
spec's photo cell has no height until the copy above it is laid out, whereas a
template's frame is a number its author measured.

### The shared mark kit

`src/lib/poster/templates/_kit.svg` holds the marks that repeat across a
vertical — four service pictograms, the heartbeat rule, the handset — as SVG
`<symbol>`s. The renderer injects it into every document, so a template uses one
with `<svg class="..."><use href="#ic-scanner"/></svg>` and nothing else.

**This exists because the references are not a designer's kit.** They come out of
an image model, so Med-SM-14, Med-SM-15 and Med-SM-16 carry the same four
pictograms in the same order for the same reason they share a palette: one
generator, one style. Tracing them per template would be twenty-three copies of
one drawing, each wrong in its own way, and each costing an hour.

Two rules keep it usable:

- **Every mark draws in `currentColor`.** A template sets `color:` on the
  container and the mark follows, which is what lets one sprite serve a
  teal-on-white template and a white-on-navy one. `check:templates` fails a kit
  that hardcodes an ink.
- **The four service marks share a 72x90 box**, so they share an apparent
  weight. A mark drawn in a different box has to have its stroke matched by eye,
  which is a good reason to keep them together.

The marks are deliberately *better* than the references rather than faithful to
them. An image model's idea of a CT scanner is decorative; this one has a gantry,
a bore and a bed. The scanner took three attempts and the failures are worth
recording: an outlined arch read as a doorway, because an arch is the one shape a
scanner shares with a door; a fully filled body read correctly but sat far
heavier than the other three and broke the set.

The kit is not in `HTML_TEMPLATE_SLUGS` and nothing renders it alone, so it gets
its own lint pass — no literal text, no network references, a viewBox on every
symbol, and no hardcoded inks.

---

## 3. Docker

Four changes, all in the runner stage:

1. `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` in `deps`, so the browser is not pulled
   into two layers that never run it.
2. `COPY src/lib/poster/templates` and `COPY src/lib/poster/fonts`.
3. `RUN node_modules/.bin/playwright install --with-deps chromium-headless-shell`,
   with `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` so the unprivileged `node` user
   finds it.
4. `RUN node scripts/assert-renderer-assets.mjs`.

**Item 2 is the trap and item 4 is why it is survivable.** This image carries no
`src` — the app is served from compiled `.next` — but the renderer reads templates
and typefaces off disk, because a template is meant to be a real file somebody can
open. Without those COPY lines everything builds, deploys and passes its health
check, and then the first poster on a migrated template fails at compose days
later on one client's row. The assertion turns that into a build failure that
names the missing directory.

**Pinning.** `playwright` is `1.62.1` exactly, not `^1.62.1`. The Chromium build
is a property of the library release, so a caret range would let a rebuild months
from now install a different Chromium and change every poster's pixels — which
matters because a retry after a WhatsApp failure is compared against the original.

`playwright` is also added to `serverComponentsExternalPackages`. It is pure JS,
but it resolves its driver and injected page scripts from paths relative to its
own files; bundled, those point inside the webpack output and the launch fails
naming a directory nobody wrote.

**Image size: 1.58 GB → 2.44 GB.** Above the ~2 GB the handoff estimated. The
first build came out at 3.03 GB because `playwright install chromium` lays down
*two* browsers — 389 MB of full Chromium and 262 MB of headless shell — and
`chromium.launch()` with the default `headless: true` runs the shell. Installing
only `chromium-headless-shell` takes 389 MB back. The remainder is `--with-deps`
(the X/GTK/NSS libraries and ~63 MB of fallback fonts) and is not obviously
reducible without hand-maintaining an apt list. For reference, `node_modules` is
881 MB of the total and `.next` is 167 MB, both unchanged by this work.

**Determinism flags** (in `browser.ts`, each with its reason in a comment):
`--disable-lcd-text`, `--font-render-hinting=none`, `--force-color-profile=srgb`,
`--disable-gpu`, `--disable-dev-shm-usage`, `--no-sandbox`. The context also pins
locale, timezone and colour scheme.

### Determinism: what was actually measured

I rendered the template inside the built image and compared it against the Windows
render, rather than assuming.

- **Within a platform: byte-identical.** Two consecutive renders match on SHA-256,
  on Windows and inside the container. This is the property the system relies on —
  production is always the same Linux image, so a retry after a WhatsApp failure
  is comparable to the original.
- **Across platforms: not identical.** 1.14% of pixels differ, and the diff is
  confined *entirely to glyph edges* — every pixel of the heart, its gradient, the
  wave, the cards, the icons and the photograph matches exactly. Chromium
  rasterises text through FreeType on Linux and DirectWrite on Windows; the flags
  above remove hinting and subpixel AA, but not sub-pixel advance rounding, and
  there is no flag that makes Windows use FreeType.

**This is a narrow regression.** satori + resvg rasterise in pure Rust and *were*
byte-identical across platforms. Nothing depends on that today, but it means a
local preview is visually identical to production rather than bit-identical.

The consequence for §5: **if golden-image baselines are added, they must be
generated in the container**, not on the dev machine. That works today —
`check:templates` runs inside the image with `scripts/`, `src/` and `tsconfig.json`
bind-mounted.

`--no-sandbox` is safe *here specifically*: the page is markup this repository
wrote, with every non-`data:` request aborted, and client copy that reaches the
DOM through `textContent` rather than a parser. If a template ever needs a remote
asset, that decision has to be revisited.

---

## 4. Fonts

`src/lib/poster/fonts/{Archivo,Inter}-var.woff2` — latin subset, variable, ~138 KB
total — embedded by the renderer as `@font-face { src: url(data:…) }`.

Bundled rather than fetched because production has already hit a blocked
`fonts.googleapis.com`, and a poster that silently falls back to a system face is
worse than one that fails: it still looks like a poster. Embedded rather than
installed with `fc-cache` for the same reason satori was handed buffers — the page
then depends on nothing outside the string it was given, which also removes the
platform drift between the two machines' system font sets.

Refreshed by hand with `npm run fonts:refresh`. Two things there are the *opposite*
of `src/lib/poster/fonts.ts`: a modern User-Agent (satori cannot parse WOFF2 and
needs Google to downgrade; Chromium wants WOFF2), and only the latin block kept.

**Archivo's width axis is loaded and is load-bearing.** The reference headlines are
condensed grotesques. Matching Med-SM-15's measured 70px cap height at the
reference's measured line width needs `font-size: 96px; font-stretch: 88%` — at
the default width that type is 70px too wide for the column. Without a
`font-stretch` descriptor naming the range, Chromium silently clamps the axis to
100%.

`check:templates` fails any template naming a family that is not bundled.

---

## 5. Verification

`npm run check:templates` — no network, no database, no fal.ai spend; photography
is procedural, same bargain `check:layouts` strikes.

1. **Content lint** (§6).
2. **Render** every registered template → `snapshots/templates/<slug>.png`.
3. **Byte-identity** — render twice, compare SHA-256. This is the `check:layouts`
   replacement the handoff asked about, and it is stronger than a perceptual diff
   for what the system actually relies on: the things that break re-render
   equality (a Chromium bump, an unpinned font, a date or a random in a template)
   break it completely rather than subtly. Same-platform only — see §3.
4. **Hostile copy** — rendered, with an assertion *inside the live page* that it
   became text and not markup.

**On screenshot diffing against a golden baseline:** deliberately not added yet.
Committing baseline PNGs makes every intentional design edit a binary churn in the
diff, and with one template the churn outweighs the signal. The moment there are
several templates it earns its place — the shape I would build is
`check:templates --update` writing baselines, and the default run comparing
against them with a small per-pixel tolerance and writing a diff image on failure.
Worth deciding at about template five, not now.

---

## 6. Sub-problem B — catching hardcoded content

`lintTemplate()` in `scripts/check-templates.ts`, wired into the `check:*` family.

The central rule does most of the work: **strip comments, `<script>`, `<style>`
and all tags, and what remains must be whitespace.** Because every slot element is
empty in the file, a template's entire literal text content is nothing. One check
therefore catches a baked-in company name, service label, strapline, phone number
or address without needing a pattern for each — and it fails with the offending
string quoted.

Around it:

- Every `data-slot` element is empty (a better message for the commonest way the
  rule above is broken: authoring against the reference with its own words left in
  as placeholder text).
- Four phone-number shapes: international `+NN …`, Indian `NNNNN NNNNN`, bare
  10-digit, US `NNN NNN NNNN`.
- Hardcoded domains and email addresses.
- No `http(s)://` anywhere — nothing loads over the network.
- No `<script>` but the manifest.
- Only bundled typeface families are named.
- Every manifest photo has a matching `data-image`.

**SVG path data is stripped before the number scan.** `d="M362.5 480C300 442 0 302…"`
is a long run of digits and separators, and every phone pattern worth writing
matches something in it eventually. Weakening the patterns to tolerate paths would
have defeated the check; removing geometry attributes first keeps both strict.

A slot the model has no value for is a *render-time* error, not a lint one — the
renderer throws naming the slot, because a renamed `data-slot` would otherwise
ship a poster with a hole in it.

---

## 7. Sub-problem A — escaping client copy

**Nothing is escaped, because no client string is ever concatenated into markup.**

`renderHtmlPoster` calls `page.evaluate(fillPoster, model)`. Playwright serialises
the model over CDP as a structured clone; `fillPoster` runs inside the page and
assigns each string with `textContent`, which stores characters rather than
parsing them. There is no HTML parser anywhere on the path from the spreadsheet to
the pixels, so there is nothing to escape and nothing to get wrong. This restores
by construction exactly the guarantee satori gave by taking React nodes.

The only non-text values are images, and both are data URIs this process built out
of Buffers it already held.

Tested by `HOSTILE_COPY` in `check:templates`, which renders
`CARE & <SCRIPT>ALERT(1)</SCRIPT>`, `O'BRIEN </STYLE> "QUOTED"` and an
over-long line, then asserts inside the page that `document.querySelectorAll('script')`
is empty and that the headline's `textContent` still contains the literal
`<SCRIPT>ALERT(1)</SCRIPT>`. `</style>` is the quieter one and matters more than
the obvious `<script>`: concatenated into markup it would close the template's own
stylesheet and unstyle the whole poster.

### The reflow half

`data-fit` shrinks a block until it stops overflowing, measured with `scrollWidth`
against the real face at the real size — after `document.fonts.ready`, or every
answer is wrong in the silent direction. This is what replaces `headlineSize`,
which took a *line count* and looked up a size, so three short words and three long
ones got the same type and one of them ran off the canvas.

Shrinking alone is not enough, and the first version of this shipped a clipped
headline: a 38-character line needs to be less than half size before it fits, and
type that small stops being a headline. So at the floor (62%) the block is allowed
to wrap, with `overflow-wrap: anywhere` for a single unbreakable word. The
copywriter's chosen line breaks are preferred, not sacred. Anything that shrank or
wrapped is logged, because the honest fix is usually shorter copy and nobody
writes shorter copy they were not told about.

---

## 8. The example — Med-SM-15

Chosen over the better-documented SM-16 because it is the one the current renderer
**provably cannot draw**. Four of its marks have no word in the layout-spec
vocabulary: an arbitrary path clipping a photograph, a gradient, per-line headline
colour, and a wave (the vocabulary offers a dome). If HTML does SM-15, the
capability question is closed rather than argued. It is also close to the
worst-case authoring job in the library, so its cost is a fair upper bound.

**Method.** The reference JPEG is the source of truth, so it was measured rather
than eyeballed: pixel scans for every block's bounds and colour histograms for
every ink. Ground `#f6f6f6`, headline `#02828c` / `#03396b`, ring gradient
`#0f979b → #025e73`, footer `#017b84`. Estimating geometry off a reference is
precisely the failure that killed the vision-extraction path, and it was not going
to be repeated by hand.

**Result after a second pass** (`snapshots/templates/med-sm-15.png`, drawn at
1080×1920, measured back in the reference's 900×1600 coordinates):

| Block | Reference | Render |
|---|---|---|
| Headline line 1 | rows 314–384, 70px caps, 619 wide | rows 313–383, 70, 616 |
| Headline line 2 | rows 414–480, 66px caps, 575 wide | rows 415–481, 66, 580 |
| Heart silhouette | rows 560–1061, 734 wide | rows 560–1061, 733 |
| Card label caps | rows 1218–1237, 19px | rows 1214–1233, 19 |
| Phone digits | rows 1411–1472, 61px | rows 1412–1473, 61 |

The first pass was much looser, and four of its faults are ones any template will
repeat:

1. **The heart was concentric.** The reference is layered artwork — a dark navy
   heart at the full silhouette, with the gradient one very slightly smaller and
   pushed up and left inside it, so the navy reads as a crescent along the right
   and under the point. A single path with an inset reads as a border instead. The
   first correction drew the dark layer as an *offset duplicate*, which widened
   the whole shape by its own offset and pushed it 16px off centre; the layering
   has to happen inside the silhouette.
2. **The icons were too light and too small** — a 68px square against the
   reference's 72×90, drawn as thin monolines where the reference uses 5px strokes
   with filled passages.
3. **The card labels were 21px** against a measured 19px cap height, which is
   26–29px of type. They also sit on the card's floor and very nearly fill its
   width, rather than floating in the middle of it.
4. **The wave had no right shoulder.** The measured edge climbs from 1359 at
   x=600 to 1277 at the right margin; the first path stopped at 1330 and read as a
   gentle curve.

**Two bugs found while authoring, both of which any template would have hit.**

*An SVG logo lays out at 0×0.* An uploaded logo usually carries a `viewBox` and no
width or height, so it has an intrinsic *ratio* and no intrinsic size. As a flex
item that resolves to a used size of 0×0 — the mark loads, reports a sensible
`naturalWidth`, and draws nothing, leaving the top fifth of the poster empty with
no error anywhere. Every template must give its logo a fixed box and
`object-fit: contain`.

*`data-fit` shrank text that fitted perfectly.* Its first version tested vertical
overflow as well as horizontal. A block set with `line-height: 1` has a content
box of exactly 1em while the face's own line box is nearer 1.19em, so
`scrollHeight` exceeds `clientHeight` on a well-fitting single line — and because
both scale with the font size, shrinking never resolves it. The phone number was
driven from 88px down to 57px to satisfy a constraint that did not exist, and the
only trace was a log line that looked like the feature working correctly. The fit
is now width-only; a height-constrained variant should arrive as an explicit
opt-in when a template actually has a definite height.

**A claim I made and withdrew:** I reported the reference's headline as
gradient-filled. Sampled down the stem of the H in HAPPIER it holds `#023468` from
cap to baseline — the apparent falloff is JPEG ringing on the counters. That is
the same class of mistake as reading geometry off a reference by eye, and the
reason every number in this template came from a pixel scan instead.

---

## 9. What I would want decided

1. **Icons belong to the template, so the service labels effectively do too.**
   SM-15's four cards carry a stethoscope, a microscope, a therapist and a scanner
   — the designer's drawings, in the reference's order. A day whose copy says
   "Pharmacy" gets the stethoscope. This follows from decision 3 (substitution is
   words, photo, logo, phone/website), and it is the one place that decision has a
   visible cost. Options: constrain the sheet's feature labels per template, or
   reopen the icon as a slot. **My recommendation: constrain the copy.** These are
   service menus, not prose, and they change about never.

2. **The logo swap loses colour.** `filter: brightness(0)` on a light ground is
   the agreed behaviour, and the reference's own lockup is navy and teal. Worth
   confirming you are happy with flat black/white before 24 templates bake it in.

3. **The typefaces and the icons are my guess.** Archivo and Inter are close
   matches, not the originals, and the four service pictograms are my drawings of
   the designer's. If the source design files exist anywhere, naming the real
   faces and lifting the icon set would buy more fidelity than any other single
   change — and would take the largest unknown out of the per-template estimate.
   The font half is one line per family in `refresh-poster-fonts.mjs`.

4. **Headline line count.** SM-15's design is two lines; `PosterCopy` allows two
   to four. Three fits and reflows correctly, but it is a different composition
   from the one that was approved. Should the manifest declare a preferred count
   and the copy prompt honour it?

---

## 10. Cost of the remaining 23

Per template, the work is: measure the reference with the scan script, author the
HTML/CSS, then several render-and-compare iterations. SM-15 is among the hardest
in the library and took roughly a day, including its share of building the
infrastructure and a full second pass on the finish.

**Revised up from my first estimate of two to three hours.** Two things came out
of the second pass that were not in that figure:

- **Type has to be solved from a render, not from a table.** Both the headline and
  the phone number were wrong twice before they were right — Archivo's lining
  figures stand at about 0.70em rather than the 0.73em a cap-height table implies,
  and matching a condensed reference means solving the size and the width axis
  together. That is two or three extra render cycles per text block.
- **The icons are per-template artwork.** I had costed them as incidental. Each
  reference carries four of the designer's own pictograms, and mine are still
  hand-drawn approximations — the microscope and the scanner are the weakest
  things in the render.

So: **three to four hours each**, or nearer two if the source icon set can be
obtained, which would remove the largest per-template unknown. Two to three
working weeks for the fleet, still front-loaded — the Medicals references share
idioms (the pulse rule, the card row, the wave, the contact bar) that become
copy-paste after the first three.

The one Restaurants template and the nine Constructions ones have not been looked
at; that estimate assumes they are no worse than the Medicals set.

---

## 11. What this makes dead

If the migration completes, roughly 220 KB of source stops being reachable:

`layout-render.tsx` (37 KB), `slots.tsx` (53 KB), `metrics.ts` (16 KB),
`theme.ts` (17 KB), `logo-key.ts` (22 KB), `text-detect.ts` (19 KB),
`plate-render.tsx` (18 KB), `plate-ink.ts` (11 KB), `plate-regions.ts` (5.6 KB),
`icons.tsx` (7 KB), `layout-risk.ts` (7.5 KB), `color.ts` (7 KB), plus
`PlateRegionEditor.tsx`, the `layoutSpec`/`plateSpec` columns, satori, resvg, and
the `check:layouts` / `check:risk` / `check:fleet` / `check:plate` scripts.

Nothing has been deleted. Both paths still work and `check:layouts` still passes.
Deletion should follow the last template, not lead it.

Also superseded, per the handoff: `docs/layout-backlog.md` and `docs/restating.md`
are history, and the dormant plate path stays dormant — its three unstarted fixes
should not be resumed.
