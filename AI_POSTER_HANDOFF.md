# AI Poster Studio — Implementation & Handoff Guide

## 1. Overview
The **AI Poster Studio** is a dedicated interactive surface within the Evokz ACE Admin Console (`/admin/poster-studio`) that empowers marketing operators to:
1. Generate studio-quality marketing posters using OpenAI's **`gpt-image-2`** image generation & editing API.
2. Upload optional reference posters/images for visual style, layout hierarchy, and direct image-to-image reference editing (`client.images.edit`).
3. Edit existing posters using natural-language instructions (e.g. "change background lighting to dusk blue") with the original image attached in the request.
4. Generate multiple variations and formats (`1024x1792` 9:16 vertical story, `1024x1024` 1:1 square post, `1792x1024` 16:9 banner).
5. Download high-resolution PNG poster assets directly.
6. Persist generation history and track AI spend in the append-only `UsageEvent` ledger.

---

## 2. Files Created & Modified

### Created Files
- **`src/lib/ai/openai-images.ts`**: Updated OpenAI image API integration module (`gpt-image-2` text-to-image via `images.generate` and image-to-image editing via `images.edit`).
- **`src/lib/ai/studio-prompts.ts`**: Prompt architecture builder and Vision-based reference poster analyzer (`analyzeReferencePoster`).
- **`src/app/admin/poster-studio/actions.ts`**: Server Actions for studio generation, reference image analysis, history management, and tenant brand context resolution.
- **`src/app/admin/poster-studio/page.tsx`**: Admin page route component rendering the Studio workspace.
- **`src/components/studio/poster-studio-workspace.tsx`**: Interactive, responsive Studio workspace component (Control panel, Canvas preview, History & variations gallery).
- **`AI_POSTER_HANDOFF.md`**: This handoff documentation.

### Modified Files
- **`src/components/admin/AdminNav.tsx`**: Added "Poster Studio" link to console navigation.
- **`prisma/schema.prisma`**: Added lightweight `PosterStudioGeneration` model for clean generation history persistence.

---

## 3. Image Integration Details (`gpt-image-2`)

- **Target Model**: `gpt-image-2` (default).
- **SDK Compatibility**: Built directly using the installed `openai` SDK (^6.49.0), utilizing `client.images.generate()` and `client.images.edit()`.
- **Text-to-Image Generation**: Triggered when no reference image is provided.
- **Reference-Image / Edit / Variation Workflow**: When a reference poster or parent image is attached (`imageDataUri` / `imageBuffer`), the actual image is converted via `OpenAI.toFile` into a supported Uploadable file and passed directly to `client.images.edit({ model: 'gpt-image-2', image: file, prompt, size })`.
- **Supported Formats & File Sizes**: Validates PNG, JPEG, and WebP images up to 50 MB.
- **Supported Sizes**: `1024x1792` (9:16 Story), `1024x1024` (1:1 Square), `1792x1024` (16:9 Banner).

---

## 4. Environment Variables & Missing Key Behavior

| Variable | Required | Description |
| --- | --- | --- |
| `OPENAI_API_KEY` | **At Runtime** | OpenAI API key for `gpt-image-2` image generation/editing and `gpt-4o` vision reference analysis. |

> ⚠️ **Key Handling:** Build (`npm run build`), TypeScript typecheck (`npm run typecheck`), and lint (`npm run lint`) **do not require an API key to be present**. At runtime, if `OPENAI_API_KEY` is missing when generation is attempted, the system fails gracefully and displays a clear message to the operator:
> `"OPENAI_API_KEY is missing. Please configure OPENAI_API_KEY in your environment variables to enable live AI poster generation."`

---

## 5. Testing & Verification Status

The implementation has been verified with:

1. **TypeScript Typecheck (`npm run typecheck`)**: `tsc --noEmit` -> **0 errors**
2. **ESLint (`npm run lint`)**: `next lint` -> **0 errors**
3. **Production Build (`npm run build`)**: `next build` -> **Succeeded cleanly** (Route `/admin/poster-studio` compiled successfully).

> *Note: Live API generation requires an `OPENAI_API_KEY` with available quota set in environment variables.*

---

## 6. Development Database Setup

Added `PosterStudioGeneration` to `prisma/schema.prisma`. Run against your development database (`localhost:5433 / evokz_ai_dev`):
```bash
npx prisma db push
```

---

## 7. Next Steps & Recommendations

- Set `OPENAI_API_KEY` in local `.env` or production server environment settings.
- Enable direct Google Drive auto-export for studio posters into tenant campaign folders.
