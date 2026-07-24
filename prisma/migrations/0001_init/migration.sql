-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ContractStatus" AS ENUM ('ACTIVE', 'PAUSED', 'CANCELLED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "BillingAttemptStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'CHALLENGED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "DunningState" AS ENUM ('OPEN', 'RETRYING', 'AWAITING_CUSTOMER', 'AWAITING_3DS', 'RECOVERED', 'EXHAUSTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "GiftGrantStatus" AS ENUM ('SCHEDULED', 'ADDED', 'SHIPPED', 'REMOVED', 'CANCELLED');

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
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "name" TEXT,
    "primaryDomain" TEXT,
    "currencyCode" TEXT NOT NULL DEFAULT 'GBP',
    "ianaTimezone" TEXT NOT NULL DEFAULT 'Europe/London',
    "contactEmail" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "enabledLocales" JSONB,
    "lastFullSyncAt" TIMESTAMP(3),

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellingPlanConfig" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shopifyGroupId" TEXT,
    "merchantCode" TEXT NOT NULL,
    "productIds" JSONB NOT NULL,
    "frequenciesWeeks" JSONB NOT NULL,
    "defaultFrequencyWeeks" INTEGER NOT NULL DEFAULT 8,
    "allowFrequencyChoice" BOOLEAN NOT NULL DEFAULT true,
    "firstOrderDiscountPct" INTEGER NOT NULL DEFAULT 20,
    "ongoingDiscountPct" INTEGER NOT NULL DEFAULT 10,
    "firstOrderGiftVariantId" TEXT,
    "prepaidEnabled" BOOLEAN NOT NULL DEFAULT false,
    "prepaidDeliveriesPerCharge" INTEGER NOT NULL DEFAULT 3,
    "prepaidDiscountPct" INTEGER NOT NULL DEFAULT 15,
    "badgeText" TEXT DEFAULT 'Most popular',
    "showBadge" BOOLEAN NOT NULL DEFAULT true,
    "preselectSubscription" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "syncStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "syncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellingPlanConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductCadence" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "title" TEXT,
    "estDaysToEmpty" INTEGER NOT NULL DEFAULT 56,
    "recommendedWeeks" INTEGER NOT NULL DEFAULT 8,
    "substituteVariantId" TEXT,
    "stockoutPolicy" TEXT,

    CONSTRAINT "ProductCadence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionContract" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopifyContractId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "status" "ContractStatus" NOT NULL DEFAULT 'ACTIVE',
    "locale" TEXT NOT NULL DEFAULT 'en',
    "currencyCode" TEXT NOT NULL,
    "intervalWeeks" INTEGER NOT NULL,
    "nextBillingDate" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "resumeAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "cancelSource" TEXT,
    "failedAt" TIMESTAMP(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "isPrepaid" BOOLEAN NOT NULL DEFAULT false,
    "prepaidDeliveriesPerCharge" INTEGER,
    "prepaidDeliveriesRemaining" INTEGER,
    "paymentMethodId" TEXT,
    "backupPaymentMethodId" TEXT,
    "cardBrand" TEXT,
    "cardLast4" TEXT,
    "cardExpiryMonth" INTEGER,
    "cardExpiryYear" INTEGER,
    "deliveryAddress" JSONB,
    "deliveryPriceCents" INTEGER NOT NULL DEFAULT 0,
    "deliveryMethodTitle" TEXT,
    "originOrderId" TEXT,
    "originOrderName" TEXT,
    "firstChargeAt" TIMESTAMP(3),
    "ordersCount" INTEGER NOT NULL DEFAULT 0,
    "lifetimeRevenueCents" INTEGER NOT NULL DEFAULT 0,
    "lifetimeDiscountCents" INTEGER NOT NULL DEFAULT 0,
    "estLifetimeGrossProfitCents" INTEGER NOT NULL DEFAULT 0,
    "grandfatheredPricing" BOOLEAN NOT NULL DEFAULT false,
    "mergeGroupId" TEXT,
    "churnRiskScore" DOUBLE PRECISION DEFAULT 0,
    "predictedEmptyDate" TIMESTAMP(3),
    "skipCount" INTEGER NOT NULL DEFAULT 0,
    "lastSkippedAt" TIMESTAMP(3),
    "savedAt" TIMESTAMP(3),
    "winbackEligibleAt" TIMESTAMP(3),
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionContract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractLine" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "shopifyLineId" TEXT,
    "productId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "variantTitle" TEXT,
    "sku" TEXT,
    "imageUrl" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "currentPriceCents" INTEGER NOT NULL,
    "compareAtPriceCents" INTEGER,
    "unitCostCents" INTEGER,
    "isGift" BOOLEAN NOT NULL DEFAULT false,
    "isOneTimeAddon" BOOLEAN NOT NULL DEFAULT false,
    "addedVia" TEXT NOT NULL DEFAULT 'CHECKOUT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContractLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingAttempt" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "shopifyAttemptId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "cycleIndex" INTEGER NOT NULL,
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "status" "BillingAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "orderId" TEXT,
    "orderName" TEXT,
    "amountCents" INTEGER,
    "currencyCode" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "declineCategory" TEXT,
    "originatingAction" TEXT NOT NULL DEFAULT 'SCHEDULER',
    "usedBackupPayment" BOOLEAN NOT NULL DEFAULT false,
    "mitEvidence" JSONB,

    CONSTRAINT "BillingAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DunningCase" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "state" "DunningState" NOT NULL DEFAULT 'OPEN',
    "triggerAttemptId" TEXT,
    "declineCode" TEXT,
    "declineCategory" TEXT,
    "ladderStep" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3),
    "paydayAligned" BOOLEAN NOT NULL DEFAULT false,
    "emailsSent" INTEGER NOT NULL DEFAULT 0,
    "smsSent" INTEGER NOT NULL DEFAULT 0,
    "lastNotifiedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "recoveredAttemptId" TEXT,
    "recoveredCents" INTEGER,

    CONSTRAINT "DunningCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriberEvent" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "contractId" TEXT,
    "customerId" TEXT,
    "email" TEXT,
    "type" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "actor" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriberEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MagicLinkToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "contractId" TEXT,
    "customerId" TEXT,
    "email" TEXT,
    "payload" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "maxUses" INTEGER NOT NULL DEFAULT 1,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "usedAt" TIMESTAMP(3),
    "createdVia" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MagicLinkToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtpCode" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OtpCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortalSession" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "isPreview" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GiftRule" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "orderIndex" INTEGER,
    "daysSubscribed" INTEGER,
    "variantId" TEXT NOT NULL,
    "variantTitle" TEXT,
    "unitCostCents" INTEGER NOT NULL DEFAULT 0,
    "announceInAdvance" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GiftRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GiftGrant" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "ruleId" TEXT,
    "cycleIndex" INTEGER NOT NULL,
    "variantId" TEXT NOT NULL,
    "status" "GiftGrantStatus" NOT NULL DEFAULT 'SCHEDULED',
    "addedAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GiftGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscountGrant" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "percent" INTEGER NOT NULL,
    "cyclesTotal" INTEGER NOT NULL,
    "cyclesRemaining" INTEGER NOT NULL,
    "grantedBy" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exhaustedAt" TIMESTAMP(3),

    CONSTRAINT "DiscountGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CancelSession" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "channel" TEXT NOT NULL DEFAULT 'PORTAL',
    "reason" TEXT,
    "reasonDetail" TEXT,
    "savesShown" JSONB,
    "saveAccepted" TEXT,
    "outcome" TEXT,
    "completedAt" TIMESTAMP(3),
    "retainedAt90d" BOOLEAN,

    CONSTRAINT "CancelSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WinbackState" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "cancelledAt" TIMESTAMP(3) NOT NULL,
    "predictedEmptyDate" TIMESTAMP(3) NOT NULL,
    "stage" INTEGER NOT NULL DEFAULT 0,
    "nextTouchAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "wonBackAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WinbackState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationLog" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "contractId" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "channel" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SENT',
    "klaviyoEventName" TEXT,
    "error" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KlaviyoOutbox" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "profileAttrs" JSONB,
    "properties" JSONB,
    "eventTime" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "KlaviyoOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookReceipt" (
    "id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "payloadHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PROCESSED',
    "error" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL,
    "jobName" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "stats" JSONB,
    "error" TEXT,

    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobLock" (
    "name" TEXT NOT NULL,
    "lockedUntil" TIMESTAMP(3) NOT NULL,
    "owner" TEXT NOT NULL,

    CONSTRAINT "JobLock_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'WARNING',
    "message" TEXT NOT NULL,
    "context" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "notifiedAt" TIMESTAMP(3),

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceChangeBatch" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "noticeDays" INTEGER NOT NULL DEFAULT 30,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "noticeSentAt" TIMESTAMP(3),
    "effectiveAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "items" JSONB NOT NULL,
    "contractsAffected" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PriceChangeBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyRollup" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "activeSubscribers" INTEGER NOT NULL DEFAULT 0,
    "pausedSubscribers" INTEGER NOT NULL DEFAULT 0,
    "newSubscribers" INTEGER NOT NULL DEFAULT 0,
    "churnedVoluntary" INTEGER NOT NULL DEFAULT 0,
    "churnedInvoluntary" INTEGER NOT NULL DEFAULT 0,
    "mrrCents" INTEGER NOT NULL DEFAULT 0,
    "chargedCents" INTEGER NOT NULL DEFAULT 0,
    "discountCents" INTEGER NOT NULL DEFAULT 0,
    "giftCogsCents" INTEGER NOT NULL DEFAULT 0,
    "estGrossProfitCents" INTEGER NOT NULL DEFAULT 0,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "recoveredCents" INTEGER NOT NULL DEFAULT 0,
    "openDunningCases" INTEGER NOT NULL DEFAULT 0,
    "skips" INTEGER NOT NULL DEFAULT 0,
    "cancels" INTEGER NOT NULL DEFAULT 0,
    "savesOffered" INTEGER NOT NULL DEFAULT 0,
    "savesAccepted" INTEGER NOT NULL DEFAULT 0,
    "addonsAttached" INTEGER NOT NULL DEFAULT 0,
    "takeRateNum" INTEGER NOT NULL DEFAULT 0,
    "takeRateDen" INTEGER NOT NULL DEFAULT 0,
    "prepaidActive" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DailyRollup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CohortCell" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "cohortMonth" TEXT NOT NULL,
    "monthOffset" INTEGER NOT NULL,
    "cohortSize" INTEGER NOT NULL DEFAULT 0,
    "activeRemaining" INTEGER NOT NULL DEFAULT 0,
    "revenueCents" INTEGER NOT NULL DEFAULT 0,
    "discountCents" INTEGER NOT NULL DEFAULT 0,
    "cogsCents" INTEGER NOT NULL DEFAULT 0,
    "shippingCostCents" INTEGER NOT NULL DEFAULT 0,
    "feesCents" INTEGER NOT NULL DEFAULT 0,
    "grossProfitCents" INTEGER NOT NULL DEFAULT 0,
    "cumGrossProfitCents" INTEGER NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CohortCell_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "filename" TEXT,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "succeeded" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "errors" JSONB,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_domain_key" ON "Shop"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "Setting_shopId_key_key" ON "Setting"("shopId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "SellingPlanConfig_shopifyGroupId_key" ON "SellingPlanConfig"("shopifyGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "SellingPlanConfig_merchantCode_key" ON "SellingPlanConfig"("merchantCode");

-- CreateIndex
CREATE UNIQUE INDEX "ProductCadence_shopId_productId_variantId_key" ON "ProductCadence"("shopId", "productId", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionContract_shopifyContractId_key" ON "SubscriptionContract"("shopifyContractId");

-- CreateIndex
CREATE INDEX "SubscriptionContract_shopId_status_idx" ON "SubscriptionContract"("shopId", "status");

-- CreateIndex
CREATE INDEX "SubscriptionContract_shopId_nextBillingDate_idx" ON "SubscriptionContract"("shopId", "nextBillingDate");

-- CreateIndex
CREATE INDEX "SubscriptionContract_shopId_email_idx" ON "SubscriptionContract"("shopId", "email");

-- CreateIndex
CREATE INDEX "SubscriptionContract_customerId_idx" ON "SubscriptionContract"("customerId");

-- CreateIndex
CREATE INDEX "SubscriptionContract_mergeGroupId_idx" ON "SubscriptionContract"("mergeGroupId");

-- CreateIndex
CREATE INDEX "ContractLine_contractId_idx" ON "ContractLine"("contractId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingAttempt_shopifyAttemptId_key" ON "BillingAttempt"("shopifyAttemptId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingAttempt_idempotencyKey_key" ON "BillingAttempt"("idempotencyKey");

-- CreateIndex
CREATE INDEX "BillingAttempt_contractId_cycleIndex_idx" ON "BillingAttempt"("contractId", "cycleIndex");

-- CreateIndex
CREATE INDEX "BillingAttempt_status_scheduledFor_idx" ON "BillingAttempt"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "DunningCase_state_nextRetryAt_idx" ON "DunningCase"("state", "nextRetryAt");

-- CreateIndex
CREATE INDEX "DunningCase_contractId_idx" ON "DunningCase"("contractId");

-- CreateIndex
CREATE INDEX "SubscriberEvent_contractId_createdAt_idx" ON "SubscriberEvent"("contractId", "createdAt");

-- CreateIndex
CREATE INDEX "SubscriberEvent_shopId_type_createdAt_idx" ON "SubscriberEvent"("shopId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "SubscriberEvent_email_idx" ON "SubscriberEvent"("email");

-- CreateIndex
CREATE UNIQUE INDEX "MagicLinkToken_tokenHash_key" ON "MagicLinkToken"("tokenHash");

-- CreateIndex
CREATE INDEX "MagicLinkToken_contractId_idx" ON "MagicLinkToken"("contractId");

-- CreateIndex
CREATE INDEX "MagicLinkToken_expiresAt_idx" ON "MagicLinkToken"("expiresAt");

-- CreateIndex
CREATE INDEX "OtpCode_email_createdAt_idx" ON "OtpCode"("email", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PortalSession_tokenHash_key" ON "PortalSession"("tokenHash");

-- CreateIndex
CREATE INDEX "PortalSession_customerId_idx" ON "PortalSession"("customerId");

-- CreateIndex
CREATE INDEX "GiftRule_shopId_trigger_idx" ON "GiftRule"("shopId", "trigger");

-- CreateIndex
CREATE INDEX "GiftGrant_contractId_cycleIndex_idx" ON "GiftGrant"("contractId", "cycleIndex");

-- CreateIndex
CREATE INDEX "DiscountGrant_contractId_idx" ON "DiscountGrant"("contractId");

-- CreateIndex
CREATE INDEX "CancelSession_contractId_idx" ON "CancelSession"("contractId");

-- CreateIndex
CREATE INDEX "CancelSession_outcome_startedAt_idx" ON "CancelSession"("outcome", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WinbackState_contractId_key" ON "WinbackState"("contractId");

-- CreateIndex
CREATE INDEX "WinbackState_status_nextTouchAt_idx" ON "WinbackState"("status", "nextTouchAt");

-- CreateIndex
CREATE INDEX "NotificationLog_contractId_createdAt_idx" ON "NotificationLog"("contractId", "createdAt");

-- CreateIndex
CREATE INDEX "NotificationLog_shopId_template_createdAt_idx" ON "NotificationLog"("shopId", "template", "createdAt");

-- CreateIndex
CREATE INDEX "KlaviyoOutbox_status_nextAttemptAt_idx" ON "KlaviyoOutbox"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookReceipt_webhookId_key" ON "WebhookReceipt"("webhookId");

-- CreateIndex
CREATE INDEX "WebhookReceipt_topic_receivedAt_idx" ON "WebhookReceipt"("topic", "receivedAt");

-- CreateIndex
CREATE INDEX "WebhookReceipt_status_idx" ON "WebhookReceipt"("status");

-- CreateIndex
CREATE INDEX "JobRun_jobName_startedAt_idx" ON "JobRun"("jobName", "startedAt");

-- CreateIndex
CREATE INDEX "Alert_shopId_resolvedAt_createdAt_idx" ON "Alert"("shopId", "resolvedAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DailyRollup_shopId_date_key" ON "DailyRollup"("shopId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "CohortCell_shopId_cohortMonth_monthOffset_key" ON "CohortCell"("shopId", "cohortMonth", "monthOffset");

-- AddForeignKey
ALTER TABLE "Setting" ADD CONSTRAINT "Setting_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellingPlanConfig" ADD CONSTRAINT "SellingPlanConfig_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionContract" ADD CONSTRAINT "SubscriptionContract_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractLine" ADD CONSTRAINT "ContractLine_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "SubscriptionContract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingAttempt" ADD CONSTRAINT "BillingAttempt_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "SubscriptionContract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DunningCase" ADD CONSTRAINT "DunningCase_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "SubscriptionContract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriberEvent" ADD CONSTRAINT "SubscriberEvent_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "SubscriptionContract"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftGrant" ADD CONSTRAINT "GiftGrant_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "SubscriptionContract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftGrant" ADD CONSTRAINT "GiftGrant_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "GiftRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscountGrant" ADD CONSTRAINT "DiscountGrant_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "SubscriptionContract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CancelSession" ADD CONSTRAINT "CancelSession_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "SubscriptionContract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

