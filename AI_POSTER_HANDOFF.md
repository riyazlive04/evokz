# AI Poster Studio — Implementation & Handoff Guide

## 1. Overview
The **AI Poster Studio** is a dedicated interactive surface within the Evokz ACE Admin Console (`/admin/poster-studio`) that empowers marketing operators to:
1. Generate studio-quality marketing posters using OpenAI's DALL-E image generation API.
2. Upload optional reference posters/images for visual style, layout hierarchy, and composition analysis.
3. Edit existing posters using natural-language instructions (e.g. "change background lighting to dusk blue").
4. Generate multiple variations and formats (`1024x1792` 9:16 vertical story, `1024x1024` 1:1 square post, `1792x1024` 16:9 banner).
5. Download high-resolution PNG poster assets directly.
6. Persist generation history and track AI spend in the append-only `UsageEvent` ledger.

---

## 2. Files Created & Modified

### Created Files
- **`src/lib/ai/openai-images.ts`**: Dedicated OpenAI image API integration module (DALL-E 3 & DALL-E 2 generation, editing, and usage ledger logging).
- **`src/lib/ai/studio-prompts.ts`**: Prompt architecture builder and Vision-based reference poster analyzer (`analyzeReferencePoster`).
- **`src/app/admin/poster-studio/actions.ts`**: Server Actions for studio generation, reference image analysis, history management, and tenant brand context resolution.
- **`src/app/admin/poster-studio/page.tsx`**: Admin page route component rendering the Studio workspace.
- **`src/components/studio/poster-studio-workspace.tsx`**: Interactive, responsive Studio workspace component (Control panel, Canvas preview, History & variations gallery).
- **`AI_POSTER_HANDOFF.md`**: This handoff documentation.

### Modified Files
- **`src/components/admin/AdminNav.tsx`**: Added "Poster Studio" link to console navigation.
- **`prisma/schema.prisma`**: Added lightweight `PosterStudioGeneration` model for clean generation history persistence.

---

## 3. Database Changes

Added the `PosterStudioGeneration` model to `prisma/schema.prisma`:

```prisma
model PosterStudioGeneration {
  id                 String   @id @default(uuid())
  prompt             String   @db.Text
  mode               String   @default("generate") // generate | edit | variation
  aspectRatio        String   @default("1024x1792") // 1024x1024 | 1024x1792 | 1792x1024
  referenceUrl       String?  @db.Text
  imageUrl           String   @db.Text
  revisedPrompt      String?  @db.Text
  parentGenerationId String?
  clientId           String?
  createdAt          DateTime @default(now())

  @@index([createdAt])
  @@index([clientId])
}
```

### Migration Instructions (Development DB)
Run against your development database (`localhost:5433 / evokz_ai_dev`):
```bash
npx prisma db push
```

---

## 4. Environment Variables Required

| Variable | Required | Description |
| --- | --- | --- |
| `OPENAI_API_KEY` | **Yes** | OpenAI API key for DALL-E 3 image generation and GPT-4o vision reference analysis. |
| `DATABASE_URL` | **Yes** | PostgreSQL database connection string (Development DB). |

> ⚠️ **Security Notice:** API keys remain strictly server-side inside Server Actions and `lib/ai/`. No keys are exposed to client-side bundles or `NEXT_PUBLIC_*` variables.

---

## 5. How to Test

1. Start local dev server:
   ```bash
   npm run dev
   ```
2. Navigate to `http://localhost:3000/admin/poster-studio` or click **Poster Studio** in the top admin navigation bar.
3. **Generate a Poster**:
   - Select mode **Generate**.
   - Enter a prompt (e.g. *"Modern real estate launch poster for luxury 3-BHK apartments with sunset lighting"*).
   - Select aspect ratio (e.g. `1024x1792` 9:16 Story).
   - Click **Generate AI Poster**.
4. **Reference Image Upload**:
   - Upload a sample poster or reference layout image.
   - Observe automatic vision reference analysis guiding color and composition.
5. **Edit / Variation Mode**:
   - Click **Edit** on a generated poster thumbnail.
   - Enter natural language edit instructions (e.g., *"Make background lighting dusk blue"*).
   - Click **Apply Edit Instruction**.
6. **Download & History**:
   - Hover over the preview canvas or history item and click **Download** to save the PNG asset.
   - Inspect generation history cards in the right column.

---

## 6. Known Limitations & Recommendations

1. **Live OpenAI Key Requirement**: Generating live DALL-E 3 images requires a valid `OPENAI_API_KEY` with available billing quota.
2. **Deterministic Vector Compositing**: For exact tenant logos, contact phone numbers, or QR codes, toggle **Vector Text Overlay Mode** or pair with the existing Satori vector composition engine (`src/lib/poster/render.tsx`).

---

## 7. Next Steps & Enhancements

- Integrate direct Google Drive auto-export for studio posters into client campaign subfolders.
- Add multi-variations batch generation option (generate 4 variations simultaneously).
