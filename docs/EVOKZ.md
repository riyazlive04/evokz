# Evokz ACE — end to end

The complete technical picture: what the platform is, what goes in, what comes
out, and how it gets from one to the other.

**Written 2026-08-28.** It describes the code on `main` at that date, and it
supersedes `PROJECT_KNOWLEDGE_BASE.md`, `SYSTEM_FLOW.md`,
`POSTER_GENERATION_STATE.md` and `HANDOVER_TESTING_GUIDE.md`, all of which
describe a poster renderer that no longer runs. Where those four disagree with
this file, this file is right — see §5.1 for what changed and why they are
wrong rather than merely stale.

For the non-technical operator's guide, see `docs/poster-handbook.html`.

---

## Contents

**Part 1 — Orientation**
[1.1 What Evokz is](#11-what-evokz-is) ·
[1.2 The stack](#12-the-stack) ·
[1.3 The flow, end to end](#13-the-flow-end-to-end)

**Part 2 — The data**
[2.1 The seven models](#21-the-seven-models) ·
[2.2 A day's lifecycle](#22-a-days-lifecycle)

**Part 3 — The frontend**
[3.1 Pages](#31-pages) ·
[3.2 Components](#32-components) ·
[3.3 API routes](#33-api-routes) ·
[3.4 Auth](#34-auth)

**Part 4 — Inputs**
[4.1 Onboarding a client](#41-onboarding-a-client) ·
[4.2 Two ways a calendar exists](#42-two-ways-a-calendar-exists) ·
[4.3 The import sheet](#43-the-import-sheet) ·
[4.4 Generated copy](#44-generated-copy)

**Part 5 — Making the poster**
[5.1 Two renderers](#51-two-renderers) ·
[5.2 The template system](#52-the-template-system) ·
[5.3 Changing a template](#53-changing-a-template) ·
[5.4 Photos](#54-photos) ·
[5.5 The logo](#55-the-logo) ·
[5.6 Determinism](#56-determinism)

**Part 6 — Outputs**
[6.1 Google Drive](#61-google-drive) ·
[6.2 Dispatch and WhatsApp](#62-dispatch-and-whatsapp) ·
[6.3 Delivery states](#63-delivery-states)

**Part 7 — Money**
[7.1 Plans and payment](#71-plans-and-payment) ·
[7.2 What a poster costs](#72-what-a-poster-costs)

**Part 8 — Keeping it honest**
[8.1 The check suite](#81-the-check-suite) ·
[8.2 What the checks cannot catch](#82-what-the-checks-cannot-catch)

**Part 9 — Running it**
[9.1 Deployment](#91-deployment) ·
[9.2 Cron, backups, health](#92-cron-backups-health) ·
[9.3 Environment](#93-environment) ·
[9.4 Common failures](#94-common-failures)

**Part 10 — State of play**
[10.1 What changed recently](#101-what-changed-recently) ·
[10.2 Known gaps](#102-known-gaps) ·
[10.3 Traps](#103-traps)

---

# Part 1 — Orientation

## 1.1 What Evokz is

A social-media agency in software. One client, one vertical, one plan; the
platform then produces a branded poster a day and sends it to them on WhatsApp,
every day for the length of their plan, with a human approval in the middle.

Three things make it more than a template filler:

- **The posters are designed, not assembled.** Each vertical has a set of
  reference designs, and every poster is one of those designs with the client's
  words, photograph and logo in it. It is meant to be indistinguishable from
  work a designer did that morning.
- **The words are the client's or the model's, never boilerplate.** A day's copy
  comes from an operator's sheet, or from a copy model briefed on the exact
  layout it has to fit.
- **Nothing sends unapproved.** Every day is generated ahead of time and waits
  for a human.

The operator is an agency admin. The client never touches the platform.

## 1.2 The stack

One Next.js process, one Postgres, one browser. No queue, no worker fleet, no
serverless — a single container with a cron poking it every minute.

| Layer | Choice | Version | Notes |
|---|---|---|---|
| Framework | Next.js (App Router) | `14.2.35` | Server actions do the writes; there is no separate API layer |
| Language | TypeScript | `^5.5.4` | `strict`, and `npm run typecheck` is part of the gate |
| UI | React | `18.3.1` | Server components by default |
| Styling | Tailwind + Radix primitives | `^3.4.6` | `src/components/ui` is a small shadcn-style set |
| Database | PostgreSQL 16 via Prisma | `5.17.0` | 14 migrations, `prisma migrate deploy` on boot |
| Validation | Zod | `^3.25.0` | Every external boundary — sheets, webhooks, model output |
| Poster rendering | Playwright → Chromium | `1.62.1` **exact** | The current renderer. See §5.1 |
| Poster rendering (legacy) | satori + resvg | `^0.10.14` / `^2.6.2` | The fallback for verticals with no authored design |
| Images | sharp | `^0.35.3` | Trimming, compositing, measurement |
| Copy | OpenAI SDK | `^6.49.0` | Captions, poster copy, brand tokenizing |
| Photography | fal.ai (Flux.1) | HTTP | Also background removal |
| Storage | Google Drive | `googleapis ^140` | Service account, per-client folders |
| Delivery | Evolution API | HTTP | WhatsApp |
| Payments | Razorpay | webhook only | Signature-verified, provisions the client |
| Host | Docker Compose on a Hostinger VPS | — | Caddy at the edge. **Not Vercel** |

**The pinned Playwright version is load-bearing**, not tidiness. A minor bump
changes the Chromium build and therefore the pixels, and posters are compared
byte-for-byte on retry. See §5.6.

## 1.3 The flow, end to end

```
                 ┌──────────────────────────────────────────────┐
   Razorpay ────▶│  provisionClient()                           │
   or the admin  │  Drive folder · campaign window · plan        │
   form          └───────────────────┬──────────────────────────┘
                                     │
                     ┌───────────────▼───────────────┐
                     │  A calendar of N days exists   │
                     │  AI-generated, or imported     │
                     │  from a sheet (§4.2)           │
                     └───────────────┬───────────────┘
                                     │  cron, every minute
   ┌─────────────────────────────────▼─────────────────────────────────┐
   │  executeIntervalDispatch()                                        │
   │                                                                   │
   │   resolve   which design, which canvas, which photos it needs     │
   │   generate  buy the photograph(s) from fal.ai        ← costs money│
   │   compose   write the poster copy if the sheet did not            │
   │             draw the poster                          ← §5         │
   │   upload    push the PNG to the client's Drive folder             │
   │   ─── waits here for a human to approve ───                       │
   │   broadcast send on WhatsApp via Evolution API                    │
   │   complete  mark DELIVERED                                        │
   └───────────────────────────────────────────────────────────────────┘
```

The stage names are literal — `ai-pipeline.ts` sets `stage` to each in turn so a
failure records which boundary it died at, and a resumed row starts from there
rather than from the top. That is why a failed upload does not re-buy the
photograph.

**Inputs**, in the order they arrive:

| Input | From | Shape |
|---|---|---|
| Client identity | Razorpay notes, or the admin form | Name, WhatsApp number, delivery days, send time, plan, vertical |
| Brand | The client's website, tokenized | Colours, tagline, logo |
| Logo | Upload | Image file, background-removable |
| The day's words | An operator's sheet, or the copy model | Headline, body, features, calls to action, caption, hashtags |
| The day's photograph | A written brief in the sheet | Text prompt → fal.ai |
| The design | The sheet names it, or the vertical's default | One of 23 authored templates |

**Outputs**:

| Output | Where | Shape |
|---|---|---|
| The poster | Google Drive, per-client folder | PNG, 1080×1920 for WhatsApp status |
| The preview | Admin console | The same PNG, via Drive |
| The message | The client's WhatsApp | Image + caption + hashtags |
| The spend | `UsageEvent` rows, dashboard | USD micros per call, per client, per day |

---

# Part 2 — The data

## 2.1 The seven models

`prisma/schema.prisma`. Seven models and three enums; the whole platform.

**`Plan`** — what a client bought. Duration and price.

**`Category`** — a vertical: Medicals, Constructions, Interiors. Owns the
designs and the default layout.

**`CategoryTemplate`** — one design. Holds the reference image in Drive
(`gDriveFileId`), optionally a clean plate (`plateDriveFileId`), the layout spec
for the legacy renderer, and — critically — the **name** operators type in the
sheet. Renaming one breaks every sheet still using the old name.

**`Client`** — the tenant. Beyond the obvious, the fields that drive rendering
are worth naming:

| Field | What it does |
|---|---|
| `cronTime`, `deliveryDays`, `startDate`, `endDate` | The campaign window. `nthDeliveryDate` walks it |
| `logoUrl`, `logoOriginalUrl`, `logoBackgroundRemoved` | The mark, before and after keying |
| `logoIncludesName` | Suppresses the printed company name for a wordmark |
| `brandTagline`, `websiteUrl`, `displayPhone` | Drawn on the poster where the design has room |
| `imageSizePreset` | Which canvas. WhatsApp status is 1080×1920 |
| `categoryId` | Which vertical, therefore which designs |
| `monthlyBudgetInr` | Spend ceiling |
| `isDemo` | Demo clients are excluded from real dispatch |

**`ContentCalendar`** — one row per day. The caption, the hashtags, the image
prompt, the poster copy as JSON, the chosen template, the approval flag, the
delivery status, and the Drive file id of the finished poster.

**`UsageEvent`** — one row per paid external call. Provider, key source,
quantity, cost in USD micros, and which client and calendar row it belongs to.
This is the only record of what a poster cost.

**`AppSetting`** — encrypted key/value. Holds bring-your-own provider keys; see
`secret-box.ts`.

**Enums**: `DeliveryStatus` (`PENDING` → `GENERATED` → `DELIVERED`, or
`FAILED`), `UsageProvider` (`OPENAI`, `FAL`, `EVOLUTION`), `UsageKeySource`
(`PLATFORM`, `BYO` — whose account paid).

## 2.2 A day's lifecycle

```
PENDING ──generate+compose+render+upload──▶ GENERATED ──approve──▶ (waits) ──send──▶ DELIVERED
   │                                            │                                        
   └────────────── FAILED ◀─────────────────────┘  (retryable; the stage is recorded)
```

Two things about this that are easy to get wrong:

**`GENERATED` is not "ready to send".** It means the poster exists in Drive. The
approval flag is separate, and dispatch will not touch an unapproved row however
long it sits. There is no reminder — an operator who stops approving produces
silence, not errors.

**A `FAILED` row remembers its stage.** Retrying resumes from the boundary that
failed, so a broadcast failure does not re-buy the photograph. `RetryFailedButton`
in the console drives this.

---

# Part 3 — The frontend

Server components by default; the interactive pieces are named client components
under `src/components/admin`. Writes go through server actions in
`src/app/admin/dashboard/actions.ts`, not through an API.

## 3.1 Pages

| Route | What it is for |
|---|---|
| `/login` | The only unauthenticated page. One password |
| `/admin/dashboard` | Fleet overview — spend, queue health, system notices |
| `/admin/clients` | The roster. Create, assign, activate |
| `/admin/clients/[id]` | One client: settings, brand identity, the calendar, the queue cards |
| `/admin/clients/[id]/brand` | Brand guideline and logo handling |
| `/admin/clients/[id]/approvals` | Bulk approval view |
| `/admin/verticals` | The verticals list |
| `/admin/verticals/[id]` | One vertical's designs — upload a reference, upload a plate, edit regions |
| `/admin/plans` | Plan catalogue |
| `/admin/demo` | A sandbox for producing sample creative without a real client |

## 3.2 Components

The ones that carry real behaviour, rather than the shadcn primitives in
`src/components/ui`:

| Component | Job |
|---|---|
| `CalendarImportPanel` | Paste or upload a sheet, preview every row with its issues, import |
| `QueueLedger` + `QueueCardActions` | The upcoming-days cards. Approve, send now, regenerate, delete |
| `CampaignApprovalControls` | Bulk approve |
| `VerticalTemplatePanel` | Upload and name designs; this is where a rename would happen |
| `PlateRegionEditor` | Draws text regions over a clean plate — **legacy renderer only** |
| `SpendPanel` + `StatTile` | Cost reporting off `UsageEvent` |
| `ImageKeyPanel` | Bring-your-own fal.ai key |
| `SystemNotices` | Surfaces misconfiguration — missing keys, unreachable services |
| `DeliveryDaysPicker`, `ImageSizeSelect`, `SeedCalendarButton`, `RetryFailedButton` | Self-describing |

## 3.3 API routes

Only five. Everything else is a server action.

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/cron` | Bearer token (`CRON_SECRET`), fails closed | The dispatch tick |
| `GET /api/health` | **None** | Container health. Reports the renderer's state; carries no error text on purpose |
| `GET /api/poster/preview` | Session | Renders a poster preview without a calendar row |
| `GET /api/templates/[id]/thumbnail` | Session | Serves a reference or plate from Drive, which is unpublished |
| `POST /api/webhooks/razorpay` | HMAC over the **raw** body | Provisions a client on payment |

## 3.4 Auth

`src/middleware.ts` gates everything except four named paths — the Razorpay
webhook, the cron endpoint, `/api/health`, and `/login`.

**There are no user accounts.** Authentication is a single password hash in
`ADMIN_PASSWORD_HASH`, checked in `src/app/login/actions.ts`, with a signed
session cookie. Consequences worth stating plainly:

- Everyone with access shares one credential.
- There is no record of who did what.
- Rotating it means changing an environment variable and redeploying.

If the platform ever has more than one operator, this is the first thing to
build.

---

# Part 4 — Inputs

## 4.1 Onboarding a client

`provisionClient()` in `src/lib/onboarding.ts`, shared by the Razorpay webhook
and the manual admin form so both compute identical campaign windows and Drive
structures. It validates with Zod, creates the client's Drive folder
(`ensureClientFolder`), normalises delivery days, and derives `startDate` /
`endDate` from the plan.

Brand extraction is separate: `src/lib/brand/css-harvest.ts` and
`src/lib/ai/brand-tokenizer.ts` read the client's website and propose colours and
a tagline. It is a starting point for the operator, not an authority.

## 4.2 Two ways a calendar exists

**Generated.** `src/lib/ai/calendar-generator.ts` writes N days of captions,
hashtags, image briefs and poster copy in batches. Used when nobody has a sheet.

**Imported.** An operator fills a spreadsheet and imports it. Rows are
`pinned by sheet` in the console, and their words are used verbatim — nothing
regenerates over them.

The imported path is the one that matters for quality, and §4.3 is its contract.

## 4.3 The import sheet

Three files: `calendar-parse.ts` (read and validate), `calendar-fit.ts` (warn
about what will not land), `calendar-import.ts` (persist).

**Columns**, in order. The first six are content; the rest are poster copy.

| Column | Required | Limit |
|---|---|---|
| `day` | yes | within the plan's duration |
| `template name` | yes | must match a design in the client's vertical |
| `caption` | yes | 10–2000 |
| `hashtags` | — | 400 |
| `image prompt` | yes | 10–2000 |
| `background prompt` | — | only read by designs with a scene backdrop |
| `headline` | yes | 2–4 lines split by `\|`, 24 chars each |
| `accent line` | yes | 1-based line number |
| `eyebrow` | — | 40 |
| `poster body` | — | 240 |
| `feature 1–4 icon / label / body` | — | label 28, body 90 |
| `cta label` | — | 28, defaults to `LEARN MORE` |
| `call label` | — | 28 |
| `website label` | — | 28 |
| `headline period` | — | `yes` / `no` |

**Rules that are not obvious:**

- **The feature count is the sheet's choice, not the design's.** `featureSlots`
  in a template's manifest is a *ceiling*. Fill two of four cards and the poster
  draws two; the row closes up. A card must be complete or empty — a label with
  no body is refused, naming the card.
- **A design with no feature row ignores features entirely**, the way a design
  with no body slot ignores `body`. Seven do.
- **The icon column is read, validated, stored and never drawn.** Icons are
  hard-coded per design. See §10.2.
- **Contact details never come from the sheet.** The phone number, website and
  tagline come from the client record, so they are correct on every poster
  automatically.
- **Rows past the plan's duration are refused**, and the console offers to
  import the ones that fit.

`npm run sheet -- --days N <slugs>` generates a correctly-shaped sheet for a
given set of designs, marking fields a design cannot draw with an em dash so the
difference between "nothing goes here" and "not filled in yet" is visible.

## 4.4 Generated copy

`src/lib/ai/poster-copy.ts` briefs the model on the *layout* — how many feature
items, whether an eyebrow is drawn, how narrow the headline column is — so the
words fit the design rather than the design straining around the words.
`coercePosterCopy` in `src/lib/types/poster.ts` then repairs what it can and
rejects what it cannot.

**One asymmetry worth knowing.** `coercePosterCopy` enforces a floor of two
features for *generated* copy — a model returning fewer has misunderstood its
brief — and no floor at all for hand-authored copy, where the count is a
deliberate choice. The `handAuthored` flag is how a caller says which it is, and
every sheet path passes it.

**A known mismatch:** for an authored HTML template, the copy stage is still
briefed from the *legacy* layout spec rather than the template's own manifest.
Nothing is truncated by this — whatever copy exists is drawn — but the model may
be told the wrong number of feature items. Only affects generated days; sheet
days are unaffected. See §10.2.

---

# Part 5 — Making the poster

## 5.1 Two renderers

**This is what the older documents get wrong**, and it is not a detail: they
describe a pipeline that no longer draws any of the posters you can see.

`renderPoster()` in `src/lib/poster/render.tsx` opens with:

```ts
const template = await findHtmlTemplateFor(input.templateLabel);
if (template) return renderViaTemplate(input, template);
```

| | **HTML templates** (current) | **Spec / plate** (fallback) |
|---|---|---|
| How a design is expressed | A hand-written `.html` file with CSS | A JSON layout spec of boxes |
| How it is drawn | Headless Chromium screenshots the page | satori builds an SVG, resvg rasterises it |
| Where designs live | `src/lib/poster/templates/*.html` | `CategoryTemplate.layoutSpec` in the database |
| Coverage | 23 designs — all Medicals, Constructions, Interiors | Anything with no authored template |
| Editing | Edit CSS | Drag regions in `PlateRegionEditor` |

If a vertical has authored templates, the spec path never runs for it. Both are
live; neither is dead code.

The rest of Part 5 describes the HTML path, because that is what draws posters
today.

## 5.2 The template system

A template is one self-contained HTML file. `src/lib/poster/html/`:

| File | Job |
|---|---|
| `template.ts` | Loads and parses templates; derives the **contract** |
| `render.ts` | Builds the document, launches the page, screenshots it |
| `fill.ts` | Runs *inside the browser*: fills slots, fits text, audits the layout |
| `browser.ts` | The shared Chromium, its flags, and its health |
| `typefaces.ts` | The bundled fonts, inlined as base64 |

**The parts of a template file:**

1. **A manifest** — a `<script type="application/json">` block naming the design,
   its aspect, the reference width its CSS is written against, how many feature
   cards it carries (`featureSlots`), and what photographs it needs.
2. **A comment** — what the design is, which reference it reproduces, and what it
   deliberately does *not* reproduce. These are load-bearing; read them before
   changing a file.
3. **A `<style>` block** — the design, in CSS, written in the reference image's
   own pixels.
4. **Markup** — with four kinds of hook:

| Hook | Meaning |
|---|---|
| `data-slot="name"` | Put this piece of copy here |
| `data-image="name"` | Put this picture here |
| `data-when="name"` | Remove this element entirely if that value is absent |
| `data-fit` / `data-fit="block"` | Shrink the type until it fits — width only, or both axes |

**The contract is derived, not declared.** `readContract()` reads those
attributes out of the markup, so what a design draws is a fact about the file
rather than a claim someone kept in sync. The sheet generator and the import
warnings both read it.

**Shared pieces:** `_kit.svg` is one SVG sprite of every icon, drawn in
`currentColor` so a template sets `color:` and the mark follows. `_base.css`
holds the classes every design uses (`.pk-headline`, `.pk-logo`, `.pk-strapline`,
`.pk-scene`, `.pk-subject`) driven by CSS custom properties.

**Copy reaches the page as `textContent`**, never as parsed HTML, and the model
is transferred by structured clone. A client can type `<script>` into a sheet and
it draws those characters. There is no HTML parser on the copy path at all.

## 5.3 Changing a template

The most common real task. The loop:

```bash
npx tsx --tsconfig scripts/tsconfig.json scripts/render-one.ts con-sm-01
# writes snapshots/templates/con-sm-01.look.png — open it, adjust, repeat
npm run check:templates     # before committing
```

`render-one.ts` renders one design with the logo trimmed exactly as production
does, which matters: `check:templates` calls the renderer directly and draws the
stand-in logo untrimmed, so it does *not* show you what a client sees.

**Adding a design** means: author the `.html`, add its slug to
`HTML_TEMPLATE_SLUGS` in `template.ts` (the list is explicit, not a directory
scan), and make sure a `CategoryTemplate` row exists with a matching name.

**Rules the lint enforces** (`scripts/check-templates.ts`): no literal text
outside slots, no hardcoded phone numbers, domains or emails, no network
references, only bundled typefaces, the manifest and markup must agree about
card count, and nothing may be painted in the logo area — the space belongs to
the client's mark, not to a frame around it.

## 5.4 Photos

`resolveTemplatePhotoRequests()` reads the manifest and asks for what the design
needs. Two kinds:

- **`scene`** — a photograph filling a band or the whole ground.
- **`subject`** — something cut out and standing free, with the background
  removed by a second fal.ai call.

Cut-outs are **trimmed of transparent margin before drawing**. A
background-removed frame comes back at its generation size with the subject
somewhere inside it, so `object-fit: contain` would fit the empty frame — measured
on a live poster as 223px of figure inside a 460px box.

A zero-length frame is a deliberate hole, not a failure: the pipeline pushes one
when a scene backdrop was declared and the day carried no `backgroundPrompt`, so
that array indices still line up.

## 5.5 The logo

The whole path, because every step of it has produced a visible bug:

```
upload → Drive → loadLogo() ──fetch, cap size, read dimensions, measure ink
                     │
                     ▼
              trimLogoMargin() ── crop the empty canvas away
                     │            raster: only if it has alpha
                     │            vector: rasterise, measure, keep the SVG
                     │            unless the crop is worth the loss
                     ▼
              .pk-logo img ── fixed box, object-fit: contain
                              filter: var(--logo-filter)
```

**Why the fixed box.** An uploaded SVG usually carries a viewBox and no width or
height, so it has an intrinsic ratio and no intrinsic size — as a flex item that
resolves to 0×0. It loads, reports a sensible `naturalWidth`, and draws nothing.

**Why the trim.** An exported logo is nearly always artwork floating in a much
larger transparent canvas, so `contain` fits the canvas. Measured: a mark drawing
at 42px inside a 330×232 slot.

**Why the alpha guard.** `sharp.trim()` on an opaque image trims by the *corner
colour*, so a logo supplied as a JPEG on a white card would have the card cropped
off — and that card is part of the artwork as supplied.

**Why the filter.** `--logo-filter: brightness(0)` for a dark mark on a light
ground, `brightness(0) invert(1)` for the reverse. The legacy renderer measured
contrast at runtime and re-inked; the template path traded that for one CSS line
per design, and two designs got the line wrong and shipped an invisible logo.
`check:templates` now measures the rendered pixels inside the logo's box and
fails below 3:1, so the trade is safe.

**The space is reserved even with no logo** — `min-height` / `min-width` on
`.pk-logo` — so a client without a mark gets the same composition as one with.

## 5.6 Determinism

A retry after a WhatsApp failure is compared against the original, so the same
input must produce the same bytes.

- **Playwright is pinned exactly** (`1.62.1`, not `^1.62.1`). A minor bump changes
  the Chromium build and therefore the pixels.
- **`--disable-lcd-text`** — subpixel antialiasing samples the background behind
  the glyph, so the same headline over a photograph rasterises differently
  depending on what is behind it.
- **`--font-render-hinting=none`** — hinting uses platform tables; left on, a
  Windows dev machine and the Debian container set the same headline at visibly
  different widths.
- **`--force-color-profile=srgb`** — otherwise Chromium adopts the host's display
  profile.
- **`--disable-gpu`** — GPU rasterisation is not bit-stable across drivers.
- **`--disable-dev-shm-usage`** — Docker gives 64 MB of `/dev/shm` and Chromium
  exceeds it rendering a 900×1600 page with photographs, dying with a bare
  "Target closed".
- **`--no-sandbox`** — the container runs unprivileged so the setuid sandbox
  cannot initialise. Safe *here specifically* because the page is markup this
  repository wrote, with no network access, and copy that reaches the DOM through
  `textContent`. If a template ever needs a remote asset, revisit this.

**Scaling uses CSS `zoom`, not `transform: scale()`.** A transform rasterises
then scales, so a 900px design blown up to 1080 arrives soft; `zoom` scales the
layout *before* rasterisation.

Renders are byte-identical within a platform and differ on glyph edges across
platforms — Windows against Linux, about 1.14% of pixels, text only. Golden
baselines must therefore be generated in the container, not locally.

---

# Part 6 — Outputs

## 6.1 Google Drive

`src/lib/google-drive.ts`, service account. Each client gets a folder at
provisioning (`ensureClientFolder`). Finished posters are uploaded there and the
Drive file id is stored on the calendar row.

Reference images and clean plates are uploaded **unpublished**, which is why
`/api/templates/[id]/thumbnail` exists — it fetches them with the service
account's own credentials and hands them to an operator who already has a
session. Do not add that path to the middleware's exception list.

## 6.2 Dispatch and WhatsApp

`src/lib/cron-worker.ts`, entered through `POST /api/cron` once a minute.
`executeIntervalDispatch()` does three things per tick:

1. **`releaseApproved`** — approved rows whose send time has arrived.
2. **`claimAndPreGenerate`** — rows due soon that have no poster yet.
3. **`claimAndSend`** — rows whose jittered send instant has passed.

Concurrency and batch sizes are all environment variables
(`CRON_MAX_CONCURRENCY`, `CRON_SEND_BATCH_LIMIT`, and so on), so a small box can
be throttled without a code change.

**Send jitter** is deliberate and worth understanding. A fleet that all message
WhatsApp on the same second every day is the most machine-like traffic shape
there is, and Meta reads the pattern rather than the content. So generation runs
at the client's exact `cronTime` and the *broadcast* is held back by a random
few minutes — drawn per row, not per client, and to the second rather than the
minute. `WHATSAPP_SEND_DELAY_MIN_MINUTES` / `_MAX_MINUTES` bound it.

## 6.3 Delivery states

`PENDING` → `GENERATED` → `DELIVERED`, with `FAILED` reachable from anywhere and
the failing stage recorded. See §2.2.

---

# Part 7 — Money

## 7.1 Plans and payment

A `Plan` is a duration and a price. Razorpay's webhook verifies an HMAC over the
**raw** request body — any parse-then-restringify round trip changes byte order
and breaks it — reads the client details from the order's `notes`, and calls the
same `provisionClient()` the admin form uses.

## 7.2 What a poster costs

Every paid call writes a `UsageEvent`: provider, quantity, cost in **USD micros**
(millionths of a dollar, because a caption batch costs a fraction of a cent and
cents would round most rows to zero), and which client and day it belongs to.

Rates live in `src/lib/pricing.ts` and are **all environment variables**, because
provider pricing changes on the provider's schedule. The dashboard prints the
rate card it used, so a mismatch with your real invoice is visible rather than
buried.

**The operationally important fact:** a poster costs money each time it is drawn,
because drawing it buys a photograph. **Regenerating buys another one.** Nothing
in the console warns about this. An operator chasing a nicer picture can spend
real money without noticing.

Keys can be the platform's own or a client's (`UsageKeySource`), and the source
is recorded from the same credentials object that made the call — never
re-resolved, so a key saved mid-sweep cannot re-attribute a render it did not pay
for.

---

# Part 8 — Keeping it honest

## 8.1 The check suite

No test framework. Each check is a standalone script that exits non-zero, in the
`lint-colors.mjs` tradition. Run them all before a deploy.

| Command | What it guarantees |
|---|---|
| `npm run typecheck` | TypeScript, strict, no emit |
| `npm run check:templates` | The big one — see below |
| `npm run check:layouts` | Legacy layout specs parse and render |
| `npm run check:risk` | Layout risk scoring |
| `npm run check:plate` | Plate rendering |
| `npm run check:import` | Sheets parse, round-trip, and survive the schema the server action applies |
| `npm run check:logo-key` | Logo background keying, and the margin trim |

**`check:templates`** is the one that protects the posters. Per template:

- **Content lint** — no literal text, no phone numbers, no domains, no network
  references, only bundled fonts, manifest agrees with markup, nothing painted in
  the logo area.
- **Renders**, and **re-renders byte-identically**.
- **Lays out cleanly across every copy shape** — the reference copy, the shortest
  the schema allows, the longest, and *every feature count the design can be
  handed*. The audit reports anything hidden, clipped, overflowing or colliding.
- **Draws the number of cards the sheet asked for** — 117 assertions.
- **The client's logo reads on its ground** — measured from the rendered pixels.
- **Survives hostile copy** — asserted inside the page, because once it is a PNG
  the difference between drawing the characters `<b>` and parsing a bold tag is a
  few pixels nobody will notice.
- **Recovers from its browser dying** — the suite kills the shared Chromium and
  renders through the wreckage.

## 8.2 What the checks cannot catch

Stated plainly, because the gap has bitten twice.

The layout audit tests **geometry**: hidden, clipped, overflowing, colliding. It
cannot tell you that a design is *wrong*. Everything below passed every check:

- A stethoscope standing over the word SAFETY on a construction poster.
- A logo drawn black on a black ground.
- The word "Visit" printed with nothing after it.
- 316px of empty orange where a design expected a figure.

All geometrically perfect. **Someone has to look at the posters.**

---

# Part 9 — Running it

## 9.1 Deployment

Docker Compose on a Hostinger VPS: Caddy at the edge for TLS and proxying,
Next.js, PostgreSQL 16. Full runbook in `DEPLOY_VPS.md`.

```bash
# on the VPS, in /opt/evokz
git fetch origin && git reset --hard origin/main
docker compose build app
docker compose up -d app
```

**The Dockerfile does three things worth knowing:**

- Installs `chromium-headless-shell` only, not the full `chromium` — the latter
  lays down two browsers and cost 600 MB.
- Copies `src/lib/poster/templates` and `src/lib/poster/fonts` explicitly.
- **Asserts the renderer works at build time** — `scripts/assert-renderer-assets.mjs`
  launches Chromium and renders a probe. A build that would have shipped a broken
  renderer fails instead.

**One domain.** `app.evokz.in` is the only name the box may serve. Do not add a
second to `APP_DOMAIN`.

## 9.2 Cron, backups, health

Two system cron entries on the VPS:

```
* * * * *   /opt/evokz/scripts/dispatch-cron.sh   # the dispatch tick
30 2 * * *  /opt/evokz/scripts/backup-db.sh       # nightly database dump
```

**Backups are written to `/opt/evokz/backups` — on the same box as the
database.** They run and they work, but if the VPS is lost, the database and
every backup of it go together. Copying them off-box is a half-hour job that has
not been done.

**The health check** now asks two questions: is the web server up (`/login`), and
is the renderer working (`/api/health`). The second returns 503 after four
consecutive render failures. Note what this does *not* do: Compose restarts a
container when it **exits**, not when it goes unhealthy, so this surfaces a
problem rather than repairing one. `docker ps` says `unhealthy` instead of
`healthy`, which is the difference between a problem someone can find and one
that waits for a client to complain.

## 9.3 Environment

Required for the platform to function at all:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres |
| `SESSION_SECRET`, `ADMIN_PASSWORD_HASH` | Login |
| `CRON_SECRET` | Authenticates the dispatch tick |
| `SETTINGS_ENCRYPTION_KEY` | Encrypts stored provider keys |
| `OPENAI_API_KEY` | Copy |
| `FAL_KEY`, `FAL_MODEL_ENDPOINT`, `FAL_CUTOUT_ENDPOINT` | Photography and cut-outs |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_DRIVE_PARENT_FOLDER_ID` | Storage |
| `EVOLUTION_API_URL`, `EVOLUTION_API_KEY` | WhatsApp |
| `RAZORPAY_WEBHOOK_SECRET` | Payments |
| `APP_TIMEZONE` | The dispatch window. `Asia/Kolkata` |

Tunables with sensible defaults: `CRON_*` (batching and concurrency),
`FAL_*` / `OPENAI_*` (timeouts, retries, models), `POSTER_*` (render and logo
timeouts, asset directories), `WHATSAPP_SEND_DELAY_*` (jitter bounds), and the
whole rate card in `pricing.ts`.

Provider keys can also be stored per-installation in `AppSetting`, encrypted by
`secret-box.ts`.

## 9.4 Common failures

| Symptom | Cause | Fix |
|---|---|---|
| `Target page, context or browser has been closed` | Chromium died | It now relaunches itself. If it persists, check container memory |
| Every poster failing at once | The renderer, not one row | `/api/health`, then container logs |
| Rows marked invalid on import | Usually days past the plan's duration | Import the ones that fit, or extend the plan |
| A poster's copy is not the operator's | The row's poster JSON failed validation and fell back to generated copy | Check the import warnings for that row |
| Logo missing | No logo on the client, or a design with no logo slot | Client settings, then §10.2 |
| `next build` fails with `EINVAL` on `.next` | OneDrive is syncing the build directory | Not a code fault. Pause syncing or build elsewhere |

---

# Part 10 — State of play

## 10.1 What changed recently

The platform moved from the spec/plate renderer to hand-authored HTML templates.
23 designs were authored — 14 Medicals, 9 Constructions and Interiors — and the
pipeline routes to them automatically.

Fixed in the last week, all deployed:

- **The client's logo drew at a fraction of its box.** Now trimmed, for raster
  and padded vector alike. Measured 42px → 232px in a 330×232 slot.
- **Two designs drew the logo black on a near-black ground.** Both inverted, and
  `check:templates` now measures contrast from the rendered pixels so it cannot
  recur on a design written later.
- **Con-SM-1 was a plainer design than its reference** — missing the chevron, the
  headline overlay, the strapline, and wearing Medicals icons. All four fixed; a
  Constructions icon set was added to the kit.
- **The sheet now decides the feature count.** A row with one feature used to be
  marked invalid *and* have all its other copy silently discarded.
- **The renderer survives its browser dying.** Previously one dead Chromium
  failed every poster for every client, permanently and silently.

## 10.2 Known gaps

Ranked by what they cost.

**1. The `feature N icon` column does nothing.** Operators are asked for an icon,
it is validated and stored, and the design draws its own hard-coded mark. A trap
in the sheet. Fixing it means a slot in the markup and a lookup in the kit.

**2. `SUBJECT_PROMPT_SUFFIX` forces a person onto every subject frame.**
`ai-pipeline.ts` appends *"a single person, full body in frame, standing…"* to
every cut-out brief, but three Constructions designs want an object — a hard hat,
materials, a digger. They get people. Changing it changes what images get bought.

**3. The copy stage briefs from the wrong shape** for authored templates — the
legacy layout spec rather than the template's manifest. Cosmetic; nothing is
truncated. Sheet-driven days are unaffected.

**4. Two orphaned elements.** Con-SM-2 prints its website *label* with no
`data-when` guard, so a client with no website gets the word "Visit" alone.
Con-SM-3 has the same problem with a decorative rule. Two attributes.

**5. Five Medicals designs have no logo slot** — Med-SM-11, 12, 13, 15, 16. The
client's mark never appears. Whether that is right depends on their references.

**6. Int-SM-3's logo passes at 3.3:1**, the tightest in the library against a
3:1 floor. Worth a look before a client with a pale mark lands on it.

**7. No golden-image baselines.** Renders are checked for self-consistency, not
against approved output. Baselines must be generated in the container (§5.6).

**8. Backups live on the same box as the database** (§9.2).

**9. One shared password, no accounts** (§3.4).

## 10.3 Traps

Things that have already cost time.

**The OneDrive build lock.** This repository sits in a OneDrive folder. `npm run
build` fails with `EINVAL` on `.next` when OneDrive is mid-sync. It is not a code
fault and no amount of reading the error will suggest otherwise.

**Shell escaping.** Writing TypeScript through heredocs has repeatedly eaten
backslashes: `\r\n` became a real newline and broke a string literal, `\b` became
a backspace character and made a lint pass vacuously. Prefer writing patch files
and running them, or avoid escapes entirely — `String.fromCharCode(10)`,
`.includes(',')` instead of a character class.

**`__name is not defined` in `page.evaluate`.** esbuild's `keepNames` helper does
not exist in the page. The shim is injected as a *string* after `setContent`,
because an `addInitScript` never fires — `setContent` does not navigate.

**Cross-platform pixel drift.** Windows and Linux differ on glyph edges, about
1.14% of pixels. Do not commit baselines generated locally.

**`evokz.in` has been blocked on some Indian networks** by SNI filtering. If the
console will not load for someone, test their connection before assuming the
platform is down.

---

*Written 2026-08-28 against `main`. When this file and the code disagree, the
code is right — and this file should be fixed.*
