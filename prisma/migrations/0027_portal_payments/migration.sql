-- 0027_portal_payments (v1.28.0)
-- Six nullable columns: four on "SubscriptionContract", one on "DunningCase",
-- one on "BillingAttempt". No new tables.
--
-- ADDITIVE ONLY: every new column is nullable, so v1.27 code runs unchanged
-- against this schema (UPDATE.md §2.3 / §5.2). Rolling the server back leaves
-- the columns in place; nothing in v1.27 reads them.
--
-- "SubscriptionContract.paymentInstrumentType": CREDIT_CARD | SHOP_PAY |
-- PAYPAL | UNKNOWN — the normalized instrument kind behind paymentMethodId,
-- mirrored wherever cardBrand/cardLast4 are (sync create, webhook upsert,
-- engine mirror refresh, backup swap, import). Decides the card-update path
-- (hosted URL is Shop Pay only; everything else goes through Shopify's
-- update email) and the instrument-aware portal label. Null = mirror not
-- yet backfilled (debug self-check `payment_update_path` counts these).
--
-- "SubscriptionContract.paymentMethodRevokedAt": stamped by the
-- payment-method revoke webhook when the revoked method was the contract's
-- primary and no backup promotion happened; cleared whenever the mirror is
-- refreshed to a live method. cardLast4 is deliberately kept for copy
-- ("Card ····4242 was removed").
--
-- "SubscriptionContract.backupSetBy" / "backupSetAt": who last set the
-- backup payment method (CUSTOMER | ADMIN | ENGINE) and when — the admin
-- Select and the customer toggle write the same backupPaymentMethodId
-- column; this records provenance.
--
-- "DunningCase.customerRetryAt": last customer-initiated "Retry now" on this
-- case (per-case throttle).
--
-- "BillingAttempt.challengeUrl": last 3DS challenge URL observed for the
-- attempt (portal "Confirm with my bank").

ALTER TABLE "SubscriptionContract" ADD COLUMN "paymentInstrumentType" TEXT;
ALTER TABLE "SubscriptionContract" ADD COLUMN "paymentMethodRevokedAt" TIMESTAMP(3);
ALTER TABLE "SubscriptionContract" ADD COLUMN "backupSetBy" TEXT;
ALTER TABLE "SubscriptionContract" ADD COLUMN "backupSetAt" TIMESTAMP(3);

ALTER TABLE "DunningCase" ADD COLUMN "customerRetryAt" TIMESTAMP(3);

ALTER TABLE "BillingAttempt" ADD COLUMN "challengeUrl" TEXT;
