-- Per-plan lock window (v1.13.0): "Block skip, pause, change or cancel for
-- the first X days" after subscribing.
--
-- Why: the first order carries the plan's largest discount, so a shopper can
-- subscribe for the discount and cancel (or skip / pause / push the next date
-- out) before a single renewal bills. The merchant sets this to roughly the
-- delivery-plus-first-use time; during that window every CUSTOMER-initiated
-- schedule reduction is refused with the unlock date, while admin, dunning
-- and system flows keep full control. 0 (the default) disables the lock, so
-- every existing plan behaves exactly as before this migration.
--
-- SellingPlanConfig.lockDays — the merchant's setting, per plan.
-- SubscriptionContract.lockDays — the commitment AS SUBSCRIBED UNDER,
-- stamped once when the contract mirror is created. The effective window is
-- min(contract stamp, current plan setting): enabling or raising the setting
-- never locks people who subscribed before it existed; lowering or disabling
-- it releases everyone immediately. Null (every pre-upgrade row, imports,
-- install backfills) = exempt.
--
-- ADDITIVE ONLY: two ADD COLUMN statements — no DROP, no RENAME, no type
-- change, no UPDATE/DELETE. Pre-upgrade code never reads either column, so
-- rollback to the previous release stays safe (ADD COLUMN … NOT NULL DEFAULT
-- is metadata-only on PG 11+; the nullable column is pure metadata).

-- AlterTable
ALTER TABLE "SellingPlanConfig" ADD COLUMN     "lockDays" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "SubscriptionContract" ADD COLUMN     "lockDays" INTEGER;
