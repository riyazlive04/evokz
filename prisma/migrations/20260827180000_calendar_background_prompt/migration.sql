-- The brief for a `scene` backdrop's frame.
--
-- Nullable and unset for every existing row, so nothing changes until a sheet
-- carries the column and a spec asks for the backdrop. A `scene` backdrop on a
-- day with no brief here falls back to the painted `blob`, which is why this can
-- be added without touching anything already scheduled.
ALTER TABLE "ContentCalendar" ADD COLUMN "backgroundPrompt" TEXT;
