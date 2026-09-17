-- Template clone mode: campaign posters are the template itself, with only its
-- words, photo and identity changed.
--
-- Generated with `prisma migrate diff --from-schema-datasource
-- --to-schema-datamodel` against the development database, then reviewed.
--
-- Additive only. No existing column, index or constraint is altered or dropped.
--   "PosterStudioMode"           + CLONE, the studio mode a clone is recorded as
--   "CategoryTemplate"           + elements / elementsReadAt / elementsError,
--                                  the template's editable elements read once
--   "ContentCalendar"            + posterElements, a day's values for them
--   "PosterStudioGeneration"     + sourceTemplateId, the template a clone came from
--   "PosterVersion"              + textCheck, the automatic read-back of its text

-- AlterEnum
ALTER TYPE "PosterStudioMode" ADD VALUE 'CLONE';

-- AlterTable
ALTER TABLE "CategoryTemplate" ADD COLUMN     "elements" JSONB,
ADD COLUMN     "elementsError" TEXT,
ADD COLUMN     "elementsReadAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ContentCalendar" ADD COLUMN     "posterElements" JSONB;

-- AlterTable
ALTER TABLE "PosterStudioGeneration" ADD COLUMN     "sourceTemplateId" TEXT;

-- AlterTable
ALTER TABLE "PosterVersion" ADD COLUMN     "textCheck" JSONB;

-- AddForeignKey
ALTER TABLE "PosterStudioGeneration" ADD CONSTRAINT "PosterStudioGeneration_sourceTemplateId_fkey" FOREIGN KEY ("sourceTemplateId") REFERENCES "CategoryTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
