-- Origin-order revenue + acquisition data foundation (v1.5.0).
--
-- ADDITIVE ONLY: eighteen nullable-or-defaulted ADD COLUMN statements on one
-- table. No DROP, no RENAME, no type change, no UPDATE/DELETE — no
-- pre-existing column is read or written, so this migration cannot lose data
-- and needs no table rewrite (ADD COLUMN … NOT NULL DEFAULT is metadata-only
-- on PG 11+). Generated with `prisma migrate diff` against the pre-0006
-- schema, like 0003/0004/0005.
--
-- Why these columns exist:
--
-- * SubscriptionContract."originOrderTotalCents" / "originOrderDiscountCents"
--   / "originOrderShippingChargedCents" / "originOrderRefundedCents" /
--   "originOrderProcessedAt" / "originOrderCurrencyCode" — the origin
--   (checkout) payment mirror. The first payment never becomes a
--   BillingAttempt, so every cohort/LTGP/rollup revenue figure was
--   structurally RENEWALS-ONLY and understated true LTV by each subscriber's
--   first (largest, first-order-discounted) payment. These columns are
--   captured from the order summary when the contract is mirrored, backfilled
--   by the daily origin_order_backfill job, and added into cohort month-0 /
--   rollup revenue by the analytics engines. "originOrderTotalCents" is the
--   amount as charged and is never rewritten; "originOrderRefundedCents"
--   accumulates REFUNDS_CREATE refunds matched by originOrderId (default 0 is
--   historically honest — no origin refund was ever recorded before this
--   migration) and analytics net it out. lifetimeRevenueCents deliberately
--   keeps its renewals-only ("billed by this app") meaning.
--
-- * SubscriptionContract."acqReferringSite" / "acqLandingSite" /
--   "acqSourceName" / "acqUtm" / "acqCountryCode" / "acqCity" /
--   "acqProvinceCode" / "acqDeviceType" / "acqTimeToPurchaseSeconds" /
--   "acqUnitsFirstOrder" / "acqOrderValueBand" / "acqRaw" — the acquisition &
--   behavior data foundation (docs/DATA_FOUNDATION.md). Captured from the
--   origin order's ORDERS_CREATE payload + the Shopify customer record,
--   SANITIZED before persistence (URLs keep host + path + utm_* params only;
--   never a raw IP, never the full user-agent string). All nullable: rows
--   predating capture simply read "unknown". Every acq* column and acqRaw is
--   nulled by the CUSTOMERS_REDACT anonymizer (GDPR). New ingest must always
--   land in additive columns or inside acqRaw — never repurpose a field.

-- AlterTable
ALTER TABLE "SubscriptionContract" ADD COLUMN     "acqCity" TEXT,
ADD COLUMN     "acqCountryCode" TEXT,
ADD COLUMN     "acqDeviceType" TEXT,
ADD COLUMN     "acqLandingSite" TEXT,
ADD COLUMN     "acqOrderValueBand" TEXT,
ADD COLUMN     "acqProvinceCode" TEXT,
ADD COLUMN     "acqRaw" JSONB,
ADD COLUMN     "acqReferringSite" TEXT,
ADD COLUMN     "acqSourceName" TEXT,
ADD COLUMN     "acqTimeToPurchaseSeconds" INTEGER,
ADD COLUMN     "acqUnitsFirstOrder" INTEGER,
ADD COLUMN     "acqUtm" JSONB,
ADD COLUMN     "originOrderCurrencyCode" TEXT,
ADD COLUMN     "originOrderDiscountCents" INTEGER,
ADD COLUMN     "originOrderProcessedAt" TIMESTAMP(3),
ADD COLUMN     "originOrderRefundedCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "originOrderShippingChargedCents" INTEGER,
ADD COLUMN     "originOrderTotalCents" INTEGER;
