-- Campaign automation, Phase 4: rolling campaign poster generation.
--
-- Generated with `prisma migrate diff --from-schema-datasource
-- --to-schema-datamodel` against the development database, then reviewed.
--
-- Additive: one nullable timestamp on "ContentCalendar" recording when the
-- current or last poster generation attempt started. It identifies the attempt
-- holding the GENERATING claim and lets an interrupted attempt be recognised as
-- stale. No backfill; legacy rows never carry a value.
-- No existing column, index or constraint is altered or dropped.

-- AlterTable
ALTER TABLE "ContentCalendar" ADD COLUMN     "posterGenerationStartedAt" TIMESTAMP(3);
