-- AnalyticsEvent replay protection: nullable unique dedupeKey, written only
-- when the emitter passes an explicit key (events.server.ts) so a redelivered
-- webhook cannot create a second warehouse row for the same fact.

-- AlterTable
ALTER TABLE "AnalyticsEvent" ADD COLUMN "dedupeKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "AnalyticsEvent_dedupeKey_key" ON "AnalyticsEvent"("dedupeKey");
