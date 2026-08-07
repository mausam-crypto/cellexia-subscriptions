-- Exact billing cadence mirror (v1.4.0).
--
-- ADDITIVE ONLY: two nullable ADD COLUMN statements. No DROP, no RENAME, no
-- type change, no UPDATE/DELETE — no pre-existing column is read or written,
-- so this migration cannot lose data and needs no table rewrite.
--
-- Why these columns exist:
--
-- SubscriptionContract."intervalWeeks" is a whole-week APPROXIMATION of the
-- Shopify billing policy (MONTH mapped to count×4, DAY to ceil(count/7)) that
-- scheduling, the portal and consolidation key off. MRR used to be computed
-- as cycleTotal × 4.345 / intervalWeeks, which overstated every monthly
-- contract by ~8.6% (4.345/4) and understated DAY cadences by up to ~16%.
--
-- These columns mirror the EXACT Shopify billing policy
-- (SellingPlanInterval unit + count) at sync time so money math can convert a
-- cycle to calendar-month revenue precisely (MONTH count n → 1/n cycles per
-- month, and so on). They are nullable: rows mirrored before v1.4.0 carry
-- NULL until their next sync, and consumers fall back to the intervalWeeks
-- approximation — never a crash, never a zero.

ALTER TABLE "SubscriptionContract" ADD COLUMN "billingIntervalUnit" TEXT;
ALTER TABLE "SubscriptionContract" ADD COLUMN "billingIntervalCount" INTEGER;
