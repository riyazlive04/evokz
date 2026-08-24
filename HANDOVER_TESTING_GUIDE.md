# Evokz ACE — Handover & Testing Guide

> **Superseded 2026-08-23.** The fifteen built-in archetypes were removed; every poster is
> now drawn from a reference template uploaded to the client's vertical and approved by an
> operator. Passages below describing archetypes, `posterArchetype`, the `theme` import
> column or `/admin/poster-preview` are history. See README § Layouts and
> docs/creative-style-spec.md §7.

**For:** the developer taking over testing, bug-hunting and fixes
**Written:** 2026-08-04
**Companion to:** [`PROJECT_KNOWLEDGE_BASE.md`](PROJECT_KNOWLEDGE_BASE.md)

---

## How to use these two documents

| Document | Covers |
| --- | --- |
| `PROJECT_KNOWLEDGE_BASE.md` | The **whole system** — architecture, DB schema, every API, every module, deployment. Reference material. |
| **This file** | **Getting running, what changed recently, the two flows you'll test most (poster generation and WhatsApp send), a costed test plan, and where the bugs are likely to be.** |

Read this one first. Dip into the knowledge base when you need depth on a subsystem.

---

## 1. What this product does

> One payment turns into a year of daily branded WhatsApp posts, with nobody opening a design tool.

Clients **never log in**. They only receive WhatsApp messages. `/admin` is entirely internal.

```
Plan + Vertical ─▶ Client onboarded ─▶ Brand tokens ─▶ Content calendar
                                                              │
                                          cron every 5 min ───┤
                                                              ▼
              fal.ai photo ─▶ poster composited ─▶ Google Drive ─▶ WhatsApp
```

**The single most important fact:** onboarding does **not** create content. A paid, provisioned client with an empty calendar delivers nothing, silently, forever. Steps 1–4 are manual and one-off per client; 5–7 run unattended.

---

## 2. Get running (10 minutes)

### Prerequisites
Node 20+, Docker Desktop, and the `.env` file (already in place at `evokz/.env`).

### Database

Postgres runs in Docker, **not** natively:

```bash
docker start evokz_ace_postgres          # container already exists
docker ps --filter name=evokz_ace_postgres
```

| | |
| --- | --- |
| Container | `evokz_ace_postgres` (postgres:16-alpine) |
| Port | **5599** → 5432 |
| Database / role | `evokz_ace` / `evokz` |
| Volume | `evokz_ace_pgdata` |

> ⚠️ **Never point Evokz at port 5432.** That is `alshifa_postgres`, a **live production database for a different project**. The two got confused once already. Evokz is 5599 and only 5599.
>
> There is also an old `evokz_pgdata` volume from a **predecessor** project (superuser `poster`, database `poster`, tables `Poster`/`Inspiration`/`SendLog`). It is unrelated — do not mount it.

### App

```bash
cd evokz
npm install
npm run dev -- -p 3002        # pin the port; other projects use 3000/3001
```

→ **http://localhost:3002/admin/dashboard**

### Sanity checks

```bash
npm run typecheck      # must be 0 errors
npm run lint           # must be 0 warnings
npm run lint:colors    # design-token guard (see §3)
```

All three are clean as of handover. **Keep them clean.**

### Local dev gotcha that will bite you

Stop the dev server with **Ctrl+C, never a hard kill.** A hard kill leaves `.next` half-written and every route 500s even though `tsc` passes. Recovery:

```powershell
Remove-Item -Recurse -Force .next, node_modules/.cache
npm run dev -- -p 3002
```

Use PowerShell `Remove-Item`, **not** Git Bash `rm -rf` — the latter silently skips locked files.

---

## 3. What changed recently

**36 files changed, ~875 insertions.** Two workstreams.

### 3A. Navy & sand theme with light/dark modes

The console was indigo/cyan with **no real dark mode** — `dark` was hardcoded on two elements and `<html>` never received it.

