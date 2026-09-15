# AI Poster Studio — Implementation & Handoff

Branch: `feature/ai-poster-studio` · Route: `/admin/poster-studio` · Not deployed, not merged.

## 1. What it does

An admin-console tool for marketing operators to make posters with OpenAI **gpt-image-2**:

| Mode | Input image | What is sent to the model |
| --- | --- | --- |
| **Generate** | Optional style reference | Brief + format + (client brand) + text rules. With a reference, the image itself is attached and described as style/layout guidance only. |
| **Edit** | **Required** — upload or a History item | The image + only the edit instruction + "keep everything else as it is". |
| **Variation** | **Required** — upload or a History item | The image + the direction + "keep the visual identity" + (client brand). |

Plus: 9:16 / 1:1 / 16:9 output, a text-free artwork option, History (latest 24), download, delete, and usage recording.

It does **not** composite text or logos. See §11.

## 2. Development environment

**Database** — Docker container `evokz_ai_dev_db` from `docker-compose.dev.yml` (Postgres 16, database `evokz_ai_dev`).

- Published on **`localhost:5434`**, not 5433. A native Windows PostgreSQL 18 service (`postgresql-x64-18`) on the development machine listens on 5433 and shadows Docker's mapping, so `localhost:5433` reaches that server instead of the container.
- `.env` (untracked) should read: `DATABASE_URL="postgresql://evokz_dev:<password from docker-compose.dev.yml>@localhost:5434/evokz_ai_dev"`.
- The previous `.env` line pointing at `localhost:5432/evokz_ace` is commented out and must not be used for development.

```bash
docker compose -f docker-compose.dev.yml up -d
npx prisma migrate status     # must print: database "evokz_ai_dev" ... at "localhost:5434"
npx prisma migrate deploy
```

Always confirm Prisma's `Datasource "db": ... at "localhost:5434"` line before running a Prisma command.

**Drive** — the studio stores images with the Google Drive credentials in `.env`. If those are the shared vault's credentials, set `POSTER_STUDIO_DRIVE_FOLDER_ID` to a scratch folder shared with the service account before testing, so test images do not land in the vault.

## 3. Prisma migration

`prisma/migrations/20260915120000_poster_studio_generation/migration.sql`

- Generated with `prisma migrate diff --from-schema-datasource --to-schema-datamodel` against the dev database after all 15 earlier migrations had been applied to it with `migrate deploy`. Before the model was rewritten, the same diff showed the unmigrated studio table was the only difference between migrations and schema. After applying, the diff is empty.
- **Purely additive:** it creates enum `PosterStudioMode`, table `PosterStudioGeneration`, two indexes, and two foreign keys *from* the new table (`clientId → Client`, `parentGenerationId → PosterStudioGeneration`, both `ON DELETE SET NULL`). No existing table or column is altered.
- Applied to the development database only. It has not been applied anywhere else; a release would need `prisma migrate deploy`.
- **Any database where the first version of the studio was created with `prisma db push`** already has an incompatible `PosterStudioGeneration` table (base64 `imageUrl` column). `migrate deploy` will fail there with "relation already exists". That table held only draft images; drop it, then deploy.

## 4. Architecture

```
Browser (poster-studio-workspace.tsx)
  │  FormData: mode, prompt, aspectRatio, clientId, textFree,
  │            sourceKind, sourceGenerationId | image (binary File)
  ▼
generateStudioPosterAction (actions.ts)
  1. validate (zod) — Edit/Variation without an image are refused
  2. load client brand context (if a client is selected)
  3. resolve input image: upload → sharp validate/normalise
                          history → download from Drive
  4. resolve Drive folder            ← before any spend
  5. build mode-specific prompt (studio-prompts.ts)
  6. renderStudioImage (openai-images.ts): images.generate | images.edit
  7. recordOpenAiImageUsage          ← money is spent at this point
  8. upload output (+ new input) to Drive, unpublished
  9. insert PosterStudioGeneration row (file ids + metadata)
  ▼
History item (metadata only) → <img src="/api/poster-studio/{id}/image?w=…">
                                  → Drive download via service account (admin-gated)
```

