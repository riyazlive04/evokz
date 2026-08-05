# Evokz ACE — AI Creative Engine

Multi-tenant creative automation: per-client scheduled Flux.1 generation → Google Drive
sync → WhatsApp delivery via Evolution API, triggered by Razorpay payments.

Next.js 14 (App Router) · React 18 · Tailwind CSS · shadcn/ui · PostgreSQL + Prisma.

---

## Getting started

```bash
npm install                # also runs `prisma generate`
cp .env.example .env       # fill in every value
npm run prisma:push        # or: npm run prisma:migrate
npm run dev                # http://localhost:3000/admin/dashboard
```

The dashboard renders a banner listing any unset integration variables (names only), so a
config gap is distinguishable from a code bug at a glance.

Seed at least one **Plan** and one **Category** from the console before onboarding a client —
provisioning validates both foreign keys.

## Architecture

| Concern | Location |
| --- | --- |
| Database schema | [prisma/schema.prisma](prisma/schema.prisma) |
| Razorpay webhook | [src/app/api/webhooks/razorpay/route.ts](src/app/api/webhooks/razorpay/route.ts) |
| Client provisioning (shared) | [src/lib/onboarding.ts](src/lib/onboarding.ts) |
| Dispatch engine | [src/lib/cron-worker.ts](src/lib/cron-worker.ts) · [src/app/api/cron/route.ts](src/app/api/cron/route.ts) |
| Creative pipeline | [src/lib/ai-pipeline.ts](src/lib/ai-pipeline.ts) |
| Poster renderer | [src/lib/poster/](src/lib/poster/) · [docs/creative-style-spec.md](docs/creative-style-spec.md) |
| Google Drive client | [src/lib/google-drive.ts](src/lib/google-drive.ts) |
| Timezone helpers | [src/lib/time.ts](src/lib/time.ts) |
| Admin console | [src/app/admin/dashboard/page.tsx](src/app/admin/dashboard/page.tsx) |
| Server actions | [src/app/admin/dashboard/actions.ts](src/app/admin/dashboard/actions.ts) |
| Brand canvas | [src/components/brand/BrandCanvasView.tsx](src/components/brand/BrandCanvasView.tsx) |
| Output-size catalogue | [src/lib/image-sizes.ts](src/lib/image-sizes.ts) |

### Delivery lifecycle

```
PENDING ──(Flux.1 photo → poster composite → Drive upload)──▶ GENERATED ──(Evolution send)──▶ DELIVERED
   └──────────────────────────── any step throws ────────────────────────────▶ FAILED (+ errorMessage)
```

`GENERATED` is a real checkpoint: a WhatsApp failure after a successful upload is retried
without re-billing fal.ai, because the stored `gDriveFileId` is reused.

## The poster layer

**The delivered creative is a composite, not a diffusion render.** fal.ai produces only the
background photograph; every readable element — logo lockup, headline, body copy, icon
features, contact bar — is typeset over it as real vector glyphs by
[src/lib/poster/](src/lib/poster/) and rasterised with satori + resvg.

This is not a stylistic choice. Diffusion models cannot spell, and the contact bar carries a
client's actual phone number and domain. A misspelt headline is embarrassing; a wrong phone
number delivered daily to a paying client's WhatsApp is a refund. So the calendar generator's
long-standing rule — *never ask the image model for text* — is still enforced, and the text
arrives from data instead.

| Concern | Location |
| --- | --- |
| Layout rules, reverse-engineered from the reference set | [docs/creative-style-spec.md](docs/creative-style-spec.md) |
| Slot components (logo, headline, accent rule, features, contact bar) | [src/lib/poster/slots.tsx](src/lib/poster/slots.tsx) |
| Eight layout archetypes + wide/letterbox adaptations | [src/lib/poster/archetypes.tsx](src/lib/poster/archetypes.tsx) |
| Brand tokens → colours, fonts, contrast correction | [src/lib/poster/theme.ts](src/lib/poster/theme.ts) |
| Spec pixel values scaled to any canvas | [src/lib/poster/metrics.ts](src/lib/poster/metrics.ts) |
| Render entry point | [src/lib/poster/render.tsx](src/lib/poster/render.tsx) |
| Preview surface | `/admin/poster-preview` |