| Change | Where |
| --- | --- |
| Full token palette, both modes | `src/app/globals.css` |
| Sand `#cdaa80` is `--primary` in **both** modes | Constant accent = one product, not two themes |
| Status tokens `success` / `warning` / `danger`, three tiers each | `DEFAULT` fill · `foreground` ink-on-fill · **`ink`** ink-on-page |
| `--scrim` — fixed-dark overlay that never flips | For overlays on generated creatives |
| Literal `navy-*` / `sand-*` ramps | Only for deliberately theme-invariant surfaces |
| Theme toggle, dependency-free | `src/components/admin/ThemeToggle.tsx` |
| Pre-paint script (no flash on reload) | `src/app/layout.tsx` |
| 130 hardcoded colours → 0 | 21 files |
| Guard script | `scripts/lint-colors.mjs` |

**The rule you must follow:** every colour comes from a semantic token. `npm run lint:colors` fails on raw Tailwind palette names. Use `text-danger-ink`, `bg-warning/10`, `border-success/25`, `text-brand-to`, `bg-primary`.

**One contrast trap worth knowing:** sand on white is **2.17:1** — unusable as text. So `--brand-to` resolves to bronze `#7d6244` in light mode and true sand in dark. True sand stays available as `--primary` for *fills*. All 24 pairings were verified against the shipped CSS; tightest is 4.73:1.

**Incidental fix:** `--font-inter` was declared but never wired into Tailwind's `fontFamily`, so **Inter had never actually applied**. It does now — the console's typography genuinely changed.

### 3B. Seven functional gaps closed

A full walk-through found **no broken buttons** — all 22 server actions wired, cron auth working, all poster archetypes rendering (five at the time of the audit; eight now). It found seven pieces of *missing logic*:

| # | Gap | Fix | Files |
| --- | --- | --- | --- |
| 1 | Razorpay `image_size` parsed then discarded | Now applied | `api/webhooks/razorpay/route.ts` |
| 2 | Demo tenants couldn't set output size | Prop wired | `admin/demo/page.tsx` |
| 3 | **Nothing warned when seeding without brand tokens** | Amber warning + confirm | `SeedCalendarButton.tsx` + 3 render sites |
| 4 | No way to clear a calendar | `clearClientCalendar` | **`ClientDangerZone.tsx`** (new) |
| 5 | No way to delete a client | `deleteClient` | **`ClientDangerZone.tsx`** (new) |
| 6 | Plan/vertical immutable after onboarding | Guarded change | **`ClientAssignment.tsx`** (new) |
| 7 | No bulk retry | `retryFailedDeliveries` | **`RetryFailedButton.tsx`** (new) |

**Why #3 mattered:** the generator folds the palette, typography and layout directives into every image prompt. Seed before tokenizing and you get a year of generic copy — and re-seeding **cannot** fix it, because `createMany({ skipDuplicates: true })` only fills empty days. Fixes #3 and #4 exist as a pair: the warning prevents the mistake, the clear undoes it.

**A latent bug found while building #6:** nothing had *ever* rewritten `endDate` after provisioning. So lengthening a plan silently didn't extend the campaign — the dispatcher kept using the old window. `updateClientPlan` now recomputes it.

> **Still open (not in the seven):** `PlanManager` lets you edit `durationDays` on an existing plan, which leaves every attached client's `endDate` stale by the same mechanism. **Good first bug for the new dev.**

---

## 4. Poster generation — deep dive

### Why this layer exists at all

**The delivered creative is a composite, not a diffusion render.** fal.ai produces *only the background photograph*. Every readable element — logo, headline, body, icon features, contact bar — is typeset over it as real vector glyphs.

> Diffusion models cannot spell, and the contact bar carries the client's **actual phone number and domain**. A misspelt headline is embarrassing; a wrong phone number delivered daily to a paying client is a refund.

Hence the rule enforced in every prompt: **never ask the image model for text.**

### The flow

