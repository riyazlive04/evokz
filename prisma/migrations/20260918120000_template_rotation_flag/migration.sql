-- Keeping a template out of the daily rotation.
--
-- Generated with `prisma migrate diff --from-schema-datasource
-- --to-schema-datamodel` against the development database, then reviewed.
--
-- Additive: one boolean column on "CategoryTemplate" saying whether the template
-- may be picked automatically — "Fill empty days" and Auto Map read it, the
-- template pickers do not, so a festival design stays assignable by hand while
-- never landing on an ordinary day. Every existing row defaults to true, so no
-- current campaign changes. No existing column, index or constraint is altered
-- or dropped, and no row is updated. `paletteSource` already exists.

-- AlterTable
ALTER TABLE "CategoryTemplate" ADD COLUMN     "autoAssign" BOOLEAN NOT NULL DEFAULT true;
