# Evokz ACE — end to end: every stage, its inputs and its outputs

**Written 2026-08-26 against `3e2d448`.**

One pass through the system, stage by stage. Each section states what goes in,
what comes out, where it lives in the code, and what it costs.

Companion documents: [`POSTER_GENERATION_STATE.md`](POSTER_GENERATION_STATE.md)
for why the rendering layer is shaped the way it is,
[`PROJECT_KNOWLEDGE_BASE.md`](PROJECT_KNOWLEDGE_BASE.md) for the wider system,
[`DEPLOY_VPS.md`](DEPLOY_VPS.md) for operations.

---

## The shape of the whole thing

```
 Razorpay ─┐
           ├─► 1. Provision ──► Client + Drive folder
 Console ──┘                          │
                                      ▼
                         2. Brand tokens ──► brandGuideline ──► PosterTheme
                                      │
 Reference PNG ──► 3. Template ───────┤
                                      ▼
 Excel sheet ────► 4. Calendar ──► ContentCalendar rows (365)
                                      │
 cron, every 5 min ─► 5. Dispatch ────┤
                                      ▼
                         6. Creative pipeline
                            ├─ fal.ai      ──► photograph
                            ├─ satori/resvg ─► composed PNG
                            ├─ Drive        ─► stored asset
                            └─ Evolution    ─► WhatsApp
                                      │
                                      ▼
                              7. Usage ledger
```

Nothing downstream of stage 4 is touched by a human in normal operation, except
the approval gate in stage 6.

---

## 1. Provisioning a client

**Code** `src/lib/onboarding.ts`, `provisionClient`

| | |
|---|---|
| **In** | `companyName`, `whatsappNumber` (10–15 digits), `planId`, `categoryId`, `cronTime` (default `09:00`), `deliveryDays` (ISO weekdays, empty = all), `imageSizePreset`, `isDemo` |
| **Out** | A `Client` row, and a Google Drive folder created for it |
| **Triggered by** | The console's onboarding dialog, or the Razorpay webhook at `/api/webhooks/razorpay` |
| **Cost** | One Drive API call |

`companyName` is a plain validated form field. **It becomes the wordmark printed
on every poster** when the client has no logo uploaded — there is no derivation
and no default, so what is typed is what appears.

`isDemo` provisions identically but the cron sweep skips the client, which is
what you want for a test tenant.

---

## 2. Brand tokenisation

**Code** `src/lib/ai/brand-tokenizer.ts`, `src/lib/brand/css-harvest.ts`,
`src/lib/brand/website-colors.ts`, `src/lib/poster/theme.ts`

Two ways in, one column out.

| | |
|---|---|
| **In (A)** | `extractBrandGuideline(clientId, sourceMaterial)` — harvests the client's site, real CSS values, then classifies them |
| **In (B)** | `applyManualBrandTokens(clientId, hexes)` — an operator types them |
| **Out** | `Client.brandGuideline` — colour candidates each carrying a `source`, plus typography hints |
| **Cost** | (A) one `gpt-4o-mini` call plus fetches; (B) free |

At render time `resolvePosterTheme` turns that into a `PosterTheme`:

```
accent · accentOnDark · accentOnLight · onAccent
onDark · onLight · darkNeutral · lightNeutral
headingFont · bodyFont
```

It prefers **measured** colours over guessed ones — anything whose `source` is
not `'llm'` — and contrast-corrects: `accentOnDark` is the accent nudged until it
clears 4.5:1 against the dark ground.

**With no usable candidates it falls back to `HOUSE_THEME`** — near-black
`#0E1116`, near-white `#F6F7F9`, amber `#F0A81E`. A client that has never been
tokenised produces black-and-amber posters. That is not a bug; it is the absence
of an input.

---

## 3. Uploading a reference template

**Code** `uploadVerticalTemplate` in `src/app/admin/dashboard/actions.ts`

| | |
|---|---|
| **In** | A PNG, JPEG or WebP up to 6 MB, and the vertical it belongs to |
| **Out** | A `CategoryTemplate` row: Drive file, `label` (from the filename, deduped), measured `width`/`height`, and a `layoutSpec` |
| **Cost** | One Drive upload. **One `gpt-4o` vision call — unless the vertical has a standard layout** |

Two behaviours, decided by `Category.defaultLayoutSpec`:

**The vertical has a standard layout** — the template inherits it. No vision
call, `layoutApprovedAt` set, `layoutAuthoredAt` stamped so a later re-read
cannot silently replace it. Ready immediately. *All seven verticals are in this
state.*

