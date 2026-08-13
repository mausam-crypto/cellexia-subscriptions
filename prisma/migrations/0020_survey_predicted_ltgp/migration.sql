-- 0020_survey_predicted_ltgp (v1.21.0)
-- Post-purchase survey (thank-you / order-status page) + per-contract
-- predicted LTGP at fixed horizons.
--
-- ADDITIVE ONLY: one new table, four nullable columns on
-- "SubscriptionContract". No DROP, no RENAME, no type change, no default
-- rewrite on existing columns. Nullable ADD COLUMN is metadata-only on
-- PG 11+, so existing rows are untouched and the previous release runs
-- unchanged against this schema (UPDATE.md §2.3 / §5.2).
--
-- "SubscriptionContract"."predictedLtgp" / "predictedLtgpAt": nightly output
--   of predicted_ltgp_run (app/lib/analytics/predicted-ltgp.server.ts) —
--   expected cumulative gross profit at 90d/180d/1y/3y/5y with per-horizon
--   honesty grades. Recomputed wholesale, like churnRiskScore.
-- "SubscriptionContract"."predictedLtgpInitial": the frozen day-one
--   prediction (stamped once for contracts scored younger than 8 days);
--   ltgp_accuracy_run compares it against matured actuals so prediction
--   error is measured, not assumed.
-- "SubscriptionContract"."surveyHoldout": deterministic intervention-holdout
--   flag assigned at survey link time; TRUE rows are excluded from
--   survey-triggered flows so answer-segment churn stays measurable.
-- "SurveyResponse": one row per checkout order shown the survey, keyed by
--   order because the thank-you page usually renders before the contract
--   mirror exists; contractId is linked by whichever side arrives second.

ALTER TABLE "SubscriptionContract" ADD COLUMN "predictedLtgp" JSONB;
ALTER TABLE "SubscriptionContract" ADD COLUMN "predictedLtgpAt" TIMESTAMP(3);
ALTER TABLE "SubscriptionContract" ADD COLUMN "predictedLtgpInitial" JSONB;
ALTER TABLE "SubscriptionContract" ADD COLUMN "surveyHoldout" BOOLEAN;

CREATE TABLE "SurveyResponse" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "contractId" TEXT,
    "customerId" TEXT,
    "source" TEXT NOT NULL,
    "locale" TEXT,
    "questionSetVersion" INTEGER NOT NULL,
    "answers" JSONB,
    "shownAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "linkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SurveyResponse_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SurveyResponse_orderId_key" ON "SurveyResponse"("orderId");
CREATE INDEX "SurveyResponse_shopId_answeredAt_idx" ON "SurveyResponse"("shopId", "answeredAt");
CREATE INDEX "SurveyResponse_contractId_idx" ON "SurveyResponse"("contractId");

ALTER TABLE "SurveyResponse" ADD CONSTRAINT "SurveyResponse_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SurveyResponse" ADD CONSTRAINT "SurveyResponse_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "SubscriptionContract"("id") ON DELETE SET NULL ON UPDATE CASCADE;