```
ContentCalendar row          Client record              fal.ai
  ├ posterCopy (JSON)          ├ brandGuideline           └ background photo
  ├ imagePrompt                ├ logoUrl                        │
  └ posterArchetype            ├ brandTagline                   │
        │                      ├ websiteUrl                     │
        │                      └ displayPhone                   │
        ▼                            ▼                          ▼
   PosterCopy  ────┐          PosterTheme            PosterPhoto
   (content)       ├──────▶   (styling)     ──▶  PosterSpec  ──▶ archetype JSX
   PosterIdentity ─┘                                                  │
                                                          satori ─────┤ SVG
                                                          resvg  ─────▼ PNG
```

**Three shapes, deliberately separate** (`src/lib/types/poster.ts`):

| Type | What | Why separate |
| --- | --- | --- |
| `PosterCopy` | Slot **content** only | Lets one day's copy render in any archetype |
| `PosterTheme` | **Styling** only | Lets one client's theme apply to all 365 days |
| `PosterSpec` | The two joined + identity + photo | An archetype reads this and nothing else |

### The eight archetypes

From `docs/creative-style-spec.md`. The first five are reverse-engineered from 12 competitor reference posters; the last three are *derived*, added because five layouts cycling by day number reads as repetitive over a 30-day campaign.

| Archetype | Composition | **Photo shape** |
| --- | --- | --- |
| `scrim` | Full-bleed photo, dark gradient over the copy side | portrait |
| `diagonal` | Solid panel left, photo right, diagonal boundary | portrait |
| `bands` | Three stacked horizontal bands | **landscape** |
| `curve` | Light field, dark curved sweep from bottom-left | **landscape** |
| `editorial` | High-key light field, photo dissolving in | portrait |
| `spotlight` | Full-bleed photo under an *even* wash, copy centred down the frame | portrait |
| `corner` | Light field, photo a tall inset panel filling the right half | portrait |
| `inverted` | Photo band across the top 30%, all copy below it | **landscape** |

**Selection is deterministic**, never random (`archetypeForDay`). The stride is *computed*, not written down — the smallest step above 1 coprime with the set size, so the walk always visits every archetype:

```ts
const stride = 3;                          // gcd(3,8)=1 → full cycle before repeat
const index = ((dayNumber - 1) * stride) % 8;
```

Day 1 onward: `scrim`, `curve`, `corner`, `diagonal`, `editorial`, `inverted`, `bands`, `spotlight`.

> Re-rendering day 47 after a failure must reproduce the layout the first attempt produced. Otherwise an operator comparing a retry against the original sees a difference that isn't there.

### ⚠️ The most misunderstood part: two different sizes

| | Set by | Purpose |
| --- | --- | --- |
| **Output canvas** | `Client.imageSizePreset` | The delivered file's exact pixel size |
| **Background photo** | **The archetype**, not the preset | Only has to cover the region the archetype gives it |

`bands`, `curve` and `inverted` place the photo in a **landscape band**. Ask fal for a 9:16 portrait and cover-fit it into a short wide box and you discard two thirds of the frame — usually decapitating the subject.

See `src/lib/poster/photo-request.ts`. **If posters look badly cropped, start here.**

### Slot skeleton (never reordered)

```
1. LOGO LOCK       top-left, always
2. TAGLINE         optional, letterspaced caps
3. HEADLINE        2–4 lines, ALL CAPS, exactly one line in accent colour
4. ACCENT RULE     120×6px bar — does most of the "designed" signalling
5. BODY            3–5 lines, ~34-char measure
6. FEATURES        2–4 items, monoline circled icon + label + body
7. HERO PHOTO      archetype-dependent region
8. CONTACT BAR     full-bleed bottom: phone left, website right
```

### Canvas modes — when the preset isn't portrait

| Mode | Aspect (w/h) | Behaviour | Dropped |
| --- | --- | --- | --- |
| `tall` | ≤ 0.82 | As designed | none |
| `wide` | > 0.82 | Copy left column, photo right | none |
| `letterbox` | > 2.2 | Logo + headline + contact only | body, features, eyebrow |

Dropped slots are **named** in logs and on the preview page — a letterbox poster that quietly omits the feature block looks intentional, and nobody discovers the preset was wrong.

### Theme resolution — why role labels are ignored