**It does not** — a vision model reads the geometry out of the image and the
result auto-approves if it parses. This is the path that produced boxes on a 0.05
grid; see `POSTER_GENERATION_STATE.md` §6.

`label` is the key an Excel sheet types to choose this template, unique per
vertical and editable.

---

## 4. Seeding the calendar

Two ways to fill `ContentCalendar`. **The import path is the one in use.**

### 4a. AI generation

**Code** `src/lib/ai/calendar-generator.ts`

| | |
|---|---|
| **In** | The client, its vertical, campaign length |
| **Out** | One `ContentCalendar` row per day: `theme`, `caption`, `hashtags`, `imagePrompt`, `posterCopy` |
| **Cost** | `gpt-4o-mini`, chunked and **sequential** — one 365-day request would blow `max_tokens`, and concurrent requests cannot share a prompt-cache entry a sibling is still writing |

### 4b. Excel import

**Code** `src/lib/calendar-parse.ts`, `src/lib/calendar-import.ts`

| | |
|---|---|
| **In** | A CSV/JSON sheet: `day`, `template name`, `caption`, `hashtags`, `image prompt`, and optional poster columns (headline, features, labels) |
| **Out** | `ContentCalendar` rows with `posterTemplateId` resolved from the template name, **plus `fitWarnings`** |
| **Cost** | Free — no model call |

`template name` is matched **strictly**: unknown, blank or unapproved rejects the
whole import rather than importing some rows.

**`fitWarnings` (`src/lib/calendar-fit.ts`) is the check that runs here and
nowhere else.** It reports rows that will import and deliver but not draw as
written:

- a headline whose line count does not match the template's emphasis pattern
- lines that will wrap past the column's character budget
- more features than the template draws
- an image brief that does not describe the figure the layout composites

Advisory, never blocking. The current live sheet produces **9 warnings across 7
rows**.

---

## 5. Dispatch

**Code** `src/app/api/cron/route.ts` → `executeIntervalDispatch` in
`src/lib/cron-worker.ts`

| | |
|---|---|
| **In** | An HTTP tick every 5 minutes carrying `Authorization: Bearer $CRON_SECRET` |
| **Out** | A `DispatchSummary` — matched clients, queued, delivered, failed, scheduled, sent, released, preGenerated, awaitingApproval |
| **Cost** | Nothing itself; it calls the pipeline |

Platform cron fires on one global timer but every client owns a private
`cronTime`, so each sweep resolves the trailing minute window in the app timezone
and selects only the clients due inside it.

**Every sweep runs two phases, send first.** Generation happens at the client's
exact minute; the WhatsApp broadcast is held back a random few minutes and
carried out by a *later* sweep, so a fleet does not message WhatsApp in a
synchronised burst. The wait is a timestamp in the database, not a sleep — the
sweep is an HTTP request with a 300s ceiling, and a sleeping worker would hold a
concurrency slot against every other client due that minute.

**Approval gates every phase.** A row with `approvedAt` null is never sent and
never released. `awaitingApproval` is counted rather than acted on, because
otherwise a campaign can stop delivering with nothing in the output to say why.

---

## 6. The creative pipeline

**Code** `runCreativePipeline` in `src/lib/ai-pipeline.ts`

One `ContentCalendar` row in, one delivered poster out. Stages are named so a
failure lands in `errorMessage` attributed correctly.

### 6.1 `load`

**In** `calendarId` · **Out** the row plus its client, or a refusal

Checks the client has a Drive folder, clears any stale error, and settles
`awaitingApproval` once — before the reuse path, so no branch can deliver an
unapproved poster.

### 6.2 Resolve the layout — *before anything is bought*

**Code** `resolveDayLayout` in `src/lib/poster/layout-library.ts`

**In** `categoryId`, `dayNumber`, the row's `posterTemplateId`
**Out** a `PosterLayoutSpec`, its template id, and any plate

Either the template the sheet pinned, or a deterministic rotation over the
vertical's approved templates. **A pin never falls back** — a deleted or
unapproved pin fails loudly rather than quietly rotating.

This runs first because the spec declares how many photographs are needed and at
what aspect. Resolving it later would bill fal.ai for frames a compose failure
then discards.

### 6.3 Resolve the canvas

**Code** `resolvePosterCanvas` in `src/lib/poster/canvas.ts`

**In** the spec's measured `aspect`, the client's `imageSizePreset`
**Out** `{ width, height, reason }`

**The template's shape wins; the preset supplies resolution.** A square reference
produces a square poster even for a client on WhatsApp Status.

