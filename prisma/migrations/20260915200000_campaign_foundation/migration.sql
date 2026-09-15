-- Campaign automation, Phase 1: data foundation.
--
-- CLIENT → CAMPAIGN → CAMPAIGN DAYS (ContentCalendar) → POSTER VERSIONS
--
-- Generated with `prisma migrate diff --from-schema-datasource
-- --to-schema-datamodel` against the development database, then reviewed.
--
-- Purely additive:
--   * six new enums;
--   * two new tables, "Campaign" and "PosterVersion";
--   * nullable or defaulted columns on "ContentCalendar" and "CategoryTemplate"
--     (NOT NULL columns carry constant defaults, which PostgreSQL 11+ records in
--     the catalogue without rewriting the table);
--   * new indexes and foreign keys.
-- No existing column, index or constraint is altered or dropped, and no row is
-- updated. Every existing calendar row keeps campaignId NULL and stays on the
-- legacy pipeline; nothing in the dispatch sweep reads the new columns.

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TemplateMappingMode" AS ENUM ('AUTO', 'MANUAL');

-- CreateEnum
CREATE TYPE "CampaignApprovalPolicy" AS ENUM ('MANUAL_REVIEW', 'AUTO_APPROVE');

-- CreateEnum
CREATE TYPE "PosterGenerationStatus" AS ENUM ('NOT_REQUESTED', 'QUEUED', 'GENERATING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "PosterVersionSource" AS ENUM ('PIPELINE', 'POSTER_STUDIO', 'MANUAL_UPLOAD');

-- CreateEnum
CREATE TYPE "PosterApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "CategoryTemplate" ADD COLUMN     "contentTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "ContentCalendar" ADD COLUMN     "activePosterVersionId" TEXT,
ADD COLUMN     "campaignId" TEXT,
ADD COLUMN     "contentRevision" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "contentType" TEXT,
ADD COLUMN     "cta" TEXT,
ADD COLUMN     "generationStatus" "PosterGenerationStatus",
ADD COLUMN     "headline" TEXT,
ADD COLUMN     "lastPosterVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "suggestedTemplateId" TEXT,
ADD COLUMN     "supportingText" TEXT;

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "startDate" TIMESTAMP(3) NOT NULL,
    "durationDays" INTEGER NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "deliveryTime" TEXT NOT NULL DEFAULT '09:00',
    "deliveryDays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "templateMappingMode" "TemplateMappingMode" NOT NULL DEFAULT 'AUTO',
    "approvalPolicy" "CampaignApprovalPolicy" NOT NULL DEFAULT 'MANUAL_REVIEW',
    "generationWindowDays" INTEGER NOT NULL DEFAULT 14,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosterVersion" (
    "id" TEXT NOT NULL,
    "calendarDayId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "source" "PosterVersionSource" NOT NULL,
    "imageDriveFileId" TEXT NOT NULL,
    "imageMimeType" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "contentRevision" INTEGER NOT NULL,
    "templateId" TEXT,
    "parentVersionId" TEXT,
    "studioGenerationId" TEXT,
    "approvalStatus" "PosterApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosterVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Campaign_clientId_status_idx" ON "Campaign"("clientId", "status");

-- CreateIndex
CREATE INDEX "Campaign_status_idx" ON "Campaign"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_id_clientId_key" ON "Campaign"("id", "clientId");

-- CreateIndex
CREATE INDEX "PosterVersion_templateId_idx" ON "PosterVersion"("templateId");

-- CreateIndex
CREATE INDEX "PosterVersion_studioGenerationId_idx" ON "PosterVersion"("studioGenerationId");

-- CreateIndex
CREATE INDEX "PosterVersion_parentVersionId_idx" ON "PosterVersion"("parentVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "PosterVersion_calendarDayId_versionNumber_key" ON "PosterVersion"("calendarDayId", "versionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "PosterVersion_id_calendarDayId_key" ON "PosterVersion"("id", "calendarDayId");

-- CreateIndex
CREATE UNIQUE INDEX "ContentCalendar_activePosterVersionId_key" ON "ContentCalendar"("activePosterVersionId");

-- CreateIndex
CREATE INDEX "ContentCalendar_campaignId_scheduledDate_idx" ON "ContentCalendar"("campaignId", "scheduledDate");

-- CreateIndex
CREATE INDEX "ContentCalendar_suggestedTemplateId_idx" ON "ContentCalendar"("suggestedTemplateId");

-- CreateIndex
CREATE UNIQUE INDEX "ContentCalendar_campaignId_dayNumber_key" ON "ContentCalendar"("campaignId", "dayNumber");

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentCalendar" ADD CONSTRAINT "ContentCalendar_campaignId_clientId_fkey" FOREIGN KEY ("campaignId", "clientId") REFERENCES "Campaign"("id", "clientId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentCalendar" ADD CONSTRAINT "ContentCalendar_suggestedTemplateId_fkey" FOREIGN KEY ("suggestedTemplateId") REFERENCES "CategoryTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentCalendar" ADD CONSTRAINT "ContentCalendar_activePosterVersionId_id_fkey" FOREIGN KEY ("activePosterVersionId", "id") REFERENCES "PosterVersion"("id", "calendarDayId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "PosterVersion" ADD CONSTRAINT "PosterVersion_calendarDayId_fkey" FOREIGN KEY ("calendarDayId") REFERENCES "ContentCalendar"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosterVersion" ADD CONSTRAINT "PosterVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "CategoryTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosterVersion" ADD CONSTRAINT "PosterVersion_parentVersionId_fkey" FOREIGN KEY ("parentVersionId") REFERENCES "PosterVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosterVersion" ADD CONSTRAINT "PosterVersion_studioGenerationId_fkey" FOREIGN KEY ("studioGenerationId") REFERENCES "PosterStudioGeneration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
