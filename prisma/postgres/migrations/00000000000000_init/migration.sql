-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopSettings" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'EUR',
    "klaviyoEnabled" BOOLEAN NOT NULL DEFAULT false,
    "klaviyoApiKeyEncrypted" TEXT,
    "settingsJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffRole" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellingPlanConfig" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyGroupId" TEXT,
    "name" TEXT NOT NULL,
    "merchantCode" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "plansJson" TEXT NOT NULL,
    "quantityDefaultsJson" TEXT NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellingPlanConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellingPlanConfigVersion" (
    "id" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" TEXT NOT NULL,
    "changedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellingPlanConfigVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductMeta" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "handle" TEXT,
    "unitContents" DOUBLE PRECISION,
    "defaultDailyUsage" DOUBLE PRECISION,
    "grossMarginPercent" DOUBLE PRECISION,
    "unitCostCents" INTEGER,
    "timeOfDay" TEXT NOT NULL DEFAULT 'BOTH',
    "concern" TEXT,
    "heroRank" INTEGER,
    "subscribable" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductMeta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompatibilityEdge" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "fromProductId" TEXT NOT NULL,
    "toProductId" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "strength" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompatibilityEdge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoutineTemplate" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "concern" TEXT NOT NULL,
    "description" TEXT,
    "stepsJson" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoutineTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionContract" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyContractId" TEXT NOT NULL,
    "shopifyCustomerId" TEXT NOT NULL,
    "customerEmail" TEXT,
    "status" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "intervalWeeks" INTEGER NOT NULL,
    "nextBillingDate" TIMESTAMP(3),
    "nextDeliveryDate" TIMESTAMP(3),
    "deliveryAddressJson" TEXT,
    "paymentMethodId" TEXT,
    "cardBrand" TEXT,
    "cardLastDigits" TEXT,
    "cardExpiryMonth" INTEGER,
    "cardExpiryYear" INTEGER,
    "successfulOrders" INTEGER NOT NULL DEFAULT 0,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "totalRevenueCents" INTEGER NOT NULL DEFAULT 0,
    "treatmentStartedAt" TIMESTAMP(3),
    "pausedUntil" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "qualityScore" DOUBLE PRECISION,
    "churnRiskScore" DOUBLE PRECISION,
    "expectedLtvCents" INTEGER,
    "autopilotEnabled" BOOLEAN NOT NULL DEFAULT false,
    "guardrailsJson" TEXT,
    "acquisitionJson" TEXT,
    "originOrderId" TEXT,
    "firstOrderAovCents" INTEGER,
    "initialDiscountPercent" DOUBLE PRECISION,
    "widgetVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionContract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractLine" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "shopifyLineId" TEXT,
    "shopifyProductId" TEXT NOT NULL,
    "shopifyVariantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "currentPriceCents" INTEGER NOT NULL,
    "sellingPlanId" TEXT,
    "sellingPlanName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContractLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AddOnItem" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "shopifyVariantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "priceCents" INTEGER NOT NULL,
    "mode" TEXT NOT NULL,
    "remainingDeliveries" INTEGER,
    "source" TEXT NOT NULL,
    "appliedAt" TIMESTAMP(3),
    "appliedLineId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AddOnItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingAttempt" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "shopifyBillingAttemptId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "errorCode" TEXT,
    "declineCategory" TEXT,
    "orderId" TEXT,
    "amountCents" INTEGER,
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "isRetry" BOOLEAN NOT NULL DEFAULT false,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DunningState" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "phase" TEXT NOT NULL DEFAULT 'NONE',
    "declineCategory" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "graceUntil" TIMESTAMP(3),
    "historyJson" TEXT NOT NULL DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DunningState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CancellationSession" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "reason" TEXT,
    "reasonDetail" TEXT,
    "offersJson" TEXT NOT NULL DEFAULT '[]',
    "outcome" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "savedByOffer" TEXT,
    "saveCostCents" INTEGER,
    "maxSaveCostCents" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "CancellationSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScoreSnapshot" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "factorsJson" TEXT NOT NULL DEFAULT '{}',
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScoreSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepletionEstimate" (
    "id" TEXT NOT NULL,
    "contractLineId" TEXT NOT NULL,
    "estimatedDailyUsage" DOUBLE PRECISION NOT NULL,
    "lastDeliveryAt" TIMESTAMP(3),
    "unitsOnHand" DOUBLE PRECISION,
    "predictedRunOutAt" TIMESTAMP(3),
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "signalsJson" TEXT NOT NULL DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepletionEstimate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdherenceSurvey" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "shopifyCustomerId" TEXT NOT NULL,
    "answersJson" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "AdherenceSurvey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Milestone" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "achievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rewardStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "rewardJson" TEXT,

    CONSTRAINT "Milestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WidgetConfig" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "widgetType" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "targetingJson" TEXT NOT NULL DEFAULT '{}',
    "settingsJson" TEXT NOT NULL DEFAULT '{}',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "experimentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WidgetConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Experiment" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "variantsJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Experiment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExperimentAssignment" (
    "id" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "variantKey" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExperimentAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsEvent" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contractId" TEXT,
    "shopifyCustomerId" TEXT,
    "payloadJson" TEXT NOT NULL DEFAULT '{}',
    "dedupeKey" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundEvent" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "destination" TEXT NOT NULL DEFAULT 'KLAVIYO',
    "eventName" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "profileEmail" TEXT,
    "payloadJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboundEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ForecastSnapshot" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "horizonWeeks" INTEGER NOT NULL DEFAULT 13,
    "rowsJson" TEXT NOT NULL,

    CONSTRAINT "ForecastSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelState" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "paramsJson" TEXT NOT NULL,
    "metricsJson" TEXT NOT NULL DEFAULT '{}',
    "sampleSize" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "subjectType" TEXT,
    "subjectId" TEXT,
    "payloadJson" TEXT NOT NULL DEFAULT '{}',
    "prevHash" TEXT,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "resultJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessedWebhook" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedWebhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MagicLinkToken" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyCustomerId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MagicLinkToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopSettings_shop_key" ON "ShopSettings"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "StaffRole_shop_email_key" ON "StaffRole"("shop", "email");

-- CreateIndex
CREATE INDEX "SellingPlanConfig_shop_idx" ON "SellingPlanConfig"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "SellingPlanConfigVersion_configId_version_key" ON "SellingPlanConfigVersion"("configId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ProductMeta_shop_shopifyProductId_key" ON "ProductMeta"("shop", "shopifyProductId");

-- CreateIndex
CREATE INDEX "CompatibilityEdge_shop_fromProductId_idx" ON "CompatibilityEdge"("shop", "fromProductId");

-- CreateIndex
CREATE UNIQUE INDEX "CompatibilityEdge_shop_fromProductId_toProductId_relation_key" ON "CompatibilityEdge"("shop", "fromProductId", "toProductId", "relation");

-- CreateIndex
CREATE INDEX "RoutineTemplate_shop_concern_idx" ON "RoutineTemplate"("shop", "concern");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionContract_shopifyContractId_key" ON "SubscriptionContract"("shopifyContractId");

-- CreateIndex
CREATE INDEX "SubscriptionContract_shop_status_idx" ON "SubscriptionContract"("shop", "status");

-- CreateIndex
CREATE INDEX "SubscriptionContract_shop_shopifyCustomerId_idx" ON "SubscriptionContract"("shop", "shopifyCustomerId");

-- CreateIndex
CREATE INDEX "SubscriptionContract_shop_nextBillingDate_idx" ON "SubscriptionContract"("shop", "nextBillingDate");

-- CreateIndex
CREATE INDEX "ContractLine_contractId_idx" ON "ContractLine"("contractId");

-- CreateIndex
CREATE INDEX "AddOnItem_contractId_idx" ON "AddOnItem"("contractId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingAttempt_shopifyBillingAttemptId_key" ON "BillingAttempt"("shopifyBillingAttemptId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingAttempt_idempotencyKey_key" ON "BillingAttempt"("idempotencyKey");

-- CreateIndex
CREATE INDEX "BillingAttempt_shop_status_idx" ON "BillingAttempt"("shop", "status");

-- CreateIndex
CREATE INDEX "BillingAttempt_contractId_idx" ON "BillingAttempt"("contractId");

-- CreateIndex
CREATE UNIQUE INDEX "DunningState_contractId_key" ON "DunningState"("contractId");

-- CreateIndex
CREATE INDEX "DunningState_nextRetryAt_idx" ON "DunningState"("nextRetryAt");

-- CreateIndex
CREATE INDEX "CancellationSession_shop_outcome_idx" ON "CancellationSession"("shop", "outcome");

-- CreateIndex
CREATE INDEX "CancellationSession_contractId_idx" ON "CancellationSession"("contractId");

-- CreateIndex
CREATE INDEX "ScoreSnapshot_contractId_kind_idx" ON "ScoreSnapshot"("contractId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "DepletionEstimate_contractLineId_key" ON "DepletionEstimate"("contractLineId");

-- CreateIndex
CREATE INDEX "AdherenceSurvey_contractId_idx" ON "AdherenceSurvey"("contractId");

-- CreateIndex
CREATE UNIQUE INDEX "Milestone_contractId_type_key" ON "Milestone"("contractId", "type");

-- CreateIndex
CREATE INDEX "WidgetConfig_shop_widgetType_active_idx" ON "WidgetConfig"("shop", "widgetType", "active");

-- CreateIndex
CREATE UNIQUE INDEX "ExperimentAssignment_experimentId_subjectKey_key" ON "ExperimentAssignment"("experimentId", "subjectKey");

-- CreateIndex
CREATE UNIQUE INDEX "AnalyticsEvent_dedupeKey_key" ON "AnalyticsEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_shop_name_occurredAt_idx" ON "AnalyticsEvent"("shop", "name", "occurredAt");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_contractId_idx" ON "AnalyticsEvent"("contractId");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundEvent_dedupeKey_key" ON "OutboundEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "OutboundEvent_status_nextAttemptAt_idx" ON "OutboundEvent"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "ForecastSnapshot_shop_computedAt_idx" ON "ForecastSnapshot"("shop", "computedAt");

-- CreateIndex
CREATE INDEX "ModelState_shop_model_idx" ON "ModelState"("shop", "model");

-- CreateIndex
CREATE UNIQUE INDEX "ModelState_shop_model_version_key" ON "ModelState"("shop", "model", "version");

-- CreateIndex
CREATE INDEX "AuditLog_shop_subjectType_subjectId_idx" ON "AuditLog"("shop", "subjectType", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "AuditLog_shop_seq_key" ON "AuditLog"("shop", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyKey_key_key" ON "IdempotencyKey"("key");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedWebhook_webhookId_key" ON "ProcessedWebhook"("webhookId");

-- CreateIndex
CREATE INDEX "ProcessedWebhook_shop_topic_idx" ON "ProcessedWebhook"("shop", "topic");

-- CreateIndex
CREATE UNIQUE INDEX "MagicLinkToken_tokenHash_key" ON "MagicLinkToken"("tokenHash");

-- CreateIndex
CREATE INDEX "MagicLinkToken_shop_shopifyCustomerId_idx" ON "MagicLinkToken"("shop", "shopifyCustomerId");

-- CreateIndex
CREATE INDEX "MagicLinkToken_shop_email_idx" ON "MagicLinkToken"("shop", "email");

-- AddForeignKey
ALTER TABLE "SellingPlanConfigVersion" ADD CONSTRAINT "SellingPlanConfigVersion_configId_fkey" FOREIGN KEY ("configId") REFERENCES "SellingPlanConfig"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractLine" ADD CONSTRAINT "ContractLine_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "SubscriptionContract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AddOnItem" ADD CONSTRAINT "AddOnItem_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "SubscriptionContract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingAttempt" ADD CONSTRAINT "BillingAttempt_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "SubscriptionContract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DunningState" ADD CONSTRAINT "DunningState_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "SubscriptionContract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepletionEstimate" ADD CONSTRAINT "DepletionEstimate_contractLineId_fkey" FOREIGN KEY ("contractLineId") REFERENCES "ContractLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Milestone" ADD CONSTRAINT "Milestone_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "SubscriptionContract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExperimentAssignment" ADD CONSTRAINT "ExperimentAssignment_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "Experiment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

