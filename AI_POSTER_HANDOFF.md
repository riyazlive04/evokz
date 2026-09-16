# AI Poster Studio — Implementation & Handoff

Branch: `feature/ai-poster-studio` · Route: `/admin/poster-studio` · Not deployed, not merged.

Also on this branch:
- **Campaign automation, Phase 1 — data foundation** (§17): schema, migration, domain rules and tests.
- **Phase 2 — AI content calendar generation** (§18): content only. Includes the first campaign calendar UI at `/admin/clients/[clientId]/campaigns/[campaignId]`. No poster generation, template mapping, approval workflow or WhatsApp changes.
- **Phase 3 — campaign template mapping** (§19, `vertical-phase3.md`): Auto Map with preview, manual and bulk mapping, mixed mode, inactive-template handling. No poster generation.
- **Phase 4 — rolling campaign poster generation** (§20, `vertical-phase4.md`): posters for the next N days through this studio's pipeline, versioned per day. No WhatsApp or delivery changes.
- **Phase 5 — campaign review and approval** (§21, `vertical-phase5.md`): the review queue, approve / reject with a reason, fix-after-rejection, bulk approval and campaign readiness. Still nothing is delivered.
- **Phase 6 — campaign WhatsApp delivery** (§22, `vertical-phase6.md`): approved posters delivered to the client's own WhatsApp number on the campaign's schedule, once each, through the existing Evolution integration.

## 1. What it does

An admin-console tool for marketing operators to make posters with OpenAI **gpt-image-2**, optionally branded with a client's existing **Brand Canvas**:

| Mode | Input image | What is sent to the model |
| --- | --- | --- |
| **Generate** | Optional reference poster | Brief + format + (Brand Canvas guidance) + text rules + no-invented-branding rule. With a reference, the image is attached as visual inspiration only (§7). |
| **Edit** | **Required** — upload or a History item's **raw artwork** | The image + the change, applied fully, with untouched areas preserved + no-invented-branding rule. |
| **Variation** | **Required** — upload or a History item's **raw artwork** | A **small preview** of the image + the campaign's original brief + the direction + one concrete creative approach + (Brand Canvas guidance) + no-invented-branding rule (§7). |

When a client is selected, the studio loads that client's Brand Canvas and composites the **exact** logo, company name, tagline, website and phone in a deterministic identity footer — never drawn by the AI (§8).

Plus: 9:16 / 1:1 / 16:9 output, a text-free artwork option, History (latest 24), preview, download (final and raw), delete, and usage recording.

## 2. Development environment

**Database** — Docker container `evokz_ai_dev_db` from `docker-compose.dev.yml` (Postgres 16, database `evokz_ai_dev`).

- Published on **`localhost:5434`**, not 5433. A native Windows PostgreSQL 18 service (`postgresql-x64-18`) on the development machine listens on 5433 and shadows Docker's mapping.
- `.env` (untracked): `DATABASE_URL="postgresql://evokz_dev:<password from docker-compose.dev.yml>@localhost:5434/evokz_ai_dev"`. The old `localhost:5432/evokz_ace` line is commented out and must not be used.

```bash
docker compose -f docker-compose.dev.yml up -d
npx prisma migrate status     # must print: database "evokz_ai_dev" ... at "localhost:5434"
npx prisma migrate deploy
```

**Never** pass this database to `--shadow-database-url`, `prisma migrate dev`, `prisma migrate reset` or `prisma db push` — see §13.

**Drive** — the Evokz Admin Drive credentials in `.env`. Studio files go to the **"Poster Studio"** folder (`POSTER_STUDIO_DRIVE_FOLDER_ID`), one subfolder per client (`Generic` without one). The BrightSmile dev-test logo lives in `Poster Studio/Test Assets`.

**Local production build** — `next start` on this machine returns 500 for authenticated pages (pre-existing; the build compiles the middleware with the default matcher). Unrelated to the studio; local testing uses `next dev`.

## 3. Prisma migrations

| Migration | Change |
| --- | --- |
| `20260915120000_poster_studio_generation` | Enum `PosterStudioMode`, table `PosterStudioGeneration`, indexes, FKs from the new table (`clientId → Client`, `parentGenerationId → self`, both `ON DELETE SET NULL`). |
| `20260915140000_poster_studio_brand_overlay` | Enum `PosterStudioLogoBackground`; columns `finalImageDriveFileId`, `finalImageMimeType`, `overlayElements text[] default '{}'`, `overlayPreset`, `logoBackground`. |
| `20260915180000_poster_studio_footer_background` | Enum `PosterStudioFooterBackground` (`AUTO`/`LIGHT`/`DARK`); nullable columns `footerBackground` (the choice) and `footerTone` (what was drawn). |
| `20260915200000_campaign_foundation` | Campaign automation Phase 1 (§17): six enums, tables `Campaign` and `PosterVersion`, nullable/defaulted columns on `ContentCalendar` and `CategoryTemplate`, indexes and FKs. Additive; no existing column, index or constraint altered; no row updated. |

- Each generated with `prisma migrate diff --from-schema-datasource --to-schema-datamodel` against the dev database, inspected, applied with `migrate deploy`; the diff is empty afterwards.
- **Purely additive and confined to the studio table.** No existing table or column is altered; nothing is added to `Client`.
- A release needs `prisma migrate deploy`. Any database where the first studio version was created with `prisma db push` has an incompatible table; drop it before deploying.

## 4. Architecture

```
Browser (poster-studio-workspace.tsx)
  │  select client ──► loadStudioBrandCanvasAction ──► Brand Canvas panel
  │                    (summary: what exists; no Drive ids / URLs)
  │  FormData: mode, prompt, aspectRatio, clientId, textFree,
  │            sourceKind, sourceGenerationId | image,
  │            overlayElements, logoBackground, footerBackground
  ▼
generateStudioPosterAction (actions.ts)
  1. validate — Edit/Variation need an image; overlay needs a client
  2. OPENAI_API_KEY present (before any Drive or DB work)
  3. load Brand Canvas (Client + parseBrandGuideline)
  4. resolve input image: upload → sharp; history → RAW artwork from Drive
     Variation of a History item: find the lineage's original brief
  5. PRE-FLIGHT (before any spend):
       overlay: fields exist · logo readable · background mode possible ·
                explicit footer tone readable for the logo · fonts load ·
                dry-run composite
       storage: Drive folder reachable
  6. prompt (studio-prompts.ts); Variation: next creative approach
  7. renderStudioImage: images.generate | images.edit      ← spend
     (Variation sends a 512 px preview of its source)
  8. recordOpenAiImageUsage
  9. returned bytes must decode — otherwise nothing is stored
 10. composeStudioPoster: RAW + exact identity footer → FINAL
 11. store RAW, FINAL (+ new upload) in Drive, unpublished
 12. insert PosterStudioGeneration row — after this, a later failure never
     trashes files or reports "not saved"
  ▼
History (metadata only) → /api/poster-studio/{id}/image            FINAL (or RAW)
                          /api/poster-studio/{id}/image?variant=raw RAW
Logo preview            → /api/poster-studio/clients/{clientId}/logo?background=…
```

| File | Role |
| --- | --- |
| `src/app/admin/poster-studio/actions.ts` | `generateStudioPosterAction`, `loadStudioBrandCanvasAction`, `deleteStudioGenerationAction` |
| `src/app/api/poster-studio/[generationId]/image/route.ts` | Stored images: final (default), raw, reference; preview or download |
| `src/app/api/poster-studio/clients/[clientId]/logo/route.ts` | Brand Canvas logo preview, resolved server-side |
| `src/components/studio/poster-studio-workspace.tsx` | Studio UI incl. Brand Canvas panel and History |
| `src/lib/poster-studio/brand-context.ts` | Loads a client's Brand Canvas; browser-safe summary |
| `src/lib/poster-studio/brand-logo.ts` | Logo resolution (original / removed), read-only |
| `src/lib/poster-studio/compose.ts` | Deterministic identity footer + pre-flight |
| `src/lib/brand/logo-fetch.ts` | Shared guarded logo fetch + sniffing |
| `src/lib/brand/identity-format.ts` | Shared `formatPhone` / `normalizeWebsite` / `normalizeTagline` |
| `src/lib/ai/openai-images.ts`, `src/lib/ai/studio-prompts.ts` | gpt-image-2 calls; prompt builders and `VARIATION_APPROACHES` |
| `src/lib/poster-studio/{limits,images,storage,history,errors}.ts` | Limits and formats; sharp (input, Variation preview, decode check); Drive; history; errors |

