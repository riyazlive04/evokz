-- Campaign automation, Phase 3: campaign template mapping.
--
-- Generated with `prisma migrate diff --from-schema-datasource
-- --to-schema-datamodel` against the development database, then reviewed.
--
-- Additive: two nullable timestamps on "ContentCalendar" recording when a
-- campaign day's MANUAL selection ("posterTemplateId") and AUTO suggestion
-- ("suggestedTemplateId") were last written. No backfill: the time of an
-- existing mapping is unknown, and legacy rows never carry a value.
-- No existing column, index or constraint is altered or dropped.

-- AlterTable
ALTER TABLE "ContentCalendar" ADD COLUMN     "templateSelectedAt" TIMESTAMP(3),
ADD COLUMN     "templateSuggestedAt" TIMESTAMP(3);
