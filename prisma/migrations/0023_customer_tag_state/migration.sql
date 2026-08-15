-- 0023_customer_tag_state (v1.23.0)
-- One new table, no changes to existing tables.
--
-- ADDITIVE ONLY: a brand-new table is invisible to the previous release, so
-- it runs unchanged against this schema (UPDATE.md §2.3 / §5.2).
--
-- "CustomerTagState": the subscriber tag this app last applied to a Shopify
-- customer (tagging setting group, v1.23.0). One row per (shop, customer)
-- the tagger has actually written to Shopify for. tagged/tagValue record the
-- applied state so reconcile passes skip Shopify round trips when nothing
-- changed, renames can remove the byte-exact OLD tag, and removals are
-- provably taking back OUR tag (no row = never touch the customer). Rows are
-- written only after the Shopify mutation succeeded.

CREATE TABLE "CustomerTagState" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "tagged" BOOLEAN NOT NULL,
    "tagValue" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerTagState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomerTagState_shopId_customerId_key" ON "CustomerTagState"("shopId", "customerId");
