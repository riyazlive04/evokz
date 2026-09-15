# AI Poster Studio — Implementation & Handoff

Branch: `feature/ai-poster-studio` · Route: `/admin/poster-studio` · Not deployed, not merged.

## 1. What it does

An admin-console tool for marketing operators to make posters with OpenAI **gpt-image-2**, optionally branded with a client's existing **Brand Canvas**:

| Mode | Input image | What is sent to the model |
| --- | --- | --- |
| **Generate** | Optional style reference | Brief + format + (Brand Canvas guidance) + text rules. With a reference, the image itself is attached as style/layout guidance only. |
| **Edit** | **Required** — upload or a History item's **raw artwork** | The image + only the edit instruction + "keep everything else as it is". |
| **Variation** | **Required** — upload or a History item's **raw artwork** | The image + the direction + what to keep (campaign, brand, quality, essential wording) + explicit licence to redesign layout, text placement, imagery and hierarchy + (Brand Canvas guidance). |

When a client is selected, the studio loads that client's Brand Canvas and can composite the **exact** logo, company name, tagline, website and phone onto the result — drawn deterministically, never by the AI (§8).

Plus: 9:16 / 1:1 / 16:9 output, a text-free artwork option, History (latest 24), download (final and raw), delete, and usage recording.

## 2. Development environment

**Database** — Docker container `evokz_ai_dev_db` from `docker-compose.dev.yml` (Postgres 16, database `evokz_ai_dev`).

- Published on **`localhost:5434`**, not 5433. A native Windows PostgreSQL 18 service (`postgresql-x64-18`) on the development machine listens on 5433 and shadows Docker's mapping.
- `.env` (untracked): `DATABASE_URL="postgresql://evokz_dev:<password from docker-compose.dev.yml>@localhost:5434/evokz_ai_dev"`. The old `localhost:5432/evokz_ace` line is commented out and must not be used.

```bash
docker compose -f docker-compose.dev.yml up -d
npx prisma migrate status     # must print: database "evokz_ai_dev" ... at "localhost:5434"
npx prisma migrate deploy
```

**Drive** — the Evokz Admin Drive credentials in `.env`. Studio files go to the **"Poster Studio"** folder inside the Admin Shared Drive (`POSTER_STUDIO_DRIVE_FOLDER_ID`).

**Local production build** — `next start` on this machine currently returns 500 for authenticated pages (the build compiles the middleware with the default matcher). Unrelated to the studio and not investigated; local testing uses `next dev`.

## 3. Prisma migrations

| Migration | Change |
| --- | --- |
| `20260915120000_poster_studio_generation` | Enum `PosterStudioMode`, table `PosterStudioGeneration`, indexes, FKs from the new table (`clientId → Client`, `parentGenerationId → self`, both `ON DELETE SET NULL`). |
| `20260915140000_poster_studio_brand_overlay` | Enum `PosterStudioLogoBackground`; columns `finalImageDriveFileId`, `finalImageMimeType`, `overlayElements text[] default '{}'`, `overlayPreset`, `logoBackground` — all nullable or defaulted. |

- Both generated with `prisma migrate diff --from-schema-datasource --to-schema-datamodel` against the dev database with no prior drift, inspected, applied with `migrate deploy`; the diff is empty afterwards.
- **Purely additive and confined to the studio table.** No existing table or column is altered; nothing is added to `Client`.
- Applied to the development database only. A release needs `prisma migrate deploy`.
- Any database where the very first studio version was created with `prisma db push` has an incompatible table; drop it before deploying.

## 4. Architecture

