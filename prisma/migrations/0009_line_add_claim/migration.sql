-- Atomic add claim for portal/admin line adds (stability pass).
--
-- ADDITIVE ONLY: one nullable ADD COLUMN and its unique index. No DROP, no
-- RENAME, no type change, no data touched.
--
-- Why:
--
-- addOneTimeAddon's duplicate guard used to be read-then-act: find an
-- existing isOneTimeAddon mirror line for the variant, then spend seconds in
-- the Shopify billing-cycle edit, then create the mirror. The portal is
-- server-rendered HTML with no client-side button disabling, so a double-tap
-- on "Add one-time" ran two overlapping requests that BOTH passed the find
-- (neither mirror existed yet), each appended the variant to the next cycle,
-- and the customer was charged for the add-on twice. addLine (recurring
-- lines) had the identical shape.
--
-- The claim inverts the order: the mirror row is created FIRST, carrying
-- addClaimKey "addon:{contractId}:{variantId}" (one-time add-ons) or
-- "line:{contractId}:{variantId}" (portal/admin recurring adds), and only
-- then does the Shopify edit run — deleted again if that edit fails. The
-- unique index makes the second concurrent create fail with P2002, which the
-- service treats as "already staged". Nullable on purpose: checkout sync,
-- gift-engine and import lines never set it (they mirror whatever Shopify
-- holds), and existing rows are untouched.
ALTER TABLE "ContractLine" ADD COLUMN "addClaimKey" TEXT;

CREATE UNIQUE INDEX "ContractLine_addClaimKey_key" ON "ContractLine"("addClaimKey");
