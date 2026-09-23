-- Poster Studio: Mix elements (base + element reference) and festival treatment.
--
-- Additive only: one enum value and three nullable columns on
-- "PosterStudioGeneration". Every existing row keeps NULL in the new columns,
-- which is exactly what it was — no second input image and no festival. No
-- existing column, index or constraint is altered or dropped, and no row is
-- updated.

-- AlterEnum
ALTER TYPE "PosterStudioMode" ADD VALUE 'MIX';

-- AlterTable
ALTER TABLE "PosterStudioGeneration" ADD COLUMN     "elementReferenceDriveFileId" TEXT,
ADD COLUMN     "elementReferenceMimeType" TEXT,
ADD COLUMN     "festival" TEXT;