```
Browser (poster-studio-workspace.tsx)
  │  select client ──► loadStudioBrandCanvasAction ──► Brand Canvas panel
  │                    (summary: what exists; no Drive ids / URLs)
  │  FormData: mode, prompt, aspectRatio, clientId, textFree,
  │            sourceKind, sourceGenerationId | image,
  │            overlayElements, logoBackground
  ▼
generateStudioPosterAction (actions.ts)
  1. validate — Edit/Variation need an image; overlay needs a client
  2. load Brand Canvas (Client + parseBrandGuideline)
  3. resolve input image: upload → sharp; history → RAW artwork from Drive
  4. PRE-FLIGHT (before any spend):
       overlay: fields exist · logo readable · background mode possible ·
                fonts load · dry-run composite
       storage: Drive folder reachable
  5. prompt (studio-prompts.ts) — reserves the identity band when overlaying
  6. renderStudioImage: images.generate | images.edit      ← spend
  7. recordOpenAiImageUsage
  8. composeStudioPoster: RAW + exact identity → FINAL
  9. store RAW, FINAL (+ new upload) in Drive, unpublished
 10. insert PosterStudioGeneration row
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
| `src/components/studio/poster-studio-workspace.tsx` | Studio UI incl. Brand Canvas panel |
| `src/lib/poster-studio/brand-context.ts` | Loads a client's Brand Canvas; browser-safe summary |
| `src/lib/poster-studio/brand-logo.ts` | Logo resolution (original / removed), read-only |
| `src/lib/poster-studio/compose.ts` | Deterministic identity overlay + pre-flight |
| `src/lib/brand/logo-fetch.ts` | Shared guarded logo fetch + sniffing (renderer, Brand Canvas action, studio) |
| `src/lib/brand/identity-format.ts` | Shared `formatPhone` / `normalizeWebsite` / `normalizeTagline` |
| `src/lib/ai/openai-images.ts`, `src/lib/ai/studio-prompts.ts` | gpt-image-2 calls; prompt builders |
| `src/lib/poster-studio/{limits,images,storage,history,errors}.ts` | Limits and formats; sharp; Drive; history; errors |
| `src/lib/poster/logo-key.ts` | + `describeLogoKeySkip` (moved from the dashboard actions) |

## 5. Image storage — RAW and FINAL

- **No image bytes in PostgreSQL.** Rows hold Drive file ids.
- **RAW artwork** (`imageDriveFileId`): exactly what gpt-image-2 returned. **The only image ever sent back to the model** for Edit and Variation — the composited final would have its exact logo and contact details redrawn.
- **FINAL poster** (`finalImageDriveFileId`): RAW + the identity overlay, same dimensions. Null when no overlay was drawn (then RAW is the poster). Preview and download use FINAL; details offer "download raw artwork".
- Drive: `Poster Studio/<client company name | "Generic">/poster-studio-<timestamp>-<mode>-raw.png` and `…-final.png`; uploads unpublished; served only via the session-gated route (`private, max-age=86400, immutable`).
- Delete trashes RAW, FINAL and an uploaded input only when no other row references them. **A client's Brand Canvas logo is never referenced by a studio row and cannot be trashed by the studio.**

## 6. OpenAI integration

- `gpt-image-2` pinned; sizes 9:16 `1152x2048`, 1:1 `1024x1024`, 16:9 `2048x1152`; quality `POSTER_STUDIO_IMAGE_QUALITY` (default `low`); 5-minute timeout; no automatic retries; operator-safe error mapping.
- Live-tested on the dev setup (Generate, Edit, Variation — before the Brand Canvas overlay existed): 1152x2048 accepted, ~27–29 s per image at low quality.

## 7. Reference, Edit and Variation behaviour

- **Generate + reference:** the reference goes through `images.edit` as style/layout guidance only.
- **Edit:** instruction + preservation clause + output frame. No brand block.
- **Variation:** "a new poster for the same campaign" — keep-list separate from a redesign-list; a near-copy is not acceptable. Revised after live test `7369b464…` kept the parent's text block; the revision is not yet live-tested.
- **Lineage:** `parentGenerationId` only for Edit/Variation of a History item. Choosing Edit/Variant on a client's poster reselects that client, so the result is composited with the same Brand Canvas.

## 8. Brand Canvas integration

**Single source of truth.** Everything is read from the existing `Client` row and `Client.brandGuideline` (via `parseBrandGuideline`) at the moment a poster is made. No brand values are copied into studio tables; nothing is written back. Poster Studio never calls `uploadClientLogo`, `removeClientLogoBackground`, `revertClientLogoBackground`, `setClientLogoUrl` or `updateClientPosterIdentity`.

| Brand Canvas data | Source | Used for |
| --- | --- | --- |
| Logo | `logoUrl` / `logoDriveFileId` / `logoOriginal*` / `logoBackgroundRemoved` | Overlay (exact) |
| Company name | `companyName` | Overlay (exact) — printed unless the logo is drawn and `logoIncludesName` |
| Tagline | `brandTagline` | Overlay (exact); prompt as context only when overlaying |
| Website | `websiteUrl` → `normalizeWebsite` | Overlay (exact) |
| Phone | `displayPhone`, else `whatsappNumber` → `formatPhone` | Overlay (exact); UI marks the WhatsApp fallback |
| Colours | `brandGuideline.colors` | Prompt; overlay band/text via `resolvePosterTheme` |
| Typography | `brandGuideline.typography` | Prompt; overlay fonts via `resolvePosterTheme` + `loadFonts` |
| Layout directives | `brandGuideline.layoutDirectives` | Prompt |
| Industry | `category.name` | Prompt |

**Studio panel.** Selecting a client loads a compact checklist (Logo, Colors, Typography, Tagline, Website, Phone, Layout rules, Industry), the logo preview, the logo background choice, and "Exact identity on the poster" checkboxes — every available element ticked by default, unavailable ones disabled and marked "not set". A link opens the client's Brand Canvas page. The summary contains no Drive ids, logo URLs or folder ids.

**Logo background (per poster, never persisted to Brand Canvas).**

| Choice | Bytes used |
| --- | --- |
| Keep original | The exact uploaded file: `logoOriginal*` when Brand Canvas has removed the background, otherwise `logo*`. Scaled only — no trim, no recolour. |
| Remove background | Brand Canvas's existing transparent logo if it has one; otherwise the original keyed **in memory** with `keyLogoBackground()`. An already-transparent PNG or an SVG is used as is. |

Default: "Remove background" when Brand Canvas has already removed it, otherwise "Keep original". If the keyer declines (`background-not-flat`, `would-erase-logo`, `nothing-to-remove`, `undecodable`), "Remove background" is disabled with `describeLogoKeySkip()`'s explanation, and a request that asks for it anyway is **stopped before the OpenAI call** with an offer to switch this poster to "Keep original". There is no silent fallback.

**Secure retrieval.** Drive-backed logos are read with `downloadDriveFile()` through the service account — the studio does not rely on, or change, the file's public link. External logo URLs use the shared guarded fetcher (timeout, 4 MB cap, `image/*` content type). The logo preview route resolves everything server-side from the client id.

**Deterministic identity overlay** (`compose.ts`, preset `footer-band`).
- A full-width band along the bottom: 12% of the height for 9:16, 15% for 1:1, 18% for 16:9 (`identityBandFraction`, shared with the prompt).
- Band and text: satori → resvg, in the client's resolved typography and theme colours, thin accent rule on top. Right column: tagline (accent colour), website, phone. Left: logo, then the company name when it is printed. Text is scaled to fit, never truncated.
- Logo: sharp composite, scaled only. The band colour adapts to the logo (dark unless `logoReadsOn` says the logo would not read), so the artwork is never recoloured.
- Everything above the band is byte-identical to the raw artwork (verified).
- **Prompt when overlaying:** the model is told the bottom N% will be covered and to keep it clear, and not to draw any logo, brand name, wordmark, tagline, phone number, web address, social handle or QR code; the brand block gives name and tagline as context only. Without the overlay every prompt is byte-identical to before (verified on 42 prompt fixtures).
- **Pre-flight before spend:** selected elements exist in Brand Canvas, logo readable, background mode achievable, fonts load, and a full dry-run composite on a blank canvas of the target size. If the overlay still fails after generation, the raw artwork is saved and the operator is warned.

**Per-poster record.** `overlayElements` (names only, e.g. `["logo","name","website","phone"]`), `overlayPreset`, `logoBackground`, `finalImageDriveFileId`. No phone, website, logo, tagline, typography or colour values.

## 9. Usage and cost tracking

- Every successful image response records a `UsageEvent` (`OPENAI`, `studio-image`, model, image count, tokens, `PLATFORM`, client). Recorded before storage.
- Image-token prices (`PRICE_OPENAI_IMAGE_*`) have no defaults; until set, rows carry `costUsdMicros = 0` meaning **not priced**, flagged in the spend panel. Reconcile with the OpenAI billing dashboard.
- Composition costs no API calls.

## 10. Limits and failure handling

- Input image 6 MB (UI and server), PNG/JPEG/WebP, normalised with sharp. Prompt 3–4,000 characters. Logo 4 MB (existing Brand Canvas limit).
- Deterministic prerequisites and Drive storage are checked **before** OpenAI is called.
- Generated-but-not-kept (Drive or database failure after billing): files from that request are trashed, and the raw image is returned once for download with an explicit message.

## 11. Known limitations

- **The Brand Canvas overlay has not been tested with a live OpenAI generation yet.** Verified offline: library tests (logo rules, keying, Drive-backed read, summaries, composition in all three formats, SVG, pre-flight refusals, prompts), server-action pre-flight with credentials blanked, and the UI/routes under `next dev` without a Generate click. Brand Canvas rows were unchanged by every test.
- One placement preset (bottom band). The band covers the bottom strip of the artwork; posters generated before the overlay existed were not composed with a reserved band.
- The band colour is chosen from the logo's *average* ink luminance; a logo mixing very light and very dark parts can lose contrast in its dark (or light) parts. The logo is deliberately not recoloured.
- Font sizing uses a width estimate; very long taglines or names are set smaller rather than truncated.
- Overlay fonts come from `POSTER_FONT_DIR` or Google Fonts at runtime; with neither available, the overlay pre-flight stops the request.
- Enclosed counters of a keyed logo keep their background colour (a documented property of `keyLogoBackground`).
- **No QR codes.** Brand Canvas has no QR field and no QR library is installed; deferred until the encoded data, source and placement are decided.
- History shows the latest 24; no pagination. Drive folders are named by company name.

## 12. Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | Yes, at runtime | gpt-image-2 calls |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_DRIVE_PARENT_FOLDER_ID` | Yes, at runtime | Evokz Admin Drive |
| `POSTER_STUDIO_DRIVE_FOLDER_ID` | Recommended | "Poster Studio" folder in the Admin Drive |
| `POSTER_STUDIO_IMAGE_QUALITY` | No (default `low`) | `low` / `medium` / `high` / `auto` |
| `POSTER_FONT_DIR` | No | Local TTFs for the overlay, instead of Google Fonts |
| `POSTER_LOGO_TIMEOUT_MS` | No (default 15000) | External logo fetch timeout |
| `PRICE_OPENAI_IMAGE_*` (3) | No (unset = unpriced) | USD per 1M image tokens |
| `DATABASE_URL` | Yes | Development: `localhost:5434/evokz_ai_dev` |
