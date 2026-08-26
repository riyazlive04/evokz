-- Marks a layout that was written by hand rather than read from the image.
--
-- Nullable and unset for every existing row, so nothing changes until
-- `scripts/apply-authored-layout.ts` writes one. Its only reader is the guard on
-- re-extraction: an authored layout cannot be overwritten by "Read layout"
-- without an explicit confirmation.
ALTER TABLE "CategoryTemplate" ADD COLUMN "layoutAuthoredAt" TIMESTAMP(3);
