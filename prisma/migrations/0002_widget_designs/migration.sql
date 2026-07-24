-- CreateTable
CREATE TABLE "WidgetDesignRevision" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "preset" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "createdBy" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WidgetDesignRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WidgetDesignRevision_shopId_createdAt_idx" ON "WidgetDesignRevision"("shopId", "createdAt");