| File | Role |
| --- | --- |
| `src/app/admin/poster-studio/page.tsx` | Loads clients and lightweight history; shows DB load errors |
| `src/app/admin/poster-studio/actions.ts` | `generateStudioPosterAction`, `deleteStudioGenerationAction` |
| `src/app/api/poster-studio/[generationId]/image/route.ts` | Serves stored images (preview, input, download) |
| `src/components/studio/poster-studio-workspace.tsx` | Studio UI |
| `src/lib/ai/openai-images.ts` | gpt-image-2 calls, quality, error mapping |
| `src/lib/ai/studio-prompts.ts` | Generate / Edit / Variation prompt builders (pure) |
| `src/lib/poster-studio/limits.ts` | Shared client-safe limits, formats, image URLs |
| `src/lib/poster-studio/brand-context.ts` | Client → brand facts for prompts |
| `src/lib/poster-studio/images.ts` | Input validation/normalisation, previews (sharp) |
| `src/lib/poster-studio/storage.ts` | Drive upload/download/trash wrappers |
| `src/lib/poster-studio/history.ts` | History select/mapping, database error copy |
| `src/lib/poster-studio/errors.ts` | `StudioError` with operator-safe messages |
| `src/lib/google-drive.ts` | + `ensurePosterStudioFolder` |
| `src/lib/usage.ts`, `src/lib/pricing.ts` | + `recordOpenAiImageUsage`, image-token rates |
| `src/lib/cost-report.ts`, `src/components/admin/SpendPanel.tsx` | + unpriced studio image count |
| `prisma/schema.prisma` | `PosterStudioMode`, `PosterStudioGeneration`, `Client.studioPosters` |

## 5. Image storage

- **No image bytes in PostgreSQL.** Rows store `imageDriveFileId` / `referenceDriveFileId` plus MIME type and measured dimensions.
- Drive layout: `<root>/<client company name | "Generic">/poster-studio-<timestamp>-<mode>.png`, where root is `POSTER_STUDIO_DRIVE_FOLDER_ID` if set, else a `Poster Studio` folder under `GOOGLE_DRIVE_PARENT_FOLDER_ID`. Not inside clients' delivery folders.
- Uploaded **unpublished** (not link-readable). Served only by `/api/poster-studio/[generationId]/image`, which sits behind the admin session middleware. Query: `w` (preview width → WebP), `variant=reference`, `full=1`, `download=1`. Responses are `private, max-age=86400, immutable`, because rows never change.
- History payload is metadata only (~800 bytes for two items in testing); images load lazily per thumbnail.
- An input image is stored once. A history image reused as input is **shared by file id, not copied**. Delete removes the row, then trashes each file only if no other row still references it. Trashed files are recoverable from the Drive bin.
- After an upload has been stored, the workspace switches the attachment to the stored copy, so repeated runs do not re-upload it.

## 6. OpenAI integration