### Archetypes

Eight compositions (§5 of the spec): `scrim`, `diagonal`, `bands`, `curve`, `editorial`,
`spotlight`, `corner`, `inverted`. A calendar row may pin one in `posterArchetype`; otherwise it
is derived from `dayNumber` by `archetypeForDay`, stepping through the set by the smallest stride
above 1 that is coprime with its size — 3 at eight archetypes — so all eight appear before any
repeats. The stride is computed rather than written down: a literal that stops being coprime
silently walks a subset forever, with nothing to catch it.

The last three are derived rather than reverse-engineered from the reference set: `spotlight`
puts a full-bleed photo under an even wash with the copy centred down the frame, `corner` insets
the photo as a tall panel filling the right half of a light field, and `inverted` runs a photo
band across the top 30% with all copy below it.

Derivation is deterministic on purpose. Re-rendering day 47 after a failure must reproduce the
layout the first attempt would have produced, or an operator comparing a retry against the
original sees a difference that isn't there.

**The archetype picks the photo's aspect ratio, not the output preset.** `bands`, `curve` and
`inverted` place the photo in a landscape band; asking fal for a 9:16 portrait and cover-fitting
it into a short wide box discards most of the frame and usually decapitates the subject. See
[src/lib/poster/photo-request.ts](src/lib/poster/photo-request.ts).

### Poster identity

`Client.logoUrl`, `brandTagline`, `websiteUrl` and `displayPhone` are real columns, not entries
in `brandGuideline` — the brand tokenizer rewrites that column wholesale, and an
operator-uploaded logo has to survive a re-extraction. Edited from the brand canvas; uploads
land in the client's Drive folder published link-readable, because the renderer fetches the URL
server-side.

`displayPhone` renders exactly as typed. When it is null the contact bar derives `+91 XXXXX
XXXXX` from `whatsappNumber`. A missing or unreachable logo degrades to a generated wordmark
lockup with a warning — never a failed delivery.

### Fonts

Satori needs font bytes; it cannot use system fonts. Faces load from `POSTER_FONT_DIR` if set,
otherwise from Google Fonts once per process.

**The loader sends a deliberately old User-Agent.** `fonts.googleapis.com/css2` sniffs the UA
and serves `woff2` to anything modern, which satori's parser cannot decompress. An old UA
downgrades the response to woff or truetype. Remove the header and every render fails with
`Unsupported OpenType signature wOF2`. Set `POSTER_FONT_DIR` in production so the render path
has no outbound dependency at all.

### Why not `next/og`

`ImageResponse` wraps exactly satori and resvg, so it looks like the obvious choice, but its
Node-runtime build **cannot load on Windows**: it resolves its own wasm assets with
`fileURLToPath(path.join(import.meta.url, '../yoga.wasm'))`, and `path.join` rewrites
`file:///D:/…` into `file:\D:\…`, which is not a parseable URL. The module throws
`TypeError: Invalid URL` at import time. It works on Vercel's Linux, which makes it worse — the
composition could not be previewed on the machine it is authored on. The two libraries are
imported directly instead.

`@resvg/resvg-js` ships a platform-specific `.node` addon and must stay in
`serverComponentsExternalPackages`; webpack cannot bundle it.

### Previewing

`/admin/poster-preview` renders all eight archetypes at any output preset, optionally with a
real client's brand and a real calendar day's copy. It costs nothing to refresh: the background
photo is generated procedurally by
[src/lib/poster/placeholder-photo.ts](src/lib/poster/placeholder-photo.ts) rather than diffused.
The page also reports the resolved theme, any contrast pairing still below target after
correction, and any slots the chosen canvas cannot carry. Add `&debug=1` to the API route to get
a stack trace instead of a one-line error — satori reports faults tersely and without naming the
element responsible.

### Creative output size

Each client carries an output-size preset (`Client.imageSizePreset`) chosen at onboarding and
editable from the client detail page. The catalogue in
[src/lib/image-sizes.ts](src/lib/image-sizes.ts) covers WhatsApp, Instagram, Facebook,
LinkedIn, X, YouTube and Pinterest, plus phone / tablet / laptop wallpapers and A4 print.
`null` falls back to `FAL_IMAGE_SIZE`, then to `whatsapp-status` (1080×1920) — the canvas
[docs/creative-style-spec.md](docs/creative-style-spec.md) is measured against.

