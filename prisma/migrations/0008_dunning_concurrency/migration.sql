-- Dunning concurrency (stability pass).
--
-- ADDITIVE ONLY: one nullable ADD COLUMN, one partial unique index, and a
-- data repair that only closes duplicate-open DunningCase rows (the exact
-- corruption the index makes impossible). No DROP, no RENAME, no type change
-- on any pre-existing column.
--
-- Why:
--
-- 1) onBillingAttemptFailed's redelivery guard (status=FAILED &&
--    declineCategory != null) is read-then-act, and declineCategory is
--    written LAST after seconds of work. A delayed FAILURE webhook landing
--    while the stale_attempt_sweep is mid-resolution ran the WHOLE engine
--    twice for the same attempt: consecutiveFailures double-incremented,
--    duplicate "payment failed" emails, and — worst — two open dunning
--    cases whose ladders each minted charge attempts.
--    "dunningClaimedAt" is the concurrency lease the engine claims
--    atomically at entry (updateMany gated on declineCategory IS NULL and a
--    null/expired lease): only one invocation proceeds. Crash-resumability
--    is preserved — a crashed run leaves declineCategory null and the lease
--    expires, so a redelivery re-drives the failure exactly as before.
--
-- 2) ensureOpenCase was find-then-create with no uniqueness on "one open
--    case per contract": two racing invocations (or two distinct failing
--    attempts) could both create a case. The partial unique index makes the
--    invariant a database fact; the engine catches the unique violation and
--    reuses the winner's case. Resolved states leave the index automatically,
--    so closing a case needs no extra bookkeeping.
ALTER TABLE "BillingAttempt" ADD COLUMN "dunningClaimedAt" TIMESTAMP(3);

-- Repair before the index can build: if a book already holds several open
-- cases for one contract (the very defect being fixed), keep the NEWEST and
-- close the rest as superseded duplicates. Their cycle's recovery is carried
-- by the surviving case's ladder on the same contract; zombie duplicates
-- otherwise keep firing retries against recovered cycles until they cancel a
-- paying subscriber.
UPDATE "DunningCase" AS dup
SET "state" = 'CANCELLED',
    "resolvedAt" = CURRENT_TIMESTAMP,
    "resolution" = 'SUPERSEDED_DUPLICATE',
    "nextRetryAt" = NULL
FROM (
  SELECT "id",
         ROW_NUMBER() OVER (
           PARTITION BY "contractId"
           ORDER BY "openedAt" DESC, "id" DESC
         ) AS rn
  FROM "DunningCase"
  WHERE "state" IN ('OPEN', 'RETRYING', 'AWAITING_CUSTOMER', 'AWAITING_3DS')
) ranked
WHERE dup."id" = ranked."id" AND ranked.rn > 1;

-- The invariant, enforced by Postgres (Prisma's schema DSL cannot express a
-- partial index — documented on the DunningCase model). Any concurrent
-- second create surfaces as a unique violation (P2002) the engine handles by
-- re-fetching the open case.
CREATE UNIQUE INDEX "DunningCase_one_open_case_per_contract"
ON "DunningCase"("contractId")
WHERE "state" IN ('OPEN', 'RETRYING', 'AWAITING_CUSTOMER', 'AWAITING_3DS');