The tokenizer emits free-text roles ("primary", "brand blue", "cta") that are **frequently mislabelled**. So `src/lib/poster/theme.ts` treats labels as a *hint* and assigns by **measurement** (saturation, lightness, contrast), then contrast-corrects everything that carries text:

| Field | Target | Why |
| --- | --- | --- |
| `onDark` / `onLight` | 7:1 | Spec headline requirement |
| `accentOnDark` | 4.5:1 | Cool accent `#1546A0` on navy `#0B1E3D` is ~1.6:1 — invisible |
| `onAccent` | — | Contact bar fills with accent; wrong here = unreadable phone number |

`auditTheme()` reports pairings still failing *after* correction — surfaced on the preview page as an account conversation, not a bug.

### Fonts — the load-bearing hack

Satori has **no access to system fonts**; every face must be handed over as bytes.

> `fonts.googleapis.com/css2` sniffs the User-Agent and serves **woff2** to anything modern. Satori's parser reads TTF/OTF/WOFF but **not woff2**. The loader sends a deliberately old UA to force a parseable format. **Remove that header and every render fails** with `Unsupported OpenType signature wOF2`.

Set `POSTER_FONT_DIR` in production so the render path has no outbound dependency.

### Why not `next/og`

`ImageResponse` wraps exactly satori + resvg, but its Node build **cannot load on Windows** — it resolves wasm assets via `path.join(import.meta.url, ...)`, which mangles `file:///D:/…` into an unparseable URL. It works on Vercel's Linux, which is worse: the composition couldn't be previewed on the machine it's authored on.

`@resvg/resvg-js` is a native `.node` addon and **must** stay in `serverComponentsExternalPackages`.

---

## 5. WhatsApp send — deep dive

### The gateway

**Evolution GO**, not Evolution Node v2. This matters:

| | Node v2 (blueprint) | **Evolution GO (actual)** |
| --- | --- | --- |
| Endpoint | `POST /message/sendMedia/{instance}` | **`POST /send/media`** |
| Body | `{media, mediatype}` | **`{number, url, type, caption, filename}`** |
| Instance | Path segment | **Selected by the API key** |

> ⚠️ `EVOLUTION_API_KEY` **must be the per-instance token** (`GET /instance/all` → `data[].token`). The global admin key returns **401** on instance-scoped routes. This is the #1 cause of `broadcast`-stage failures.

### The payload

```ts
POST {EVOLUTION_API_URL}/send/media
apikey: {EVOLUTION_API_KEY}

{ number:   "919444088489",              // E.164, no "+"
  url:      "<Google Drive direct-download link>",
  type:     "image",
  caption:  "<caption>\n\n<hashtags>",
  filename: "Day_042_Creative.png" }
```

Evolution fetches the media **server-side** and carries no Google credentials — which is why `uploadClientAsset` publishes every file `{role:'reader', type:'anyone'}`.

### Deliberately not retried

```ts
// Deliberately not retried: a timeout here is ambiguous — the message may
// already have been queued — so a retry risks double-sending to the client's
// WhatsApp. The row is left FAILED for an operator to re-send.
```

fal.ai and Drive **are** retried (exponential backoff, 3 attempts, only on timeouts/408/425/429/5xx). WhatsApp is not. That asymmetry is intentional.

### 🐛 Known weakness — verify this

The call passes `tolerateEmptyBody: true`, which makes both an empty body **and an unparseable non-JSON body** count as success. A gateway returning `200` with an HTML error page would be recorded as `DELIVERED` and billed a message.

**Test it:** point `EVOLUTION_API_URL` at something returning HTML with 200 and see whether the row goes DELIVERED. If it does, that's a real bug to fix — parse Evolution GO's actual success envelope and assert on it.

---

## 6. The delivery state machine

```
PENDING ──(fal.ai → poster → Drive upload)──▶ GENERATED ──(Evolution)──▶ DELIVERED
   └──────────────── any step throws ─────────────────▶ FAILED (+ errorMessage)
```

