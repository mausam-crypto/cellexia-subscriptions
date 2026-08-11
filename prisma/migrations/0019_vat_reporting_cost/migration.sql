-- VAT / sales tax as a reporting cost (v1.15.0): the tax share of kept
-- revenue, subtracted from both gross-profit surfaces while the merchant has
-- enabled the costModel.vat setting (Settings → Costs & profit). Nothing here
-- changes billing — reporting only.
--
-- ADDITIVE ONLY: four ADD COLUMN statements with NOT NULL DEFAULT 0 across
-- two derived-analytics tables. No DROP, no RENAME, no type change, no
-- UPDATE/DELETE — no pre-existing column is read or written, so this
-- migration cannot lose data and needs no table rewrite (ADD COLUMN … NOT
-- NULL DEFAULT is metadata-only on PG 11+). Both tables are derived (rollup
-- recompute / full cohort-triangle recompute), so a rollback that drops the
-- app version simply leaves the columns at their honest default.
--
-- Why these columns exist:
--
-- * DailyRollup."vatCents" / CohortCell."vatCents" — the tax contained in
--   the revenue each surface books: the cohort cell's KEPT revenue (net of
--   refunds, captured tax scaled to the kept share), and — like feesCents —
--   the rollup day's CHARGED (gross) revenue, booked on the charge day and
--   never credited back on a later refund's recorded day (the cohort
--   surface carries the refund-adjusted figure). Resolution per charge (the
--   COGS pattern — first known value wins): the REAL captured order tax
--   (BillingAttempt."taxCents" / SubscriptionContract."originOrderTaxCents",
--   migration 0016); else an estimate EXTRACTED from the charged total —
--   net × rate/(100+rate) — at the contract's delivery-country rate
--   (costModel.vat.countryRatesPct, set per country in Settings) falling
--   back to the default rate. While the vat setting is disabled (the
--   default) both columns stay 0 and gross profit is unchanged.
--
-- * DailyRollup."estimatedVatCents" / CohortCell."estimatedVatCents" — the
--   share of vatCents that came from the rate estimate instead of a
--   captured order total, so partly-estimated VAT is disclosed exactly the
--   way estimatedCogsCents discloses estimated COGS.
--
-- History note: the cohort triangle is a full nightly recompute, so the
-- entire LTGP history carries VAT from the first run after enablement; the
-- daily rollup only recomputes its trailing window, so closed rollup days
-- keep their pre-VAT gross profit (closed days are never rewritten — the
-- same rule every other rollup change follows).

ALTER TABLE "DailyRollup" ADD COLUMN "vatCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "DailyRollup" ADD COLUMN "estimatedVatCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CohortCell" ADD COLUMN "vatCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CohortCell" ADD COLUMN "estimatedVatCents" INTEGER NOT NULL DEFAULT 0;
