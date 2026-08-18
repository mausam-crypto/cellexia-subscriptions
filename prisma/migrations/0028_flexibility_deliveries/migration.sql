-- 0028_flexibility_deliveries (v1.28.0, Stage D/E foundation)
-- Twelve nullable columns: three on "ContractLine", two on
-- "SubscriptionContract", six on "BillingAttempt", one on "WinbackState".
-- No new tables, no indexes.
--
-- ADDITIVE ONLY: every new column is nullable with no default, so v1.27 code
-- runs unchanged against this schema (UPDATE.md §2.3 / §5.2). Rolling the
-- server back leaves the columns in place; nothing in v1.27 reads them.
-- ("SubscriptionContract.pausedReason" already exists since 0016 and is
-- reused by the vacation-hold work — it is NOT re-added here.)
--
-- "ContractLine.skippedCycleIndex": the Shopify billing-cycle index the
-- customer chose "not this time" for on THIS line (per-line skip — a
-- billing-cycle contract draft that removes the line from that one cycle,
-- the contract line itself untouched). The estimate marks the line
-- skippedThisCycle when this equals the upcoming cycle index and bills 0 for
-- it; a value below the upcoming index is stale (the cycle settled, was
-- skipped whole, or the schedule re-anchored) and is nulled by
-- clearStaleCycleOverrides. Null = the line ships as usual.
--
-- "ContractLine.cycleQuantityOverride" / "cycleQuantityOverrideIndex": a
-- one-cycle quantity tweak ("just 1 this time") staged on the given cycle
-- index through the same billing-cycle draft path. The estimate bills
-- cycleQuantityOverride units when the index equals the upcoming cycle;
-- both are nulled together when stale. The recurring `quantity` column keeps
-- the plan quantity — the override never rewrites the contract.
--
-- "SubscriptionContract.deliveryInstructions": customer-entered delivery
-- note (P2.8), mirrored to the Shopify contract note / custom attributes.
--
-- "SubscriptionContract.cancelScheduledAt": a cancellation the customer
-- asked for at the END of the current (prepaid / committed) term instead of
-- immediately — the contract stays ACTIVE until the scheduler honours it.
-- Null = no scheduled cancel.
--
-- "BillingAttempt.trackingUrl" / "trackingCompany" / "trackingNumber" /
-- "orderStatusUrl" / "shippedAt" / "deliveredAt": renewal-order shipping
-- facts captured from FULFILLMENTS webhooks / order reads so the portal and
-- the shipped / delivered emails can show "track your parcel" without an
-- admin call. fulfilledAt (0016) keeps the first-fulfillment instant used by
-- analytics; shippedAt / deliveredAt are the customer-facing milestones.
--
-- "WinbackState.reason": the cancel reason snapshotted when the win-back
-- episode opened, so touches can be reason-aware without re-reading the
-- (possibly since-overwritten) contract.cancelReason.

ALTER TABLE "ContractLine" ADD COLUMN "skippedCycleIndex" INTEGER;
ALTER TABLE "ContractLine" ADD COLUMN "cycleQuantityOverride" INTEGER;
ALTER TABLE "ContractLine" ADD COLUMN "cycleQuantityOverrideIndex" INTEGER;

ALTER TABLE "SubscriptionContract" ADD COLUMN "deliveryInstructions" TEXT;
ALTER TABLE "SubscriptionContract" ADD COLUMN "cancelScheduledAt" TIMESTAMP(3);

ALTER TABLE "BillingAttempt" ADD COLUMN "trackingUrl" TEXT;
ALTER TABLE "BillingAttempt" ADD COLUMN "trackingCompany" TEXT;
ALTER TABLE "BillingAttempt" ADD COLUMN "trackingNumber" TEXT;
ALTER TABLE "BillingAttempt" ADD COLUMN "orderStatusUrl" TEXT;
ALTER TABLE "BillingAttempt" ADD COLUMN "shippedAt" TIMESTAMP(3);
ALTER TABLE "BillingAttempt" ADD COLUMN "deliveredAt" TIMESTAMP(3);

ALTER TABLE "WinbackState" ADD COLUMN "reason" TEXT;
