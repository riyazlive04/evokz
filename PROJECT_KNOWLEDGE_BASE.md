# Evokz ACE — Project Knowledge Base

> **Superseded 2026-08-23.** The fifteen built-in archetypes were removed; every poster is
> now drawn from a reference template uploaded to the client's vertical and approved by an
> operator. Passages below describing archetypes, `posterArchetype`, the `theme` import
> column or `/admin/poster-preview` are history. See README § Layouts and
> docs/creative-style-spec.md §7.

**Complete handover document.** Everything a new developer needs to understand, run, maintain, debug and continue this codebase without further knowledge transfer.

- **Audit date:** 2026-08-03
- **Repo root (Next.js project root):** `evokz/`
- **Git history:** 1 commit (`c9e4c41` — "Evokz ACE: creative automation console with bulk content import"). There is no meaningful history to bisect against.
- **Verified at audit time:** `tsc --noEmit` → **0 errors**; `next lint` → **0 warnings, 0 errors**.
- **Size:** 79 source files, ~19,500 lines under `src/`.

> **Read [§17 Known Issues](#17-known-issues--technical-debt) before writing any code.** Two findings are blocking: there is **no authentication on the admin console**, and the **`.env` file is in the wrong directory** so no credentials currently load.

---

## Table of contents

1. [Project overview & business goals](#1-project-overview--business-goals)
2. [Tech stack](#2-tech-stack)
3. [Architecture](#3-architecture)
4. [Folder structure](#4-folder-structure)
5. [Database schema](#5-database-schema)
6. [API surface](#6-api-surface)
7. [Server actions (the real mutation API)](#7-server-actions-the-real-mutation-api)
8. [Authentication, authorization & user roles](#8-authentication-authorization--user-roles)
9. [Modules, pages & features](#9-modules-pages--features)
10. [Navigation flow](#10-navigation-flow)
11. [The creative pipeline](#11-the-creative-pipeline)
12. [The poster rendering layer](#12-the-poster-rendering-layer)
13. [The AI/LLM layer](#13-the-aillm-layer)
14. [Integrations](#14-integrations)
15. [Environment variables & configuration](#15-environment-variables--configuration)
16. [Deployment](#16-deployment)
17. [Known issues & technical debt](#17-known-issues--technical-debt)
18. [Implementation status: complete vs pending](#18-implementation-status-complete-vs-pending)
19. [Reusable components & conventions](#19-reusable-components--conventions)
20. [Dependencies](#20-dependencies)
21. [Important files & their purpose](#21-important-files--their-purpose)
22. [Local development & troubleshooting](#22-local-development--troubleshooting)
23. [Onboarding checklist for the new developer](#23-onboarding-checklist-for-the-new-developer)

---

## 1. Project overview & business goals

### What it is

**Evokz ACE (AI Creative Engine)** is a multi-tenant B2B SaaS built for a marketing agency. It automates the entire lifecycle of daily branded social-media creatives for construction and real-estate clients:

> A client pays via Razorpay → the system provisions them → an operator extracts their brand tokens and seeds a content calendar → every day at that client's chosen minute, the system generates a background photo (Flux.1 via fal.ai), composites a fully typeset poster over it, uploads it to an isolated Google Drive folder, and delivers it to the client's WhatsApp via Evolution API.

The agency's staff never touch a design tool. The client receives one finished, on-brand poster per day for the length of their campaign.

### Business goals

| Goal | How the system serves it |
| --- | --- |
| **Zero-touch daily delivery** | Per-client `cronTime` + a 5-minute dispatch sweep. No human in the loop once a calendar is seeded. |
| **Per-client brand fidelity** | Brand tokenizer extracts palette/typography → drives both the image prompts and the poster's rendered theme. |
| **Creatives that look designed, not generated** | The poster layer (§12) composites real vector type over the photo. Diffusion models cannot spell; a wrong phone number delivered daily is a refund. |
| **Unit-economics visibility** | Append-only `UsageEvent` ledger + spend panel showing cost per post, plan margin, and per-client monthly budget alerts. |
| **Sales enablement** | A demo workspace where a prospect's brand is tokenized live and a creative is sent to their WhatsApp in seconds. |
| **Operator escape hatches** | Bulk CSV/JSON calendar import (no LLM spend), manual onboarding, force re-send, regenerate, Drive-folder repair. |

### Who uses it

There is exactly **one human-facing surface**: the internal admin console at `/admin/*`, used by the agency's operations staff. **Clients have no login and never see the app** — they receive WhatsApp messages. This is important context for the auth discussion in §8.

### Origin

The system was scaffolded from `evokz-architecture-blueprint.md` (kept at the repo root for provenance). The implementation deliberately diverges from the blueprint in three places, all documented in-code:

| Blueprint said | Implementation does | Why |
| --- | --- | --- |
| Anthropic Claude 3.5 Sonnet for copy | OpenAI `gpt-4o-mini` | Claude 3.5 Sonnet was retired 2025-10-28 and returns 404. |
| Evolution **Node v2** API (`POST /message/sendMedia/{instance}`, `{media, mediatype}`) | Evolution **GO** (`POST /send/media`, `{url, type}`, no instance path) | The deployed gateway is Evolution GO; the instance is selected by the API key. |
| Exact-minute cron matching | Trailing minute *window* matching | A platform cron firing every 5 minutes only ever observes 1 minute in 5, so exact matching would silently drop ~80% of clients. |

---

## 2. Tech stack

| Layer | Technology | Version |
| --- | --- | --- |
| Framework | Next.js (App Router) | 14.2.35 |
| UI runtime | React | 18.3.1 |
| Language | TypeScript (`strict`, `noUncheckedIndexedAccess`) | ^5.5.4 |
| Styling | Tailwind CSS + CSS custom properties | ^3.4.6 |
| Component primitives | shadcn/ui over Radix UI | dialog/label/select/slot |
| Icons | lucide-react | ^0.414.0 |
| ORM | Prisma | 5.17.0 |
| Database | PostgreSQL | — |
| Validation | Zod | ^3.25.0 |
| LLM | OpenAI SDK (Structured Outputs) | ^6.49.0 |
| Image generation | Flux.1 Schnell via fal.ai REST | — |
| Poster rasterisation | `satori` (JSX → SVG) + `@resvg/resvg-js` (SVG → PNG) | ^0.10.14 / ^2.6.2 |
| Storage | Google Drive API v3 via `googleapis` | ^140.0.1 |
| Messaging | Evolution API (Evolution GO, WhatsApp) | REST |
| Payments | Razorpay webhooks | HMAC-SHA256 |
| Hosting | Vercel (inferred from `vercel.json`) | — |

**Notable absences:** no test framework, no CI configuration, no state-management library (server components + server actions cover it), no auth library, no logging/APM service, no Prisma migrations.

> ⚠️ **The stale global memory index (`MEMORY.md`) describes a completely different project** — React+Vite frontend, Express backend, a 12-stage "AI Brain" pipeline, 440 passing tests, phases 1–12 complete. **None of that matches this repository.** Disregard it; this document is the accurate record.

---

## 3. Architecture

### Shape

This is a **single Next.js application** — no separate backend service. Everything runs in one deployable:

- **Server Components** read from Postgres directly via Prisma and render HTML.
- **Server Actions** (`'use server'`) are the mutation API — called directly from client components, no REST layer.
- **Route Handlers** exist only for the three things that *must* be HTTP endpoints: the Razorpay webhook (external caller), the cron trigger (external scheduler), and the poster preview (consumed by an `<img>` tag).

### System diagram

```
                    ┌──────────────┐
   Razorpay ───────▶│ POST         │
   (order.paid)     │ /api/webhooks│──┐
                    │  /razorpay   │  │
                    └──────────────┘  │
                                      ▼
                              ┌────────────────┐        ┌──────────────┐
   Operator ──▶ /admin/* ────▶│ provisionClient│───────▶│ Google Drive │
   (browser)    (RSC + server │ (lib/onboarding)│        │ client folder│
                 actions)     └────────────────┘        └──────────────┘
                    │                  │
                    │                  ▼
                    │           ┌─────────────┐
                    │           │  PostgreSQL │
                    │           │  (Prisma)   │
                    │           └─────────────┘
                    │                  ▲
                    ▼                  │
        ┌───────────────────────┐      │
        │ generateContentCalendar│─────┤  writes ContentCalendar rows
        │  (OpenAI, batched)     │      │
        └───────────────────────┘      │
        ┌───────────────────────┐      │
        │ applyCalendarImport   │──────┘  (CSV/JSON, no LLM)
        └───────────────────────┘

   Vercel Cron ──▶ GET /api/cron ──▶ executeIntervalDispatch()
   (*/5 * * * *)   (Bearer auth)     │
                                     │  selects clients whose cronTime
                                     │  is in the trailing window
                                     ▼
                          ┌──────────────────────┐
                          │ runCreativePipeline()│  (per calendar row,
                          │  lib/ai-pipeline.ts  │   ≤4 concurrent)
                          └──────────────────────┘
                                     │
       ┌─────────────┬───────────────┼───────────────┬──────────────┐
       ▼             ▼               ▼               ▼              ▼
   fal.ai        ensurePosterCopy  renderPoster   Drive upload   Evolution
   (Flux.1       (OpenAI, only     (satori +      (+ publish     (WhatsApp
    photo)        if missing)       resvg)         link-readable) send)
       │                              │               │              │
       └──── UsageEvent ledger ───────┴───────────────┴──────────────┘
```

### Key architectural decisions (and why)

1. **`ContentCalendar` is the pipeline's fuel.** The dispatcher only delivers rows that already exist. A client with no calendar delivers nothing, forever, silently. The client matrix flags any client whose seeded days are fewer than its plan duration.

2. **`GENERATED` is a real checkpoint, not a cosmetic status.** Once the asset is in Drive, the row is marked `GENERATED` *before* the WhatsApp send. A broadcast failure is retried by reusing `gDriveFileId` — no re-billing of fal.ai.

3. **The sweep is awaited, not detached.** A serverless invocation is torn down the moment its handler resolves, so fire-and-forget dispatch would silently kill in-flight generations. `executeIntervalDispatch` awaits everything (`lib/cron-worker.ts:93`).

4. **Every server action returns a discriminated `ActionResult`, never throws.** An unhandled server-action rejection reaches the browser as an opaque digest, which is useless to an operator staring at a failed row.

5. **All time arithmetic goes through an explicit IANA zone.** A container runs in UTC but `Client.cronTime` is wall-clock intent. `lib/time.ts` never touches the host locale.

6. **Two sizes exist and they are not the same thing.** The *output canvas* (`Client.imageSizePreset`) sizes the delivered composite. The *background photo* size comes from the **archetype**, not the preset — because each archetype gives the photo a differently shaped region.

7. **The spend ledger is append-only.** Rows are never updated, so the ledger stays a faithful record of what was spent even as rates change. Costs are stored as USD micros (integers) to avoid float drift across millions of summed rows.

---

## 4. Folder structure

```
Documents/Evokz/
├── .env                          ⚠️ WRONG LOCATION — see §17.2
├── package-lock.json             (stub, ignore)
└── evokz/                        ← the actual Next.js project root
    ├── .env.example              Fully documented template (6.9 KB)
    ├── .eslintrc.json            extends next/core-web-vitals
    ├── README.md                 Excellent 380-line operator/dev guide
    ├── evokz-architecture-blueprint.md   Original scaffold spec (provenance)
    ├── evokz-home.png            Design reference screenshot
    ├── components.json           shadcn/ui config
    ├── next.config.mjs           serverComponentsExternalPackages
    ├── postcss.config.mjs
    ├── tailwind.config.ts        Brand tokens + micro-3D plugin
    ├── tsconfig.json             strict + noUncheckedIndexedAccess
    ├── vercel.json               Cron schedule + function maxDurations
    ├── docs/
    │   └── creative-style-spec.md    ★ The layout bible (226 lines)
    ├── prisma/
    │   └── schema.prisma             4 models, 2 enums. NO migrations dir.
    └── src/
        ├── app/
        │   ├── layout.tsx             Root shell, Inter font
        │   ├── globals.css            CSS custom properties (design tokens)
        │   ├── page.tsx               redirect → /admin/dashboard
        │   ├── admin/
        │   │   ├── layout.tsx         Console chrome + AdminNav
        │   │   ├── dashboard/
        │   │   │   ├── page.tsx       Ops overview, counters, queue, spend
        │   │   │   └── actions.ts     ★ ALL server actions (894 lines)
        │   │   ├── clients/
        │   │   │   ├── page.tsx       Client matrix
        │   │   │   └── [clientId]/
        │   │   │       ├── page.tsx   Client detail + bulk import
        │   │   │       └── brand/page.tsx   Brand canvas
        │   │   ├── plans/page.tsx     Plan CRUD
        │   │   ├── verticals/page.tsx Category CRUD
        │   │   ├── demo/page.tsx      Sales demo workspace
        │   │   └── poster-preview/page.tsx   Layout regression surface
        │   └── api/
        │       ├── cron/route.ts              GET/POST, Bearer-authed
        │       ├── poster/preview/route.ts    GET → image/png
        │       └── webhooks/razorpay/route.ts POST, HMAC-verified
        ├── components/
        │   ├── admin/       17 console components
        │   ├── brand/       3 brand-canvas components
        │   └── ui/          8 shadcn primitives
        ├── hooks/
        │   └── use-action.ts   Server-action pending/error wrapper
        └── lib/
            ├── ai-pipeline.ts      ★ The orchestrator (701 lines)
            ├── cron-worker.ts      Dispatch sweep
            ├── onboarding.ts       Shared provisioning
            ├── google-drive.ts     Drive v3 client
            ├── calendar-import.ts  Bulk import writer
            ├── calendar-parse.ts   ★ Isomorphic sheet parser (1077 lines)
            ├── cost-report.ts      Spend aggregation
            ├── pricing.ts          Rate card + money formatting
            ├── usage.ts            Ledger writers
            ├── queue-entry.ts      Shared ContentCalendar projection
            ├── image-sizes.ts      Output-size catalogue (33 presets)
            ├── env.ts              Lazy typed env access
            ├── time.ts             Timezone-correct helpers
            ├── prisma.ts           Singleton client
            ├── utils.ts            cn()
            ├── ai/
            │   ├── openai.ts           Structured-Outputs wrapper
            │   ├── calendar-generator.ts  Batched calendar seeding
            │   ├── brand-tokenizer.ts     Brand → design tokens
            │   ├── poster-copy.ts         Single-day backfill
            │   └── poster-prompt.ts       Shared copy contract
            ├── poster/
            │   ├── render.tsx          Entry point (satori + resvg)
            │   ├── archetypes.tsx      ★ 8 layouts (1456 lines)
            │   ├── slots.tsx           ★ Slot components (757 lines)
            │   ├── theme.ts            Brand tokens → PosterTheme
            │   ├── metrics.ts          Spec px → canvas px
            │   ├── color.ts            Contrast maths
            │   ├── fonts.ts            Font byte loading
            │   ├── icons.tsx           16 monoline icons
            │   ├── image-info.ts       PNG/JPEG/WebP/GIF/SVG dimension reader
            │   ├── photo-request.ts    Archetype → fal.ai render size
            │   └── placeholder-photo.ts  Procedural photo for previews
            └── types/
                ├── brand.ts      BrandGuideline schema + parser
                └── poster.ts     ★ PosterCopy/Theme/Spec + archetypes
```

---

## 5. Database schema

**File:** `prisma/schema.prisma` · **Provider:** PostgreSQL · **Client:** `prisma-client-js`

### Enums

```prisma
enum DeliveryStatus { PENDING  GENERATED  DELIVERED  FAILED }

enum UsageProvider {
  OPENAI     // Copy + brand tokenizer, billed per token
  FAL        // Flux.1 image synthesis, billed per image
  EVOLUTION  // WhatsApp broadcast, billed per message (often self-hosted, ₹0)
}
```

### `Plan`

Campaign packages. Duration drives each client's `endDate` at onboarding and caps how many `ContentCalendar` days can be seeded.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `String @id @default(uuid())` | |
| `name` | `String` | e.g. "100-Day Blitz" |
| `durationDays` | `Int` | 1–3650, validated in the action |
| `priceInr` | `Int?` | **Full-campaign** fee, not monthly. `null` = "not priced yet" → margin reads *unknown*, not zero. |
| `createdAt` / `updatedAt` | `DateTime` | |
| `clients` | `Client[]` | `onDelete: Restrict` from the Client side |

### `Category` (called "Vertical" in the UI)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `String @id @default(uuid())` | |
| `name` | `String` | e.g. "Real Estate", "Heavy Construction" |
| `createdAt` / `updatedAt` | `DateTime` | |
| `clients` | `Client[]` | `onDelete: Restrict` |

### `Client` (the tenant)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `String @id @default(uuid())` | |
| `companyName` | `String` | Also the Drive folder name |
| `whatsappNumber` | `String` | E.164 **without** `+`, e.g. `919876543210`. **Not unique.** |
| `cronTime` | `String @default("09:00")` | Per-client delivery minute, `HH:MM`, 24-hour |
| `startDate` / `endDate` | `DateTime` | Campaign window, computed from plan duration |
| `isActive` | `Boolean @default(true)` | Pause/resume; the sweep skips inactive |
| `isDemo` | `Boolean @default(false)` | Sales-demo tenant — **skipped by the dispatch sweep** |
| `monthlyBudgetInr` | `Int?` | Spend cap for the calendar month. `null` disables the alert (≠ ₹0 cap). |
| `brandGuideline` | `Json?` | Design tokens. **Rewritten wholesale** by the tokenizer. |
| `gDriveFolderId` | `String?` | Isolated Drive subfolder. `null` = onboarding half-failed → repairable. |
| `imageSizePreset` | `String?` | Preset id from `lib/image-sizes.ts`. **Deliberately a String, not an enum** — the catalogue is presentation data that gains entries whenever a platform changes its spec, and each addition would otherwise need a migration. `null` → fleet default. |
| `logoUrl` | `String?` | Fetchable image URL for the poster's logo lockup |
| `logoDriveFileId` | `String?` | Set only when *we* host the file, so a re-upload can trash the previous one |
| `brandTagline` | `String?` | Letterspaced caps line under the logo, ≤60 chars |
| `websiteUrl` | `String?` | Contact bar, right cell |
| `displayPhone` | `String?` | Contact bar, left cell. **Rendered verbatim.** Falls back to a formatted `whatsappNumber`. |
| `planId` / `categoryId` | `String` | `onDelete: Restrict` — a plan/vertical in use cannot be deleted |
| `createdAt` / `updatedAt` | `DateTime` | |

**Index:** `@@index([cronTime, isActive])` — drives the per-minute dispatch sweep.

> **Why poster identity lives in real columns, not `brandGuideline`:** the brand tokenizer *rewrites that JSON column wholesale*. An operator-uploaded logo has to survive a re-extraction, so it cannot live inside the column that gets replaced.

### `ContentCalendar` (one campaign day)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `String @id @default(uuid())` | |
| `clientId` | `String` | `onDelete: Cascade` |
| `dayNumber` | `Int` | 1..`plan.durationDays` (demo instant-sends append past the end) |
| `scheduledDate` | `DateTime` | Day 1 = campaign start. Computed with `addZonedDays` (DST-safe). |
| `theme` | `String` | 2–5 word content angle |
| `caption` | `String @db.Text` | The WhatsApp message body, 40–90 words |
| `hashtags` | `String` | Space-separated, normalised |
| `imagePrompt` | `String @db.Text` | **Background photo only** — never contains text instructions |
| `posterCopy` | `Json?` | Slot content, validated by `posterCopySchema`. `null` → `ensurePosterCopy` backfills at render time. |
| `posterArchetype` | `String?` | Layout pin. `null` → derived deterministically from `dayNumber`. |
| `gDriveFileId` | `String?` | Storage reference |
| `gDriveViewUrl` | `String?` | Direct-download link handed to Evolution API |
| `deliveryStatus` | `DeliveryStatus @default(PENDING)` | |
| `errorMessage` | `String? @db.Text` | `[stage] message`, secrets redacted, capped at 4000 chars |
| `createdAt` / `updatedAt` | `DateTime` | |

**Constraints:** `@@unique([clientId, dayNumber])` (backs `skipDuplicates` on concurrent seeds/imports) · `@@index([scheduledDate, deliveryStatus])` (dispatch window scanning).

### `UsageEvent` (append-only spend ledger)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `String @id @default(uuid())` | |
| `clientId` | `String?` | **`onDelete: SetNull`** — money spent on a since-removed client still counts toward the agency total and must not disappear |
| `calendarId` | `String?` | **Deliberately not a relation** — deleting a failed calendar entry must not erase its cost |
| `provider` | `UsageProvider` | |
| `operation` | `String` | `calendar` \| `brand-tokenizer` \| `image` \| `poster-copy` \| `whatsapp` |
| `model` | `String?` | e.g. `gpt-4o-mini`, `fal-ai/flux/schnell` |
| `inputTokens` / `cachedTokens` / `outputTokens` | `Int @default(0)` | `cachedTokens` is a **subset** of `inputTokens` |
| `imageCount` / `messageCount` | `Int @default(0)` | |
| `costUsdMicros` | `Int @default(0)` | USD millionths, priced at the rates in force when recorded |
| `backfilled` | `Boolean @default(false)` | ⚠️ **Nothing writes `true`** — see §17.4 |
| `createdAt` | `DateTime @default(now())` | |

**Indexes:** `[clientId, createdAt]` (hottest query) · `[provider, createdAt]` · `[createdAt]`.

### Entity relationships

```
Plan  1 ──── N  Client  1 ──── N  ContentCalendar
                  │                     (Cascade delete)
Category 1 ─── N ─┘
                  │
                  1 ──── N  UsageEvent   (SetNull on client delete)
```

### Migration strategy

⚠️ **There is no `prisma/migrations/` directory.** The workflow is `prisma db push` (`npm run prisma:push`). This means:
- No migration history, no rollback, no reproducible schema evolution.
- `npm run prisma:migrate` exists in `package.json` but has never been run.
- **Before the first production deploy**, baseline the schema with `prisma migrate dev --name init` and switch to `prisma migrate deploy` in CI. See §17.7.

---

## 6. API surface

Only **three HTTP route handlers** exist. Everything else is a Server Action (§7).

### `POST /api/webhooks/razorpay`

**File:** `src/app/api/webhooks/razorpay/route.ts` · `runtime = 'nodejs'` · `dynamic = 'force-dynamic'` · `maxDuration: 60`

Provisions a client on payment.

**Security:** HMAC-SHA256 of the **raw request body** against `RAZORPAY_WEBHOOK_SECRET`, compared with `crypto.timingSafeEqual`. The raw body is read via `request.text()` — any parse-then-restringify round trip changes byte order and breaks the HMAC. Length is guarded before the timing-safe compare (which throws on mismatched lengths).

**Event handling:** only `order.paid` is processed. Any other event returns `200 {ok, ignored}` so Razorpay stops redelivering.

**Expected `notes` keys** (set at order creation; both snake_case and camelCase accepted):

| Note key | Aliases | Required | Purpose |
| --- | --- | --- | --- |
| `company_name` | `companyName` | ✅ | Client display name + Drive folder name |
| `whatsapp_phone` | `whatsappPhone`, `phone_number`, `phoneNumber`, `whatsapp_number` | ✅ | Delivery target, international digits |
| `plan_id` | `planId` | ✅ | Existing `Plan.id` (UUID) |
| `category_id` | `categoryId` | ✅ | Existing `Category.id` (UUID) |
| `preferred_cron_time` | `cron_time`, `cronTime` | ❌ | `HH:MM`, defaults `09:00` |
| `image_size` | `imageSize`, `image_size_preset`, `imageSizePreset` | ❌ | ⚠️ **Parsed but never applied — see §17.3** |

**Response codes:**

| Code | Meaning | Retry? |
| --- | --- | --- |
| `200` | Provisioned, or event ignored | — |
| `400` | Missing/invalid signature, or malformed JSON | No — deliberately opaque, an unauthenticated caller learns nothing |
| `422` | Valid signature but unusable notes | No — this is a checkout-integration bug worth surfacing in the Razorpay dashboard |
| `500` | Secret unconfigured, or transient DB fault | Yes — provisioning is idempotent |

**Idempotency:** `provisionClient` deduplicates on `(whatsappNumber, planId, endDate >= now, isDemo)`. Razorpay redelivers `order.paid` on any non-2xx and on manual replay, so this matters.

**Resilience:** if Google Drive folder creation fails, the client row is **still written** and `driveWarning` is returned. A third-party outage must not lose a paying customer; the folder is repairable from the console.

### `GET | POST /api/cron`

**File:** `src/app/api/cron/route.ts` · `runtime = 'nodejs'` · `maxDuration = 300`

Triggers `executeIntervalDispatch()`.

**Auth:** `Authorization: Bearer $CRON_SECRET`, or `?token=$CRON_SECRET` as a fallback for schedulers that cannot set headers. **Fails closed** — an unset `CRON_SECRET` returns `401` for everyone rather than exposing the dispatcher.

**Response (200):**
```json
{
  "ok": true,
  "ranAt": "2026-08-03T09:00:12.000Z",
  "timeZone": "Asia/Kolkata",
  "minuteWindow": ["09:00","08:59","08:58","08:57","08:56"],
  "matchedClients": 3,
  "queuedItems": 3,
  "delivered": 2, "failed": 1, "skipped": 0,
  "items": [{ "calendarId":"…", "companyName":"…", "dayNumber":42,
              "status":"FAILED", "stage":"broadcast", "error":"…" }]
}
```

`500 {ok:false, error:"Dispatch sweep failed"}` on a sweep-level fault (DB unreachable, bad timezone config) — internals are logged, not leaked.

**Curl:**
```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://your-app/api/cron
```

### `GET /api/poster/preview`

**File:** `src/app/api/poster/preview/route.ts` · `runtime = 'nodejs'`

Renders one poster as `image/png`. Costs nothing: the background photo is generated procedurally by `placeholder-photo.ts`, so no fal.ai / Drive / WhatsApp call is made. Everything downstream of the photo is the exact production path.

| Query param | Values | Default |
| --- | --- | --- |
| `archetype` | Any of the 15 ids in `POSTER_ARCHETYPES` — the eight bases (`scrim`, `diagonal`, `bands`, `curve`, `editorial`, `spotlight`, `corner`, `inverted`) plus `scrim-mirror`, `diagonal-mirror`, `curve-mirror`, `editorial-mirror`, `corner-mirror`, `spotlight-centred`, `bands-photo-top`. Note the day-number rotation only ever picks `scrim`, `bands`, `spotlight`, `inverted` — the rest need a sheet pin or a template mapping. | `scrim` |
| `preset` | Any `IMAGE_SIZE_PRESETS` id | `whatsapp-status` |
| `clientId` | UUID — renders with a real client's brand, logo, contact details | none (sample) |
| `day` | Calendar day whose stored `posterCopy` to use (with `clientId`) | sample copy |
| `tone` | `dusk` \| `daylight` | `dusk` |
| `debug` | `1` → appends the stack trace to the error body | off |

**Response headers:** `X-Poster-Archetype`, `X-Poster-Dropped` (comma-separated slots the canvas could not carry, or `none`). `Cache-Control: no-store` — the whole point is to reflect current code.

**Errors** return `500` as `text/plain` (readable in the network panel when an `<img>` breaks), not JSON.

⚠️ **This endpoint is unauthenticated and performs a full CPU-bound satori+resvg render.** With `clientId` it also exposes a client's company name, phone, website and logo. See §17.1.

---

## 7. Server actions (the real mutation API)

**All 19 server actions live in one file:** `src/app/admin/dashboard/actions.ts` (894 lines).

### The contract

```ts
export type ActionResult<T = undefined> =
  | { ok: true;  data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };
```

Every action returns this shape and **never throws**. `toFailure(error, context)` maps thrown errors to operator-readable copy, including Prisma constraint codes:

| Prisma code | Message |
| --- | --- |
| `P2002` | "That record already exists." |
| `P2003` | "Cannot delete: clients are still attached to this record." |
| `P2025` | "That record no longer exists." |

Zod errors surface the first field message plus the full `fieldErrors` map.

Every mutating action calls `revalidateAdmin()` → `revalidatePath('/admin', 'layout')`. Scoped to the whole console because a mutated record is visible from several sections at once (a plan on `/admin/plans`, its client count on `/admin/clients`).

### Complete action inventory

| # | Action | Signature | Validation | Notes |
| --- | --- | --- | --- | --- |
| 1 | `createPlan` | `(PlanInput)` | name 2–120; duration int 1–3650; price int 0–100M nullable | |
| 2 | `updatePlan` | `(id, PlanInput)` | + id uuid | |
| 3 | `deletePlan` | `(id)` | id uuid | **Pre-checks client count** so the operator sees *how many* block the delete, rather than a bare P2003 |
| 4 | `createCategory` | `(CategoryInput)` | name 2–120 | |
| 5 | `updateCategory` | `(id, CategoryInput)` | + id uuid | |
| 6 | `deleteCategory` | `(id)` | id uuid | Same pre-check |
| 7 | `updateClientCronTime` | `(clientId, cronTime)` | `HH_MM_PATTERN` = `/^([01]\d\|2[0-3]):([0-5]\d)$/` | |
| 8 | `updateClientBudget` | `(clientId, number \| null)` | int 0–100M nullable | `null` clears the alert (≠ ₹0 cap) |
| 9 | `updateClientImageSize` | `(clientId, presetId \| null)` | `isImageSizePresetId` | Applies **from the next render only**; past days keep their asset |
| 10 | `setClientActive` | `(clientId, boolean)` | boolean | Pause/resume |
| 11 | `createClientManually` | `(ClientProvisionInput)` | `clientProvisionSchema` | Runs the exact same `provisionClient` the webhook uses |
| 12 | `repairDriveFolder` | `(clientId)` | uuid | Retro-provisions a folder for a half-failed onboarding |
| 13 | `forceResendCreative` | `(calendarId)` | uuid | `{reuseExistingAsset: true, allowRedelivery: true}` — cheap re-send |
| 14 | `regenerateCreative` | `(calendarId)` | uuid | `{reuseExistingAsset: false}` — **re-bills fal.ai** |
| 15 | `deleteCalendarEntry` | `(calendarId)` | uuid | Frees the `dayNumber` for re-seeding. Drive asset is left in place. |
| 16 | `runDemoCreativeNow` | `(clientId, DemoCreativeInput)` | theme 2–120; caption 10–2000; hashtags ≤400; imagePrompt 10–2000 | **Refuses on a non-demo client.** Appends after the last `dayNumber`. |
| 17 | `extractBrandGuideline` | `(clientId, sourceMaterial)` | ≥40 chars | Surfaces the underlying error message (missing key vs refusal vs thin material) |
| 18 | `seedContentCalendar` | `(clientId, limit?)` | limit int 1–365 | **The expensive call.** Sequential batches. |
| 19 | `importCalendarEntries` | `(clientId, CalendarImportInput)` | Full re-parse server-side | Never trusts the browser's day map |
| 20 | `updateClientPosterIdentity` | `(clientId, PosterIdentityInput)` | tagline ≤60; website ≤120 + domain regex; phone ≤32 + `/^[+0-9()\s-]{6,}$/` | Empty strings → `null` |
| 21 | `uploadClientLogo` | `(clientId, FormData)` | PNG/JPEG/WebP/SVG; ≤4 MB; Drive folder must exist | Trashes the superseded file **after** the row update |
| 22 | `setClientLogoUrl` | `(clientId, url \| null)` | `/^https?:\/\/\S+$/i`, ≤2048 | Clears `logoDriveFileId` too, so a later re-upload can't trash an unrelated file |

### Notable action behaviours

**`runDemoCreativeNow` guard chain** (`actions.ts:437`): client exists → `isDemo` is true → `gDriveFolderId` exists → append `dayNumber = last + 1` → create row → run pipeline with `allowRedelivery`. On failure the row is **deliberately left behind** because it carries the stage and error message, and its card offers re-send/regenerate/delete.

**`uploadClientLogo` ordering** (`actions.ts:815`): the DB row is updated *before* the old Drive file is trashed, so a failure at the trash step cannot leave the client pointing at a file that has just been binned.

**`importCalendarEntries` rejection reporting** (`actions.ts:648`): when every row bounces, `describeImportRejection` names the specific reason — "already seeded" and "past the plan duration" call for completely different fixes.

---

## 8. Authentication, authorization & user roles

### Current state: **there is none.**

This section is short because there is nothing to document, and that is itself the most important fact in this file.

- ❌ No `middleware.ts` anywhere in the repo (verified by filesystem search).
- ❌ No auth library (`next-auth`, `clerk`, `lucia`, …) in `package.json`.
- ❌ No session, cookie, token or password handling in any source file.
- ❌ No `User`, `Account`, `Session` or `Role` model in `schema.prisma`.
- ❌ No route guard, no `redirect('/login')`, no layout-level check.

**Every `/admin/*` page is publicly reachable by anyone who knows the URL.** `src/app/page.tsx` redirects `/` straight to `/admin/dashboard`, so the console is the site's landing page.

### Why this is worse than "just an unprotected admin panel"

Next.js Server Actions compile to POST endpoints identified by an action ID that is **embedded in the JavaScript bundle served to every visitor**. Because `/admin/*` is public, any visitor can read those IDs and invoke every action in §7 directly. An unauthenticated attacker can:

| Action | Consequence |
| --- | --- |
| `seedContentCalendar` | Burns OpenAI spend — up to 365 days × sequential LLM batches per call |
| `regenerateCreative` / `runDemoCreativeNow` | Burns fal.ai spend and **sends WhatsApp messages to real client numbers** |
| `deletePlan` / `deleteCategory` / `deleteCalendarEntry` | Destroys configuration and campaign days |
| `createClientManually` | Creates tenants and Drive folders |
| `uploadClientLogo` | Writes arbitrary ≤4 MB files into the agency's Google Drive vault |
| `setClientActive` | Silently pauses every paying client's campaign |

Plus data exposure: the dashboard lists every client, their WhatsApp numbers, spend, and margins. `/api/poster/preview?clientId=…` renders a client's brand identity into a PNG without any check.

### The two things that *are* authenticated

| Surface | Mechanism | Quality |
| --- | --- | --- |
| `/api/webhooks/razorpay` | HMAC-SHA256 over raw body, `timingSafeEqual` | ✅ Correct |
| `/api/cron` | `Bearer $CRON_SECRET` (or `?token=`), fails closed | ✅ Adequate |

### Roles

There is **one implicit role: "operator"** — anyone with network access to the app. There is no role model, no permission check, and no per-user attribution of any action.

The only authorization-shaped logic in the codebase is a **tenant-kind guard**, not a user guard:

```ts
// actions.ts:458 — runDemoCreativeNow
if (!client.isDemo) return failure('Instant sends are restricted to demo tenants.');
```

...and its dispatch-side counterpart:

```ts
// cron-worker.ts:54 — executeIntervalDispatch
isDemo: false,   // demo tenants are driven by hand; the sweep must never
                 // WhatsApp a prospect's number unattended
```

### Recommended remediation (in priority order)

1. **Immediately:** put the deployment behind Vercel Password Protection or an IP allowlist. This is a one-setting change and closes the hole today.
2. **Short term:** add `src/middleware.ts` matching `/admin/:path*` and `/api/poster/preview`, validating a signed session cookie. Even a single shared password backed by an HTTP-only signed cookie is a vast improvement.
3. **Proper:** add NextAuth (or Auth.js) with a `User` model and an `OPERATOR` / `ADMIN` role split — `ADMIN` for plan/vertical/client deletion and budget changes, `OPERATOR` for day-to-day queue work.
4. **Regardless of which:** re-verify inside each destructive server action. Middleware protects page loads and route handlers, but defence in depth matters when the action IDs are public.

---

## 9. Modules, pages & features

### 9.1 Dashboard — `/admin/dashboard`

**Files:** `page.tsx` (508 lines) · `actions.ts` · `SpendPanel` · `QueueLedger` · `ClientRoster` · `StatTile` · `SystemNotices`

The live operational console. `dynamic = 'force-dynamic'` — never cached.

**Layout, top to bottom:**

1. **Config warning banner** — `findUnsetIntegrationKeys()` lists any unset credential **by name only, never value**, so a config gap is distinguishable from a code bug at a glance. Checks: `DATABASE_URL`, `OPENAI_API_KEY`, `RAZORPAY_WEBHOOK_SECRET`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_DRIVE_PARENT_FOLDER_ID`, `FAL_KEY`, `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `CRON_SECRET`.

2. **Four counter tiles** — Active clients / Due today / Delivered / Failed. Each is a link that toggles `?view=` to open a drill-down panel below it. `spendParams()` preserves the spend-panel filters so toggling a counter doesn't reset them.

3. **Drill-down panel** (only when `?view=` is set) — loads at most 60 rows and reports `Showing the first N of M` when truncated. `loadDetail` only runs when a tile is expanded, so the default dashboard keeps its original query cost.

4. **Spend panel** — see §9.7.

5. **Failed deliveries** (suppressed while the `failed` drill-down is open, to avoid showing the same rows twice) — most recent 8, with the persisted `errorMessage` inline.

6. **Event queue feed** — next 24 scheduled entries across all clients, previewed from Drive thumbnails.

**Data loading:** one `Promise.all` of 6 queries (`loadDashboardData`), plus a parallel `loadCostReport`. A thrown error renders `<DatabaseErrorState>` rather than a Next.js error page.

**User flow:** operator opens the console → sees failures first (they need a human) → clicks a failed card's **Send now** (reuses Drive asset) or **Regenerate** (re-bills fal.ai) or **Delete** (two-step confirm, auto-disarms after 6 s).

### 9.2 Client matrix — `/admin/clients`

**Files:** `page.tsx` · `ClientMatrix.tsx` (393 lines) · `CreateClientDialog.tsx` (274 lines)

Lists every **non-demo** client (`where: { isDemo: false }` — mixing demo tenants in would put a prospect's throwaway record next to paying campaigns). Ordered live-first, then newest.

**Per row:** company name (links to detail), WhatsApp, plan, vertical, `cronTime` (inline-editable — **Enter commits, Escape reverts**), campaign window, active badge, Drive-folder status, delivered count, calendar coverage.

**Calendar-coverage flag:** when `calendarCount < totalDays` the row surfaces a **Generate N days** button (`SeedCalendarButton`). This is the safety net for the system's biggest silent failure mode — a client with no calendar delivers nothing forever.

**Manual onboarding dialog** (`CreateClientDialog`): company name, WhatsApp, plan, vertical, delivery time, output-size preset (pre-selected to `whatsapp-status`, because *the spec-correct shape should be what an operator has to deliberately move away from, not what they have to find*). The trigger button is disabled with a tooltip when no plan or vertical exists yet. On a `driveWarning` the dialog **stays open** so the operator sees why.

### 9.3 Client detail — `/admin/clients/[clientId]`

**File:** `page.tsx` (474 lines)

Guards a malformed id with a `UUID_PATTERN` test → `notFound()`, because an invalid uuid literal reaching Postgres surfaces as a 500 rather than a 404.

**Sections:**

1. **Four delivery counters** — Delivered / Pending / Generated / Failed.
2. **Tenant record** — WhatsApp, plan, vertical, delivery minute, campaign start/end, output size (with a `· soft photo` warning when `photoIsUpscaledAt`), Drive folder id, poster-logo status, contact bar, brand-token swatches.
3. **Operations** — delivery-progress bar (`DELIVERED / plan.durationDays`), `ClientControls`, and the seed button when coverage is incomplete.
4. **Bulk content import** — see §9.8.
5. **Failed deliveries** (if any).
6. **Calendar timeline** — next 24 entries from today; if the campaign is over, falls back to the most recent 24 so the page is never empty.

**`ClientControls`** exposes 5 mutations: delivery time (Enter/Escape), pause/resume, monthly spend cap (blank = no cap), Drive-folder repair (only shown when missing), and creative output size. Each has its own dirty-state, save button, revert button, and a 2-second "Saved" flash.

### 9.4 Brand canvas — `/admin/clients/[clientId]/brand`

**Files:** `page.tsx` · `BrandCanvasView.tsx` (780 lines) · `PosterIdentityPanel.tsx` (360) · `BrandTokenizerPanel.tsx` (112)

Three stacked panels:

1. **`BrandCanvasView`** — a Figma-style dark workspace rendering the extracted `brandGuideline`: colour swatches with roles, typography specimens, layout directives, asset ledger. Uses the micro-3D Tailwind utilities (`perspective-1000`, `rotate-x-*`) registered in `tailwind.config.ts`.

2. **`PosterIdentityPanel`** — edits the four identity fields the renderer composites onto every creative. Logo can be **uploaded** (lands in the client's Drive folder, published link-readable) or **pointed at an external URL**. The URL is *not* fetched on save — a link that 404s degrades to the wordmark lockup at render time, and blocking on a reachability check would reject perfectly good URLs that are momentarily down.

3. **`BrandTokenizerPanel`** — a textarea for site copy / scrape output / positioning notes (≥40 chars), and an **Extract design tokens** button.

> **Order matters.** Extract brand tokens *before* seeding a calendar. The calendar generator folds the palette, typography and layout directives into every `imagePrompt`; seeding first produces generic creatives.

### 9.5 Plan manager — `/admin/plans`

**Files:** `page.tsx` · `PlanManager.tsx` (384 lines)

Full CRUD. Each row shows name, `durationDays`, `priceInr` (blank = unpriced), and the attached client count. Deletes are blocked while clients reference the plan, and the console reports how many.

`durationDays` is load-bearing: it sets each client's `endDate` at onboarding and caps how many calendar days can be seeded. `priceInr` is the **full-campaign** fee and feeds the margin column on the spend panel.

### 9.6 Vertical manager — `/admin/verticals`

**Files:** `page.tsx` · `CategoryManager.tsx` (195 lines)

Full CRUD over `Category`. Each client is bound to exactly one vertical, which feeds both the image-prompt and copy stages (`Industry: ${category.name}` in the system prefix).

### 9.7 Spend panel (component on the dashboard)

**Files:** `SpendPanel.tsx` (550 lines) · `lib/cost-report.ts` (343 lines) · `lib/pricing.ts` (123 lines)

Aggregates the `UsageEvent` ledger via **grouped SQL sums**, never by loading rows into memory — so it stays cheap as the ledger grows past millions of rows.

**Filters (URL params):** `range` (`7d` \| `30d` \| `90d` \| `mtd` \| `all`, default `30d`) · `spendClient` · `spendProvider`.

**Per-client columns:** spend (₹), delivered posts, cost per post, plan fee, margin ₹ and %, current-month spend vs cap, budget-used %.

Two details worth knowing:

- **Budget alerts always measure the calendar month**, whatever range is displayed — so switching to "Last 7 days" cannot make an over-budget client look fine (`cost-report.ts:216`).
- **Orphaned spend is preserved.** A `UsageEvent` whose client row was removed appears as a synthetic **"Removed clients"** row so it still counts toward the agency total.

**Pricing model** (`pricing.ts`): `cachedTokens` is a *subset* of `inputTokens` in OpenAI's accounting, so the uncached remainder is billed at the full rate and the cached portion at the discounted one. Treating them as separate additive buckets would over-bill every cached call. All costs are integer USD micros. The panel prints the rate card it used, so a mismatch with the real invoice is visible rather than silent.

### 9.8 Bulk content import (component on client detail)

**Files:** `CalendarImportPanel.tsx` (672 lines) · `lib/calendar-parse.ts` (1077) · `lib/calendar-import.ts` (317)

Loads a hand-authored calendar instead of generating one. **No OpenAI call → no spend, no sequential-batch wait.**

**Accepts:** CSV, TSV, semicolon-delimited, or a JSON array. BOM-stripped (Excel and Google Sheets both prepend one). Capped at **400 rows** and **1 MB**.

**Column matching is by alias**, in any order — `image prompt`, `Image_Prompt`, `prompt`, `visual prompt`, `photo brief` all resolve to `imagePrompt`. Headers are normalised by lowercasing and stripping non-alphanumerics.

| Column | Required | Notes |
| --- | --- | --- |
| `theme` | ✅ | 2–120 chars |
| `caption` | ✅ | 10–2000 chars — the WhatsApp message body |
| `image prompt` | ✅ | 10–2000 chars — background photo only |
| `day` | ❌ | **Blank = append.** Takes the lowest campaign day not already written, and never a day an explicitly-numbered row in the same file asked for. |
| `hashtags` | ❌ | ≤400 chars |

**Poster columns (all optional, but all-or-nothing per row):** `headline` (2–4 lines separated by `\|`), `accent line` (1-based in the sheet, stored 0-based; blank → line 2), `eyebrow`, `poster body` (12–30 words), `feature N icon/label/body` (2–4 features), `call label`, `website label`, `headline period` (yes/no), `archetype`.

> **Why all-or-nothing:** touch any one poster cell and that row must supply a complete block. A half-filled poster cannot be rendered, and silently falling back to generation would hide the operator's typo behind a plausible-looking result. Likewise an unknown icon name is **reported**, not swapped for `shieldCheck` — an icon contradicting its own label is worse than being told to fix the spelling. Over-length cells are reported rather than truncated at a word boundary, which is what `coercePosterCopy` would otherwise do to deliberate wording.

**Two conflict modes:**

| Mode | Behaviour |
| --- | --- |
| **Keep** (`skip`) | Skips any day that already has a row |
| **Overwrite** | Replaces copy on `PENDING` and `FAILED` days only → resets to `PENDING`, clears `errorMessage`, **and clears `gDriveFileId`/`gDriveViewUrl`** |

`GENERATED` and `DELIVERED` days are **never** rewritten; the panel labels them **Locked**.

> **Why overwrite clears the Drive references:** a `FAILED` row can be holding an image rendered from the *old* prompt (upload succeeded, broadcast did not). Keeping the reference would let a later re-send deliver the previous creative under the new caption.
>
> **Why `posterCopy` and `posterArchetype` are treated asymmetrically on overwrite:** poster copy is *derived from the caption being replaced*, so it is cleared unless the sheet supplies a new block. The archetype is a layout *pin* rather than derived content, so a sheet with no opinion on it leaves an existing pin alone (`calendar-import.ts:299-303`).

**Isomorphic validation:** the panel parses in the browser and dry-runs the whole sheet before anything is written, so each row shows the day it will land on and whether it creates, replaces, or bounces. **The server action re-parses and re-resolves independently** — the browser's day map is a render-time snapshot and is never trusted (`calendar-parse.ts` imports zod only, never Prisma, so it is safe in both bundles).

**Write batching:** updates run in chunks of 25 inside `$transaction`. A 365-row import would otherwise hold one interactive transaction open across the entire write — exactly the shape that exhausts a serverless connection pool. The tradeoff (a mid-import fault leaves earlier chunks committed) is recoverable: re-importing is a no-op in skip mode and rewrites identical copy in overwrite mode.

**Two template buttons** emit content-only and content-plus-every-poster-column shapes, both with two filled example rows — the image-prompt and headline house rules are easier to copy than to describe.

### 9.9 Demo workspace — `/admin/demo`

**Files:** `page.tsx` (501 lines) · `DemoCreativePanel.tsx` (229)

A full client detail page for throwaway `isDemo` tenants, plus an **Instant creative** panel that writes one row from hand-typed copy and runs the pipeline immediately — fal.ai render, Drive upload, WhatsApp send — instead of waiting for a cron minute.

Demo tenants are ordinary `Client` rows flagged `isDemo`, so every action and component here is the same one the Clients section uses. They are excluded from the client matrix **and from the dispatch sweep**.

A persistent amber banner warns: *"Sends from this section are real: Flux.1 is billed, the asset is written to Drive, and WhatsApp delivers to +{number} immediately."*

Rows are appended after the last `dayNumber` (`@@unique([clientId, dayNumber])` means a fixed number would collide on the second send). Calendar coverage counts only rows within `1..plan.durationDays`, so instant sends don't hide the seed button.

**Sales flow:** create demo tenant with the prospect's WhatsApp → paste their website copy → **Extract design tokens** → watch the palette land on the canvas → type a theme/caption/prompt → **Send now** → the prospect's phone buzzes with a branded poster.

### 9.10 Poster preview — `/admin/poster-preview`

**File:** `page.tsx` (310 lines)

The visual regression surface. Renders **all eight archetypes side by side** at any output preset, optionally with a real client's brand and a real calendar day's copy. Costs nothing to refresh.

**Also reports:** the resolved theme (5 colour chips + font families), any contrast pairing still below target after correction (`auditTheme`), and any slots the chosen canvas cannot carry (`droppedSlots`).

Uses a plain `<img>` with an eslint-disable, deliberately — the route is dynamic and uncached by design, which is exactly what `next/image` would try to optimise away.

---

## 10. Navigation flow

```
/  ──redirect──▶  /admin/dashboard
```

**Primary nav** (`AdminNav.tsx`, a client component purely so `usePathname` can resolve the active tab):

```
Dashboard │ Plan │ Verticals │ Clients ············ Posters │ Demo
   ▲                             ▲                     ▲        ▲
 /admin/  /admin/  /admin/   /admin/clients      /admin/    /admin/
dashboard  plans  verticals   (nested: true)  poster-preview  demo
```

`Posters` and `Demo` are pinned to the far end via `ml-auto` — they are sales/QA surfaces, not console sections.

**Deep links:**

```
/admin/dashboard
  ?view=clients|today|delivered|failed      drill-down panel
  &range=7d|30d|90d|mtd|all                 spend range
  &spendClient=<uuid> &spendProvider=<enum> spend filters

/admin/clients
  └─▶ /admin/clients/[clientId]             (company name link)
        └─▶ /admin/clients/[clientId]/brand (Brand canvas button)
        └─▶ drive.google.com/drive/folders/…  (Drive vault button, new tab)

/admin/demo?tenant=<uuid>                   tenant switcher

/admin/poster-preview
  ?preset=<id>&clientId=<uuid>&day=<n>&tone=dusk|daylight
```

### Canonical operator journey (new paying client)

```
1. /admin/plans      → create the plan (name, duration, price)      [once]
2. /admin/verticals  → create the vertical                          [once]
3. Razorpay order.paid  ──or──  /admin/clients → Manual onboarding
                     → client row + Drive folder provisioned
4. /admin/clients/[id]/brand
                     → upload logo, set tagline/phone/website
                     → paste brand material → Extract design tokens  ★ DO THIS FIRST
5. /admin/clients/[id]
                     → Generate N days   (LLM, slow, costs money)
                       ──or── Bulk content import (CSV/JSON, free)
6. Verify at /admin/poster-preview?clientId=[id]&day=1
7. Cron takes over. Watch /admin/dashboard for failures.
```

---

## 11. The creative pipeline

**File:** `src/lib/ai-pipeline.ts` (701 lines) · entry point `runCreativePipeline(calendarId, options)`

### State machine

```
PENDING ──(fal.ai photo → poster composite → Drive upload)──▶ GENERATED
                                                                  │
                                                          (Evolution send)
                                                                  ▼
                                                             DELIVERED

  └────────────────── any step throws ──────────────────▶ FAILED (+ errorMessage)
```

### Stages

`type PipelineStage = 'load' | 'generate' | 'compose' | 'upload' | 'broadcast' | 'complete'`

`compose` is its own stage because a font fetch or a bad logo URL fails there — attributing that to `generate` would send an operator looking at fal.ai for a satori problem.

### Options

```ts
interface PipelineOptions {
  reuseExistingAsset?: boolean;  // re-send stored Drive asset, no fal.ai re-bill
  allowRedelivery?: boolean;     // deliver even when already DELIVERED
}
```

| Caller | Options | Effect |
| --- | --- | --- |
| Cron sweep | `{}` | Full generate for `PENDING` rows |
| `forceResendCreative` | `{reuse: true, allowRedelivery: true}` | Cheap re-send |
| `regenerateCreative` | `{reuse: false, allowRedelivery: true}` | **Re-bills fal.ai** |
| `runDemoCreativeNow` | `{reuse: false, allowRedelivery: true}` | Fresh render |

### Step-by-step

**Load.** Fetch the row + client. Return early with `skipped: 'already-delivered'` if `DELIVERED` and no `allowRedelivery`. Throw if the client has no `gDriveFolderId` (onboarding never provisioned a folder). **Clear any stale `errorMessage` up front**, so a partial retry does not read as still-broken while it is in flight.

**Generate (fal.ai).** Resolve the client's size preset → resolve the archetype (stored, else `archetypeForDay(dayNumber)`) → `resolvePhotoRequest(archetype, preset)` gives the *photo* size.

```ts
POST https://fal.run/{FAL_MODEL_ENDPOINT}
Authorization: Key {FAL_KEY}
{ prompt, image_size: {width, height}, num_images: 1,
  sync_mode: true, enable_safety_checker: true }
```

`image_size` is sent as explicit `{width, height}` rather than one of fal's named shapes (`square`, `portrait_16_9`, …) — those top out at 1024 px and cap the short edge at 576, which cannot express the sizes this spec needs. `sync_mode: true` blocks until pixels are ready, so no queue polling. Both response forms are handled: an inlined `data:` URI, and a hosted URL (downloaded separately).

**Usage is recorded the moment fal returns pixels** — before the upload, which can still fail without making the render free.

**Compose.** `ensurePosterCopy(entry.id)` (a no-op for a normally seeded day) → `renderPoster({...})` → if the resolved archetype differs from what's stored, persist it so a later re-render reproduces the same layout.

**Upload.** `Day_042_Creative.png` → `uploadClientAsset` → publish `{role: 'reader', type: 'anyone'}` → read back `webContentLink`. Then **checkpoint**: persist `gDriveFileId`, `gDriveViewUrl`, status `GENERATED`.

**Broadcast.**
```ts
POST {EVOLUTION_API_URL}/send/media
apikey: {EVOLUTION_API_KEY}
{ number, url, type: 'image', caption, filename }
```
Caption = `caption + "\n\n" + hashtags`.

> **Deliberately not retried.** A timeout here is ambiguous — the message may already have been queued — so a retry risks double-sending to the client's WhatsApp. The row is left `FAILED` for an operator to re-send.

**Complete.** Status `DELIVERED`, `errorMessage` nulled.

### Retry & error policy

`withRetries(label, maxAttempts, op, stage)` — exponential backoff `1s, 2s, 4s…`, up to `FAL_MAX_ATTEMPTS` (default 3). `isRetryable` returns true for timeouts, network failures, and HTTP `408 / 425 / 429 / 5xx`. **All other 4xx are terminal** — re-billing a rejected prompt is waste.

Failures are persisted best-effort into `errorMessage` as `[stage] message`, capped at 4000 chars, with **secrets redacted**: `redactSecrets` strips `FAL_KEY`, `EVOLUTION_API_KEY`, `RAZORPAY_WEBHOOK_SECRET`, `GOOGLE_PRIVATE_KEY`, `CRON_SECRET` from anything the dashboard will render.

### The dispatch sweep

**File:** `src/lib/cron-worker.ts` · `executeIntervalDispatch(now = new Date())`

```ts
prisma.client.findMany({
  where: {
    isActive:  true,
    isDemo:    false,                     // demos are hand-driven only
    cronTime:  { in: minuteWindow },      // trailing window, app timezone
    startDate: { lte: end },
    endDate:   { gte: start },
  },
  select: { …, calendarDays: {
    where: { scheduledDate: { gte: start, lt: end },
             deliveryStatus: 'PENDING' },
    orderBy: { dayNumber: 'asc' },
  }},
})
```

Single indexed round-trip, backed by `@@index([cronTime, isActive])` and `@@index([scheduledDate, deliveryStatus])`.

**`mapWithConcurrency`** runs up to `CRON_MAX_CONCURRENCY` (default 4) items in flight — no item waits on the one before it. A worker that throws is captured as a `FAILED` outcome so one bad row cannot abort the sweep.

> ⚠️ **`CRON_WINDOW_MINUTES` must be ≥ your real cron interval.** With a 5-minute schedule and a window of 1, four out of five clients would never be picked up.

---

## 12. The poster rendering layer

**The delivered creative is a composite, not a diffusion render.** fal.ai produces only the background photograph; every readable element — logo lockup, headline, body copy, icon features, contact bar — is typeset over it as real vector glyphs and rasterised with satori + resvg.

This is not a stylistic choice. Diffusion models cannot spell, and the contact bar carries a client's actual phone number and domain. A misspelt headline is embarrassing; a wrong phone number delivered daily to a paying client's WhatsApp is a refund.

### Pipeline

```
PosterCopy (LLM/operator)  ─┐
PosterTheme (brand tokens) ─┼─▶ PosterSpec ─▶ renderArchetype() ─▶ JSX
PosterIdentity (client)    ─┤                                       │
PosterPhoto (fal.ai bytes) ─┘                                       ▼
                                                        satori(tree, {w,h,fonts})
                                                                    │  SVG
                                                                    ▼
                                                    Resvg(svg, {fitTo:{width}})
                                                                    │
                                                                    ▼  PNG Buffer
```

### The three shapes (`lib/types/poster.ts`)

| Type | What it is | Source |
| --- | --- | --- |
| `PosterCopy` | Slot **content** only, no styling | LLM or operator sheet |
| `PosterTheme` | **Styling** only, no content | Brand tokenizer → `resolvePosterTheme` |
| `PosterSpec` | The two joined with identity + photo. Fully resolved; an archetype reads it and nothing else. | `render.tsx` |

Keeping copy and theme apart is what lets one day's copy render in any of the eight archetypes, and one client's theme apply to all 365 days.

### The eight archetypes

From §5 of `docs/creative-style-spec.md`. A–E were reverse-engineered from 12 competitor reference posters; F–H are *derived* rather than observed — the reference set clustered into five, but five layouts cycling by day number is visibly repetitive over a 30-day campaign, and each of the three fills a gap the originals left (an unused photo treatment, an unused contact-bar form, an unused reading order):

| Archetype | Composition | Photo shape | References |
| --- | --- | --- | --- |
| `scrim` | Full-bleed photo, directional dark scrim over the copy side | portrait | 1, 6, 9, 10 |
| `diagonal` | Solid panel left, photo right, straight diagonal boundary | portrait | 2, 13 |
| `bands` | Three stacked horizontal bands with hard edges | **landscape** | 3, 5, 7 |
| `curve` | Light field with a dark curved sweep rising from bottom-left | **landscape** | 4 |
| `editorial` | High-key light field, photo dissolving into it | portrait | 8, 11, 12 |
| `spotlight` | Full-bleed photo under an *even* wash; copy and features centred as one block down the frame — the only composition that does not anchor copy to the top | portrait | derived |
| `corner` | Light field; photo a tall inset panel filling the right half (8%–76% of height), bleeding off the right edge only, accent hairline at its base; copy and a vertical feature list share the left column. Uses the **stacked** contact bar | portrait | derived |
| `inverted` | Photo band across the top 30% with an accent hairline on the seam, all copy below it on the dark ground — the only composition where the photo is read before the copy | **landscape** | derived |

**Selection:** a row may pin one in `posterArchetype`; otherwise `archetypeForDay(dayNumber)` derives it:

```ts
// stride is computed, not written down: the smallest step above 1 that is
// coprime with the set size, so the walk visits every archetype.
const stride = 3;  // gcd(3, 8) === 1, so the walk is a full cycle
const index = ((dayNumber - 1) * stride) % 8;
```

Day 1 onward that gives `scrim`, `curve`, `corner`, `diagonal`, `editorial`, `inverted`, `bands`, `spotlight`. Deriving the stride is what makes adding an archetype safe: a hardcoded `2` at six archetypes has `gcd(2, 6) === 2` and silently walks three of them forever, with no error and nothing to catch it.

Deterministic on purpose: re-rendering day 47 after a failure must reproduce the layout the first attempt would have produced, or an operator comparing a retry against the original sees a difference that isn't there.

> **The archetype picks the photo's aspect ratio, not the output preset.** `bands`, `curve` and `inverted` place the photo in a landscape band; asking fal for a 9:16 portrait and cover-fitting it into a short wide box discards most of the frame and usually decapitates the subject. See `photo-request.ts`.

### The slot skeleton (invariant across all 12 references)

Slots may be omitted but **never reordered**:

```
1. LOGO LOCK      top-left, always
2. TAGLINE        optional, letterspaced caps
3. HEADLINE       2–4 lines, ALL CAPS, exactly one line in accent colour
4. ACCENT RULE    120 × 6 px bar — does most of the "designed" signalling
5. BODY PARAGRAPH 3–5 lines, sentence case, ~34-char measure
6. FEATURE BLOCK  2–4 items, monoline circled icon + label + 2-line body
7. HERO PHOTO     the opposite region; archetype-dependent
8. CONTACT BAR    full-bleed bottom, phone left + website right
```

### Canvas modes (`metrics.ts`)

The eight archetypes are portrait compositions, but the catalogue offers square, landscape and letterbox shapes (all flagged `offBrand`). Rather than emit a poster with slots running off the bottom edge, the renderer switches composition:

| Mode | Trigger (aspect = w/h) | Behaviour | Dropped slots |
| --- | --- | --- | --- |
| `tall` | ≤ 0.82 | The archetype as designed | none |
| `wide` | > 0.82 | Copy in a left column, photo right | none |
| `letterbox` | > 2.2 | Logo + headline + contact only | body paragraph, feature block, eyebrow |

Dropped slots are **named in the logs and on the preview page** rather than silently omitted — a letterbox poster that quietly drops the feature block looks intentional, and nobody discovers the preset was a bad choice.

**Scaling:** every spec measurement is stated against a 940 × 1568 reference. `resolveMetrics(w, h)` converts once; no slot component does arithmetic on a raw spec number. Scale is the **smaller** of the two axis ratios — scaling by width alone on a 1440 × 3120 phone canvas would make the design 3418 px tall and push the contact bar off the poster.

**Headline fitting:** satori will not auto-fit text; an over-wide line wraps, and a headline whose hand-authored line breaks get re-wrapped stops looking designed. `fittedHeadlineSize` predicts width using `AVERAGE_CAP_ADVANCE = 0.75` (measured from real output: "COMMERCIAL" at 98.8 px in Archivo Black rasterises to ~740 px), shrinks to fit, and never goes below 55% of the intended size.

### Theme resolution (`theme.ts`)

The tokenizer emits a loose bag of hexes with free-text role labels ("primary", "brand blue", "cta") and free-text font names. **None of that is trustworthy** — roles are frequently mislabelled, palettes arrive with five near-identical blues or with nothing but greys, and font names may be faces we have no bytes for.

So role labels are treated as a **hint** and the actual assignment is made by *measurement*:

- **Accent:** highest `accentScore` among non-neutral colours, with a `+0.15` bonus for `accent|primary|brand|cta|highlight` labels and a `-0.3` penalty for `background|surface|neutral|text|body`. Weighting rather than filtering means a palette whose every label is wrong still resolves sensibly.
- **Dark ground:** darkest colour with luminance ≤ 0.12, preferring one with saturation ≥ 0.15 so the panel reads as the client's own. Falls back to `#0D2447` navy (cool family) or `#0E1116` near-black (warm).
- **Light ground:** luminance ≥ 0.78 and saturation ≤ 0.2, else `#F6F7F9`.
- **Family:** hue ≤ 70° or ≥ 340° → `warm`; otherwise `cool`. The references never mix families in one poster.

Then **every colour that carries text is contrast-corrected**:

| Field | Target | Why it exists |
| --- | --- | --- |
| `onDark` / `onLight` | 7:1 | Spec headline requirement |
| `accentOnDark` | 4.5:1 | A cool accent like `#1546A0` on `#0B1E3D` navy is ~1.6:1 — an accented headline line would be nearly invisible. The references dodge this by only putting cool accents on light fields, but the renderer has to survive any archetype paired with any brand. |
| `accentOnLight` | 4.5:1 | Amber/yellow fails on white |
| `onAccent` | — | Dark on amber, white on deep blue. The contact bar fills with the accent; getting this wrong makes the phone number unreadable. |

`auditTheme()` reports pairings still below target *after* correction — surfaced on the preview page as *"This palette cannot fully carry the house look. Worth an account conversation rather than a code change."*

### Fonts (`fonts.ts`)

Satori rasterises text itself and has **no access to system fonts** — every face must be handed to it as a buffer. Two sources, in order: `POSTER_FONT_DIR` (looked up as `<Family>-<weight>.ttf`), then Google Fonts.

> **The legacy User-Agent is load-bearing.** `fonts.googleapis.com/css2` sniffs the UA and serves `woff2` to anything modern. Satori's parser reads TTF, OTF and WOFF but **not** WOFF2 — the Brotli table compression is a different container entirely. An old UA makes Google downgrade to a parseable format. Remove the header and every render fails with `Unsupported OpenType signature wOF2`.

The cache holds the **in-flight promise**, not the resolved buffer, so a burst of concurrent renders (the sweep firing several clients in the same minute) collapses onto one fetch per face. A rejected promise is evicted so a transient failure doesn't poison the cache for the process lifetime.

One missing weight does not fail the render (satori synthesises from the nearest); a face with *no* weights loaded throws.

**Face mapping:** free-text family names are matched exactly, then by substring both ways — the tokenizer often returns decorated names like "Montserrat ExtraBold" or "Inter (variable)". Serif/slab suggestions fall through to the default grotesque deliberately: none of the 12 references use a serif, and honouring a mistaken serif extraction would break the house look more visibly than ignoring it.

`heaviestWeight()` exists because Anton and Archivo Black ship a single 400 face that is *already* black — requesting 900 makes satori synthesise a faux-bold on top of an ultra-heavy design and the counters fill in.

### Logo handling (`render.tsx`)

Process-lifetime cache keyed by URL (a re-upload changes the URL, so it misses correctly). **Returns null on every failure** — a missing or broken logo degrades to the generated wordmark lockup, never a failed delivery.

Checks: ≤4 MB, 15 s timeout, and the content type must start with `image/` — *a Drive link whose sharing was never opened returns an HTML interstitial with a 200*, so the type has to be checked rather than assumed. SVG is detected by content type or by sniffing the first 300 bytes.

### Phone formatting

`displayPhone` passes through **verbatim** when set — an operator who typed `+91 98765 43210` chose that spacing. Only the fallback path formats, grouping 12-digit Indian numbers as `+91 XXXXX XXXXX`; anything else gets a plain `+` prefix rather than a guessed grouping, since applying Indian spacing to a 9-digit European number would render a number that cannot be dialled.

### Why not `next/og`

`ImageResponse` wraps exactly satori and resvg, so it looks like the obvious choice, but its Node-runtime build **cannot load on Windows**: it resolves its own wasm assets with `fileURLToPath(path.join(import.meta.url, '../yoga.wasm'))`, and `path.join` rewrites `file:///D:/…` into `file:\D:\…`, which is not a parseable URL. The module throws `TypeError: Invalid URL` at import time. It works on Vercel's Linux, which makes it worse — the composition could not be previewed on the machine it is authored on.

`@resvg/resvg-js` ships a platform-specific `.node` addon and **must** stay in `serverComponentsExternalPackages`; webpack cannot bundle it.

---

## 13. The AI/LLM layer

### Shared wrapper — `lib/ai/openai.ts`

Every LLM call goes through `generateStructured<T>(request)`, which pins the response with **Structured Outputs** (`response_format: json_schema`, `strict: true`) so the model cannot wrap its JSON in prose.

```ts
interface StructuredRequest {
  label: string;          // for logs and error messages
  systemPrompt: string;   // STABLE — everything reusable belongs here
  userPrompt: string;     // the varying part
  schema: Record<string, unknown>;
  schemaName: string;     // a-z A-Z 0-9 _ - only
  maxTokens?: number;
  temperature?: number;
  bill?: UsageContext & { operation: UsageOperation };
}
```

**Failure taxonomy** (`LlmError.kind`): `refusal` · `truncated` · `filtered` · `malformed` · `transport` · `config`. Structured Outputs surface a safety decline in `choice.message.refusal` rather than as an error, so that is checked **before** reading content.

**Retry policy:** only `RateLimitError`, `APIConnectionError`, and `APIError` with `status >= 500`. `APIConnectionError` is tested before `APIError` because it derives from it. A refusal or schema violation is deterministic and re-billing it would be waste.

**Billing happens before the JSON parse** — the tokens are billed by OpenAI whether or not the payload turns out to be usable.

**Prompt caching:** OpenAI caches long prompt *prefixes* automatically once they exceed ~1024 tokens. `logUsage` prints `cached=` on every call so the effect is observable — a `cached` of 0 across repeated batches means the shared prefix is either too short or is being invalidated by per-call content leaking into `systemPrompt`.

**Strict-mode constraint to remember:** every object must set `additionalProperties: false` and list **all** of its properties in `required`. Optional fields are unsupported — which is why `eyebrow` is an empty-string-to-omit rather than a nullable field. A violation surfaces as a `400` at request time, not a type error.

### Stage 1 — Brand tokenizer (`ai/brand-tokenizer.ts`)

**Trigger:** Brand canvas → "Extract design tokens". **Temperature 0.2** (extraction should be near-deterministic, so the same material yields a stable palette). **maxTokens 2000.** Input is bounded at 24,000 chars so a pasted full-site scrape cannot blow the context window.

**Output schema:** `colors[]` (hex + role from `primary|secondary|accent|background`), `typography{headingFont, bodyFont, vibeClassification}`, `layoutDirectives[]`.

Prompt rules: derive from evidence, don't invent a contradicting palette; 3–6 colours with exactly one `primary` and one `background`; fonts must be **real, widely available typeface names** — never a description like "a modern sans"; `layoutDirectives` are 3–6 short imperative rules an image generator can act on, with no colour or font restatements.

Re-validated through `parseBrandGuideline`, and **`assets` are carried through untouched** so persisting a fresh extraction doesn't wipe the operator's asset ledger. Throws if no usable colours or typography came back.

### Stage 2 — Calendar generator (`ai/calendar-generator.ts`)

**Trigger:** Client matrix / detail → "Generate N days". **Temperature 0.9** (captions should not converge on one template).

**Per day it produces:** `theme` (2–5 words, all distinct), `caption` (40–90 words, WhatsApp body — *not* image text), `hashtags` (5–8, space-separated), `imagePrompt` (50–90 words, background photo only), and the nested `poster` block.

**Batching:** `CALENDAR_BATCH_SIZE` (default 10, max 25), run **sequentially**. Two reasons: a single request for 365 days would blow past `max_tokens`, and concurrent requests cannot read a prompt-cache entry that a sibling is still writing — so the per-client brand prefix would be re-billed on every batch instead of once.

**Prompt structure:** the stable per-client brief (company, industry, campaign length, palette, typography, layout directives) lives in the **system prefix** so it caches. The `userPrompt` carries the day numbers plus a running list of themes already used, so batches don't repeat each other.

**Defensive handling:** the model's days are re-validated with zod; days not requested and duplicates are ignored; omitted days are logged and simply stay unseeded for a later run. The `poster` block is left unvalidated in that schema and narrowed by `coercePosterCopy` instead — a bad poster block must not discard an otherwise good day, since the caption and image prompt are still deliverable.

**Idempotency:** re-running only fills gaps. `createMany({skipDuplicates: true})` leans on `@@unique([clientId, dayNumber])`, so a concurrent run cannot produce a constraint failure or a double-seeded day.

### Stage 3 — Poster-copy backfill (`ai/poster-copy.ts`)

**Trigger:** the pipeline's `compose` stage, **only when needed**. **Temperature 0.7** (a single repair, no sibling days to diverge from).

Runs only for rows lacking usable copy — those seeded before the poster layer existed, or whose batch response was unrepairable. It is a **no-op for a normally seeded day**, and its spend is logged under its own `poster-copy` operation so a client accruing them is visible as a prompt problem rather than hidden inside `calendar`.

The copy is anchored to that day's existing theme, caption and image prompt — otherwise the headline can contradict the photograph it is typeset over.

**Throws** if the model cannot produce usable copy. That is the right behaviour: without poster copy there is nothing to typeset, and `FAILED` with a readable reason beats delivering a photograph with no text on it — the exact defect this whole layer exists to fix.

### The shared contract (`ai/poster-prompt.ts`)

`POSTER_SCHEMA`, `POSTER_COPY_RULES` and `IMAGE_PROMPT_RULES` are shared by the generator and the backfill. **If the rules diverged, a backfilled day would render subtly differently from its neighbours and nobody would notice until a month of creatives were viewed side by side.**

Two rules worth memorising:

> **`imagePrompt`:** NEVER request embedded text, words, letters, numbers, signage, logos or watermarks. Image models render these badly, and every readable element is composited afterwards as real type.
>
> **Poster copy:** Write no phone number, no URL and no company name into any poster field; those are injected from the client record. Make no factual claims about pricing, discounts, awards, statistics, years in business, or project counts — you have no source for any of them.

### The repair layer (`coercePosterCopy` in `types/poster.ts`)

Structured Outputs **reject `minItems`/`maxItems` under `strict: true`**, so array lengths can only be asked for in prose — and the model does sometimes return five features or a single headline line. Straight `safeParse` would discard the whole day's copy over that.

So: over-long arrays are trimmed, over-long strings cut at a **word boundary**, a one-line headline split at its midpoint, an unknown icon mapped to `shieldCheck`, and `accentLineIndex` clamped into range (defaulting to line 2 — the accent line in 8 of 12 references).

Anything that cannot be repaired **without inventing content** — no headline at all, fewer than two features, no body — still returns `null`, because a poster with fabricated copy would be delivered to a paying client before anyone noticed.

### Model choice

Default `gpt-4o-mini` via `OPENAI_MODEL`. Output is clamped to 16,384 tokens (the model's ceiling) so an over-large env value becomes a clear error rather than a confusing truncation.

---

## 14. Integrations

### Razorpay

Point a webhook at `POST /api/webhooks/razorpay`, subscribe to **order.paid**, set `RAZORPAY_WEBHOOK_SECRET`. Pass the keys in §6 in the order's `notes`. `notes` set at order creation surface on the payment entity too; the payment copy is preferred, with the order entity as fallback.

⚠️ **Payment does not seed a calendar.** A paying customer is provisioned but delivers nothing until an operator seeds or imports one. See §17.10.

### Google Drive

**Setup:** create a service account, enable the Drive API, share the parent vault folder with the service-account email as **Content manager / Editor**.

`GOOGLE_PRIVATE_KEY` accepts the single-line form copied straight out of the credentials JSON — `normalizePrivateKey` strips surrounding quotes and unescapes literal `\n` at runtime.

**Client:** memoised per process (`getDriveClient`). All calls set `supportsAllDrives: true` so the same code path works whether the vault lives in My Drive or a Shared Drive.

**Folder provisioning** is idempotent — a folder of the same name already under the parent is reused, so webhook retries cannot litter the vault with duplicates. Query values are escaped for the Drive `q` syntax (`\` and `'`).

**Upload** streams the buffer via `Readable.from`, then publishes `{role:'reader', type:'anyone'}` — Evolution API fetches the media server-side and carries no Google credentials.

**Thumbnails** point at `lh3.googleusercontent.com/d/{id}=w512`, not `drive.google.com/thumbnail?id=`. That endpoint only 302s here anyway, but the hop is served from the signed-in Drive origin: it carries `Cross-Origin-Opener-Policy` and `X-Frame-Options`, and varies on the viewer's Google cookies — so an `<img>` in the console breaks for a *logged-in* operator while working fine for an anonymous fetch. This host answers with `Access-Control-Allow-Origin: *` and no such headers.

**`trashDriveFile`** never throws — a logo that cannot be tidied up must not fail the upload that replaced it. Trashed rather than permanently deleted, so an operator who replaces the wrong logo can recover it.

### Evolution API (WhatsApp)

**Evolution GO**, not Node v2. `POST /send/media` with `{number, url, type, caption, filename}`, authenticated with an `apikey` header.

> ⚠️ **`EVOLUTION_API_KEY` must be the per-INSTANCE token** (from `GET /instance/all` → `data[].token`). The global admin key is rejected with 401 on instance-scoped routes. There is no instance-name setting because the instance is selected by the key.

### fal.ai (Flux.1)

`POST https://fal.run/{endpoint}` with `Authorization: Key {FAL_KEY}`. Default endpoint `fal-ai/flux/schnell`. Render limits (`image-sizes.ts`): max edge 2048 px, dimensions must be multiples of 16, min edge 512 px.

> **Cost caveat not surfaced in the UI:** `PRICE_FAL_PER_IMAGE` is a flat per-image rate. If `FAL_MODEL_ENDPOINT` is pointed at a model that bills per megapixel, the spend ledger will under-report at large canvases. `fal-ai/flux/schnell` is flat-rated, so the default configuration is accurate.

### OpenAI

See §13. Only the `chat.completions` endpoint is used, always with `response_format: json_schema`.

---

## 15. Environment variables & configuration

**Template:** `evokz/.env.example` (fully commented, 124 lines).

### Complete variable reference

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| **Database** | | | |
| `DATABASE_URL` | ✅ | — | PostgreSQL connection string |
| **Scheduling** | | | |
| `APP_TIMEZONE` | | `Asia/Kolkata` | IANA zone for all `cronTime` and date resolution |
| `CRON_WINDOW_MINUTES` | | `5` | ⚠️ **Must be ≥ your real cron interval** |
| `CRON_SECRET` | ✅ | — | Bearer token for `/api/cron`. **Fails closed if unset.** |
| `CRON_MAX_CONCURRENCY` | | `4` | Max creatives generated concurrently per sweep |
| **Razorpay** | | | |
| `RAZORPAY_WEBHOOK_SECRET` | ✅ | — | HMAC signing secret |
| **Google Drive** | | | |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | ✅ | — | Service account address |
| `GOOGLE_PRIVATE_KEY` | ✅ | — | Full PEM; literal `\n` unescaped at runtime |
| `GOOGLE_DRIVE_PARENT_FOLDER_ID` | ✅ | — | The vault folder, shared with the SA as Editor |
| **OpenAI** | | | |
| `OPENAI_API_KEY` | ✅ | — | |
| `OPENAI_MODEL` | | `gpt-4o-mini` | |
| `OPENAI_MAX_TOKENS` | | `8000` | Clamped to 16,384 in code |
| `OPENAI_MAX_ATTEMPTS` | | `3` | |
| `CALENDAR_BATCH_SIZE` | | `10` | Days per request; clamped to 25 |
| **fal.ai** | | | |
| `FAL_KEY` | ✅ | — | `key_id:key_secret` |
| `FAL_MODEL_ENDPOINT` | | `fal-ai/flux/schnell` | |
| `FAL_IMAGE_SIZE` | | `whatsapp-status` | Fleet default; a **preset id**, not a fal named shape |
| `FAL_TIMEOUT_MS` | | `120000` | |
| `FAL_MAX_ATTEMPTS` | | `3` | |
| **Evolution** | | | |
| `EVOLUTION_API_URL` | ✅ | — | Base URL, trailing slashes stripped |
| `EVOLUTION_API_KEY` | ✅ | — | ⚠️ **Per-instance token, not the admin key** |
| `EVOLUTION_TIMEOUT_MS` | | `60000` | |
| **Rate card (display + ledger)** | | | |
| `PRICE_OPENAI_INPUT_PER_MTOK` | | `0.15` | USD per 1M input tokens |
| `PRICE_OPENAI_CACHED_INPUT_PER_MTOK` | | `0.075` | |
| `PRICE_OPENAI_OUTPUT_PER_MTOK` | | `0.60` | |
| `PRICE_FAL_PER_IMAGE` | | `0.003` | |
| `PRICE_WHATSAPP_PER_MESSAGE` | | `0` | 0 for self-hosted Evolution |
| `USD_INR_RATE` | | `88` | Display-only conversion |
| **Poster renderer** | | | |
| `POSTER_FONT_DIR` | | `''` | Directory of TTF/OTF. **Strongly recommended in production** |
| `POSTER_FONT_TIMEOUT_MS` | | `15000` | |
| `POSTER_LOGO_TIMEOUT_MS` | | `15000` | |

### Access pattern (`lib/env.ts`)

Deliberately **not validated at module load**. A missing Evolution key must not stop the dashboard from rendering, and a missing FAL key must fail *inside* the pipeline's try/catch so the failure lands in `ContentCalendar.errorMessage` instead of crashing the process.

- `requireEnv(key)` → throws `MissingEnvError`
- `optionalEnv(key, fallback)` / `intEnv` / `floatEnv` → fall back on unset **or unparseable** values. `floatEnv` also rejects negatives, because a negative rate would silently turn spend into income.
- `findUnsetIntegrationKeys()` → names only, for the dashboard banner.

### ⚠️ Current configuration state

The `.env` file exists at **`Documents/Evokz/.env`** — one level **above** the Next.js project root at `Documents/Evokz/evokz/`. **Next.js only loads `.env` from its own project root**, so none of these values are currently loaded. See §17.2.

All 10 integration keys *are* present in that file. **Not** present (all have code defaults, but note the implications):

- `OPENAI_MAX_TOKENS`, `OPENAI_MAX_ATTEMPTS`, `FAL_MODEL_ENDPOINT`, `FAL_IMAGE_SIZE`, `FAL_TIMEOUT_MS`, `FAL_MAX_ATTEMPTS`, `EVOLUTION_TIMEOUT_MS` — safe defaults.
- **All `PRICE_*` and `USD_INR_RATE`** — the ledger will price everything at the built-in defaults. Verify these against real invoices before trusting the margin column.
- **`POSTER_FONT_DIR`** — every cold start will fetch faces from `fonts.gstatic.com` **inside the render path**, so a Google Fonts outage becomes a delivery failure. Set this in production.

### Other configuration files

| File | Contents |
| --- | --- |
| `next.config.mjs` | `reactStrictMode`; `serverComponentsExternalPackages: ['googleapis', 'google-auth-library', '@resvg/resvg-js']` |
| `tsconfig.json` | `strict: true`, `noUncheckedIndexedAccess: true`, `moduleResolution: 'bundler'`, path alias `@/* → ./src/*` |
| `tailwind.config.ts` | `darkMode: ['class']`; brand token colours; 5 gradients; 3 brand glows; a custom plugin registering `perspective-*`, `rotate-x/y/z-*`, `preserve-3d`, `backface-hidden` (Tailwind v3 ships none of these) |
| `vercel.json` | Cron `*/5 * * * *` → `/api/cron`; `maxDuration` 300 s (cron) / 60 s (webhook) |
| `components.json` | shadcn/ui: default style, RSC, slate base, CSS variables |
| `.eslintrc.json` | `extends: next/core-web-vitals` |

---

## 16. Deployment

### Target: Vercel

`vercel.json`:
```json
{
  "crons": [{ "path": "/api/cron", "schedule": "*/5 * * * *" }],
  "functions": {
    "src/app/api/cron/route.ts":              { "maxDuration": 300 },
    "src/app/api/webhooks/razorpay/route.ts": { "maxDuration": 60  }
  }
}
```

> ⚠️ **Both settings require a Vercel Pro plan.** Hobby caps cron at once-daily and function duration at 60 s. On Hobby, the 5-minute schedule will not run and a long sweep will be killed mid-flight.

### Build

```bash
npm run build     # → prisma generate && next build
```

The `postinstall` hook also runs `prisma generate`, so a fresh CI install produces a client automatically.

### Pre-deploy checklist

1. **Add authentication** (§8) — or at minimum enable Vercel Password Protection. **Do not deploy publicly without this.**
2. Set every variable from §15 in the Vercel project settings (all environments).
3. Set `POSTER_FONT_DIR` and commit the font files, or accept the Google Fonts dependency in the render path.
4. Verify the `PRICE_*` rate card against real provider invoices.
5. Baseline Prisma migrations (`prisma migrate dev --name init`) and switch the deploy step to `prisma migrate deploy`.
6. Share the Drive vault folder with the service account as **Content manager**.
7. Register the Razorpay webhook and subscribe to `order.paid`.
8. Confirm `EVOLUTION_API_KEY` is the **per-instance** token.
9. Seed at least one `Plan` and one `Category` — provisioning validates both foreign keys and the onboarding dialog is disabled without them.
10. Smoke test:
    ```bash
    curl -H "Authorization: Bearer $CRON_SECRET" https://your-app/api/cron
    curl "https://your-app/api/poster/preview?archetype=scrim" -o test.png
    ```

### Alternative schedulers

Any scheduler works provided it sends `Authorization: Bearer $CRON_SECRET`. Keep `CRON_WINDOW_MINUTES` ≥ the real interval.

### Runtime requirements

- **Node.js runtime only** — all three route handlers declare `runtime = 'nodejs'`. `@resvg/resvg-js` is a native addon and cannot run on the edge.
- Cold starts fetch fonts unless `POSTER_FONT_DIR` is set.
- Memory: the poster preview route caps the placeholder photo's long edge at 1280 px because a full-size print-preset PNG, base64-inflated into the SVG string, was enough to exhaust the dev server's heap.

---

## 17. Known issues & technical debt

Ordered by severity. Items 1 and 2 are deployment blockers.

### 🔴 17.1 — No authentication on the admin console (BLOCKER)

**Severity: Critical.** Fully detailed in §8.

No `middleware.ts`, no auth library, no session, no user model. `/` redirects to `/admin/dashboard`, so the console is the landing page. Because Server Action IDs ship in the public bundle, all 22 mutations in §7 are invocable by any anonymous visitor — including ones that spend money and send WhatsApp messages to real client numbers.

**Fix:** §8 remediation list. Enable Vercel Password Protection today; add middleware + a session this sprint.

### 🔴 17.2 — `.env` is outside the Next.js project root (BLOCKER)

**Severity: Critical.** The file is at `Documents/Evokz/.env`; the Next.js root is `Documents/Evokz/evokz/`. Next.js loads `.env` only from its own root, so **no configured credential is currently reaching the app**. Every integration will fail, and the dashboard's config banner will list all 10 keys as unset.

**Fix:**
```bash
mv "Documents/Evokz/.env" "Documents/Evokz/evokz/.env"
```
`evokz/.gitignore` already ignores `.env`, so this is safe. (The stray `Documents/Evokz/package-lock.json` is an empty stub and can be deleted too.)

### 🟠 17.3 — Razorpay webhook silently drops `image_size`

**Severity: Medium.** `route.ts:43-48` parses the `image_size` note through four aliases, but the `provisionClient` call at `route.ts:135-141` never passes it:

```ts
const result = await provisionClient({
  companyName:    notes.companyName as string,
  whatsappNumber: notes.whatsappNumber as string,
  planId:         notes.planId as string,
  categoryId:     notes.categoryId as string,
  cronTime:       notes.cronTime ?? '09:00',
  // ← imageSizePreset is missing
});
```

The README documents `image_size` as a supported note key, so this is a documented-but-unwired feature. Every webhook-provisioned client silently lands on the fleet default.

**Fix:** add `imageSizePreset: notes.imageSizePreset ?? null,`. The schema already accepts it (`onboarding.ts:39-44`, `.nullish()`).

### 🟠 17.4 — `UsageEvent.backfilled` is never written

**Severity: Low-Medium.** The column exists, and `cost-report.ts:240` counts rows where `backfilled: true` to set `hasBackfilled` on the report — but **no code path ever writes `true`**. The "reconstruct historical spend from calendar rows" tool the schema comment describes was never built, so `hasBackfilled` is permanently `false` and any UI branch on it is dead.

**Fix:** either build the backfill script, or drop the column and the report field.

### 🟠 17.5 — No test suite of any kind

**Severity: Medium.** No test files, no test runner in `package.json`, no CI config. Every verification is manual. The highest-value units to cover first, all pure and easily testable:

| Module | Why it matters |
| --- | --- |
| `lib/time.ts` | DST correctness — `addZonedDays` vs `addDays` is a documented delivery-day bug class |
| `lib/calendar-parse.ts` | 1077 lines of untested parsing across CSV/TSV/JSON, aliases, and poster columns |
| `lib/types/poster.ts` | `coercePosterCopy` repair logic and `archetypeForDay` determinism |
| `lib/pricing.ts` | Cached-token subset arithmetic — an error here misstates every margin |
| `lib/poster/theme.ts` | Contrast correction and accent selection |
| `lib/poster/metrics.ts` | Canvas-mode thresholds and headline fitting |

### 🟠 17.6 — Unauthenticated, uncached, CPU-heavy preview endpoint

**Severity: Medium.** `/api/poster/preview` performs a full satori+resvg render per request with `Cache-Control: no-store` and no rate limit — a cheap CPU-exhaustion vector. With `?clientId=`, it also renders a client's company name, phone, website and logo into the PNG without any authorization check. `/admin/poster-preview` compounds this by listing up to 100 clients by name.

**Fix:** cover it with the same middleware as `/admin/*` (§8), and add a simple per-IP rate limit.

### 🟡 17.7 — No Prisma migrations

**Severity: Medium (operational).** `prisma/` contains only `schema.prisma`. The workflow is `db push`. No history, no rollback, no reproducible evolution. `npm run prisma:migrate` exists but has never been run.

**Fix:** `npx prisma migrate dev --name init` against a clean database to baseline, commit `prisma/migrations/`, and switch the deploy step to `prisma migrate deploy`.

### 🟡 17.8 — Evolution success detection is loose

**Severity: Medium.** The broadcast call passes `tolerateEmptyBody: true`, which makes both an empty body **and an unparseable non-JSON body** count as success (`ai-pipeline.ts:544, 555`). A gateway that returns `200` with an HTML error page would be recorded as `DELIVERED` and billed a message.

The non-retry policy itself is correct and deliberate (a timeout is ambiguous; a retry risks double-sending), but success should be positively confirmed.

**Fix:** parse Evolution GO's actual success envelope and assert on it, keeping the empty-body tolerance only for the documented shape.

### 🟡 17.9 — Orphaned Drive files accumulate

**Severity: Low.** Two paths null out `gDriveFileId`/`gDriveViewUrl` without trashing the Drive object:

- `deleteCalendarEntry` (`actions.ts:390`) — documented: "the Drive asset (if any) is left alone"
- Import overwrite (`calendar-import.ts:309`) — documented: "The orphaned Drive file is left in place, matching what `deleteCalendarEntry` already does"

Deliberate and consistent, but the vault grows unboundedly. `trashDriveFile` already exists and never throws.

**Fix:** call `trashDriveFile` on both paths, or add a periodic reconciliation job.

### 🟡 17.10 — Payment does not trigger content generation

**Severity: Medium (product gap).** `order.paid` provisions the client and the Drive folder, but seeds **no calendar**. Since the dispatcher only delivers rows that exist, a paying customer receives nothing until an operator manually clicks "Generate N days" or imports a sheet.

The client matrix flags incomplete coverage, which is the mitigation — but nothing alerts anyone, and a client can sit at zero deliveries indefinitely.

**Fix (pick one):** kick off a bounded seed (say, the first 7 days) from the webhook; or add an "unseeded clients" alert to the dashboard; or accept it and document the manual step in the ops runbook.

### 🟡 17.11 — Clients can never be deleted

**Severity: Low.** There is no `deleteClient` action anywhere. Clients can be paused (`setClientActive`) but not removed. `UsageEvent.clientId` is `onDelete: SetNull` and `cost-report.ts` renders a "Removed clients" row — infrastructure for a deletion path that does not exist.

**Fix:** add `deleteClient` with a confirm step, or document that pausing is the intended terminal state.

### 🟡 17.12 — Duplicate clients possible on the same WhatsApp number

**Severity: Low.** `Client.whatsappNumber` has no unique constraint. `provisionClient` deduplicates on `(whatsappNumber, planId, endDate >= now, isDemo)` — so the *same* number on two *different* plans creates two live clients, both delivering to that number daily.

This may be intentional (a client upgrading mid-campaign), but nothing surfaces it.

**Fix:** at minimum, warn in the onboarding dialog when the number already has a live campaign.

### 🟢 17.13 — Demo tenants cannot change output size

**Severity: Cosmetic.** `demo/page.tsx:305-313` renders `<ClientControls>` without the `imageSizePreset` prop. The prop is optional (defaults `null`), so the picker renders blank and a save would set the client to the fleet default rather than reflecting its stored value.

**Fix:** pass `imageSizePreset={tenant.imageSizePreset}` and add it to `DemoTenant` / `loadDemoTenants`.

### 🟢 17.14 — Dead export

`addTotals` (`cost-report.ts:164`, re-exported at :343) has no callers.

### 🟢 17.15 — No observability

`console.info` / `console.warn` / `console.error` with `[ace:*]` prefixes throughout, but no structured logging, no error tracking (Sentry), no metrics, no alerting. On Vercel this means grepping function logs. There is also no health-check endpoint.

### 🟢 17.16 — Single-commit git history

One commit, so `git blame` and `git bisect` are useless. Establish a normal commit cadence going forward.

### 🟢 17.17 — Documentation drift in global memory

The user-level `MEMORY.md` index describes an entirely different architecture (Vite + Express, a 12-stage AI Brain, 440 passing tests, 12 completed phases). None of it matches this repository and it will mislead anyone who reads it first. This document supersedes it.

---

## 18. Implementation status: complete vs pending

### ✅ Complete and verified

| Area | Status |
| --- | --- |
| Database schema (4 models, 2 enums, 5 indexes) | Complete |
| Razorpay webhook + HMAC verification | Complete (minus `image_size`, §17.3) |
| Client provisioning (shared webhook + manual paths) | Complete, idempotent |
| Google Drive integration (folder, upload, publish, trash, thumbnails) | Complete |
| Timezone-correct dispatch sweep with minute-window matching | Complete |
| Creative pipeline with per-stage error attribution and checkpointing | Complete |
| fal.ai integration with retry/backoff and data-URI + hosted-URL handling | Complete |
| Evolution GO WhatsApp delivery | Complete (success detection loose, §17.8) |
| Poster renderer: 8 archetypes, 3 canvas modes, 8 slots, 16 icons | Complete |
| Brand tokenizer (OpenAI Structured Outputs) | Complete |
| Calendar generator (batched, cache-aware, gap-filling) | Complete |
| Poster-copy backfill | Complete |
| Bulk CSV/TSV/JSON import with browser dry-run + server re-validation | Complete |
| Plan CRUD + referential guards | Complete |
| Category CRUD + referential guards | Complete |
| Client matrix with inline editing | Complete |
| Client detail page | Complete |
| Brand canvas + poster identity editor | Complete |
| Demo workspace with instant send | Complete |
| Poster preview surface (all 8 archetypes, any preset, real brands) | Complete |
| Spend ledger + cost report + margin + budget alerts | Complete |
| Output-size catalogue (33 presets, 9 groups) | Complete |
| Config-gap banner + database error states | Complete |
| TypeScript strict compliance | ✅ 0 errors |
| ESLint compliance | ✅ 0 warnings |

### ⚠️ Partially complete

| Feature | State | Gap |
| --- | --- | --- |
| Razorpay `image_size` | Parsed | Not applied (§17.3) |
| `UsageEvent.backfilled` | Column + reader | No writer (§17.4) |
| Demo output size | Component supports it | Prop not passed (§17.13) |
| Payment → first creative | Provisioning only | No calendar seeding (§17.10) |
| Client lifecycle | Create, pause, resume | No delete (§17.11) |

### ❌ Not started

| Feature | Priority |
| --- | --- |
| **Authentication / authorization / user model** | 🔴 **Blocker** |
| Test suite + CI | 🟠 High |
| Prisma migrations | 🟠 High |
| Rate limiting on public endpoints | 🟠 High |
| Error tracking / structured logging / alerting | 🟡 Medium |
| Health-check endpoint | 🟡 Medium |
| Drive garbage collection | 🟡 Medium |
| Client-facing portal | — (out of scope; clients receive WhatsApp only) |
| Multi-channel delivery (Instagram/LinkedIn auto-post) | — (sizes exist, posting does not) |
| Analytics on delivered creatives (opens, replies) | — |

### Realistic completion estimate

**~70% complete.** The entire creative value chain — provisioning → brand extraction → content generation → poster composition → storage → delivery → cost accounting — is built, coherent, and internally consistent, with unusually thorough inline documentation of *why* each decision was made. What is missing is the production-hardening layer: authentication, tests, migrations, observability, and rate limiting.

---

## 19. Reusable components & conventions

### UI primitives — `src/components/ui/` (shadcn/ui over Radix)

| Component | Notes |
| --- | --- |
| `button.tsx` | CVA variants: `default`, `outline`, `ghost`, `destructive`; sizes `default`, `sm`, `icon`. Supports `asChild` via Radix `Slot` (used constantly to wrap `<Link>`). |
| `card.tsx` | `Card` / `CardHeader` / `CardTitle` / `CardDescription` / `CardContent` |
| `badge.tsx` | Variants including `emerald`, `amber`, `slate`, `red` |
| `dialog.tsx` | Radix Dialog wrapper |
| `input.tsx`, `label.tsx`, `select.tsx`, `table.tsx` | Standard |

### Admin components — `src/components/admin/`

| Component | Reusability |
| --- | --- |
| `PageHeader` | Every admin page. Props: `icon`, `eyebrow`, `title`, `description`, `children` (actions). |
| `StatTile` | Dashboard + client detail + demo. Props: `icon`, `label`, `value`, `hint`, `tone`, `href`, `active`. |
| `QueueLedger` + `QueueEntry` | Dashboard, client detail, demo. **The canonical calendar-row card.** Always build its rows with `toQueueEntry()` from `lib/queue-entry.ts` so every surface reads the same columns. |
| `QueueCardActions` | Send now / Regenerate / Delete (two-step, auto-disarming) |
| `StatusBadge` | `DeliveryStatus` → colour |
| `ClientControls` | Client detail + demo. 5 mutations with dirty-state, save, revert, saved-flash. |
| `ImageSizeSelect` | Onboarding dialog + client controls. Grouped picker with off-brand and soft-photo advisories. |
| `SeedCalendarButton` | Client matrix + detail + demo |
| `CreateClientDialog` | Clients page + demo page (`demo` prop flips copy and sets `isDemo`) |
| `SystemNotices` | `ConfigWarning` + `DatabaseErrorState` |
| `ClientRoster` | Read-only tenant breakdown (dashboard drill-down) |
| `ClientMatrix`, `PlanManager`, `CategoryManager`, `SpendPanel`, `CalendarImportPanel`, `DemoCreativePanel` | Page-specific |

### The `useAction` hook — `src/hooks/use-action.ts`

**The single pattern for calling a server action from a client component.**

```tsx
const save = useAction(updateClientCronTime);
// save.run(...args) → Promise<ActionResult<T>>
// save.pending, save.error, save.fieldErrors, save.reset()
```

Server actions never throw, but a transport-level failure (dropped connection, deploy mid-request) still rejects — that case is normalised into the same error channel.

> **Read the comment at `use-action.ts:27`.** The mount effect must *re-arm* the flag in its setup body, not only clear it in cleanup: React StrictMode mounts → unmounts → remounts every effect in development, so an effect that only ever sets `false` leaves the ref latched off from the first render, and every `finally` skips `setPending(false)` — spinning a button forever on an action that succeeded.

### Shared library conventions

- **Narrowing untrusted JSON:** `parseBrandGuideline` and `parsePosterCopy` are the single narrowing points for their columns. Both **never throw**; partial records degrade to empty/null rather than crashing a page.
- **Money:** always integer USD micros. Format with `formatUsd` / `formatInr` / `formatTokens`, never manual `toFixed`.
- **Dates:** always through `lib/time.ts`. **Use `addZonedDays`, not `addDays`**, for anything the dispatcher later matches against a day window — adding exact 24 h multiples drifts across a DST transition by enough to push a row into the neighbouring local day.
- **Queue projections:** always `queueSelect` + `toQueueEntry`.

### Coding conventions observed throughout

1. **Comments explain *why*, never *what*.** Nearly every non-obvious line carries a rationale. Match this — it is the codebase's greatest asset.
2. **Server actions return `ActionResult`, never throw.**
3. **Zod at every boundary** — server actions, route handlers, JSON columns, LLM responses.
4. **`export const dynamic = 'force-dynamic'`** on every admin page.
5. **Import order:** node builtins → external → `@/` internal → relative. Enforced by convention, not tooling.
6. **Named exports** everywhere except Next.js page/layout defaults and `BrandCanvasView`.
7. **`interface` for object shapes, `type` for unions.**
8. **`as const` for lookup tables**, paired with `(typeof X)[number]` union types.
9. **Log prefixes:** `[ace:pipeline]`, `[ace:cron]`, `[ace:llm]`, `[ace:poster]`, `[ace:drive]`, `[ace:usage]`, `[ace:admin]`, `[ace:razorpay]`, `[ace:calendar]`, `[ace:onboarding]`, `[ace:poster-preview]`. Keep them greppable.
10. **Section dividers:** `// ---------------------------------------------------------------------------` above each block in long files.
11. **Client components** are marked `'use client'` and kept as small leaves; pages stay server components.
12. **`noUncheckedIndexedAccess` is on** — array access yields `T | undefined`. Existing code uses `!` only where an invariant is proven (e.g. `PRESETS_BY_ID.get(DEFAULT_IMAGE_SIZE_ID)!`, non-null by construction).

---

## 20. Dependencies

### Production

| Package | Version | Used for | Notes |
| --- | --- | --- | --- |
| `next` | 14.2.35 | Framework | App Router |
| `react` / `react-dom` | 18.3.1 | UI | |
| `@prisma/client` | 5.17.0 | DB client | Must match `prisma` exactly |
| `zod` | ^3.25.0 | Validation | Every boundary |
| `openai` | ^6.49.0 | LLM | Structured Outputs |
| `googleapis` | ^140.0.1 | Drive v3 | **In `serverComponentsExternalPackages`** |
| `satori` | ^0.10.14 | JSX → SVG | Cannot read WOFF2 |
| `@resvg/resvg-js` | ^2.6.2 | SVG → PNG | **Native `.node` addon — must stay external** |
| `@radix-ui/react-dialog` | ^1.1.1 | Dialog | |
| `@radix-ui/react-label` | ^2.1.0 | Label | |
| `@radix-ui/react-select` | ^2.1.1 | Select | |
| `@radix-ui/react-slot` | ^1.1.0 | `asChild` | |
| `lucide-react` | ^0.414.0 | Icons | |
| `class-variance-authority` | ^0.7.0 | Variants | |
| `clsx` + `tailwind-merge` | ^2.1.1 / ^2.4.0 | `cn()` | |
| `tailwindcss-animate` | ^1.0.7 | Animations | |

### Development

`typescript` ^5.5.4 · `prisma` 5.17.0 · `tailwindcss` ^3.4.6 · `eslint` ^8.57.0 · `eslint-config-next` 14.2.35 · `postcss` ^8.4.39 · `autoprefixer` ^10.4.19 · `@types/{node,react,react-dom}`

### Scripts

| Script | Command |
| --- | --- |
| `dev` | `next dev` |
| `build` | `prisma generate && next build` |
| `start` | `next start` |
| `lint` | `next lint` |
| `typecheck` | `tsc --noEmit` |
| `prisma:generate` / `prisma:push` / `prisma:migrate` / `prisma:studio` | Prisma CLI |
| `postinstall` | `prisma generate` |

### Upgrade cautions

- **`@prisma/client` and `prisma` must move together.**
- **`satori` major bumps** change the supported CSS subset; re-verify all eight archetypes on the preview page.
- **`@resvg/resvg-js`** is platform-specific — verify on both the dev OS and the deploy target.
- **`next` 15** requires `searchParams`/`params` to be awaited Promises in pages. Every admin page here uses the Next 14 synchronous form and would need updating.
- **`zod` v4** has breaking changes to `.default()` and error formatting; `toFailure` reads `error.flatten().fieldErrors`.

---

## 21. Important files & their purpose

Ranked by how much a new developer needs them.

### Must read first

| File | Lines | Why |
| --- | --- | --- |
| `README.md` | 381 | Exceptional operator + developer guide. Read it before the code. |
| `docs/creative-style-spec.md` | 226 | **The layout bible.** Every number in `metrics.ts` traces back here. |
| `prisma/schema.prisma` | 176 | The data model, heavily commented with rationale. |
| `src/lib/ai-pipeline.ts` | 701 | The orchestrator. Understand this and you understand the product. |
| `src/app/admin/dashboard/actions.ts` | 894 | Every mutation in the system. |

### Core runtime

| File | Lines | Purpose |
| --- | --- | --- |
| `src/lib/cron-worker.ts` | 158 | Dispatch sweep, minute-window selection, bounded concurrency |
| `src/lib/onboarding.ts` | 194 | `provisionClient` — shared by webhook and manual path; idempotent |
| `src/lib/google-drive.ts` | 198 | Drive v3: folders, upload, publish, trash, thumbnails |
| `src/lib/time.ts` | 171 | Timezone-correct helpers. **`addZonedDays` vs `addDays` matters.** |
| `src/lib/env.ts` | 80 | Lazy typed env access + config-gap detection |
| `src/lib/prisma.ts` | 23 | Singleton, `globalThis`-cached for dev hot reload |
| `src/lib/usage.ts` | 119 | Ledger writers. **Fire-and-forget by design** — a failed insert must never turn a successful generation into a pipeline failure. |
| `src/lib/pricing.ts` | 123 | Rate card, USD-micros maths, money formatting |
| `src/lib/cost-report.ts` | 343 | Spend aggregation via grouped SQL sums |
| `src/lib/queue-entry.ts` | 60 | Shared `ContentCalendar` projection |
| `src/lib/image-sizes.ts` | 485 | 33 output presets + fal render limits + resolution rules |

### AI layer

| File | Lines | Purpose |
| --- | --- | --- |
| `src/lib/ai/openai.ts` | 285 | Structured-Outputs wrapper, error taxonomy, retry policy, billing |
| `src/lib/ai/calendar-generator.ts` | 307 | Batched sequential seeding with prompt-cache-friendly prefix |
| `src/lib/ai/brand-tokenizer.ts` | 163 | Brand material → design tokens |
| `src/lib/ai/poster-copy.ts` | 117 | Single-day backfill |
| `src/lib/ai/poster-prompt.ts` | 86 | **Shared contract** — keeps generator and backfill identical |

### Poster layer

| File | Lines | Purpose |
| --- | --- | --- |
| `src/lib/poster/archetypes.tsx` | ~1,460 | The eight compositions + wide/letterbox adaptations |
| `src/lib/poster/slots.tsx` | 757 | Logo, eyebrow, headline, accent rule, body, features, contact bar |
| `src/lib/poster/render.tsx` | 326 | Entry point: satori + resvg, logo fetch/cache, identity formatting |
| `src/lib/poster/theme.ts` | 321 | Brand tokens → measured, contrast-corrected `PosterTheme` |
| `src/lib/poster/metrics.ts` | 261 | Spec px → canvas px; canvas modes; headline fitting |
| `src/lib/poster/fonts.ts` | 285 | Font bytes; **the legacy UA header is load-bearing** |
| `src/lib/poster/color.ts` | 219 | Contrast ratio, luminance, HSL, accent scoring |
| `src/lib/poster/icons.tsx` | 210 | 16 monoline icons in a 24-unit viewBox |
| `src/lib/poster/image-info.ts` | 299 | Dimension reader for PNG/JPEG/WebP/GIF/SVG |
| `src/lib/poster/photo-request.ts` | 86 | Archetype → fal.ai render size |
| `src/lib/poster/placeholder-photo.ts` | 214 | Procedural photo so previews cost nothing |
| `src/lib/types/poster.ts` | ~400 | `PosterCopy` / `PosterTheme` / `PosterSpec`, archetypes, `coercePosterCopy` |
| `src/lib/types/brand.ts` | 112 | `BrandGuideline` schema + salvaging parser |

### Import layer

| File | Lines | Purpose |
| --- | --- | --- |
| `src/lib/calendar-parse.ts` | 1077 | **Isomorphic** sheet parser — zod only, safe in the browser bundle |
| `src/lib/calendar-import.ts` | 317 | Pure write planner + chunked transactional writes |
| `src/components/admin/CalendarImportPanel.tsx` | 672 | Browser dry-run panel |

### Configuration

| File | Purpose |
| --- | --- |
| `.env.example` | The authoritative variable reference — 124 documented lines |
| `next.config.mjs` | `serverComponentsExternalPackages` (do not remove `@resvg/resvg-js`) |
| `vercel.json` | Cron schedule + `maxDuration` (both need Pro) |
| `tailwind.config.ts` | Brand tokens + micro-3D plugin |
| `evokz-architecture-blueprint.md` | Original scaffold spec — historical provenance only |

---

## 22. Local development & troubleshooting

### First run

```bash
cd "Documents/Evokz/evokz"
mv ../.env .            # ← fixes §17.2
npm install             # also runs prisma generate
npm run prisma:push
npm run dev             # http://localhost:3000/admin/dashboard
```

Seed at least one **Plan** and one **Category** from the console before onboarding anyone — provisioning validates both foreign keys, and the onboarding dialog is disabled without them.

### Verification loop

```bash
npm run typecheck   # tsc --noEmit    — currently 0 errors
npm run lint        # next lint       — currently 0 warnings
npm run build       # prisma generate && next build
npm run prisma:studio   # browse/seed data
```

Both checks pass clean as of this audit. **Keep them clean.**

### Documented gotchas (from the README, all real)

**Stop the dev server with Ctrl+C, never a hard kill.** A hard kill leaves `.next` half-written; the next start then fails with `Cannot find module '.next/server/middleware-manifest.json'` or `Cannot find module './vendor-chunks/lucide-react.js'` and **every route 500s** even though `tsc` and `next build` pass. Killing the `npm` wrapper also orphans the `next dev` child, which keeps holding the port.

Recovery (also the fix for a `next build` / `next dev` collision — they share `.next`):

```powershell
# stop any orphans, then:
Remove-Item -Recurse -Force .next, node_modules/.cache
npm run dev
```

> On Windows use PowerShell's `Remove-Item`, **not** Git Bash `rm -rf` — the latter silently skips locked files and leaves the directory in the same broken state.

**`prisma generate` fails with `EPERM … query_engine-windows.dll.node`** while the dev server is running, because the engine DLL is loaded. Stop the server first, or ignore it when the client is already generated.

### Debugging playbook

| Symptom | Where to look |
| --- | --- |
| Nothing delivers | Is there a calendar? (`calendarCount` on the matrix) · Is the client `isActive` and not `isDemo`? · Is `cronTime` inside `CRON_WINDOW_MINUTES`? · Is today inside `[startDate, endDate]`? · Check `/api/cron` output. |
| Delivery fails at `generate` | fal.ai. Check `FAL_KEY`, `FAL_MODEL_ENDPOINT`, and the persisted `errorMessage` for the HTTP status. |
| Delivery fails at `compose` | Fonts or logo. `Unsupported OpenType signature wOF2` → the legacy UA header was dropped. A logo error → check the Drive link is shared link-readable (an unshared link returns an HTML interstitial with a 200). |
| Delivery fails at `upload` | Drive. Is the vault folder shared with the service account as Content manager? Is `gDriveFolderId` set? |
| Delivery fails at `broadcast` | Evolution. Is `EVOLUTION_API_KEY` the **per-instance** token, not the admin key? Is the instance connected? |
| Calendar generation truncates | `finish_reason: 'length'` → lower `CALENDAR_BATCH_SIZE` or raise `OPENAI_MAX_TOKENS`. |
| Every batch re-bills full input tokens | Watch `cached=` in `[ace:llm]` logs. Something day-specific has leaked into `systemPrompt`, invalidating the shared prefix. |
| Poster layout looks wrong | `/admin/poster-preview?clientId=…&day=…`. Add `&debug=1` to the API route for a stack trace — satori reports faults tersely and without naming the element responsible. |
| Slots missing from a poster | Check `X-Poster-Dropped` header / the preview page's canvas-mode warning. A `letterbox` canvas drops body, features and eyebrow by design. |
| Contrast looks bad | The preview page runs `auditTheme` and lists pairings still below target after correction. |
| Spend numbers look wrong | The panel prints the rate card it used. Compare against the real invoice; `PRICE_*` may be unset and defaulting. |
| Dashboard banner lists unset keys | §17.2 — the `.env` is probably still in the parent directory. |

---

## 23. Onboarding checklist for the new developer

### Day 1 — orient

- [ ] Read `README.md` end to end (381 lines, worth every minute)
- [ ] Read `docs/creative-style-spec.md` (226 lines — it explains *why* the poster layer exists)
- [ ] Read this document's §3 (architecture), §11 (pipeline), §17 (known issues)
- [ ] Skim `prisma/schema.prisma` — the comments carry the design rationale

### Day 1 — get it running

- [ ] **Move `.env` into `evokz/`** (§17.2)
- [ ] `npm install && npm run prisma:push && npm run dev`
- [ ] Confirm the dashboard's config banner is empty
- [ ] Create a Plan and a Category
- [ ] Create a demo tenant with **your own** WhatsApp number
- [ ] Extract brand tokens from any company's website copy
- [ ] Fire one **Instant creative** — watch it land on your phone

That last step exercises the entire stack: OpenAI → fal.ai → satori/resvg → Drive → Evolution. If it works, everything works.

### Week 1 — trace the code

- [ ] Follow one calendar row through `runCreativePipeline` with a debugger
- [ ] Open `/admin/poster-preview`, switch archetypes and presets, watch the canvas mode change
- [ ] Read `lib/types/poster.ts` — the three-shape separation is the key abstraction
- [ ] Read `lib/poster/theme.ts` — understand why role labels are hints, not instructions
- [ ] Do a bulk import with the "content + poster columns" template; deliberately break a cell and watch the dry-run report it

### Week 1 — first contributions (ordered by value)

1. **Add authentication** (§17.1) — nothing else should ship first
2. **Fix the `.env` location** and document it in the README (§17.2)
3. **Wire `image_size` in the Razorpay webhook** — a 1-line fix for a documented feature (§17.3)
4. **Baseline Prisma migrations** (§17.7)
5. **Add tests** for `lib/time.ts`, `lib/pricing.ts`, `lib/types/poster.ts` — all pure, all high-value (§17.5)
6. **Pass `imageSizePreset` on the demo page** (§17.13)

### Mental models to internalise

1. **`ContentCalendar` is the fuel.** No rows → no deliveries, silently, forever.
2. **The photo is a background with a mandated empty region**, never the finished creative. All text is composited.
3. **Two sizes exist:** the output canvas (from the preset) and the background photo (from the archetype). They are not the same thing.
4. **`GENERATED` is a real checkpoint** so a WhatsApp failure never re-bills fal.ai.
5. **Determinism is a feature.** Archetype derivation, layout scaling, and re-renders must all reproduce. An operator comparing a retry against the original must not see a difference that isn't there.
6. **Everything degrades rather than fails**, except where a wrong result would reach a paying client's WhatsApp — then it fails loudly with a readable reason.
7. **The comments explain *why*.** When you change something, update the *why*, not just the code.

---

*Generated from a complete end-to-end audit of the repository at commit `c9e4c41` on 2026-08-03. Typecheck and lint verified passing at time of writing.*
