-- AI Poster Studio: raw artwork vs final composited poster, and the per-poster
-- Brand Canvas overlay choices.
--
-- Generated with `prisma migrate diff --from-schema-datasource --to-schema-datamodel`
-- against the development database, which was at
-- 20260915120000_poster_studio_generation with no drift.
--
-- Purely additive and confined to "PosterStudioGeneration": one enum and five
-- columns, every one nullable or defaulted, so existing rows need no backfill.
-- Their `imageDriveFileId` already is raw model output — no overlay existed when
-- they were made — and a null `finalImageDriveFileId` means "the raw artwork is
-- the poster", which is exactly true of them.
--
-- No brand data is copied here. Logo, phone, website, tagline, typography and
-- colours stay on "Client" (Brand Canvas); these columns record only which
-- elements were drawn and which logo background was chosen for this poster.

-- CreateEnum
CREATE TYPE "PosterStudioLogoBackground" AS ENUM ('ORIGINAL', 'REMOVED');

-- AlterTable
ALTER TABLE "PosterStudioGeneration" ADD COLUMN     "finalImageDriveFileId" TEXT,
ADD COLUMN     "finalImageMimeType" TEXT,
ADD COLUMN     "logoBackground" "PosterStudioLogoBackground",
ADD COLUMN     "overlayElements" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "overlayPreset" TEXT;
