-- History for the AI Poster Studio (/admin/poster-studio).
--
-- Generated with `prisma migrate diff --from-schema-datasource --to-schema-datamodel`
-- against the development database (docker-compose.dev.yml) after every earlier
-- migration had been applied to it with `prisma migrate deploy`, so this is
-- exactly the difference between the migration history and schema.prisma — and
-- that difference is this table alone.
--
-- Purely additive. It creates one enum, one table, its indexes and two foreign
-- keys *from* the new table; no existing table or column is altered. The
-- `clientId` foreign key references "Client"("id") but adds nothing to "Client",
-- and both keys are ON DELETE SET NULL, so no existing delete path can be blocked
-- or cascaded by a studio row.
--
-- No image bytes are stored. The first version of the studio kept base64 data
-- URIs in a text column and was never migrated; its table only ever existed where
-- `prisma db push` had created it. Images now live in Google Drive and these rows
-- hold the file ids.

-- CreateEnum
CREATE TYPE "PosterStudioMode" AS ENUM ('GENERATE', 'EDIT', 'VARIATION');

-- CreateTable
CREATE TABLE "PosterStudioGeneration" (
    "id" TEXT NOT NULL,
    "mode" "PosterStudioMode" NOT NULL,
    "prompt" TEXT NOT NULL,
    "sentPrompt" TEXT NOT NULL,
    "aspectRatio" TEXT NOT NULL,
    "size" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "quality" TEXT NOT NULL,
    "textFree" BOOLEAN NOT NULL DEFAULT false,
    "imageDriveFileId" TEXT NOT NULL,
    "imageMimeType" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "referenceDriveFileId" TEXT,
    "referenceMimeType" TEXT,
    "parentGenerationId" TEXT,
    "clientId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosterStudioGeneration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PosterStudioGeneration_createdAt_idx" ON "PosterStudioGeneration"("createdAt");

-- CreateIndex
CREATE INDEX "PosterStudioGeneration_clientId_createdAt_idx" ON "PosterStudioGeneration"("clientId", "createdAt");

-- AddForeignKey
ALTER TABLE "PosterStudioGeneration" ADD CONSTRAINT "PosterStudioGeneration_parentGenerationId_fkey" FOREIGN KEY ("parentGenerationId") REFERENCES "PosterStudioGeneration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosterStudioGeneration" ADD CONSTRAINT "PosterStudioGeneration_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;
