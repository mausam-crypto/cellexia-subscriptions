-- Learned model parameters (docs/LEARNING-DATA-V2.md §1). Append-only: each
-- recalibration by the learning job writes version + 1 for (shop, model); the
-- newest version wins and a missing row means "use static defaults".

-- CreateTable
CREATE TABLE "ModelState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "paramsJson" TEXT NOT NULL,
    "metricsJson" TEXT NOT NULL DEFAULT '{}',
    "sampleSize" INTEGER NOT NULL,
    "computedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "ModelState_shop_model_version_key" ON "ModelState"("shop", "model", "version");

-- CreateIndex
CREATE INDEX "ModelState_shop_model_idx" ON "ModelState"("shop", "model");