## 5. Image storage — RAW and FINAL

- **No image bytes in PostgreSQL.** Rows hold Drive file ids; no base64 is stored.
- **RAW artwork** (`imageDriveFileId`): exactly what gpt-image-2 returned. **The only image ever sent back to the model** for Edit and Variation — the final would have its exact logo and contact details redrawn by the AI.
- **FINAL poster** (`finalImageDriveFileId`): RAW + the identity footer, same dimensions. Null when no overlay was drawn (then RAW is the poster). Everything above the footer is pixel-identical to RAW (verified).
- **Input** (`referenceDriveFileId`): the upload or History image sent with the request, stored at full size. For Variation the model receives a reduced copy; the stored input is not reduced.
- Drive: `Poster Studio/<client company name | "Generic">/poster-studio-<timestamp>-<mode>-raw.png` and `…-final.png`; uploads unpublished; served only via the session-gated route (`private, max-age=86400, immutable`).

## 6. OpenAI integration

- `gpt-image-2` pinned; sizes 9:16 `1152x2048`, 1:1 `1024x1024`, 16:9 `2048x1152`; quality `POSTER_STUDIO_IMAGE_QUALITY` (default `low`); 5-minute timeout; no automatic retries; operator-safe error mapping (401, 403, 404, 413, 429/quota, moderation, invalid image, size, 5xx, timeout, network).
- Low quality: ~25–40 s per image. Input tokens: ~270–550 for a text-only Generate, ~1.5k for Variation (512 px preview), ~2k for Edit or reference-guided Generate.

## 7. Generate, Reference, Edit and Variation behaviour

**Generate.** Brief, format, Brand Canvas guidance (colours, typography, feel, layout rules, industry; name and tagline as context only when the footer is drawn), text rules, no-invented-branding rule.

**Reference poster → Generate.** The uploaded reference goes through `images.edit` as *visual inspiration*: its composition approach, hierarchy, colour and lighting treatment, typographic feel and finish. The prompt forbids reproducing it or rebuilding its layout element for element, forbids copying its wording, people or products, and tells the model to ignore the reference's own identity (logos, names, taglines, contact details, QR codes, badges, seals) without inventing replacements. With a client, Brand Canvas colours and typography win where they conflict. The upload is validated (≤ 6 MB, PNG/JPEG/WebP by declared type **and** decoded format), normalised to WebP and stored; after a successful request it stays attached (as the stored copy) for reuse until removed.

**Edit.** The change is applied fully — a replaced subject, scene or large region is redrawn completely rather than blended with the old content — and every area the change does not touch is kept as it is. An edit does not remove things it was not asked to change: a logo-like mark already present in the raw artwork (from a poster generated before the branding rule existed) survives unless the instruction removes it.

**Variation.** A genuinely new creative direction for the same campaign:

