-- Campaign automation, Phase 2: AI content calendar generation.
--
-- Generated with `prisma migrate diff --from-schema-datasource
-- --to-schema-datamodel` against the development database, then reviewed. The
-- final UPDATE is hand-written.
--
-- Additive:
--   * enum "CampaignContentStatus";
--   * "Category"."contentStrategy" (nullable JSONB — null uses the default strategy);
--   * "ContentCalendar"."contentStatus" (nullable), "contentIssues" (text[] default
--     '{}'), "suggestedTemplateType" (nullable).
-- No existing column, index or constraint is altered or dropped.
--
-- The UPDATE touches campaign days only (campaignId IS NOT NULL): slots created
-- by Phase 1 carry no status and are, by definition, not generated yet. Legacy
-- rows keep contentStatus NULL.

-- CreateEnum
CREATE TYPE "CampaignContentStatus" AS ENUM ('NOT_GENERATED', 'READY', 'NEEDS_REVIEW');

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "contentStrategy" JSONB;

-- AlterTable
ALTER TABLE "ContentCalendar" ADD COLUMN     "contentIssues" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "contentStatus" "CampaignContentStatus",
ADD COLUMN     "suggestedTemplateType" TEXT;

-- Backfill: existing campaign slots start as not generated.
UPDATE "ContentCalendar" SET "contentStatus" = 'NOT_GENERATED' WHERE "campaignId" IS NOT NULL AND "contentStatus" IS NULL;
