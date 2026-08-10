-- Multi-unit order frequencies (v1.8.0).
--
-- ADDITIVE ONLY: two nullable ADD COLUMN statements. No DROP, no RENAME, no
-- type change, no UPDATE/DELETE — no pre-existing column is read or written,
-- so this migration cannot lose data and needs no table rewrite.
--
-- Why these columns exist:
--
-- SellingPlanConfig."frequenciesWeeks" could only express whole-week
-- cadences, so a merchant could not offer "every 10 days" or "every month",
-- let alone mix units inside one plan group. These columns store the
-- multi-unit truth — "frequencies" as [{unit: DAY|WEEK|MONTH, count}, ...]
-- and "defaultFrequency" as one such pair — which the selling-plan sync,
-- admin UI, buy box and portal all read first (app/lib/frequency.ts).
--
-- They are nullable: rows saved before v1.8.0 carry NULL until their next
-- save, and consumers fall back to the legacy week columns — never a crash,
-- never a lost frequency. The legacy columns keep being WRITTEN as whole-week
-- approximations on every save so a rollback to a pre-v1.8.0 build still
-- sees a coherent (week-only) view of every config.

ALTER TABLE "SellingPlanConfig" ADD COLUMN "frequencies" JSONB;
ALTER TABLE "SellingPlanConfig" ADD COLUMN "defaultFrequency" JSONB;