| State | Meaning | Owns a Drive asset? | Retry cost |
| --- | --- | --- | --- |
| `PENDING` | Content written, nothing rendered | No | — |
| `GENERATED` | Image in Drive, send incomplete | **Yes** | **Free** — reuses the file |
| `DELIVERED` | Landed on WhatsApp | Yes | — |
| `FAILED` | Broke somewhere; reason on the row | **Maybe** | Depends |

> **`GENERATED` is a real checkpoint, not cosmetic.** It exists so a WhatsApp outage never makes you pay fal.ai twice.

**Pipeline stages** (the `errorMessage` is prefixed `[stage]`):

| Stage | Fails when |
| --- | --- |
| `load` | Row missing, or client has no Drive folder |
| `generate` | fal.ai — bad key, timeout, rejected prompt |
| `compose` | Fonts or logo — **satori/resvg, not fal.ai** |
| `upload` | Google Drive |
| `broadcast` | Evolution / WhatsApp |

`compose` is its own stage deliberately: attributing a font failure to `generate` sends you looking at fal.ai for a satori problem.

**Secrets are redacted** from `errorMessage` before it reaches the dashboard.

---

## 7. Test plan

### ⚠️ Rule zero

**Never test on a non-demo client.** Create a **demo tenant with your own WhatsApp number**. Demo tenants are excluded from the cron sweep, so they can never fire unattended at a prospect.

### Tier 1 — Posters, free (`/admin/poster-preview`)

Renders the real composite; only the photo is faked. **Your fastest visual feedback loop.**

| # | Test | Expect |
| --- | --- | --- |
| 1.1 | Open the page | Eight posters, one per archetype |
| 1.2 | Cycle output sizes | Reshape correctly; off-brand shapes badged amber |
| 1.3 | Pick LinkedIn banner (5.9:1) | Red warning naming dropped slots |
| 1.4 | Toggle photo tone | Background warms/cools |
| 1.5 | Toggle light/dark | Console changes, **posters identical** (server-rendered) |
| 1.6 | `?debug=1` on `/api/poster/preview` | Stack trace instead of one-line error |

### Tier 2 — Vertical, brand and domain setup (~₹2)

| # | Test | Expect |
| --- | --- | --- |
| 2.1 | `/admin/verticals` → add one | Appears; delete blocked while in use |
| 2.2 | `/admin/demo` → New demo tenant, **your number**, 30-day plan | Drive folder auto-provisioned |
| 2.3 | Read the **Setup progress** strip at the top | Three steps, each ✔ or pending |
| 2.4 | **Brand identity** card → **Configure** | Opens the brand page with a "Back to demo workspace" link |
| 2.5 | Set logo, tagline, **website domain**, phone → back to demo | Card now shows four ✔ |
| 2.6 | Brand canvas → paste site copy → Extract tokens | 3–6 swatches, fonts, layout directives |
| 2.7 | Preview → Brand → your tenant | Their palette; **domain and phone correct in the contact bar** |

> **Order note:** identity and tokens are independent — you can do 2.6 before 2.4 if you want to show a prospect their palette immediately. What *does* matter is that **both come before generating a calendar**.

> 2.5 is the key check: confirm brand + vertical + domain all landed **before** spending on fal.ai.

### Tier 3 — Real image, real WhatsApp (~₹0.30)

`/admin/demo` → **Instant creative**. Use an image prompt that reserves negative space:

```
Modern flat-roof luxury villa at dusk, warm interior lights through
floor-to-ceiling glass, subject pushed to the right, clear open sky
filling the upper left, golden hour, cinematic
```

**Verify on the delivered image:**

| Check | Proves |
| --- | --- |
| Headline spelled correctly | Text is vector, not diffused |
| Phone + domain exactly as typed | The refund-risk check |
| Logo present, not a wordmark | Logo fetch worked |
| Brand colours applied | Tokens reached the renderer |
| **No text inside the photo** | Image-prompt rule held |
| File in Drive vault | Storage sync works |

### Tier 4 — Calendar & dispatch (~₹1)

