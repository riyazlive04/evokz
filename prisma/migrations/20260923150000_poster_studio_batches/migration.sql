-- Bulk Poster Studio runs: a batch per uploaded sheet, an item per Day + Prompt row.
--
-- Generated with `prisma migrate diff --from-schema-datasource
-- --to-schema-datamodel` against the development database, then reviewed.
--
-- Additive only: two enums, two new tables and one nullable column
-- ("PosterStudioGeneration"."batchItemId") with its index and foreign key.
-- Every existing studio row keeps NULL there, which is what it was: not made
-- by a bulk run. No existing column, index or constraint is altered or
-- dropped, and no row is updated.

-- CreateEnum
CREATE TYPE "PosterStudioBatchTarget" AS ENUM ('STUDIO', 'CAMPAIGN');

-- CreateEnum
CREATE TYPE "PosterStudioBatchStatus" AS ENUM ('DRAFT', 'RUNNING', 'PAUSED', 'DONE', 'CANCELLED');

-- AlterTable
ALTER TABLE "PosterStudioGeneration" ADD COLUMN     "batchItemId" TEXT;

-- CreateTable
CREATE TABLE "PosterStudioBatch" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "target" "PosterStudioBatchTarget" NOT NULL,
    "clientId" TEXT,
    "campaignId" TEXT,
    "aspectRatio" TEXT NOT NULL,
    "quality" TEXT,
    "textFree" BOOLEAN NOT NULL DEFAULT false,
    "festival" TEXT,
    "overlayElements" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "logoBackground" "PosterStudioLogoBackground" NOT NULL DEFAULT 'ORIGINAL',
    "footerBackground" "PosterStudioFooterBackground" NOT NULL DEFAULT 'AUTO',
    "status" "PosterStudioBatchStatus" NOT NULL DEFAULT 'DRAFT',
    "pausedReason" TEXT,
    "sourceFileName" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PosterStudioBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosterStudioBatchItem" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "dayLabel" TEXT NOT NULL,
    "dayNumber" INTEGER,
    "prompt" TEXT NOT NULL,
    "aspectRatio" TEXT,
    "festival" TEXT,
    "textFree" BOOLEAN,
    "quality" TEXT,
    "status" "PosterGenerationStatus" NOT NULL DEFAULT 'NOT_REQUESTED',
    "startedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "generationId" TEXT,
    "calendarDayId" TEXT,
    "posterVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PosterStudioBatchItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PosterStudioBatch_status_idx" ON "PosterStudioBatch"("status");

-- CreateIndex
CREATE INDEX "PosterStudioBatch_createdAt_idx" ON "PosterStudioBatch"("createdAt");

-- CreateIndex
CREATE INDEX "PosterStudioBatchItem_status_startedAt_idx" ON "PosterStudioBatchItem"("status", "startedAt");

-- CreateIndex
CREATE INDEX "PosterStudioBatchItem_calendarDayId_idx" ON "PosterStudioBatchItem"("calendarDayId");

-- CreateIndex
CREATE UNIQUE INDEX "PosterStudioBatchItem_batchId_position_key" ON "PosterStudioBatchItem"("batchId", "position");

-- CreateIndex
CREATE INDEX "PosterStudioGeneration_batchItemId_idx" ON "PosterStudioGeneration"("batchItemId");

-- AddForeignKey
ALTER TABLE "PosterStudioGeneration" ADD CONSTRAINT "PosterStudioGeneration_batchItemId_fkey" FOREIGN KEY ("batchItemId") REFERENCES "PosterStudioBatchItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosterStudioBatch" ADD CONSTRAINT "PosterStudioBatch_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosterStudioBatch" ADD CONSTRAINT "PosterStudioBatch_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosterStudioBatchItem" ADD CONSTRAINT "PosterStudioBatchItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "PosterStudioBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosterStudioBatchItem" ADD CONSTRAINT "PosterStudioBatchItem_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "PosterStudioGeneration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosterStudioBatchItem" ADD CONSTRAINT "PosterStudioBatchItem_calendarDayId_fkey" FOREIGN KEY ("calendarDayId") REFERENCES "ContentCalendar"("id") ON DELETE SET NULL ON UPDATE CASCADE;

