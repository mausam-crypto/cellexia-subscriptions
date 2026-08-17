-- 0026_widget_visits (v1.27.0)
-- One new table. ADDITIVE ONLY: invisible to v1.26 code (UPDATE.md §2.3 /
-- §5.2); rolling the server back leaves the rows in place, unread.
--
-- "WidgetVisitorDay": the storefront visit ledger written by the buy-box
-- beacon — one row per anonymous visitor (browser-local random id, no
-- personal data) per shop-day per (design, preselect) seen. It is the
-- conversion-rate denominator that pairs with "SubscribableOrder" (orders)
-- so the Results tab can put conversion, take rate and kept take rate per
-- widget design on the same footing.

CREATE TABLE "WidgetVisitorDay" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "vid" TEXT NOT NULL,
    "designKey" TEXT NOT NULL,
    "designPreselect" TEXT NOT NULL DEFAULT 'u',
    "countryCode" TEXT,
    "marketHandle" TEXT,
    "deviceType" TEXT,
    "views" INTEGER NOT NULL DEFAULT 0,
    "engaged" BOOLEAN NOT NULL DEFAULT false,
    "addedToCart" BOOLEAN NOT NULL DEFAULT false,
    "addedSubscription" BOOLEAN NOT NULL DEFAULT false,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WidgetVisitorDay_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WidgetVisitorDay_shopId_day_vid_designKey_designPreselect_key" ON "WidgetVisitorDay"("shopId", "day", "vid", "designKey", "designPreselect");
CREATE INDEX "WidgetVisitorDay_shopId_day_idx" ON "WidgetVisitorDay"("shopId", "day");
CREATE INDEX "WidgetVisitorDay_shopId_designKey_day_idx" ON "WidgetVisitorDay"("shopId", "designKey", "day");
-- (shopId, lastSeenAt): the scoreboard's "last visit" is a top-1 by lastSeenAt
-- and the self-check counts rows seen since a cutoff; without this index both
-- would sort the shop's whole ledger on every read.
CREATE INDEX "WidgetVisitorDay_shopId_lastSeenAt_idx" ON "WidgetVisitorDay"("shopId", "lastSeenAt");
