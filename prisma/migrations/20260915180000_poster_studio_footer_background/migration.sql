-- AI Poster Studio: per-poster identity footer background.
-- Additive and confined to the studio table: one enum, two nullable columns.

-- CreateEnum
CREATE TYPE "PosterStudioFooterBackground" AS ENUM ('AUTO', 'LIGHT', 'DARK');

-- AlterTable
ALTER TABLE "PosterStudioGeneration" ADD COLUMN     "footerBackground" "PosterStudioFooterBackground",
ADD COLUMN     "footerTone" "PosterStudioFooterBackground";
