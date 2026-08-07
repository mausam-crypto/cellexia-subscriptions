-- Success-settlement completion marker (stability pass).
--
-- ADDITIVE ONLY: one nullable ADD COLUMN plus a backfill that touches ONLY
-- the new column. No DROP, no RENAME, no type change on any pre-existing
-- column — this migration cannot lose data.
--
-- Why this column exists:
--
-- handleBillingAttemptSuccess used to claim the attempt (status → SUCCESS)
-- and then run the contract counter increment, gift flip, add-on clearing,
-- dunning close, order confirmation and event logging as SEPARATE statements.
-- If the process died between the claim and those side effects, the
-- redelivered webhook hit status=SUCCESS and took the mirror-refresh-only
-- replay path: the bookkeeping was lost FOREVER (open dunning case left
-- behind, ordersCount/lifetimeRevenueCents never incremented, rollup revenue
-- undercounted). The failure path was always re-driveable (declineCategory is
-- written LAST by the dunning engine); the success path had no equivalent.
--
-- "settledAt" is that equivalent: the accounting now commits atomically with
-- the claim (one transaction) and settledAt is stamped LAST, after every
-- remaining side effect. A SUCCESS attempt with settledAt NULL is
-- half-settled, and the replay path re-drives the missing side effects
-- (each one individually idempotent) instead of returning.
ALTER TABLE "BillingAttempt" ADD COLUMN "settledAt" TIMESTAMP(3);

-- Backfill: every attempt already SUCCESS predates the marker and had its
-- side effects driven by the pre-marker code (or is unrecoverable anyway —
-- the redrive path is idempotent, so this is an optimisation, not a
-- correctness requirement). Writes ONLY the newly added column.
UPDATE "BillingAttempt"
SET "settledAt" = COALESCE("completedAt", CURRENT_TIMESTAMP)
WHERE "status" = 'SUCCESS';
