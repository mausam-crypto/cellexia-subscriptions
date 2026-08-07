-- Contract ownership (v1.2.4).
--
-- ADDITIVE ONLY: three ADD COLUMN and one CREATE INDEX. No DROP, no RENAME, no
-- type change, no UPDATE/DELETE — not one pre-existing column is read or
-- written, so this migration cannot lose data and needs no table rewrite
-- (ADD COLUMN … NOT NULL DEFAULT is metadata-only on PG 11+).

-- AlterTable
ALTER TABLE "SellingPlanConfig" ADD COLUMN     "shopifyPlanIds" JSONB;

-- AlterTable
--
-- WHY THE FILL VALUE AND THE STANDING DEFAULT ARE BOTH 'UNKNOWN'.
--
-- The shop may run a second subscription app (the client's store runs Joy
-- Subscriptions). SUBSCRIPTION_CONTRACTS_* webhooks fire for EVERY contract on
-- the store, whoever created it, and this app has been mirroring all of them
-- since before ownership existed — so at the moment this migration runs, every
-- pre-existing row is of unknown provenance. Some are ours; some are Joy's.
--
-- The fill value of ADD COLUMN is what those rows get. 'OURS' would be
-- FAIL-OPEN: the billing sweep charges everything marked OURS, so the first
-- sweep after the upgrade would charge Joy's subscribers on top of Joy —
-- exactly the duplicate charge this column exists to prevent — and it would do
-- so silently, with no admin step in between. There is also no evidence in the
-- database to decide it here: ContractLine."sellingPlanId" and
-- SellingPlanConfig."shopifyPlanIds", the two columns ownership is derived
-- from, are both added by THIS migration and are therefore null on every
-- pre-existing row.
--
-- So the backfill is 'UNKNOWN', which every billing / dunning / notification /
-- Klaviyo / analytics / portal query treats as NOT ours (see OURS_ONLY in
-- app/lib/ownership/ownership.server.ts). Nothing pre-existing is billed until
-- it has been positively identified — by reclassifyContracts(), which the
-- Preview & launch page runs on demand and go-live runs automatically, or by
-- an admin claiming it on the Subscribers page. Worst case of a failure there
-- is a renewal that waits; worst case of the other direction is a real
-- customer charged twice.
--
-- 'UNKNOWN' also STAYS the column default for rows inserted from here on,
-- matching prisma/schema.prisma. An earlier draft flipped the default to
-- 'OURS' in a second statement, on the reasoning that every insert path writes
-- ownership explicitly anyway (the webhook mirror classifies it, both import
-- paths and the portal demo fixture stamp OURS). That reasoning is true and
-- was still the wrong way round: a default is only ever REACHED by an insert
-- that forgot the column, so its value is not "what most contracts are", it is
-- "what a future bug gets". 'OURS' hands that bug straight to the billing
-- sweep; 'UNKNOWN' hands it to reclassifyContracts(). Same mistake, one costs
-- a duplicate charge to a real customer and the other costs a renewal that
-- waits.
--
-- Keeping one statement instead of two is a second, smaller win: there is no
-- window — even under a non-transactional partial apply — in which the column
-- exists with a fail-open default.
ALTER TABLE "SubscriptionContract" ADD COLUMN     "ownership" TEXT NOT NULL DEFAULT 'UNKNOWN';

-- AlterTable
ALTER TABLE "ContractLine" ADD COLUMN     "sellingPlanId" TEXT,
ADD COLUMN     "sellingPlanName" TEXT;

-- CreateIndex
CREATE INDEX "SubscriptionContract_shopId_ownership_status_nextBillingDat_idx" ON "SubscriptionContract"("shopId", "ownership", "status", "nextBillingDate");
