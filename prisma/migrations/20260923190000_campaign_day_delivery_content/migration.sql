-- Campaign delivery content: an optional link sent under the WhatsApp caption,
-- and internal notes that are never sent.
--
-- Generated with `prisma migrate diff --from-schema-datasource
-- --to-schema-datamodel` against the development database, then reviewed.
--
-- Additive only: two nullable columns on "ContentCalendar". Every existing row
-- keeps NULL, which means no link and no notes. The caption itself reuses the
-- existing "caption" column. No existing column, index or constraint is altered
-- or dropped, and no row is updated.

-- AlterTable
ALTER TABLE "ContentCalendar" ADD COLUMN     "deliveryLink" TEXT,
ADD COLUMN     "internalNotes" TEXT;
