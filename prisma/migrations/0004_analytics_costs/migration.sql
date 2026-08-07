-- Analytics cost model (ships in v1.4.0; a work-in-progress header briefly
-- dated it v1.2.5 — that version was never released).
--
-- ADDITIVE ONLY: nine ADD COLUMN statements. No DROP, no RENAME, no type
-- change, no UPDATE/DELETE — no pre-existing column is read or written, so
-- this migration cannot lose data and needs no table rewrite
-- (ADD COLUMN … NOT NULL DEFAULT is metadata-only on PG 11+).
--
-- Why these columns exist:
--
-- * ProductCadence."unitCostCentsOverride" — the merchant's own per-product
--   COGS entry (Plans page → "Costs & margins"). Before this migration COGS
--   came ONLY from Shopify inventoryItem.unitCost mirrored into
--   ContractLine."unitCostCents", which most stores never fill in — LTGP then
--   silently read revenue-with-zero-cost. Resolution order per billed line:
--   ContractLine.unitCostCents → this override → costModel.cogsFallbackPctOfPrice
--   (see app/lib/analytics/costs.server.ts).
--
-- * BillingAttempt."refundedCents" — refunds recorded by the REFUNDS_CREATE
--   webhook against the attempt's order. The originally charged amountCents is
--   never rewritten; analytics subtract this column instead, so charge history
--   and rollups stay reconcilable.
--
-- * DailyRollup."refundedCents" / "shippingCostCents" / "feesCents" /
--   "estimatedCogsCents" and CohortCell."refundedCents" /
--   "estimatedCogsCents" — the two gross-profit surfaces previously used
--   DIFFERENT formulas (rollup: charged − COGS; cohorts: revenue − COGS −
--   customer-paid delivery − hardcoded 2.9%+30¢). Both now store the same
--   decomposition (revenue net of refunds − COGS − fulfillment/shipping cost −
--   payment fees), and estimatedCogsCents records how much of the COGS figure
--   came from the percentage fallback so the UI can flag partly-estimated LTGP.
--
-- The zero DEFAULTs are historically honest for the backfill: no refunds were
-- recorded and no shipping/fee estimates were computed before this migration,
-- and the nightly cohort recompute + rollup re-runs fill the new columns
-- forward from raw data.

-- AlterTable
ALTER TABLE "ProductCadence" ADD COLUMN     "unitCostCentsOverride" INTEGER;

-- AlterTable
ALTER TABLE "BillingAttempt" ADD COLUMN     "refundedCents" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "DailyRollup" ADD COLUMN     "estimatedCogsCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "feesCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "refundedCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "shippingCostCents" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "CohortCell" ADD COLUMN     "estimatedCogsCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "refundedCents" INTEGER NOT NULL DEFAULT 0;
