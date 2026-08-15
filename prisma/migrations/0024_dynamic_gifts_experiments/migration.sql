-- 0024_dynamic_gifts_experiments (v1.24.0)
-- Two new columns on "GiftRule", two on "GiftGrant", one new table.
--
-- ADDITIVE ONLY: new columns are defaulted or nullable and the new table is
-- invisible to the previous release, so v1.23 code runs unchanged against
-- this schema (UPDATE.md §2.3 / §5.2). Rollback safety is deliberate in the
-- design: a DYNAMIC gift rule keeps a real fallback "variantId", so old code
-- that ignores "selection" still grants a real product.
--
-- "GiftRule.selection": FIXED | DYNAMIC. DYNAMIC rules resolve the gift
-- variant per contract at grant time via the gift picker (gifts.pool
-- setting); "variantId" becomes the picker's fallback.
-- "GiftRule.repeatsAnnually": DAYS_SUBSCRIBED rules fire at every anniversary
-- multiple instead of once; old code ignores it and keeps fire-once.
--
-- "GiftGrant.unitCostCents": COGS stamped at grant time for dynamically
-- picked gifts (the rule's cost describes the fallback variant, not the
-- picked one). Analytics read grant → rule → per-variant override → 0.
-- "GiftGrant.source": producer label (RULE | LADDER | FIRST_ORDER |
-- SAVE_FLOW | WINBACK | REWARDS | MANUAL) so gift spend can be split by
-- origin.
--
-- "ExperimentAssignment": the per-(shop, experiment, customer) exposure
-- ledger. The arm is a deterministic hash of (experimentKey, unit) — this
-- table freezes the arm at first exposure so later allocation changes can
-- never reshuffle customers whose treatment already diverged. "unit" is the
-- lowercased customer email (per-person, never per-contract); "contractId"
-- is a convenience pointer with deliberately no FK (mirrors
-- "CustomerTagState") so the row survives contract deletion.

ALTER TABLE "GiftRule" ADD COLUMN "selection" TEXT NOT NULL DEFAULT 'FIXED';
ALTER TABLE "GiftRule" ADD COLUMN "repeatsAnnually" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "GiftGrant" ADD COLUMN "unitCostCents" INTEGER;
ALTER TABLE "GiftGrant" ADD COLUMN "source" TEXT;

CREATE TABLE "ExperimentAssignment" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "experimentKey" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "arm" TEXT NOT NULL,
    "contractId" TEXT,
    "firstExposedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExperimentAssignment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExperimentAssignment_shopId_experimentKey_unit_key" ON "ExperimentAssignment"("shopId", "experimentKey", "unit");

CREATE INDEX "ExperimentAssignment_shopId_experimentKey_arm_idx" ON "ExperimentAssignment"("shopId", "experimentKey", "arm");
