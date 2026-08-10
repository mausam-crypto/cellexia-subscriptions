-- Data-collection audit (v1.9.0): capture-at-the-moment columns for facts the
-- analytics and lifecycle engines were reconstructing after the fact — or
-- silently lacking.
--
-- ADDITIVE ONLY: twenty-five nullable-or-defaulted ADD COLUMN statements
-- across nine tables, plus two new tables and their indexes. No DROP, no
-- RENAME, no type change, no UPDATE/DELETE — no pre-existing column is read
-- or written, so this migration cannot lose data and needs no table rewrite
-- (ADD COLUMN … NOT NULL DEFAULT is metadata-only on PG 11+).
--
-- Why these columns exist:
--
-- * SubscriptionContract."expiredAt" / "pausedReason" / "merchantSkipCount"
--   — lifecycle facts the status machine held without dating or attributing:
--   WHEN a contract flipped EXPIRED (the way cancelledAt dates a cancel),
--   WHY it paused (the pause analogue of cancelReason: CUSTOMER | ADMIN |
--   SAVE_FLOW | STOCKOUT_DELAY | SYSTEM), and how many skips the MERCHANT
--   initiated — counted apart from skipCount so churn-risk features read
--   customer intent only (an admin skipping around a stockout is not a
--   disengagement signal).
--
-- * SubscriptionContract."originOrderTaxCents" / "originOrderFulfilledAt" —
--   the origin (checkout) money mirror of migration 0006, continued: the tax
--   share of the origin total, so net-of-tax revenue math stops treating the
--   checkout payment as tax-free, and the origin order's first fulfillment
--   timestamp, so delivery-experience analytics can measure the pay→ship gap
--   for cycle 0. Filled by the same capture-at-mirror / origin_order_backfill
--   paths as the 0006 columns; null = not captured yet.
--
-- * SubscriptionContract."billingMinCycles" / "billingMaxCycles" — mirror of
--   the Shopify billing policy's cycle bounds, alongside the interval columns
--   mirrored since v1.4.0. Read by the portal's commitment-aware cancel
--   guards and by expiry analytics next to expiredAt; null = no bound set.
--
-- * ContractLine."pricingPolicy" — the line's {basePrice, cycleDiscounts[]}
--   exactly as the contract query returns it. The price-change apply engine
--   reads it to compute per-line adjustments; lines without one are recorded
--   SKIPPED_NULL_LINE in PriceChangeContractOutcome instead of guessed at.
--
-- * BillingAttempt."discountCents" / "taxCents" / "shippingCents" /
--   "subtotalCents" — the renewal-order money breakdown captured at
--   settlement. amountCents keeps the total as charged; these split it so
--   rollup + cohort math can report net-of-tax revenue and real discount
--   spend instead of estimating them. The discount figure also feeds the
--   FIRST writer of SubscriptionContract.lifetimeDiscountCents (renewals-only
--   meaning, like lifetimeRevenueCents).
--
-- * BillingAttempt."orderProcessedAt" / "fulfilledAt" — the renewal order's
--   processedAt and first-fulfillment timestamps, so charge→ship latency is
--   measurable per cycle (the renewal twin of originOrderProcessedAt /
--   originOrderFulfilledAt).
--
-- * BillingAttempt."costSnapshot" — per-charge cost basis {v:1, cogsCents,
--   estimatedCogsCents, shippingCostCents, fulfillmentCostCents,
--   deliveriesPerCharge, lines[]} captured at settlement through the shared
--   cost model, so gross-profit history survives later cost-setting edits:
--   analytics read the snapshot when present and fall back to live cost
--   resolution only for pre-0016 rows.
--
-- * DunningCase."amountAtRiskCents" / "amountAtRiskCurrencyCode" — the
--   ESTIMATED cycle amount at case-open, priced from the contract's lines +
--   delivery at that moment. Failed attempts carry no amountCents (Shopify
--   only prices an attempt on success), so recovery reporting had case
--   counts but no money at stake. An estimate, never rewritten;
--   recoveredCents holds the actual.
--
-- * DunningCase."originalPaymentMethodId" — the contract's paymentMethodId
--   at case-open, compared to the method at recovery so analytics can split
--   "customer fixed the card" from "retry ladder got lucky".
--
-- * DunningCase."ladderCursor" — which entry of the CONFIGURED retry ladder
--   the next retry reads from. ladderStep counts retries performed; the
--   cursor pins schedule position so a mid-case ladder-config edit cannot
--   replay or skip steps. Null = pre-0016 case, engine falls back to
--   ladderStep.
--
-- * GiftGrant."shippedAt" — stamped at the ADDED→SHIPPED settlement flip so
--   analytics can count gift COGS even after mirror hygiene later flips the
--   grant REMOVED: the ship fact survives the status machine.
--
-- * NotificationLog."outboxId" — the KlaviyoOutbox row that carried the
--   notification, so a logged SENT traces to the delivery attempt that
--   actually left the building (the outbox retries/fails independently).
--
-- * PriceChangeBatch."currencyCode" — the currency the batch's old/new
--   prices are denominated in, stamped from the shop at creation, so the
--   apply step's currency guard can refuse contracts billed in another
--   currency instead of writing cross-currency cents. Null = pre-0016 batch
--   (readers assume the shop currency, which is what those batches meant).
--
-- * WinbackState."optedOutAt" — when status flipped OPTED_OUT, so the
--   suppression is datable and auditable.
--
-- * DailyRollup."excludedForeignCurrencyCents" — money the currency guards
--   excluded from the row's shop-currency aggregates, made visible instead
--   of silently dropped. Default 0 is historically honest: nothing visible
--   was ever recorded before this column.
--
-- * DailyRollup."snapshotFabricated" — true on gap-backfilled rollup days
--   whose point-in-time snapshot columns (activeSubscribers, mrrCents,
--   openDunningCases, ...) could not be reconstructed after the fact, so
--   dashboards can badge fabricated days instead of presenting them as
--   measured. Default false is correct for every pre-0016 row: they were
--   all written live.
--
-- Why the new tables exist:
--
-- * "PriceChangeContractOutcome" — per-contract outcome of a price-change
--   batch. The batch used to keep only contractsAffected, an aggregate that
--   could not answer "which contract failed, and why", so a half-applied
--   batch was invisible. One row per (batch, contract) per phase: APPLIED |
--   FAILED | SKIPPED_NULL_LINE | NOTICE_SENT | NOTICE_FAILED, with the
--   Shopify/user error verbatim on the *_FAILED rows.
--
-- * "AvailabilitySnapshot" — one row per (shop, shop-tz day): which
--   subscribable variants were unavailable that day, out of how many were
--   checked. Shopify availability is unqueryable retroactively, so without
--   this record stockout analytics could never say what was actually out of
--   stock on the day a renewal was delayed, skipped or substituted.