Two caveats are surfaced in the picker rather than blocked:

- **Off-brand shapes.** Every reference poster in the style-spec set is portrait, so square
  and landscape presets are flagged. The renderer does not refuse them: an aspect over 0.82
  switches to a `wide` composition (copy column left, photo right), and over 2.2 to a
  `letterbox` one that keeps only the logo, headline and contact details. Dropped slots are
  named in the logs and on the preview page rather than silently omitted.
- **A softened background photo.** Flux renders up to ~2048 px per side, so on the largest
  presets (4K, ultrawide, iPad Pro, A4) the photograph is stretched to cover the canvas. The
  delivered file is still the preset's exact size and all type stays vector-sharp — only the
  photo loses detail, which is why this is an advisory rather than a refusal.

Because the preset sets the composite canvas and the archetype sets the photo request, no
preset is bounded by Flux's ceiling: a 3840×2160 wallpaper is delivered at 3840×2160.

One cost caveat is **not** surfaced in the UI: `PRICE_FAL_PER_IMAGE` is a flat per-image rate,
so if `FAL_MODEL_ENDPOINT` is pointed at a model that bills per megapixel, the spend ledger
will under-report at large canvases. `fal-ai/flux/schnell` is flat-rated, so the default
configuration is accurate.

## Integration setup

### Razorpay

Point a webhook at `POST /api/webhooks/razorpay`, subscribe to **order.paid**, and set the
signing secret as `RAZORPAY_WEBHOOK_SECRET`. Pass these keys in the order's `notes`:

| Note key | Purpose |
| --- | --- |
| `company_name` | Client display name and Drive folder name |
| `whatsapp_phone` | Delivery target, international digits |
| `plan_id` | Existing `Plan.id` (UUID) |
| `category_id` | Existing `Category.id` (UUID) |
| `preferred_cron_time` | `HH:MM`, defaults to `09:00` |
| `image_size` | Optional output-size preset id; omit for the fleet default |

Response codes: `400` invalid/missing signature · `422` valid signature but unusable notes
(a checkout-integration bug — retrying will not help) · `500` transient fault, safe to retry
because provisioning is idempotent on `(whatsappNumber, planId)` over a live window.

### Google Drive

Create a service account, enable the Drive API, then share the parent vault folder with the
service-account email as **Content manager / Editor**. `GOOGLE_PRIVATE_KEY` accepts the
single-line form copied straight out of the credentials JSON — literal `\n` is unescaped at
runtime.

### Cron