- Model **`gpt-image-2`**, pinned in code: the output sizes below are gpt-image-2-only. SDK `openai@6.49.0` (`client.images.generate` / `client.images.edit`), `n: 1`, `output_format: 'png'`, base64 response.
- **Sizes** (checked against the installed SDK's `size` documentation: edges divisible by 16, ratio within 1:3–3:1, not above the experimental 2560x1440): 9:16 → `1152x2048`, 1:1 → `1024x1024`, 16:9 → `2048x1152`. The old `1024x1792`/`1792x1024` were DALL·E 3 sizes and 4:7, not 9:16.
- **Quality** from `POSTER_STUDIO_IMAGE_QUALITY` (`low|medium|high|auto`), default **`low`** for cost-conscious testing.
- Timeout 5 minutes. **No automatic retries**: a retry silently doubles the wait, and a timed-out request may still have been billed.
- `input_fidelity` is not sent; the SDK documentation does not clearly state gpt-image-2 support for it.
- There is **no gpt-4o vision step** any more. The reference image goes to the image model directly.
- Error mapping (raw provider messages are logged server-side, never shown): missing key, 401 key rejected, 403 access/organisation verification, 404 model not available, 429 rate limit vs `insufficient_quota`, `moderation_blocked` / safety, invalid input image, 413 too large, other 400/422, 5xx, timeout, network.

## 7. Reference, Edit and Variation behaviour

- **Generate + reference:** `images.edit` with the reference attached, and the prompt says to follow its composition, hierarchy, colour treatment and typographic feel without copying its wording, logos, people or brand marks. The model may still borrow more than asked; that is not enforceable.
- **Edit:** the prompt is the instruction, a preservation clause (composition, subject, colours, lighting, typography, existing text), the output frame, and "no new text" if text-free is on. The brief and brand block are not sent.
- **Variation:** direction, a keep-identity clause, format, the client brand block if a client is selected, and text-free if on.
- **Lineage:** `parentGenerationId` is set only for Edit/Variation made from a History item's output. Generate never sets it, even with a History image as reference. `referenceDriveFileId` records the actual input image in every case.
- Edit/Variation with no image are refused in both the UI and the server action, with a message asking for an upload or a History selection.

## 8. Brand context

When a client is selected (Generate and Variation), `loadStudioClient` sends only stored data:

- company name (spell exactly), category as industry, `brandTagline` (verbatim, only if the design includes a tagline)
- `brandGuideline.colors[{hex, role}]` (up to 6), via `parseBrandGuideline`
- typography `headingFont` / `bodyFont` / `vibeClassification`
- `layoutDirectives` (up to 6)

Missing fields are omitted, not invented. The old code read `primaryColor`/`palette`, which the tokenizer never writes. Logos, phone and website are not sent.

## 9. Usage and cost tracking

- Every successful image response records a `UsageEvent` via `recordOpenAiImageUsage`: provider `OPENAI`, operation **`studio-image`**, model, `imageCount: 1`, `inputTokens` (text + image), `outputTokens`, `keySource: PLATFORM`, client when selected. It is recorded before storage, because the spend has happened even if saving fails.
- **Cost:** OpenAI's image response has token counts but no price. The rates `PRICE_OPENAI_IMAGE_TEXT_INPUT_PER_MTOK`, `PRICE_OPENAI_IMAGE_IMAGE_INPUT_PER_MTOK` and `PRICE_OPENAI_IMAGE_OUTPUT_PER_MTOK` have **no defaults**. Until all three are set, rows are written with `costUsdMicros = 0`, because the existing column is NOT NULL. **That zero means "not priced", not free:**
  - the server logs a warning per image;
  - the spend panel shows the count of unpriced studio images and says totals understate OpenAI spend;
  - the rate card line reads "not priced".
- **Provider billing reconciliation against the OpenAI dashboard is required** until the rates are configured. Even then, figures are only as accurate as the configured rates.

## 10. Limits and failure handling

- **Input image: 6 MB**, PNG/JPEG/WebP, enforced identically in the UI and on the server (`MAX_STUDIO_IMAGE_BYTES`). It is under the unchanged 8 MB Server Action body limit, and the file travels as binary FormData. Uploads are decoded with sharp (declared MIME and real format both checked), EXIF-rotated, metadata stripped, capped at 2048px, and stored as WebP q90.
- Prompt: 3–4,000 characters.
- Missing Drive configuration or an unreachable folder fails **before** OpenAI is called, so nothing is spent.
- **Generated but not kept:** if the Drive upload or the database insert fails after the image was billed, the action trashes any files written by that request and returns `ok: false` with a message saying the poster was generated and billed but is not in History. The image is sent back once as a download link; it is not stored anywhere. No fake local ids.
- A missing table (`P2021`) or unreachable database shows a specific message on the page and in actions.

## 11. Known limitations

- **Not yet tested against the live OpenAI API or live Google Drive.** Verified so far: typecheck, lint, build, migration on the dev DB, and an offline smoke test (prompts, brand mapping, input validation, mode rules, storage pre-flight, history shape, shared-file lineage) with credentials blanked. The first real run should check that gpt-image-2 accepts `1152x2048`/`2048x1152` for this account, and look at edit fidelity and cost per quality.
- **Text-free artwork only asks the model for no lettering.** No vector text or logo compositing exists in the studio.
- The client logo is not sent to the model; brand consistency depends on the prompt.
- One image per request; no masks, no streaming/partial previews, no progress beyond a spinner.
- History shows the latest 24, with no pagination or search.
- The Drive folder is named by client company name; renaming a client starts a new folder.
- A reference is guidance; the model can still copy elements from it.
- Studio images appear under OpenAI in the spend panel; the provider label now reads "OpenAI · copy & studio".

## 12. Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | Yes, at runtime | gpt-image-2 calls. Not needed for build/typecheck/lint. |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_DRIVE_PARENT_FOLDER_ID` | Yes, at runtime | Image storage (existing vault credentials) |
| `POSTER_STUDIO_DRIVE_FOLDER_ID` | No | Store studio images in this folder instead of `Poster Studio` under the vault |
| `POSTER_STUDIO_IMAGE_QUALITY` | No (default `low`) | `low` / `medium` / `high` / `auto` |
| `PRICE_OPENAI_IMAGE_TEXT_INPUT_PER_MTOK`, `PRICE_OPENAI_IMAGE_IMAGE_INPUT_PER_MTOK`, `PRICE_OPENAI_IMAGE_OUTPUT_PER_MTOK` | No (unset = unpriced) | USD per 1M tokens for studio images |
| `DATABASE_URL` | Yes | Development: `localhost:5434/evokz_ai_dev` |
