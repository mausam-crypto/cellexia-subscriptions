-- 0025_design_measurement (v1.26.0)
-- Five nullable columns on "SubscriptionContract", one on
-- "WidgetDesignRevision", two new tables.
--
-- ADDITIVE ONLY: every new column is nullable and both new tables are
-- invisible to the previous release, so v1.25 code runs unchanged against
-- this schema (UPDATE.md §2.3 / §5.2). Rolling the server back leaves the
-- rows in place; nothing in v1.25 reads them.
--
-- "SubscriptionContract.originDesign*": the buy-box design (preset key,
-- whether subscription was preselected, the design revision live at checkout,
-- and how it was resolved) that acquired this subscriber — write-once, and
-- DELIBERATELY outside the acq* family: the merchant decided a design label
-- is not personal data and must survive CUSTOMERS_REDACT so lifetime gross
-- profit by design stays whole.
--
-- "WidgetDesignRevision.label": optional merchant-given design name.
--
-- "SubscribableOrder": one row per subscribable storefront order (the
-- take-rate denominator population) with the design seen, subscription
-- outcome and hygiene flags. PII-free (no email / customer id).
--
-- "MarketCountryMap": country → Shopify market handle cache.

ALTER TABLE "SubscriptionContract" ADD COLUMN "originDesignKey" TEXT;
ALTER TABLE "SubscriptionContract" ADD COLUMN "originDesignPreselect" TEXT;
ALTER TABLE "SubscriptionContract" ADD COLUMN "originDesignRevisionId" TEXT;
ALTER TABLE "SubscriptionContract" ADD COLUMN "originDesignSource" TEXT;
ALTER TABLE "SubscriptionContract" ADD COLUMN "originDesignStampedAt" TIMESTAMP(3);

ALTER TABLE "WidgetDesignRevision" ADD COLUMN "label" TEXT;

CREATE TABLE "SubscribableOrder" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderName" TEXT,
    "processedAt" TIMESTAMP(3) NOT NULL,
    "countryCode" TEXT,
    "currencyCode" TEXT,
    "marketHandle" TEXT,
    "deviceType" TEXT,
    "sourceName" TEXT,
    "orderTotalCents" INTEGER,
    "units" INTEGER,
    "designKey" TEXT,
    "designPreselect" TEXT,
    "designRevisionId" TEXT,
    "designSource" TEXT NOT NULL,
    "calendarDesignKey" TEXT,
    "hasSellingPlanLine" BOOLEAN NOT NULL DEFAULT false,
    "ownership" TEXT NOT NULL,
    "exposure" BOOLEAN NOT NULL DEFAULT false,
    "subscribed" BOOLEAN NOT NULL DEFAULT false,
    "contractId" TEXT,
    "subscribedAt" TIMESTAMP(3),
    "promo" BOOLEAN NOT NULL DEFAULT false,
    "mixed" BOOLEAN NOT NULL DEFAULT false,
    "transition" BOOLEAN NOT NULL DEFAULT false,
    "staff" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscribableOrder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SubscribableOrder_shopId_orderId_key" ON "SubscribableOrder"("shopId", "orderId");
CREATE INDEX "SubscribableOrder_shopId_processedAt_idx" ON "SubscribableOrder"("shopId", "processedAt");
CREATE INDEX "SubscribableOrder_shopId_designKey_processedAt_idx" ON "SubscribableOrder"("shopId", "designKey", "processedAt");
CREATE INDEX "SubscribableOrder_shopId_contractId_idx" ON "SubscribableOrder"("shopId", "contractId");

CREATE TABLE "MarketCountryMap" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "marketHandle" TEXT NOT NULL,
    "marketName" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketCountryMap_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MarketCountryMap_shopId_countryCode_key" ON "MarketCountryMap"("shopId", "countryCode");