`vercel.json` schedules `/api/cron` every 5 minutes. Any scheduler works provided it sends
`Authorization: Bearer $CRON_SECRET`. The endpoint fails closed if `CRON_SECRET` is unset.

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://your-app/api/cron
```

**`CRON_WINDOW_MINUTES` must be ≥ your real cron interval.** The dispatcher matches
`Client.cronTime` against every minute in the trailing window; with a 5-minute schedule and a
window of 1, four out of five clients would never be picked up. All matching is done in
`APP_TIMEZONE`, not the container's UTC clock.

## Operating the console

- **Plan / Vertical managers** — full CRUD. Deletes are blocked while clients reference the
  record, and the console reports how many.
- **Client matrix** — inline `cronTime` editing (Enter commits, Escape reverts), pause/resume,
  and Drive-folder repair for a client whose onboarding half-failed. The company name links to
  its brand canvas.
- **Event queue feed** — upcoming entries previewed from Drive thumbnails. Failed deliveries
  get their own section above the queue, with the persisted `errorMessage` shown inline.
- **Send now** reuses the stored Drive asset; **Regenerate** forces a fresh Flux.1 render.
- **Bulk content import** (client detail page) — load a calendar the team wrote by hand
  instead of generating it. See below.

## Bulk content import

Per-client, on the client detail page. Accepts CSV, TSV, or a JSON array carrying **theme,
caption, hashtags, image prompt** — the same four fields the calendar generator produces — and
writes them straight into `ContentCalendar`. No OpenAI call, so no spend and none of the
sequential-batch wait. The poster text layer can be authored in the same sheet or left to the
render-time backfill; see [below](#authoring-the-poster-text-layer).

| Concern | Location |
| --- | --- |
| Sheet parsing + wire contract (isomorphic) | [src/lib/calendar-parse.ts](src/lib/calendar-parse.ts) |
| Day resolution + writes | [src/lib/calendar-import.ts](src/lib/calendar-import.ts) |
| Operator panel | [src/components/admin/CalendarImportPanel.tsx](src/components/admin/CalendarImportPanel.tsx) |

Column headers are matched by alias (`image prompt`, `Image_Prompt`, `prompt`, … all resolve
to `imagePrompt`) in any order; `theme`, `caption`, and `image prompt` are required, `day` and
`hashtags` optional. **Leave `day` blank to append** — those rows take the lowest campaign days
not already written, and never a day an explicitly-numbered row in the same file asked for.
Capped at 400 rows per import.

The panel parses in the browser and dry-runs the whole sheet before anything is written, so
each row shows the day it will land on and whether it creates, replaces, or bounces. The server
action re-parses and re-resolves independently — the browser's day map is a render-time snapshot
and is never trusted.

Two conflict modes. **Keep** skips any day that already has a row. **Overwrite** replaces the
copy on `PENDING` and `FAILED` days only, resetting them to `PENDING` and clearing
`errorMessage` and the Drive asset references — a `FAILED` row can be holding an image rendered
from the *old* prompt, and a later re-send would otherwise deliver the previous creative under
the new caption. `GENERATED` and `DELIVERED` days are never rewritten; the panel labels them
**Locked**.

### Authoring the poster text layer

The poster columns are optional. Leave them out and `ensurePosterCopy` derives the headline,
body, and features from that day's theme, caption, and image prompt on first render — one small
OpenAI call per day, at render time rather than seed time. Supply them and nothing is generated
at all.

| Column | Notes |
| --- | --- |
| `headline` | 2–4 lines separated by `\|`. The breaks are the copywriter's decision, not the renderer's. |
| `accent line` | Which headline line takes the brand colour, **counting from 1**. Stored 0-based. Blank → line 2. |
| `eyebrow` | Optional caps kicker. Blank omits it. |
| `poster body` | 12–30 words. Distinct from `caption`, which is the WhatsApp message body. |
| `feature N icon/label/body` | Three per feature, 2–4 features. Icon must be one of the names in `POSTER_ICONS`. |
| `call label` / `website label` | Contact-bar imperatives. Blank → `CALL US TODAY` / `VISIT OUR WEBSITE`. |
| `headline period` | yes/no. |
| `archetype` | Pins the layout to one of the eight. Blank rotates by day number. |

Poster columns are **all-or-nothing per row**: touch any one and that row must supply a complete
block. A half-filled poster cannot be rendered, and silently falling back to generation would
hide the operator's typo behind a plausible-looking result. An unknown icon name is reported
rather than swapped for `shieldCheck` — an icon contradicting its own label is worse than being
told to fix the spelling. Over-length cells are likewise reported instead of being truncated at
a word boundary, which is what `coercePosterCopy` would otherwise do to deliberate wording.

JSON input takes the generator's **nested `poster` object** verbatim, so a seeded calendar can be
exported, edited, and pasted straight back in.

The two template buttons emit exactly these two shapes — content-only, and content plus every
poster column — both with two filled example rows, since the image-prompt and headline house
rules are easier to copy than to describe.

`posterCopy` and `posterArchetype` are treated differently on overwrite, deliberately: poster
copy is *derived from the caption being replaced*, so it is cleared unless the sheet supplies a
new block; the archetype is a layout pin rather than derived content, so a sheet with no opinion
on it leaves an existing pin alone.

## Content stages (OpenAI)

Two LLM-backed stages feed the pipeline. Both are schema-constrained via Structured Outputs
(`response_format: json_schema`, `strict: true`), so the model cannot wrap its JSON in prose.

| Stage | Module | Triggered from |
| --- | --- | --- |
| Brand tokenizer | [src/lib/ai/brand-tokenizer.ts](src/lib/ai/brand-tokenizer.ts) | Brand canvas page → "Extract design tokens" |
| Calendar generator | [src/lib/ai/calendar-generator.ts](src/lib/ai/calendar-generator.ts) | Client matrix → "Generate N days" |
| Poster-copy backfill | [src/lib/ai/poster-copy.ts](src/lib/ai/poster-copy.ts) | Pipeline, `compose` stage, only when needed |

The calendar generator writes each day's **poster copy** alongside its caption — headline lines,
which line takes the accent, body, feature labels, CTA wording — into `ContentCalendar.posterCopy`.
Both stages share one contract in [src/lib/ai/poster-prompt.ts](src/lib/ai/poster-prompt.ts); if
the rules diverged, a backfilled day would render subtly differently from its neighbours and
nobody would notice until a month of creatives were viewed side by side.

`ensurePosterCopy` runs in the pipeline only for rows that lack usable copy — those seeded before
the poster layer existed, or whose batch response was unrepairable. It is a no-op for a normally
seeded day, and its spend is logged under its own `poster-copy` operation so a client accruing
them is visible as a prompt problem rather than hidden inside `calendar`.

Structured Outputs reject `minItems`/`maxItems` under `strict: true`, so array lengths are asked
for in prose and repaired afterwards by `coercePosterCopy` — over-long arrays trimmed, over-long
strings cut at a word boundary, a one-line headline split in two. Rejecting a nearly-good response
outright would discard a whole day's copy over something mechanically fixable.

**Order matters.** Extract brand tokens first — the calendar generator folds the palette,
typography, and layout directives into every `imagePrompt`, so seeding a calendar before
tokenizing produces generic creatives.

**`ContentCalendar` is the pipeline's fuel.** The dispatcher only delivers rows that already
exist, so a client with no calendar delivers nothing. The client matrix flags any client whose
seeded days are fewer than its plan duration. Generation is not the only way to fill it — see
[Bulk content import](#bulk-content-import) for the hand-authored path.

Generation is chunked (`CALENDAR_BATCH_SIZE`, default 10 days) and runs **sequentially** — a
365-day calendar in one request would exceed the output cap, and concurrent requests can't
benefit from a prompt-cache entry a sibling is still populating. The per-client brand brief
lives in the system prefix, which OpenAI caches automatically once it exceeds ~1024 tokens;
watch `cached=` in the `[ace:llm]` log lines to confirm batches 2..N are hitting it. Re-running
only fills gaps — existing days are never overwritten, and `@@unique([clientId, dayNumber])`
backs that with `skipDuplicates`.

### Model choice

Default is `gpt-4o-mini` (`OPENAI_MODEL`), replacing the blueprint's Claude 3.5 Sonnet, which
was retired on 2025-10-28 and now returns 404.

Temperature is tuned per stage, not globally: the tokenizer runs at **0.2** (extraction should
be near-deterministic, so the same material yields a stable palette) and the calendar at
**0.9** (captions should not converge on one template).

Under `strict: true`, Structured Outputs require every object to set
`additionalProperties: false` and list **all** of its properties in `required` — optional
fields are unsupported. Both schemas already satisfy this; keep it in mind when editing them,
since a violation surfaces as a `400` at request time rather than a type error.

## Local dev gotchas

**Stop the dev server with Ctrl+C, not by killing the process.** A hard kill leaves `.next`
half-written; the next start then fails with `Cannot find module
'.next/server/middleware-manifest.json'` or `Cannot find module
'./vendor-chunks/lucide-react.js'` and **every route 500s** even though `tsc` and
`next build` pass. Killing the `npm` wrapper also orphans the `next dev` child, which keeps
holding the port.

Recovery, and the same fix for the `next build` / `next dev` collision (they share `.next`):

```powershell
# stop any orphans, then:
Remove-Item -Recurse -Force .next, node_modules/.cache
npm run dev
```

On Windows use PowerShell's `Remove-Item`, not Git Bash `rm -rf` — the latter silently skips
locked files and leaves the directory in the same broken state.

`prisma generate` also fails with `EPERM ... query_engine-windows.dll.node` while the dev
server is running, because the engine DLL is loaded. Stop the server first, or ignore it when
the client is already generated.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Dev server |
| `npm run build` | `prisma generate` + production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (next/core-web-vitals) |
| `npm run prisma:push` | Push schema without migrations |
| `npm run prisma:studio` | Browse/seed data |