| # | Test | Expect |
| --- | --- | --- |
| 4.1 | Generate 30 days (**not 365**) | ~1 min; no warning, since you tokenized |
| 4.2 | Read 3 captions + 3 image prompts | On-vertical; prompts reserve negative space |
| 4.3 | `curl -H "Authorization: Bearer $CRON_SECRET" localhost:3002/api/cron` | `matchedClients: 0` — **demo correctly skipped** |
| 4.4 | Cron with no auth | `401` |

### Tier 5 — The seven new fixes (free)

| # | Test | Expect |
| --- | --- | --- |
| 5.1 | Seed on a client with **no** tokens | Amber warning + "Generate anyway" confirm |
| 5.2 | Seed on a tokenized client | Runs straight away |
| 5.3 | Operations → change vertical | Saves; notes seeded days keep old copy |
| 5.4 | 30-day plan, 30 days seeded → switch to 365 | Allowed; end date moves |
| 5.5 | Switch **back** to 30-day | **Refused**, naming the count |
| 5.6 | Danger zone → Clear unsent days | Removes pending/failed, reports kept |
| 5.7 | Retry 5.5 | Now succeeds |
| 5.8 | Danger zone → wrong name typed | Delete stays disabled |
| 5.9 | Correct name → delete | Redirects; Drive folder **in the bin** |
| 5.10 | Dashboard spend panel | Spend survives as "Removed clients" |

**Run 5.4 → 5.5 → 5.6 → 5.7 as a sequence** — it demonstrates why those fixes shipped together.

### Total cost of a full pass: **under ₹5**

---

## 8. Where the bugs probably are

Ranked by likelihood × impact. **These are leads, not confirmed defects.**

### High

| Area | What to probe |
| --- | --- |
| **Evolution success detection** | §5 — does a 200-with-HTML get recorded as DELIVERED? |
| **Seed is all-or-nothing** | `generateContentCalendar` accumulates all batches and writes **once at the end**. Kill the server at batch 30 of 37 — you should lose everything. Verify, then consider per-batch persistence. |
| **Seed would die in production** | One server action for ~15 min. `vercel.json` raises `maxDuration` only for `/api/cron` and the webhook, **not server actions**. |
| **`PlanManager` staleness** | Edit a plan's `durationDays` → attached clients' `endDate` goes stale. Confirmed unfixed. |

### Medium

| Area | What to probe |
| --- | --- |
| **No pagination anywhere** | Hard caps: 24 upcoming, 8 failures, 60 drill-down. The client-matrix search filters **only loaded rows** — at 50+ clients it silently searches a partial list. |
| **Orphaned Drive files** | `deleteCalendarEntry` leaves the asset. So does import-overwrite. Vault grows unboundedly. |
| **Poster preview is unauthenticated** | Full CPU-bound render, no rate limit, and `?clientId=` leaks brand identity. |
| **Duplicate clients** | `whatsappNumber` has no unique constraint. Same number + different plan = two live clients both delivering. |
| **DST** | `addZonedDays` is used for `scheduledDate`, but `addDays` (not DST-aware) for `endDate`. Probe a campaign spanning a DST change. |

### 🔴 Not a bug — a deployment blocker

**There is no authentication.** No middleware, no session, no user model. `/` redirects straight to `/admin/dashboard`. Because Next.js Server Action IDs ship in the public bundle, **every action is invocable by any anonymous visitor** — including ones that spend money and send WhatsApp messages.

Fine on localhost. **Do not expose this to the internet.** See `PROJECT_KNOWLEDGE_BASE.md` §8.

---

## 9. Debugging playbook

| Symptom | Look at |
| --- | --- |
| Nothing delivers | Calendar exists? Client `isActive` and **not** `isDemo`? `cronTime` inside `CRON_WINDOW_MINUTES`? Today inside `[startDate, endDate]`? |
| Fails at `generate` | fal.ai — `FAL_KEY`, endpoint, HTTP status in `errorMessage` |
| Fails at `compose` | `Unsupported OpenType signature wOF2` → the legacy UA header was dropped. Logo error → Drive link not shared link-readable (an unshared link returns **HTML with a 200**) |
| Fails at `upload` | Vault folder shared with the service account as Content manager? |
| Fails at `broadcast` | **Per-instance token**, not the admin key |
| Calendar generation truncates | `finish_reason: length` → lower `CALENDAR_BATCH_SIZE` or raise `OPENAI_MAX_TOKENS` |
| Every batch re-bills full input | Watch `cached=` in `[ace:llm]` logs — something day-specific leaked into the system prompt |
| Poster looks wrong | `/admin/poster-preview?clientId=…&day=…`, then `&debug=1` on the API route |
| Slots missing | `X-Poster-Dropped` header / canvas-mode warning — letterbox drops them by design |
| Colours look off | The preview page runs `auditTheme` and lists failures |

