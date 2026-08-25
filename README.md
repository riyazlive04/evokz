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

`SETTINGS_ENCRYPTION_KEY` is only needed if the operator will supply their own fal.ai key from
the console (see **Operating the console**). Without it that panel refuses to save rather than
storing a credential in plain text; everything else runs.

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
| fal.ai credential resolution | [src/lib/fal-credentials.ts](src/lib/fal-credentials.ts) |
| Secret encryption at rest | [src/lib/secret-box.ts](src/lib/secret-box.ts) |
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

It is also a **deliberate pause**. On the dispatch sweep the run stops there and stamps
`sendAfter` a random 2–8 minutes out ([src/lib/send-jitter.ts](src/lib/send-jitter.ts)); a
later sweep broadcasts whatever has come due. A fleet that all messages WhatsApp on the same
minute, to the second, every day is the most machine-like traffic shape there is, and Meta
reads the pattern rather than the content — so the fleet stops being punctual. The gap is
drawn per poster, so two clients sharing a `cronTime` still separate.

The wait is a timestamp, never a sleep: the sweep is an HTTP request capped at 300s, and a
sleeping worker would hold one of its concurrency slots against every other client due that
minute. Operator-driven sends — retry, force re-send, regenerate, demo — skip the delay
entirely, because a human waiting on a button should not be made to wait.

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
| Layout spec — a template's geometry as data | [src/lib/types/layout-spec.ts](src/lib/types/layout-spec.ts) |
| Spec interpreter (draws every layout) | [src/lib/poster/layout-render.tsx](src/lib/poster/layout-render.tsx) |
| Reading a layout out of an uploaded poster | [src/lib/ai/layout-extractor.ts](src/lib/ai/layout-extractor.ts) |
| Brand tokens → colours, fonts, contrast correction | [src/lib/poster/theme.ts](src/lib/poster/theme.ts) |
| Spec pixel values scaled to any canvas | [src/lib/poster/metrics.ts](src/lib/poster/metrics.ts) |
| Render entry point | [src/lib/poster/render.tsx](src/lib/poster/render.tsx) |
| Preview surface | `/api/poster/preview` |

### Layouts

Every poster is drawn from a reference template an operator uploaded to the client's vertical,
whose geometry the vision extractor read and whose `layoutApprovedAt` is set. There are no
built-in compositions: a vertical with no approved template cannot generate at all, and says so
as a `[compose]` failure naming the fix.

**Approval is automatic when the extraction is clean.** Uploading a template approves it there
and then, provided `validateLayoutSpec` found no structural fault — a draft with a fault is
stored unapproved, because `parseLayoutSpec` refuses it at render time and approving it would
put a template in the rotation that never draws. Two paths still leave a template withdrawn and
both are re-reads: the console's *Read layout* button and `layouts:read --all`. A re-read
replaces geometry that is already drawing live posters, with a non-deterministic result, and
that is the case still worth a human.

The cost of this is real and worth stating: nothing now sits between a misread layout and a
client except your own sweep. Run `npm run check:fleet -- ./review` after a batch of uploads,
look at the folder, and withdraw what is wrong. `npm run layouts:approve <vertical>` applies the
same rule retroactively to templates uploaded before it existed.

A calendar row may name its template in `posterTemplateId`, set only by an imported sheet.
Otherwise the vertical's approved templates are walked by `dayNumber` using the smallest stride
above 1 coprime with the set size, so all of them appear before any repeats. The stride is
computed rather than written down: a literal that stops being coprime silently walks a subset
forever, with nothing to catch it.

Nothing writes a pin back on render. Its predecessor `posterArchetype` did, which froze a day's
layout against every later change — approving a new template could never reach a day that had
rendered once.

The last three are derived rather than reverse-engineered from the reference set: `spotlight`
puts a full-bleed photo under an even wash with the copy centred down the frame, `corner` insets
the photo as a tall panel filling the right half of a light field, and `inverted` runs a photo
band across the top 30% with all copy below it.

Derivation is deterministic on purpose. Re-rendering day 47 after a failure must reproduce the
layout the first attempt would have produced, or an operator comparing a retry against the
original sees a difference that isn't there.

**The layout picks each photo's aspect ratio, not the output preset.** A template placing its
photo in a landscape band, asked for a 9:16 portrait and cover-fitted into a short wide box,
discards most of the frame and usually decapitates the subject. A spec may declare up to two
photo cells, and each is a separate billed render. See
[src/lib/poster/photo-request.ts](src/lib/poster/photo-request.ts).

### Clean plates — reproducing a template exactly

The grid path above **rebuilds** a poster from a description of it, so it reproduces band
structure and nothing else. Masks, rounded feature cards, curved footers, gradients and the
reference's own palette are not in the layout vocabulary and are simply lost. Where a client
wants their posters to look like the template they chose, the template needs a **clean plate**.

