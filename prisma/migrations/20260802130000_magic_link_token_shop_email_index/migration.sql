-- requestMagicLink's one-live-link-per-address cooldown (and its
-- enumeration-defence decoy twin) look up MagicLinkToken by (shop, email);
-- without this index both queries table-scan.

-- CreateIndex
CREATE INDEX "MagicLinkToken_shop_email_idx" ON "MagicLinkToken"("shop", "email");
