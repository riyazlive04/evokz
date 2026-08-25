-- The clean plate: a template's artwork with its own words and photography
-- erased, composited as the poster's actual background.
--
-- Every column is nullable or defaulted, so existing rows keep rendering on the
-- `layoutSpec` grid path untouched. A template only changes behaviour once an
-- operator uploads a plate AND approves its regions.
ALTER TABLE "CategoryTemplate"
  ADD COLUMN "plateDriveFileId" TEXT,
  ADD COLUMN "plateViewUrl"     TEXT,
  ADD COLUMN "plateWidth"       INTEGER,
  ADD COLUMN "plateHeight"      INTEGER,
  ADD COLUMN "plateSpec"        JSONB,
  ADD COLUMN "plateApprovedAt"  TIMESTAMP(3),
  ADD COLUMN "paletteSource"    TEXT NOT NULL DEFAULT 'client';

-- Serves generation's plate path: approved plates for one vertical, the mirror
-- of @@index([categoryId, layoutApprovedAt]).
CREATE INDEX "CategoryTemplate_categoryId_plateApprovedAt_idx"
  ON "CategoryTemplate" ("categoryId", "plateApprovedAt");
