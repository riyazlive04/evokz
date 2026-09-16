-- Campaign automation, Phase 6: campaign WhatsApp delivery.
--
-- Additive: one new enum and one new table. No existing table, column, index or
-- constraint is altered or dropped, and nothing is backfilled. The legacy
-- delivery columns on "ContentCalendar" ("deliveryStatus", "sendAfter",
-- "approvedAt", "gDriveViewUrl") are deliberately untouched — campaign delivery
-- keeps its own records so the legacy dispatch sweep and its isolation suite are
-- unaffected.
--
-- "CampaignDelivery"."calendarDayId" is UNIQUE on purpose: it is the
-- idempotency mechanism. One campaign day can have at most one delivery row,
-- ever, so a duplicated cron sweep, a second browser tab, a retry or a restart
-- cannot produce a second send.

-- CreateEnum
CREATE TYPE "CampaignDeliveryStatus" AS ENUM ('SCHEDULED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED', 'SKIPPED');

-- CreateTable
CREATE TABLE "CampaignDelivery" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "calendarDayId" TEXT NOT NULL,
    "posterVersionId" TEXT NOT NULL,
    "status" "CampaignDeliveryStatus" NOT NULL DEFAULT 'SCHEDULED',
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "sendingStartedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "providerMessageId" TEXT,
    "failureReason" TEXT,
    "failurePermanent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CampaignDelivery_calendarDayId_key" ON "CampaignDelivery"("calendarDayId");

-- CreateIndex
CREATE INDEX "CampaignDelivery_status_scheduledFor_idx" ON "CampaignDelivery"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "CampaignDelivery_campaignId_status_idx" ON "CampaignDelivery"("campaignId", "status");

-- CreateIndex
CREATE INDEX "CampaignDelivery_posterVersionId_idx" ON "CampaignDelivery"("posterVersionId");

-- AddForeignKey
ALTER TABLE "CampaignDelivery" ADD CONSTRAINT "CampaignDelivery_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignDelivery" ADD CONSTRAINT "CampaignDelivery_calendarDayId_fkey" FOREIGN KEY ("calendarDayId") REFERENCES "ContentCalendar"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignDelivery" ADD CONSTRAINT "CampaignDelivery_posterVersionId_fkey" FOREIGN KEY ("posterVersionId") REFERENCES "PosterVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
