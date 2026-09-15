# AI Poster Studio — Implementation & Handoff

Branch: `feature/ai-poster-studio` · Route: `/admin/poster-studio` · Not deployed, not merged.

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
