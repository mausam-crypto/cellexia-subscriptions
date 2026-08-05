-- Add-on fulfillment tracking (offers/addOnFulfillment.server.ts).
-- `appliedAt` marks that the add-on has been injected into the subscription
-- contract as a real ContractLine (so it is actually charged and shipped);
-- `appliedLineId` records the local ContractLine id created at application
-- time so consumption after a successful charge can remove the exact line
-- (with a variant-match fallback when Shopify rewrites line ids on later
-- draft commits). Both nullable — purely additive.

-- AlterTable
ALTER TABLE "AddOnItem" ADD COLUMN "appliedAt" DATETIME;
ALTER TABLE "AddOnItem" ADD COLUMN "appliedLineId" TEXT;
