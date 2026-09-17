-- Per-template prompt for campaign poster generation.
--
-- Generated with `prisma migrate diff --from-schema-datasource
-- --to-schema-datamodel` against the development database, then reviewed.
--
-- Additive: one nullable text column on "CategoryTemplate" holding the admin's
-- standing instruction for that template, added to the image prompt whenever a
-- campaign poster is generated from it. No backfill: null means no instruction.
-- No existing column, index or constraint is altered or dropped.

-- AlterTable
ALTER TABLE "CategoryTemplate" ADD COLUMN     "prompt" TEXT;
