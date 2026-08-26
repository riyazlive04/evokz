-- The layout every template uploaded to a vertical is given.
--
-- Nullable and unset everywhere, so uploads keep extracting until a vertical is
-- given one. See `Category.defaultLayoutSpec` for why a vertical would want it.
ALTER TABLE "Category" ADD COLUMN "defaultLayoutSpec" JSONB;