1. **Small source preview.** The source is sent at a 512 px long edge (`reduceVariationSource`). At full resolution the edit endpoint kept the parent's subject, pose, headline block and layout whatever the prompt said (three prompt versions tested live). The preview still carries the message, subject, mood and legible headline.
2. **Campaign intent.** For a History source the brief of the nearest Generate up the lineage is included; the source artwork is authoritative where they differ.
3. **Rotating concrete approach.** Each variation is given one of `VARIATION_APPROACHES` — typographic, illustrated, split layout, wide scene, graphic shapes, close-up — the next one for that parent (offset by the parent id; uploads rotate with the studio's variation count). The operator's direction wins when it asks for a style or layout. The approach is visible in the sent prompt.
4. **Keep / change.** Keep the message, key facts (offer, date, audience), brand mood and finish. Change the concept, subject, imagery style, focal point, composition, hierarchy and type treatment. The parent's layout and typography are never named as something to keep; a near-duplicate is named as the failure.

**No invented branding (all modes).** The model must not create logos, logo-like marks, monograms, emblems, crests, badges, seals, stamps, certification or award marks, watermarks, QR codes, barcodes, or company/brand/business names — explicitly including a symbol alone in a circle, shield or tile where a logo would sit, a stand-alone emblem of the business's subject (e.g. a tooth for a dental clinic) in a corner or along an edge, and lettering that reads as a made-up wordmark. Where a logo would go, clean background — no placeholder. With the footer, the prompt says the exact identity is added deterministically afterwards. Variation also forbids carrying over a mark from the source. Ordinary illustrations, pictograms and decorative icons remain allowed.

**Lineage.** `parentGenerationId` only for Edit/Variation of a History item. Choosing Edit/Variation on a client's poster reselects that client, so the result is composited with the same Brand Canvas.

## 8. Brand Canvas integration

**Single source of truth.** Everything is read from the existing `Client` row and `Client.brandGuideline` (via `parseBrandGuideline`) when a poster is made. No brand values are copied into studio tables; nothing is written back. Poster Studio never calls `uploadClientLogo`, `removeClientLogoBackground`, `revertClientLogoBackground`, `setClientLogoUrl` or `updateClientPosterIdentity`.

| Brand Canvas data | Source | Used for |
| --- | --- | --- |
| Logo | `logoUrl` / `logoDriveFileId` / `logoOriginal*` / `logoBackgroundRemoved` | Footer (exact) |
| Company name | `companyName` | Footer (exact) — printed unless the logo is drawn and `logoIncludesName` |
| Tagline | `brandTagline` | Footer (exact); prompt as context only when overlaying |
| Website | `websiteUrl` → `normalizeWebsite` | Footer (exact) |
| Phone | `displayPhone`, else `whatsappNumber` → `formatPhone` | Footer (exact); UI marks the WhatsApp fallback |
| Colours | `brandGuideline.colors` | Prompt; footer accent and neutrals via `resolvePosterTheme` |
| Typography | `brandGuideline.typography` | Prompt; footer fonts via `resolvePosterTheme` + `loadFonts` |
| Layout directives | `brandGuideline.layoutDirectives` | Prompt |
| Industry | `category.name` | Prompt |

**Studio panel.** A compact checklist (Logo, Colors, Typography, Tagline, Website, Phone, Layout rules, Industry), the logo preview, logo background choice, "Exact identity on the poster" checkboxes (available elements ticked by default, missing ones disabled), and the footer background selector. No Drive ids, logo URLs or folder ids reach the browser.

**Logo background (per poster, never persisted to Brand Canvas).**

| Choice | Bytes used |
| --- | --- |
| Keep original | The exact uploaded file (`logoOriginal*` when Brand Canvas removed the background, otherwise `logo*`). Scaled only. |
| Remove background | Brand Canvas's transparent logo if it has one; otherwise the original keyed **in memory** with `keyLogoBackground()`. Already-transparent PNG or SVG used as is. |

If the keyer declines (`background-not-flat`, `would-erase-logo`, `nothing-to-remove`, `undecodable`), "Remove background" is disabled with `describeLogoKeySkip()`'s explanation, and a request forcing it is **stopped before the OpenAI call** with an offer to use "Keep original". No silent fallback.

**Identity footer** (`compose.ts`, preset `footer-band`).

- Height: 12% of the poster for 9:16, 15% for 1:1, 18% for 16:9 (`identityBandFraction`, shared with the prompt, which keeps that strip clear).
- **Background — Auto / Light / Dark** (default Auto), per poster:
  - **Auto** measures the mean luminance of the artwork just above and into the footer (downsampled, plain pixel arithmetic — no AI) and picks Light at ≥ 0.32, else Dark.
  - **Light / Dark** are explicit. A transparent logo that would not read on the chosen tone stops the request before spend with a message to choose the other tone or Auto. Opaque logos carry their own background and read on either.
  - Readability of a transparent logo is the share of its ink clearing 3:1 against the ground (≥ 60%), not its average colour.
  - The ground is the brand's light or dark neutral carrying a little of the artwork's hue; if that tint would cost the logo its legibility the plain neutral is used. The top 16% of the footer feathers into the artwork instead of a hard edge.
- **Hierarchy:** company name (heading font, heaviest weight, largest) → tagline beneath it (body bold, brand accent, never larger than 62% of the name) → website and phone (body regular, quieter colour, never larger than the tagline). Tagline and contact sizes are solved together so neither crowds the other out. Long names and taglines go onto two explicitly balanced lines. Text is sized to fit, never truncated.
- Text colours are contrast-checked against the ground (name ≥ 7:1, tagline and contact ≥ 4.5:1).
- Logo: sharp composite, scaled only — never trimmed or recoloured.
- **Pre-flight before spend:** selected elements exist, logo readable, background mode possible, explicit tone readable, fonts load, full dry-run composite. If composition still fails after generation, the raw artwork is saved and the operator warned.

**Per-poster record.** `overlayElements` (names only), `overlayPreset`, `logoBackground`, `footerBackground` (choice), `footerTone` (drawn), `finalImageDriveFileId`. No brand values.

## 9. History

- Latest 24 items, metadata only; images load lazily through the session-gated route. No Drive ids in the browser payload (verified by scanning every page and action response).
- Card: thumbnail (placeholder if the image cannot be loaded), prompt clamped to two lines, mode, format, client; actions **Edit**, **Vary**, **Download**, **Delete** with touch-sized targets.
- Selecting a card previews the **FINAL** poster. Below the preview, always visible: **Download** (final), **Full size**, **Edit**, **Variation**, **Delete**; details offer **download raw artwork**, show the identity elements, logo background, footer choice/tone, lineage link and the prompt sent. On narrow screens the preview scrolls into view.
- **Edit / Variation** attach the item's **RAW** artwork and reselect its client.
- **Delete** removes the row; its RAW, FINAL and input files go to the Drive bin only if no other row references them. Children survive with `parentGenerationId` set to null (DB and UI). The confirmation says so when the item has children.
- A missing Drive file shows "could not be loaded" with **Try again**; Edit/Variation from it stops before spend with a clear message; Delete still works.

## 10. Usage and cost tracking

- Every image response records a `UsageEvent` (`OPENAI`, `studio-image`, model, image count, tokens, `PLATFORM`, client) before storage — including a response whose bytes then fail to decode.
- `PRICE_OPENAI_IMAGE_*` have no defaults; until set, rows carry `costUsdMicros = 0` meaning **not priced**, flagged in the spend panel.

## 11. Limits and failure handling

- Input image 6 MB (UI and server), PNG/JPEG/WebP by declared type and decoded format. Prompt 3–4,000 characters. Logo 4 MB.
- Checked **before** OpenAI is called: request validity, API key, client exists, source image readable, Brand Canvas prerequisites, footer tone, fonts, dry-run composite, Drive folder reachable.
- Generated but not kept (Drive or database failure after billing): files from that request are trashed and the image is returned once for download with an explicit "not in History" message. Never reported as success.
- Leaving the page mid-generation warns; the request still finishes and appears in History.
- Operator messages never include stack traces, provider payloads, Drive ids or secrets.

## 12. QR codes

**QR destination source needs to be defined before QR implementation.**

Brand Canvas has no QR field, campaign URL, CTA URL or destination URL, and no QR library is installed. `Client.websiteUrl` exists but is a display contact value ("Stored as typed"), not a validated destination, and whether a poster's QR should open the client's website or a campaign-specific page is a product decision. When the source is defined, QR must be generated deterministically, composited after generation like the footer, optional, readable, and never sent to or drawn by the model.

## 13. Development database recovery (2026-09-15)

During the final audit, `prisma migrate diff --from-migrations … --shadow-database-url` was run with the **dev** `DATABASE_URL`. Prisma resets a shadow database, so `evokz_ai_dev` lost all rows (the BrightSmile test client, studio history, usage, settings) and its `_prisma_migrations` table. Production, `main` and other databases were not involved; Drive files were not touched.

Recovery (no reset, no `db push`):

1. Confirmed `DATABASE_URL` → `localhost:5434/evokz_ai_dev` and that every table was empty.
2. Created a scratch database `evokz_ai_dev_migration_check` in the same dev container and ran `prisma migrate deploy` against it.
3. `prisma migrate diff --from-url <dev> --to-url <scratch>` and `--from-url <scratch> --to-schema-datamodel` — both empty, proving the dev structure equals the migrations' output.
4. `prisma migrate resolve --applied <name>` for all 18 migrations on the dev database (history only; no schema SQL run).
5. Verified: 18 history rows, `migrate status` up to date, drift diff empty, all tables present. Dropped the scratch database.
6. Recreated only the fictional **BrightSmile Dental Care** client (dev Plan and Category for its foreign keys) with its recorded Brand Canvas values, linked to the existing `brightsmile-dental-logo-dev-test.png` in `Poster Studio/Test Assets`. Rendered footer and Brand Canvas summary match the pre-wipe client.

Studio images from before the wipe remain in Drive with no rows referencing them.

## 14. Testing status

Live gpt-image-2 (low quality, dev DB, private Drive) — 16 successful calls in total:

| Flow | Result |
| --- | --- |
| Variation (×3 after the final change) | Materially different concepts (type-led hero; toothbrush close-ups) from family-photo parents; parent unchanged; `parentGenerationId`, RAW input, RAW/FINAL separation, usage verified. Two earlier prompt-only versions were near-duplicates — the reason for §7's preview + approaches. |
| Edit ×2 | Main artwork replaced with a dental consultation; whole photo replaced with an illustration (old concept gone); headline, pill and exact identity kept. |
| Reference poster → Generate (1:1) | Reference style used, brand colours won, reference wording/brand not copied; RAW, FINAL, WebP input stored. |
| Generate: BrightSmile 9:16 and 16:9, no client 16:9 | Clean; the brief that previously produced a corner tooth mark produced none; no invented names; no-client stores RAW only. |
| Footer | Auto → Light on bright artwork, Dark chosen explicitly, both logo modes. |

No spend (local mock of the Images API, real Drive and dev DB, driven through the real UI):

- Server validation with zero provider calls: empty prompt, unsupported aspect ratio, unknown footer value, Edit/Variation without image, overlay without client, unknown client, unknown identity element, missing history id, fake image bytes, disallowed MIME; browser checks for type and 6 MB.
- Provider failures: 500, 401, moderation, malformed JSON, empty data, undecodable image (usage recorded, nothing stored), dropped connection; timeout mapping in-process.
- Missing API key and unreachable Drive folder: refused before any provider call.
- Database outage after generation: no success, Drive files trashed, one-time download offered.
- Refresh during generation: poster saved and visible in History.
- Delete parent with children; missing Drive file (preview, thumbnail, Edit refused before spend, Delete).
- Unsupported logo background removal (gradient logo): option disabled in UI; forced request refused with zero provider calls; Brand Canvas unchanged.
- Long client name (92 chars) + long tagline/website/phone: footers in all three formats exact and non-overlapping; no page overflow on 390 px and 1440 px.
- After DB recovery: Preview (FINAL), Download (final and raw, bytes match Drive), Edit (RAW attached, client reselected, submit), Variation, Delete, reference upload.
- Offline composition: all tones × logo modes × formats × missing-field subsets; pixels above the footer identical to RAW.
- Browser payload scan: 0 Drive ids, 0 secret values. Image route: 307 to login without a session; server action 401 without a session.

## 15. Known limitations

- Variation quality is probabilistic. The preview + approach rotation made every post-change live sample materially different, but a Variation can still resemble its parent, particularly when the operator's direction asks for the same style. Borderline decorative symbols were seen (a shield with a family pictogram inside a hero illustration, a neon tooth sign on a clinic wall) — scene elements, not placed as logos.
- Edit preserves areas it is not asked to change, including any logo-like mark already in older raw artwork.
- One placement preset (bottom footer). The footer covers the bottom strip; posters generated before the overlay existed were not composed with a reserved strip.
- Footer text sizing uses per-character width estimates; very long names or contact lines are set smaller (a 92-character name in 9:16 is small but exact).
- Auto tone is one luminance threshold over the footer region; a strongly split artwork (dark left, light right) gets one tone.
- Overlay fonts come from `POSTER_FONT_DIR` or Google Fonts at runtime; with neither available, the overlay pre-flight stops the request.
- Enclosed counters of a keyed logo keep their background colour (a property of `keyLogoBackground`).
- No QR codes (§12).
- History shows the latest 24; no pagination. Drive folders are named by company name.
- A browser that already loaded an image keeps showing its cached copy (`immutable`) even if the Drive file is later removed.
- Image prices are not configured; studio usage rows are unpriced.

## 16. Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | Yes, at runtime | gpt-image-2 calls |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_DRIVE_PARENT_FOLDER_ID` | Yes, at runtime | Evokz Admin Drive |
| `POSTER_STUDIO_DRIVE_FOLDER_ID` | Recommended | "Poster Studio" folder in the Admin Drive |
| `POSTER_STUDIO_IMAGE_QUALITY` | No (default `low`) | `low` / `medium` / `high` / `auto` |
| `POSTER_FONT_DIR` | No | Local TTFs for the footer, instead of Google Fonts |
| `POSTER_LOGO_TIMEOUT_MS` | No (default 15000) | External logo fetch timeout |
| `PRICE_OPENAI_IMAGE_*` (3) | No (unset = unpriced) | USD per 1M image tokens |
| `DATABASE_URL` | Yes | Development: `localhost:5434/evokz_ai_dev` |

No new environment variables were added in this round.

## 17. Campaign automation — Phase 1 foundation

**Status: data foundation only.** Schema, migration, domain rules and tests. **NOT IMPLEMENTED** (later phases): AI content calendar generation for campaigns, template mapping UI, drag-and-drop, poster generation queue, rolling generator, Poster Studio integration, approval UI, delivery queue / WhatsApp wiring, campaign dashboard. Nothing in the dispatch sweep, dashboard, importer or Poster Studio reads the new tables or columns.

Target workflow: `CLIENT → CAMPAIGN → CAMPAIGN DAYS → CONTENT → TEMPLATE MAPPING → POSTER VERSIONS → APPROVAL → DELIVERY QUEUE → WHATSAPP`.
Principle: **a 365-day plan is 365 independently editable scheduled content slots, not 365 locked posters.**

### 17.1 Existing architecture found

| Concept | Where it lives today |
| --- | --- |
| Plan / program | `Plan` (name, `durationDays`, `priceInr`) |
| Client ↔ plan | `Client.planId`. The client row is also the only "campaign": `startDate`, `endDate`, `cronTime`, `deliveryDays`, `isActive` |
| Vertical | `Category` |
| Template | `CategoryTemplate` (per vertical; `width`/`height`, `layoutApprovedAt`, `plateApprovedAt`) |
| Calendar / delivery day | `ContentCalendar`: one row per client per day, unique `(clientId, dayNumber)`; content (`theme`, `caption`, `hashtags`, `imagePrompt`, `posterCopy`), template pin `posterTemplateId`, the one poster file (`gDriveFileId`) |
| Generation status | `deliveryStatus` `PENDING → GENERATED` and the `generationQueuedAt` mark (backlog phase of `cron-worker.ts`) |
| Approval | `ContentCalendar.approvedAt` (nullable timestamp) |
| Scheduled delivery | `cron-worker.ts`: client `cronTime` window → `sendAfter` jitter → claim → `runCreativePipeline` |
| Evolution API delivery | `ai-pipeline.ts` `POST /send/media`; `deliveryStatus = DELIVERED`; `UsageEvent` (`EVOLUTION`, `whatsapp`, `calendarId`) |
| Poster Studio | `PosterStudioGeneration` (immutable rows, Drive ids, lineage) |
| Poster history | **None.** Regenerate swaps `gDriveFileId`; the old Drive file is orphaned |

### 17.2 Decisions

1. **Reused:** `Client`, `Plan`, `Category`, `CategoryTemplate`, `PosterStudioGeneration`, `UsageEvent`, `nthDeliveryDate` scheduling.
2. **Extended (additive):** `ContentCalendar` **is** the CampaignDay. There is no separate CampaignDay table, because a calendar row already is one scheduled content slot. `CategoryTemplate` gains `isActive` and `contentTypes`.
3. **New:**
   - `Campaign`: no model carries campaign status, mapping mode or approval policy, and a client can only represent one campaign.
   - `PosterVersion`: no poster history exists.
4. **Relations:**

```
Client 1─N Campaign 1─N ContentCalendar (campaign day) 1─N PosterVersion
  │           │ N─1 Plan                 │ N─1 CategoryTemplate (selected: posterTemplateId)
  │           │ N─1 Category             │ N─1 CategoryTemplate (suggestedTemplateId)
  │                                      │ 0..1 → PosterVersion (activePosterVersionId)
  └─1─N ContentCalendar (legacy rows: campaignId NULL)
PosterVersion N─1 CategoryTemplate · N─1 PosterStudioGeneration · self (parentVersionId)
```

Integrity enforced by the database:
- `ContentCalendar(campaignId, clientId) → Campaign(id, clientId)`: a day's campaign belongs to the same client.
- `ContentCalendar(activePosterVersionId, id) → PosterVersion(id, calendarDayId)`: a day can only point at its own versions. `activePosterVersionId` is unique. `NO ACTION`: an active version cannot be deleted, but deleting the day cascades.
- `PosterVersion(calendarDayId, versionNumber)` is unique.
- `PosterVersion.studioGenerationId` is `RESTRICT`: a studio row whose file a campaign version shares cannot be deleted, because studio deletion trashes the file.

### 17.3 Campaign

`clientId`, `planId`, `categoryId` (vertical), `name`, `status`, `startDate`, `durationDays`, `endDate`, delivery configuration (`deliveryTime`, `deliveryDays`), `templateMappingMode`, `approvalPolicy` (`MANUAL_REVIEW` / `AUTO_APPROVE`), generation configuration (`generationWindowDays`, default 14).

- **No Brand Canvas data is copied.** Posters read the client's current Brand Canvas at generation time, as Poster Studio does.
- The schedule is the campaign's own, snapshotted from the client at creation (plan, vertical, delivery time and weekdays default from the client). `createCampaign` materialises every day slot from it in one transaction.

### 17.4 Campaign day (`ContentCalendar` with `campaignId`)

| Need | Column |
| --- | --- |
| campaign / date / sequence | `campaignId` (new), `scheduledDate`, `dayNumber`; addressable as unique `(campaignId, dayNumber)` |
| topic | `theme` (reused) |
| content type | `contentType` (new; a pillar key of the vertical's content strategy — Phase 2, §18.2) |
| headline / supporting text / CTA | `headline`, `supportingText`, `cta` (new) |
| caption / hashtags / visual prompt | `caption`, `hashtags`, `imagePrompt`, `backgroundPrompt` (reused) |
| suggested / selected template | `suggestedTemplateId` (new) / `posterTemplateId` (reused) |
| generation status | `generationStatus` (new; null on legacy rows) |
| approval status | on the **active `PosterVersion`** (an approval is about one exact image) |
| delivery status | `deliveryStatus` (reused); not written by the campaign domain yet |
| active poster | `activePosterVersionId` (new) |
| revision | `contentRevision` (new) and `lastPosterVersion` (the version-number allocator) |

- No image bytes, Brand Canvas values or template files are stored on the day.
- A new day has empty content (`''` in the legacy NOT NULL columns), no template, no poster and `generationStatus = NOT_REQUESTED`.
- It never sets `approvedAt` or `generationQueuedAt`, so the legacy sweep cannot select it (verified by a test).

### 17.5 Content vs poster

Content lives on the day. Posters are `PosterVersion` rows. A day can have content and a template and still no poster: `Day 127 → content → template assigned → poster not generated yet` is a normal state.

`contentRevision` connects the two. It increments on any change to a **poster input**: topic, content type, headline, supporting text, CTA, image/background prompt, or the effective template. Each version stores the revision it was made from. An older revision means the poster is **outdated**; nothing is rewritten. Caption and hashtags travel with the WhatsApp message, not the image, so editing them does not outdate an approved poster.

### 17.6 Template mapping

- `Campaign.templateMappingMode`: `AUTO` or `MANUAL`.
- Effective template (`effectiveTemplateId`): the operator's selection always wins. Under AUTO, the mapper's suggestion fills unselected days. Under MANUAL, a suggestion is only a hint.
- Template A → Day 2, B → Day 5, C → Day 17; one template on many days; one selected template per day by construction (a single column).
- Assignment is refused for a template from another vertical or an inactive one. Content-type fit is advisory (`templateSuitsContentType`).
- Template metadata:
  - `contentTypes` (new; empty means any).
  - Aspect ratio comes from the existing `width`/`height` (`templateAspectRatio`).
  - `isActive` (new) lets a template be retired without deleting it; deletion would SetNull every mapping. The legacy rotation does not read `isActive` yet.
  - Approval reuses `layoutApprovedAt` (`isTemplateLayoutApproved`) — the gate the renderer enforces for a pinned template. (Phase 1 also accepted `plateApprovedAt`; corrected in Phase 3, §19.)

### 17.7 Poster versions

`PosterVersion`:
- Identity and source: `versionNumber`, `source` (`PIPELINE` / `POSTER_STUDIO` / `MANUAL_UPLOAD`).
- Image: `imageDriveFileId`, `imageMimeType`, `width`/`height`. A Drive id only; a data URI is refused.
- Provenance: `contentRevision`, `templateId`, `parentVersionId` (edited from), `studioGenerationId`.
- Review: `approvalStatus`, `reviewedAt`, `reviewNote`.

- Rows are written only once an image exists, and then only the review fields change. v1 → v2 → v3 are separate rows and history is never overwritten.
- **ACTIVE** is `ContentCalendar.activePosterVersionId`, a pointer rather than a status on each row. At most one active version per day holds by construction, with no partial index (which Prisma 5 cannot model without drift).
- `addPosterVersion` allocates the number by incrementing the day's `lastPosterVersion` inside the transaction, which also locks the row. It auto-activates unless the new version is older content than the active one (`shouldAutoActivate`), so out-of-order generations cannot displace newer work.
- `activatePosterVersion` is the explicit operator choice, for example going back to v1.
- Only the active version may ever be delivered (`evaluateDeliveryReadiness`).

### 17.8 Status concepts

| Axis | Where | Values | Transitions |
| --- | --- | --- | --- |
| Campaign | `Campaign.status` | DRAFT, ACTIVE, PAUSED, COMPLETED, CANCELLED | DRAFT→ACTIVE/CANCELLED; ACTIVE→PAUSED/COMPLETED/CANCELLED; PAUSED→ACTIVE/CANCELLED; COMPLETED, CANCELLED terminal |
| Poster generation | `ContentCalendar.generationStatus` | NOT_REQUESTED, QUEUED, GENERATING, SUCCEEDED, FAILED | NOT_REQUESTED→QUEUED; QUEUED→GENERATING/NOT_REQUESTED; GENERATING→SUCCEEDED/FAILED; SUCCEEDED/FAILED→QUEUED. Applied as conditional claims (`transitionGenerationStatus`); QUEUED only while the campaign is DRAFT/ACTIVE |
| Poster version | derived | active / inactive, current / outdated | pointer and `contentRevision`; no stored status |
| Approval | `PosterVersion.approvalStatus` | PENDING, APPROVED, REJECTED | PENDING→APPROVED/REJECTED; APPROVED→PENDING (withdraw); REJECTED→PENDING (reconsider). Initial value from `Campaign.approvalPolicy` |
| Delivery | `ContentCalendar.deliveryStatus` (existing) | PENDING, GENERATED, DELIVERED, FAILED | Unchanged; campaign wiring is a later phase |

Delivery readiness is derived, never stored. In order: campaign not ACTIVE → no active poster → active poster outdated → rejected → not approved → **ready**.

What happens when:

| Event | Effect |
| --- | --- |
| Content changes (poster input) | `contentRevision++` on that one row. Existing versions become outdated; their approval is kept as history but they are not deliverable. |
| Caption / hashtags change | That row only; no revision change; an approved current poster stays ready. |
| Template changes | `contentRevision++` if the **effective** template changed (a MANUAL-mode suggestion does not). |
| Poster regenerated | `generationStatus` QUEUED → GENERATING → SUCCEEDED/FAILED. On success a new version is added and activated if not older than the active one, with approval PENDING (or APPROVED under AUTO_APPROVE). Failure records `errorMessage` and leaves the active version untouched. |
| Poster edited (Poster Studio, future) | New `POSTER_STUDIO` version with `parentVersionId` and `studioGenerationId`, activated; earlier versions untouched. |
| Poster version replaced | `activatePosterVersion` moves the pointer. The newly active version keeps its own approval, and is deliverable only if it is also current. |
| Poster approved | That version → APPROVED. The day is ready if the version is active and current and the campaign is ACTIVE. |
| Poster rejected | That version → REJECTED with a note. It stays active and visible, but the day is not deliverable until a new or other version is activated and approved. |
| Campaign paused | `status = PAUSED` only. No day or version row changes. Readiness becomes `campaign-not-active` and generation cannot be queued. Resuming restores both. Days whose date passed while paused are not rescheduled (a later-phase decision). |

### 17.9 Future support (NOT IMPLEMENTED)

- **Rolling generation window.**
  - Days exist without posters.
  - `(campaignId, scheduledDate)` is indexed.
  - `Campaign.generationWindowDays` holds N.
  - A future generator selects the next N days that have content and no current active version, and claims them via `transitionGenerationStatus`.
- **Edit only this day.**
  - Poster Studio makes an Edit from the day's active version's image.
  - `addPosterVersion({ source: 'POSTER_STUDIO', parentVersionId, studioGenerationId })` activates it.
  - The queue then uses the new version. Other days are untouched (tested byte-for-byte on days 126 and 128).
- **Regenerate from Day 101 onward.** Days are addressable by `(campaignId, dayNumber)`. `dayNumber >= 101` selects exactly 265 rows and leaves days 1–100 alone (tested).

### 17.10 Code and tests

| File | Role |
| --- | --- |
| `src/lib/campaign/model.ts` | Pure rules: transition tables, poster-input fields, effective template, readiness, auto-activation, slot planning (single walk, identical dates to `nthDeliveryDate`). The Phase 1 content-type catalogue was replaced in Phase 2 by vertical content strategies (§18.2) |
| `src/lib/campaign/service.ts` | DB operations taking `prisma` or a transaction client: `createCampaign`, `changeCampaignStatus`, `findCampaignDay`, `updateCampaignDayContent`, `selectDayTemplate`, `suggestDayTemplate`, `transitionGenerationStatus`, `addPosterVersion`, `activatePosterVersion`, `reviewPosterVersion`. Racing writes are conditional updates that report `conflict`. No provider calls. |
| `scripts/check-campaign-model.ts` | `npm run check:campaign`: 54 pure checks |
| `scripts/check-campaign-db.ts` | `npm run check:campaign-db`: 89 checks against the dev DB inside one transaction that is always rolled back (table counts compared before and after). Refuses a non-local or non-dev `DATABASE_URL`. |

The DB suite covers all 14 Phase 1 requirements, including:
- A 365-day campaign.
- Composite-key and unique-pointer refusals, checked separately.
- Day 126/128 isolation.
- AUTO/MANUAL mapping and AUTO_APPROVE.
- Poster Studio rows unchanged, with delete protection for shared files.
- Legacy calendar rows, template SetNull and vertical Restrict.
- Cascades.

No OpenAI, fal.ai, Drive or WhatsApp calls.

### 17.11 Known concerns — address before campaign days exist outside tests

1. ~~**Legacy client-level actions do not know about campaigns.**~~ **Resolved** — see §17.12.
2. **One calendar per client.** `ContentCalendar @@unique([clientId, dayNumber])` remains for the legacy pipeline, so a client cannot hold a second campaign (for example a renewal) with overlapping day numbers. `createCampaign` refuses this with `calendar-occupied`. The fix is a planned change to that constraint, not part of Phase 1.
3. **Schedule duplication.** `Client.startDate/endDate/cronTime/deliveryDays/planId` and the campaign's own schedule can diverge. The dispatch sweep still reads the client. When delivery is wired, dispatch should read the campaign for campaign days.
4. **Delivery projection.** The existing sweep sends `gDriveFileId`/`gDriveViewUrl` (a link-readable file) after `approvedAt`. Campaign images are Drive ids, and studio files are unpublished. The delivery phase must copy the ready, active version into those columns (publishing the file) or teach dispatch to read versions directly.
5. **Studio file sharing.** Studio deletion only checks studio rows before trashing. The `RESTRICT` FK blocks deleting a linked studio row, but the studio's error message is generic. Integration should check `PosterVersion` references first.
6. `CategoryTemplate.isActive` and `contentTypes` are not yet honoured by the legacy template rotation.
7. The legacy dashboard/ledger **pages** (read-only) still list and count campaign days alongside legacy days for a client; their buttons now refuse campaign days (§17.12). Separating the views is campaign-dashboard work.
8. The local dev server's Prisma engine was locked during `prisma generate`. The locked DLL was renamed (`node_modules/.prisma/client/query_engine-windows.dll.node.locked-*`), not deleted, and can be removed once `next dev` restarts.

### 17.12 Legacy calendar tooling is scoped away from campaign days

`src/lib/calendar-scope.ts` defines `LEGACY_CALENDAR` (`{ campaignId: null }`), the refusal copy, and `countCampaignDays`. For every row that predates campaigns `campaignId` is null, so legacy behaviour is unchanged. Campaign days are changed only by `src/lib/campaign/service.ts`.

| Path | Change |
| --- | --- |
| `queueCampaignGeneration` (queue all) | Counts and marks legacy PENDING rows only |
| `clearClientCalendar` | Selects, counts and deletes legacy rows only |
| `updateClientDeliveryDays` | Reschedules and counts legacy rows only |
| `updateClientCategory` | Unpins legacy rows only (a campaign day's template is checked against the campaign's vertical) |
| `updateClientPlan` | Stranded-day refusal counts legacy rows only |
| `approveAllCreatives`, `retryFailedDeliveries` | Legacy rows only |
| `approveCreative`, `unapproveCreative`, `deleteCalendarEntry`, `regenerateCreative` | Refuse a campaign day before writing anything (`bookSendNow` is scoped too) |
| `runCreativePipeline` | Returns a `load` refusal for a campaign day **without** writing to the row. This covers "Send now", retry and the sweep's claims |
| `executeIntervalDispatch` (all three phases, the awaiting-approval count, and the release, pre-generate and send claims) | Legacy rows only |
| `generateContentCalendar` (seed), `applyCalendarImport` (sheet import), `storeManualPoster` (manual upload) | Refuse a client whose calendar holds campaign days, before any LLM call, planning or Drive upload. Each reads occupied days client-wide, so it would rewrite a campaign day (import overwrite) or interleave legacy days into the campaign's numbering |

Not changed: `runDemoCreativeNow` (appends a new legacy row after the highest day number and never touches existing rows), `deleteClient` (explicit client deletion cascades to campaigns by design), and read-only pages.

`npm run check:calendar-scope` has 39 checks.
- **Fixtures:** clients mixing campaign days (dressed as FAILED, GENERATED, approved, pinned, queued and due) with legacy days.
- **Code under test:** the real server actions, importer, manual upload, seeder entry, pipeline and dispatch sweep.
- **Assertions:**
  - Each legacy effect still happens.
  - Campaign rows and their poster versions are byte-identical afterwards.
- **Isolation:**
  - Everything runs inside one rolled-back transaction, via a facade on `globalThis.prisma`.
  - Table counts are compared before and after.
  - `fetch` is stubbed and provider keys are blanked. The suite asserts zero network attempts.
- **Proof it catches the bug:** against the pre-fix code, 23 of the 39 checks fail.

## 18. Campaign automation — Phase 2: AI content calendar generation

**Status: content planning only.** AI writes each campaign day's *content* into its existing slot.

**NOT IMPLEMENTED** (later phases):
- Poster generation of any kind (no gpt-image-2, no fal.ai, no uploads).
- Rolling poster generation.
- Template mapping and drag-and-drop.
- Approval workflow.
- Delivery queue and WhatsApp / Evolution changes.
- A campaign dashboard beyond the calendar page.

The f5053c4 protections are unchanged: legacy seed, import and upload still refuse campaign clients, and the pipeline and sweep still ignore campaign days.

### 18.1 Audit findings

- **Reused, not duplicated:**
  - Topic is `ContentCalendar.theme`; `caption`, `hashtags` and `imagePrompt` are existing columns.
  - `contentType`, `headline`, `supportingText`, `cta` and `contentRevision` come from Phase 1.
  - Client, vertical and plan are reached through `Campaign`.
- **AI:** `generateStructured` (strict JSON schema, retries, `UsageEvent` recording) and `buildImagePromptRules` are reused. Spend is recorded under the existing `calendar` operation.
- **Vertical:** `Category` had no content strategy, and Phase 1's content-type catalogue was hardcoded. Both are replaced by §18.2.
- **Language:** the application has no language setting, so content is written in English.
- **UI:** no campaign UI existed, not even campaign creation. §18.6 adds both.

### 18.2 Content strategy (per vertical)

`Category.contentStrategy` (JSON) holds weighted **pillars**, each `{ key, label, weight 1–20, guidance, promotional }`.

- A vertical without one uses `DEFAULT_CONTENT_STRATEGY`, which is industry-neutral: educational, practical tips, myth vs fact, common questions, awareness, service spotlight, engagement, trust & values, seasonal, promotional.
- No industry's categories exist in code. A Dental vertical defines its own pillars, for example "Preventive care".
- **Editing:** use the vertical page's *Content strategy* card. The text format is `Label | weight | guidance` with an optional `| promotional`. The key is the label's slug, so the text round-trips exactly. Saving empty text restores the default.
- **Balance is deterministic** (`planContentTypes`): smooth weighted round-robin over the whole campaign.
  - Each pillar gets its weighted share of days, within one day.
  - No type repeats on consecutive days, and promotional days are never back to back.
  - Day N always gets the same type, whether it is generated alone, in a range or in a full run.
- `ContentCalendar.contentType` must be a pillar key. The model's schema is an enum of the vertical's keys, and manual edits are validated against the same strategy.

### 18.3 Data model — migration `20260915220000_campaign_content_generation`

Additive, with one scoped backfill.

| Change | Purpose |
| --- | --- |
| Enum `CampaignContentStatus` (`NOT_GENERATED`, `READY`, `NEEDS_REVIEW`) | Content state of a campaign day, independent of posters |
| `ContentCalendar.contentStatus` (nullable) | Null on legacy rows; campaign slots start `NOT_GENERATED` |
| `ContentCalendar.contentIssues text[]` | Deterministic validation findings behind `NEEDS_REVIEW` |
| `ContentCalendar.suggestedTemplateType` (nullable) | The generator's layout hint (`SUGGESTED_TEMPLATE_TYPES`, e.g. `tips-list`), for the future template mapper. Not a template id; `suggestedTemplateId` is untouched |
| `Category.contentStrategy` (nullable JSONB) | §18.2 |
| `UPDATE … SET contentStatus = 'NOT_GENERATED' WHERE campaignId IS NOT NULL` | Existing campaign slots are empty by definition; legacy rows are not touched |

The planned date is **not** asked of the model. Each day's date is its slot's `scheduledDate`.

### 18.4 Generation service (`src/lib/campaign/content-generation.ts`)

- **Context sent:**
  - Company name, vertical, plan, duration, start date, delivery weekdays.
  - Brand tagline and brand voice (`brandGuideline.typography.vibeClassification`).
  - The strategy pillars with guidance.
  - Each requested day's number, date and planned content type.
  - History: every other day's topic, and the nearest 40 headlines and 12 CTAs.
- **Never sent:** Drive ids, logo URLs, WhatsApp number, website or any secret. The brief's `ContentBrief` type has no such fields, and both test suites assert that nothing private appears in the requests.
- **Structured output:** strict JSON schema with every field required, and content type and template type as enums. The output is re-validated with zod before anything is written.
- **Chunked:** at most **30 days per request**, run sequentially so later chunks reuse the cached system prompt and see what earlier chunks wrote.
  - 365 days take 13 requests.
  - A response cut off at the token cap (`LlmError` `truncated`) splits the chunk in half automatically.
  - Any other failure stops the run at that chunk. Earlier chunks stay saved, and the report names the day to resume from.
- **Idempotent:**
  - `missing` mode (the default) writes only `NOT_GENERATED` slots, so repeating a request makes no model call and changes nothing.
  - Slots are unique per `(campaignId, dayNumber)` and only ever updated, so no duplicate day can be created.
  - Replacing content requires `overwrite` mode explicitly.
- **Deterministic validation** (`validateGeneratedChunk`):
  - *Refused:* entries that fail the schema, day numbers that were not requested, and duplicate day numbers (the first wins).
  - *Omitted days* are reported and stay empty, ready to retry.
  - *Accepted but NEEDS_REVIEW:* an exact duplicate topic or headline anywhere in the campaign (case, punctuation and spacing ignored), a content type other than the planned one, the same CTA as the previous day, or an over-long headline or CTA.
- **Concurrent edits:** each write is conditional on the day's `updatedAt` and `contentRevision`. An operator edit made while the model was writing is kept and reported as `changedMeanwhile`.
- **What a content write changes:** `theme`, `contentType`, `headline`, `supportingText`, `cta`, `caption`, `hashtags`, `imagePrompt`, `suggestedTemplateType`, `contentStatus`, `contentIssues`, and `contentRevision + 1`.
  - Never changed: date, day number, template columns, poster versions, the active pointer, generation status, delivery columns, approval.

### 18.5 Partial generation and regeneration — chosen behaviour

| Operation | Behaviour |
| --- | --- |
| Generate all / missing | Empty slots of the range, 30 per request. Written days are skipped. |
| Generate a range, e.g. days 91–120 | The same, limited to the range. Asking again for a written range makes no request. |
| Regenerate a range, e.g. days 101–130 | `overwrite` mode, behind a confirmation in the UI. Replaces content in the range only. A day's existing content type is kept when it is a valid pillar. Days outside the range are untouched. **Poster versions are never deleted or changed, and the active poster stays active.** Because `contentRevision` moves, each existing poster becomes *outdated* (derived: version revision < day revision). The report and the UI flag those days as needing poster regeneration. Continuation (`nextFromDay`) moves past processed chunks, so no day is rewritten twice in one run. |
| Regenerate one day (`regenerateCampaignDayContent`) | One request for exactly that day. Same date, day number, template mapping and poster versions. New content, `contentRevision + 1`. Other days unaffected; nothing generated or sent. |

### 18.6 Manual editing, review and UI

- **Manual edit** (`updateCampaignDayContent`, Phase 1 extended):
  - Changes one row and makes no model call.
  - Refused when the day changed since it was loaded.
  - Content type must be a pillar of the vertical's strategy.
  - The edit counts as the review: status becomes `READY` (or `NOT_GENERATED` if edited back to empty) and findings are cleared.
  - Poster inputs bump the revision; caption and hashtags do not.
- **Mark reviewed** (`markCampaignDayContentReviewed`): `NEEDS_REVIEW` → `READY` with no content change.
- **Client page → Campaigns card:** lists the client's campaigns with ready / to review / not generated counts, and has a *New campaign* form (name, first day, content days, Auto/Manual mapping) that creates a DRAFT with empty slots. A client with legacy calendar days is told why a campaign cannot use those day numbers.
- **Calendar page** (`/admin/clients/[clientId]/campaigns/[campaignId]`):
  - *Summary:* stat tiles for content ready, needs review, not generated and posters outdated.
  - *Range and generation:* select with inputs, a click or shift-click. *Generate missing (N)*; *Regenerate range* with confirmation and a count of posters that will be marked outdated. Runs one request per chunk from the browser, with progress, *Stop after this request*, and a clear error on a failed chunk.
  - *Day list:* filters by status; per day the status (✓ Content ready / ✏ Needs review / ○ Not generated), content type, topic, headline, findings, layout hint, template and poster state (not generated / current / outdated).
  - *Per-day actions:* *Edit* (dialog), *Regenerate* (confirmation) and *Mark reviewed*.
  - Read-only when the campaign is COMPLETED or CANCELLED.
- **Vertical page → Content strategy card:** §18.2.

### 18.7 Code and tests

| File | Role |
| --- | --- |
| `src/lib/campaign/content-strategy.ts` | Strategy type, default, parsing, editor text format, `planContentTypes`, `SUGGESTED_TEMPLATE_TYPES` |
| `src/lib/campaign/content-plan.ts` | Pure: target selection, chunking, history, prompts, schema, `validateGeneratedChunk` |
| `src/lib/campaign/content-generation.ts` | `generateCampaignContent`, `regenerateCampaignDayContent`; injectable generator (default `generateStructured`) |
| `src/lib/campaign/service.ts` | Slots start `NOT_GENERATED`; manual edits validate against the strategy and set status; `markCampaignDayContentReviewed` |
| `src/app/admin/campaigns/actions.ts` | Create campaign, generate one chunk, regenerate day, edit day, mark reviewed, save strategy |
| `src/components/campaign/*` | `CampaignCalendar`, `CampaignDayEditor`, `CreateCampaignForm`, `ContentStrategyEditor` |

**Automated tests** (`npm run …`):

| Suite | Checks | Covers |
| --- | --- | --- |
| `check:campaign-content` | 57, pure | Strategy parsing, round trip, default neutrality; balanced deterministic assignment; targets and 13-chunk plan for 365 days; validation; schema enums; prompt content |
| `check:campaign-content-db` | 65 | Dev DB, fake generator, one rolled-back transaction, row counts compared, 0 network attempts — see below |

The `check:campaign-content-db` suite covers:
- Chunked generation and prompt privacy.
- An idempotent retry: no request, no overwrite, no duplicates.
- Range 91–120.
- A failing chunk, then resume from exactly that chunk.
- An omitted day, filled on the next run.
- Duplicate headline → NEEDS_REVIEW.
- Range regeneration keeping dates, templates and poster versions, and marking the poster outdated.
- Overwrite continuation without double writes.
- Day 127 regeneration: neighbours, versions, usage and delivery fields unchanged.
- Manual edit, strategy validation and mark reviewed.
- An operator edit during generation is kept.
- Truncation split.
- A cancelled campaign and a bad range are refused before any request.
- Legacy rows untouched.

Phase 1 and f5053c4 suites still pass: `check:campaign` 55, `check:campaign-db` 89, `check:calendar-scope` 39.

**UI check (local, not committed; `.studio-checks/campaign-ui/`):**
- *Setup:* a temporary git worktree dev server (so the operator's running `next dev` was not disturbed) with OpenAI pointed at a local chat-completions mock — no spend. Playwright drove the real UI.
- *Flows verified:* create campaign → Generate missing (45 days in 2 requests, nothing private in requests) → manual edit (no request) → regenerate day → mark reviewed → regenerate range 1–10 → failing chunk reported, then resumed → strategy editor save.
- *Browser:* 0 browser errors (baseline page also 0); no horizontal overflow at 390 px.
- *Cleanup:* fixtures and their usage rows removed; the dev DB matches its prior contents.

### 18.8 Known limitations and concerns

- **Content language** is English only (no language setting exists).
- **Seasonal references** rely on the model and the date; no holiday calendar is supplied, so nothing checks a festival's date.
- **Duplicate detection** is exact after normalisation. Paraphrased repeats are steered by the prompt history, not detected.
- **A long run is browser-driven.** Closing the tab stops after the current request; everything written is kept and *Generate missing* resumes. There is no server-side background job.
- **Concurrent runs** on the same range can both pay for a request; the second one's writes are skipped by the conditional update.
- **Changing a vertical's strategy** does not rewrite existing days. Days keep their old content type, shown as "(not in strategy)" in the editor, and later generation plans with the new pillars.
- **Legacy views:** the client page's legacy stats and ledgers still count and list campaign days (§17.11 item 7).
- **Colour lint:** `npm run lint:colors` reports colour classes in `src/components/studio/poster-studio-workspace.tsx` that were already there at f5053c4. No new file triggers it, and Poster Studio was not modified.

## 19. Campaign automation — Phase 3: campaign template mapping

**Status: template mapping only.** Full record: [`vertical-phase3.md`](vertical-phase3.md). No poster is generated, no provider is called, and no poster version is touched. Poster generation is Phase 4.

- **Storage reused.** Auto Map writes only `ContentCalendar.suggestedTemplateId`; manual mapping writes only `posterTemplateId`. A manual choice therefore cannot be overwritten by an auto run. `effectiveTemplateId` and the `contentRevision` bump on an effective change are unchanged from §17.6.
- **Migration `20260915230000_campaign_template_mapping`** (additive): `ContentCalendar.templateSelectedAt` and `templateSuggestedAt`. "Who" is not recorded: the console has one shared login.
- **Compatibility** (hard rules): same vertical, `isActive`, approved (`layoutApprovedAt` and a readable spec), shape within 2% of the client's output preset or unmeasured, and `contentTypes` empty or containing the day's stored or planned type.
- **Auto Map** (`planAutoMap`) is deterministic and previewed. Apply requires the preview's fingerprint. Days with no compatible template stay unmapped with a reason.
- **Manual Map** is a days ↔ templates board: drag-and-drop on desktop; select template → select days → apply on touch. It supports selection, range and repeat-pattern bulk mapping.
- **Deactivating a template** (vertical page → *Campaign use*) never changes days. They are flagged "Template inactive — action required" with a replacement workflow.
- **Deleting a template** still referenced by open-campaign days is refused.
- **Code:** `src/lib/campaign/template-mapping.ts` (pure), `src/lib/campaign/template-mapping-service.ts`, `src/components/campaign/CampaignTemplateMapping.tsx`.
- **Tests:** `check:campaign-mapping` (62) and `check:campaign-mapping-db` (82).

## 20. Campaign automation — Phase 4: rolling campaign poster generation

**Status:** posters for campaign days, generated by this studio's pipeline. The full record is [`vertical-phase4.md`](vertical-phase4.md). There are no WhatsApp or delivery changes.

- **One pipeline.** `src/lib/campaign/poster-generation-service.ts` composes the same functions as `generateStudioPosterAction`, in the same order:
  - Brand Canvas → overlay pre-flight → Drive folder;
  - GENERATE prompt with the day's content and its mapped template attached as the reference;
  - gpt-image-2 → usage → decode check → footer → RAW and FINAL files.

  Each poster is a `PosterStudioGeneration` row plus an immutable `PosterVersion` (`PIPELINE`, linked by `studioGenerationId`), which becomes the day's active version.
- **Rolling window.** `Campaign.generationWindowDays` (default 14). Batches cover only today … today + N − 1; explicit day ranges may reach further.
- **Eligibility and states** are pure rules in `src/lib/campaign/poster-generation.ts`:
  - Eligibility: campaign ACTIVE, content READY, a usable mapped template, a studio format (9:16, 1:1, 16:9), and Brand Canvas colours. Otherwise a named reason.
  - States (derived): Not generated, Generating, Failed, Needs approval, Approved, Rejected, Outdated, Needs attention.
- **Migration `20260916000000_campaign_poster_generation`:** additive `ContentCalendar.posterGenerationStartedAt`, the claim token used for stale-attempt recovery (10 minutes).
- **Poster Studio changes:**
  - `?campaignDay=` opens a day's poster in Edit, with **Save to Day N** (a `POSTER_STUDIO` version).
  - Deleting a History item a campaign version uses is refused with a clear message.
  - The Phase 1 version rule now allows `PIPELINE` versions to link a studio row.
- **Tests:** `check:campaign-posters` (55) and `check:campaign-posters-db` (80). The local browser check passes 39 / 39.

## 21. Campaign automation — Phase 5: campaign review and approval

**Status:** posters can be reviewed, approved, sent back and fixed. The full record is [`vertical-phase5.md`](vertical-phase5.md). Nothing is delivered and nothing is sent; delivery is Phase 6.

- **No second approval system, and no migration.** Approval stays on `PosterVersion` (`approvalStatus`, `reviewedAt`, `reviewNote`), moved only by §17's `reviewPosterVersion`, and the day's state stays §20's derived `derivePosterState`. The rejection reason is stored in the existing `reviewNote`.
- **Code:** `src/lib/campaign/review.ts` (pure rules), `src/lib/campaign/review-service.ts`, `src/components/campaign/CampaignReviewQueue.tsx` and `CampaignDayDetail.tsx` (shared with the Phase 4 card, which lost its own version dialog).
- **Approve** applies only to the day's active, current, PENDING version. Outdated, rejected, generating, missing, a non-active version and a closed campaign are each refused with a named reason. Approving an already-approved day is a no-op.
- **Reject** takes a reason from a fixed catalogue (Wrong layout, Content issue, Branding issue, Image quality, Template mismatch, Other — which requires detail) plus optional detail, stored as `"Branding issue — the logo sits over the headline"`. Nothing is deleted: the version, its Drive files and history are kept, and the day keeps it as active so it can be fixed. An APPROVED poster passes through PENDING, since §17 allows no direct transition.
- **Fixing** is **Edit in Poster Studio** (a `POSTER_STUDIO` version) or **Regenerate** (a `PIPELINE` version, behind a confirm that names the AI cost). Either way the new version is active and PENDING; the rejected one is untouched.
- **Bulk approval** plans first — "Selected: N · Can approve: X · Skipped: Y" — never approves an invalid day, reports the rest grouped by reason, and re-checks each day at the write so a changed day becomes a conflict rather than an approval.
- **Readiness** (`campaignReadiness`): content and templates campaign-wide, posters and approvals window-only, `deliveryReady` through §17's `evaluateDeliveryReadiness`, and `windowReady` false whenever any blocker exists. The client dashboard's "Needs attention" links to `?review=<filter>`.
- **Tests:** `check:campaign-review` (46) and `check:campaign-review-db` (63). The local browser check passes 38 / 38.

## 22. Campaign automation — Phase 6: campaign WhatsApp delivery

**Status:** approved campaign posters are delivered over WhatsApp. The full record is [`vertical-phase6.md`](vertical-phase6.md). No message has ever been sent from this work — every test drives a local mock gateway.

- **One Evolution integration, two callers.** The transport moved to `src/lib/whatsapp.ts`; `ai-pipeline.ts`'s `broadcastWhatsAppMedia` is now a thin wrapper over it that preserves the legacy contract exactly (tolerates an unreadable 2xx body, discards the message id, re-throws as `PipelineStageError('broadcast', …)` with the same text). No second integration exists.
- **Recipient: `Client.whatsappNumber`** — the business's own number, the same destination the legacy sweep uses. This product has **no** contacts, audience or consent model, and none was invented; the UI says so plainly. A customer broadcast would be a blocking architectural gap.
- **Migration `20260916120000_campaign_delivery`** (additive): `CampaignDeliveryStatus` and `CampaignDelivery`. A new table rather than the legacy columns, which are legacy-scoped and carry no version, attempts, message id or schedule.
- **Idempotency is the schema.** `CampaignDelivery.calendarDayId` is UNIQUE — one delivery per day, ever — plus a conditional-update claim, a terminal `SENT`, and a settle guarded on the claim.
- **The gate is server-side and runs twice**: once before claiming, then again on the claimed row immediately before the provider call. `manual: true` (Send Now) relaxes only the scheduled moment.
- **The version is pinned**, not looked up: a poster regenerated after booking cancels the booking rather than sending either version.
- **Media** is a signed, 30-minute link to `/api/campaign-media/<token>` that streams the bytes through the service account. Drive files stay unpublished; `PUBLIC_BASE_URL` must be set or delivery refuses.
- **Scheduling** reuses `/api/cron` (Bearer `CRON_SECRET`, fails closed) as a fourth sweep phase. `Campaign.deliveryTime` resolved in the app timezone; a day whose local date passed is SKIPPED, not sent late.
- **Retries** are bounded at 3 with 1/5-minute backoff. A timeout is treated as **permanent** — it may already have been queued, and a duplicate cannot be recalled.
- **Tests:** `check:campaign-delivery` (84) and `check:campaign-delivery-db` (93). The local browser check passes 75 / 75.
- ⚠️ **The Prisma schema-engine binary is blocked by a Windows Application Control policy on this machine**, so `prisma migrate deploy` / `migrate diff` cannot run here. This migration was applied with `psql` and its `_prisma_migrations` row written by hand (same name and SHA-256 checksum). `prisma generate` and the query engine are unaffected.