A plate is the reference exported as a PNG with its own words erased and its photographic areas
made transparent. The renderer then draws three layers — the generated photograph, the plate over
it, the day's type on top — so every treatment survives as pixels because nothing describes it.
See [src/lib/poster/plate-render.tsx](src/lib/poster/plate-render.tsx).

Per template, in the vertical's console:

1. **Erase.** In any image editor, remove every word the client's own copy replaces, and delete
   the photography to transparency. What you leave on the plate is fixed for every client that
   ever draws from it, so a baked-in wordmark must go. Three rules that decide whether a composite
   reads as the template or as two posters on top of each other:
   - **Erase what the renderer redraws.** A feature block is drawn complete — icon, label and any
     sentence — so erase the reference's icons *and* labels but keep the cards they sit in. Same
     for the CTA: the renderer draws the whole button, so erase the reference's pill and leave the
     surface behind it, or the two buttons show as a ring around each other.
   - **Keep what nothing describes.** Card chrome, curves, rules, gradients, the wave over a
     footer: all of it survives untouched, and that is the entire reason for the plate.
   - **Chrome follows the client, ink follows the plate.** Under `Colours: template's` the
     *type* is set in the colours sampled from the reference, but marks the renderer fills —
     the button, the feature icons — still take the client's accent. A template whose button must
     stay its own colour should keep that button as artwork and carry no `cta` region.
2. **Upload plate.** [findPlateHoles](src/lib/poster/plate-regions.ts) measures the transparent
   regions; the count is reported so an export that flattened two holes into one is visible.
3. **Place regions → Read regions from original.** The vision pass in
   [src/lib/ai/plate-extractor.ts](src/lib/ai/plate-extractor.ts) proposes a box per block of
   type, reading the *reference* — the plate no longer has the words on it — and measures each
   block's ink colour from the pixels with
   [sampleRegionInk](src/lib/poster/plate-ink.ts). Drag the boxes onto the artwork, re-sample the
   ink for any box you moved far, and save. A box is the space the copy is *allowed*, not the size
   of the reference's particular words: draw it tight and the client's headline is set two sizes
   smaller.
4. **See it composited**, then **Approve plate**. Approval is its own gate, separate from the
   layout's, because a template can have a sound grid and a plate whose headline box sits across
   somebody's face. Withdrawing it drops the template back to the grid.
5. **Colours: template's** keeps the reference's own palette — normally what a plate wants, since
   it is finished artwork in its designer's colours. The default resolves from the client's brand.

A template still needs an **approved layout spec** as well: `loadCategoryLayouts` filters on
`layoutApprovedAt` before it looks at the plate, and the grid is what a plate falls back to if its
region map ever stops parsing. `npm run layouts:read <vertical>` reads a draft layout for every
template in a vertical that has never had one — it approves nothing.

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

`/api/poster/preview?templateId=…` renders one template's extracted layout — approved or not,
which is what makes it the review surface. `?clientId=…` renders what that client would actually
receive, resolving the layout exactly as the pipeline does. With neither it renders the built-in
sample layout, which is what the brand panel's thumbnail uses. It costs nothing to refresh: the background
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

Because the preset sets the composite canvas and the layout sets the photo requests, no
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
- **Image generation key** (bottom of the dashboard) — point image generation at your own
  fal.ai account instead of the platform's. The key is AES-256-GCM encrypted with
  `SETTINGS_ENCRYPTION_KEY` before it is stored, never returned to the browser, and resolved
  per render — so saving one takes effect on the next generation with no redeploy.
  **While a key is saved, `FAL_KEY` is never used**: a rejected key, an empty balance, or a
  key that will not decrypt each fail the row with a message naming the cause rather than
  quietly billing Evokz. The switch is also **one-way from the console** — a saved key can be
  replaced by another of the operator's own, but only someone with server access can hand
  billing back (DEPLOY_VPS.md §10), so the first save asks for confirmation. **Test key**
  spends one 512×512 render to prove a key works before the 9am sweep does, and does not
  switch anything. Renders on your own key are counted in the spend panel but not costed, and
  they never count toward a client's monthly budget cap.
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

On overwrite, `posterCopy` and `theme` are both cleared — each is *derived from the caption being
replaced*, so keeping either would typeset the old headline, or show the old angle, over new
content. `posterTemplateId` is written unconditionally: the template column is required, so
there is no no-opinion state for a sheet to express.

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
| `npm run check:secret-box` | Fixture suite for the at-rest encryption — no database needed |
| `npm run check:plate` | Compositing, hole detection and ink sampling for the clean-plate path |
| `npm run layouts:read <vertical>` | Read a layout for every template in a vertical that has none, approving the clean ones. One vision call per template |
| `npm run layouts:approve <vertical>` | Approve every stored layout in a vertical that would render. `--dry-run` to preview; never un-approves |
| `npm run check:fleet -- ./review` | Render every stored spec, approved or not, to a folder. The review surface |
| `npm run prisma:push` | Push schema without migrations |
| `npm run prisma:studio` | Browse/seed data |