### 6.4 Size the photo requests

**Code** `resolveSpecPhotoRequests` in `src/lib/poster/photo-request.ts`

**In** the spec and the resolved canvas
**Out** one `{ width, height, kind, reason }` per photo cell

Sized against the cell the photograph actually lands in, not the delivered
canvas. Getting this wrong crops a portrait into a letterbox and decapitates the
subject.

### 6.5 `generate`

**In** the day's `imagePrompt` + the request size
**Out** image bytes
**Cost** one `fal-ai/flux/schnell` render per photo cell, **billed the moment
pixels arrive** — before the upload, which can fail without making the render free

Sequential, not parallel: fal's rate limits are per key across the whole sweep,
and firing two at once to save seconds on one row risks 429s for every other
client that minute.

A `subject` cell then goes through `fal-ai/birefnet/v2` for background removal,
billed separately. **A failed matte is a degradation, not a failure** — the frame
composites with its own background rather than losing the client's day.

### 6.6 `compose`

**Code** `renderPoster` in `src/lib/poster/render.tsx`

| In | Out |
|---|---|
| the layout spec | |
| `posterCopy` (words) | |
| `brandGuideline` → `PosterTheme` (colours) | a PNG at the resolved canvas |
| identity: company name, logo, phone, website | |
| the generated photograph(s) | |

What happens inside:

1. **Metrics** — the design system resolved to this canvas's pixels
2. **Logo** — fetched, measured, cached for the process lifetime; **recoloured to
   an ink that reads** if it would otherwise be invisible
3. **Plate surfaces** — where a plate is in play, the artwork under each text
   region is sampled so type is coloured against what is actually behind it
4. **Tree** → `renderLayoutSpec` (grid) or `renderPlateSpec` (plate)
5. **satori** → SVG, **resvg** → PNG

`assertRenderableCanvas` refuses impossible geometry first: resvg is a native
addon and panics in Rust, which **terminates the Node process** and would take a
whole sweep with it.

### 6.7 `upload`

**In** the PNG · **Out** `gDriveFileId`, `gDriveViewUrl`, status → `GENERATED`
**Cost** one Drive upload

Published link-readable, because Evolution API fetches it with no Google
credentials.

### 6.8 `broadcast`

**In** the Drive URL, caption + hashtags, the client's WhatsApp number
**Out** status → `DELIVERED`
**Cost** one Evolution API send

Skipped when `deferBroadcast` is set — the sweep's generation phase stamps
`sendAfter` and a later sweep does it.

---

## 7. The usage ledger

**Code** `src/lib/usage.ts`, `src/lib/pricing.ts`

**In** every billable call, recorded at the moment it succeeds
**Out** append-only `UsageEvent` rows → the console's spend panel

Operations tracked: `calendar`, `poster-copy`, `brand-tokenizer`,
`layout-extract`, `plate-regions`, `plate-labels`, `image`, `image-cutout`,
`whatsapp`.

Each row carries which key paid — the fleet's or an operator's own — so a key
saved mid-sweep cannot re-attribute a render it did not pay for.

---

## 8. What a single poster costs

| Stage | Calls | When |
|---|---|---|
| Template read | 1 vision | **Only if the vertical has no standard layout.** Once per upload, never per poster |
| Copy | 1 `gpt-4o-mini` | Once per day at seed; zero if the sheet supplies it |
| Photograph | 1 flux per photo cell | Every render |
| Cut-out | 1 birefnet per `subject` cell | Every render |
| Drive | 1 upload | Every render |
| WhatsApp | 1 send | Every delivery |

The current layout has **one** photo cell, so a poster is one flux render plus
one birefnet call. Adding a background photograph would double the diffusion
spend — which is why it has not been added without a decision.

---

## 9. Where a human touches it

Four places, and only four:

1. **Onboarding** — create the client, set its brand colours
2. **Templates** — upload references; approve a layout if the vertical has no
   standard one
3. **The sheet** — write the calendar, and read the import's fit warnings
4. **Approval** — approve a day's poster before it can be delivered

Everything else is unattended.

---

## 10. Verifying any of it without spending money

```bash
npm run check:layouts   # every fixture at every preset
npm run check:plate     # compositing, colour grounds, logo treatment
npm run check:import    # sheet parsing and conflict modes
npm run check:fleet     # every stored spec in a real database
```

And a poster rendered through the exact production path, with procedural
photography and no fal, Drive or WhatsApp call:

```
https://app.evokz.in/api/poster/preview?templateId=<id>
```