-- AlterTable
ALTER TABLE "SubscriptionContract" ADD COLUMN     "billingMaxCycles" INTEGER,
ADD COLUMN     "billingMinCycles" INTEGER,
ADD COLUMN     "expiredAt" TIMESTAMP(3),
ADD COLUMN     "merchantSkipCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "originOrderFulfilledAt" TIMESTAMP(3),
ADD COLUMN     "originOrderTaxCents" INTEGER,
ADD COLUMN     "pausedReason" TEXT;

-- AlterTable
ALTER TABLE "ContractLine" ADD COLUMN     "pricingPolicy" JSONB;

-- AlterTable
ALTER TABLE "BillingAttempt" ADD COLUMN     "costSnapshot" JSONB,
ADD COLUMN     "discountCents" INTEGER,
ADD COLUMN     "fulfilledAt" TIMESTAMP(3),
ADD COLUMN     "orderProcessedAt" TIMESTAMP(3),
ADD COLUMN     "shippingCents" INTEGER,
ADD COLUMN     "subtotalCents" INTEGER,
ADD COLUMN     "taxCents" INTEGER;

-- AlterTable
ALTER TABLE "DunningCase" ADD COLUMN     "amountAtRiskCents" INTEGER,
ADD COLUMN     "amountAtRiskCurrencyCode" TEXT,
ADD COLUMN     "ladderCursor" INTEGER,
ADD COLUMN     "originalPaymentMethodId" TEXT;

-- AlterTable
ALTER TABLE "GiftGrant" ADD COLUMN     "shippedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "NotificationLog" ADD COLUMN     "outboxId" TEXT;

-- AlterTable
ALTER TABLE "PriceChangeBatch" ADD COLUMN     "currencyCode" TEXT;

-- AlterTable
ALTER TABLE "WinbackState" ADD COLUMN     "optedOutAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "DailyRollup" ADD COLUMN     "excludedForeignCurrencyCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "snapshotFabricated" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "PriceChangeContractOutcome" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceChangeContractOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AvailabilitySnapshot" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "unavailableVariantIds" JSONB NOT NULL,
    "checkedVariants" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AvailabilitySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PriceChangeContractOutcome_batchId_idx" ON "PriceChangeContractOutcome"("batchId");

-- CreateIndex
CREATE INDEX "PriceChangeContractOutcome_contractId_idx" ON "PriceChangeContractOutcome"("contractId");

-- CreateIndex
CREATE UNIQUE INDEX "AvailabilitySnapshot_shopId_date_key" ON "AvailabilitySnapshot"("shopId", "date");