**Log prefixes** (all greppable): `[ace:pipeline]` `[ace:cron]` `[ace:llm]` `[ace:poster]` `[ace:drive]` `[ace:usage]` `[ace:admin]` `[ace:razorpay]` `[ace:calendar]`

**Useful queries:**

```bash
# state of play
docker exec evokz_ace_postgres psql -U evokz -d evokz_ace -c \
 'SELECT "deliveryStatus", COUNT(*) FROM "ContentCalendar" GROUP BY 1;'

# recent failures with their stage
docker exec evokz_ace_postgres psql -U evokz -d evokz_ace -c \
 'SELECT "dayNumber", LEFT("errorMessage",90) FROM "ContentCalendar"
  WHERE "deliveryStatus"='"'"'FAILED'"'"' ORDER BY "updatedAt" DESC LIMIT 10;'

# spend
docker exec evokz_ace_postgres psql -U evokz -d evokz_ace -c \
 'SELECT provider, operation, COUNT(*), SUM("costUsdMicros")
  FROM "UsageEvent" GROUP BY 1,2;'
```

---

## 10. Conventions to follow when fixing

1. **Comments explain *why*, never *what*.** This codebase's greatest asset. Match it.
2. **Server actions return `ActionResult`, never throw.** An unhandled rejection reaches the browser as an opaque digest, useless to an operator.
3. **Zod at every boundary** — actions, routes, JSON columns, LLM responses.
4. **Call `revalidateAdmin()`** after every mutation.
5. **Client components use the `useAction` hook** for pending/error state.
6. **Destructive UI reuses the two-step confirm** from `QueueCardActions.tsx` (with its auto-disarm timer).
7. **Colours must be semantic tokens.** `npm run lint:colors` enforces it.
8. **`src/lib/poster/` is a separate world** — server-side image rendering in raw hex through satori/resvg. It reads **no** CSS variables. Web-UI theme changes cannot affect delivered creatives, and vice versa.

---

## 11. Current data state at handover

| | |
| --- | --- |
| Clients | 1 — **Maruthy** (real, not demo; no brand tokens; no calendar) |
| Plans | 3 — 30-Day Pilot / 100-Day Blitz / 365-Day Scale (**all unpriced**) |
| Verticals | 3 — Real Estate / Heavy Construction / Interior Design |
| Calendar days | 0 |
| Spend to date | ~$0.03 (an aborted seed) |

**Plan prices are deliberately blank** — a commercial decision, not an oversight. Null reads as *unknown margin* rather than a misleading ₹0.

### Not yet verified

Honest disclosure — these were built but **not exercised against real data**, because doing so meant creating and destroying records:

- The stranded-days refusal on plan change (5.5)
- Client deletion end-to-end (5.9)
- Bulk retry (sends real WhatsApp messages)
- A production build (`next build`) — dev server and build share `.next`

**Start your testing there.**

---

## 12. First week suggestions

1. Run the full test plan (§7). Under ₹5, and it teaches you the system faster than reading.
2. Probe the four **High** leads in §8 and confirm or dismiss each.
3. Fix the `PlanManager` `durationDays` staleness — small, self-contained, real.
4. Add tests. There are **none**. Best first targets, all pure functions: `lib/time.ts` (DST correctness), `lib/pricing.ts` (cached-token arithmetic), `lib/types/poster.ts` (`coercePosterCopy`, `archetypeForDay` determinism).
5. Baseline Prisma migrations — the project uses `db push` with **no migration history**.
