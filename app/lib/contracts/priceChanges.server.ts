import { z } from "zod";
import type { PriceChangeBatch } from "@prisma/client";
import prisma from "~/db.server";
import { adminClientForShop } from "~/shopify.server";
import { logEvent } from "~/lib/events/log.server";
import { getSetting } from "~/lib/settings/settings.server";
import { addDaysTz, formatShopDate } from "~/lib/dates.server";
import { applyDiscountPct, formatMoney } from "~/lib/money";
import { sendNotification } from "~/lib/notifications/send.server";
import { draftLineUpdate, withContractDraft } from "~/lib/graphql/index.server";
import {
  ongoingDiscountPctForProduct,
  proportionalPriceCents,
  resolveActor,
  resolveSource,
  type ServiceOptions,
} from "./shared.server";

/**
 * Product price changes for existing subscribers. Two modes (a setting, not
 * an accident — settings.priceChangePolicy):
 *
 *  - GRANDFATHER: existing ACTIVE contracts keep their price forever; the
 *    batch marks them grandfatheredPricing so later propagations skip them.
 *  - PROPAGATE_WITH_NOTICE: subscribers are notified `noticeDays` ahead, and
 *    only after `effectiveAt` do their contract lines move to the new price
 *    minus their ongoing subscription discount.
 *
 * "Affected" always means: ACTIVE contracts having a line with one of the
 * batch's variantIds.
 */

// ── Batch items ──────────────────────────────────────────────────────────────

const priceChangeItemSchema = z.object({
  variantId: z.string().min(1),
  oldPriceCents: z.number().int().min(0),
  newPriceCents: z.number().int().min(0),
});
const itemsSchema = z.array(priceChangeItemSchema).min(1);

export type PriceChangeItem = z.infer<typeof priceChangeItemSchema>;

function parseBatchItems(batch: PriceChangeBatch): PriceChangeItem[] {
  const parsed = itemsSchema.safeParse(batch.items);
  if (!parsed.success) {
    throw new Error(`PriceChangeBatch ${batch.id} has malformed items JSON`);
  }
  return parsed.data;
}

function affectedContractsWhere(shopId: string, variantIds: string[]) {
  return {
    shopId,
    status: "ACTIVE" as const,
    lines: { some: { variantId: { in: variantIds } } },
  };
}

// ── Create ───────────────────────────────────────────────────────────────────

/**
 * Create a DRAFT price-change batch. Mode/noticeDays default from
 * settings.priceChangePolicy; contractsAffected is snapshotted for the admin
 * UI (recounted at notice/apply time).
 */
export async function createPriceChangeBatch(
  shopId: string,
  items: PriceChangeItem[],
  mode?: "PROPAGATE_WITH_NOTICE" | "GRANDFATHER",
  noticeDays?: number,
  options?: ServiceOptions & { createdBy?: string | null },
): Promise<PriceChangeBatch> {
  const validItems = itemsSchema.parse(items);
  const policy = await getSetting(shopId, "priceChangePolicy");
  const resolvedMode = mode ?? policy.mode;
  const resolvedNoticeDays = noticeDays ?? policy.noticeDays;

  const variantIds = validItems.map((i) => i.variantId);
  const contractsAffected = await prisma.subscriptionContract.count({
    where: affectedContractsWhere(shopId, variantIds),
  });

  const batch = await prisma.priceChangeBatch.create({
    data: {
      shopId,
      mode: resolvedMode,
      noticeDays: resolvedNoticeDays,
      createdBy: options?.createdBy ?? resolveActor(options),
      status: "DRAFT",
      items: validItems as object,
      contractsAffected,
    },
  });

  await logEvent({
    shopId,
    type: "admin.action",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      action: "price_change_batch_created",
      batchId: batch.id,
      mode: resolvedMode,
      noticeDays: resolvedNoticeDays,
      itemCount: validItems.length,
      contractsAffected,
    },
  });

  return batch;
}

// ── Notice ───────────────────────────────────────────────────────────────────

export interface SendNoticesResult {
  batch: PriceChangeBatch;
  contractsNotified: number;
  failures: number;
}

/**
 * Send the advance notice to every affected ACTIVE, non-grandfathered
 * contract, stamp noticeSentAt / effectiveAt (= now + noticeDays in the shop
 * timezone) and move the batch to NOTICE_SENT. Idempotent: a batch already
 * past DRAFT is returned unchanged.
 */
export async function sendPriceChangeNotices(
  batchId: string,
  options?: ServiceOptions,
): Promise<SendNoticesResult> {
  const batch = await prisma.priceChangeBatch.findUniqueOrThrow({
    where: { id: batchId },
  });
  if (batch.status === "NOTICE_SENT" || batch.status === "APPLIED") {
    return { batch, contractsNotified: 0, failures: 0 }; // already sent
  }
  if (batch.status !== "DRAFT") {
    throw new Error(
      `PriceChangeBatch ${batch.id} is ${batch.status} — cannot send notices`,
    );
  }

  const items = parseBatchItems(batch);
  const itemByVariant = new Map(items.map((i) => [i.variantId, i]));
  const variantIds = items.map((i) => i.variantId);

  const shop = await prisma.shop.findUniqueOrThrow({
    where: { id: batch.shopId },
  });
  const tz = shop.ianaTimezone;
  const now = new Date();
  const effectiveAt = addDaysTz(now, batch.noticeDays, tz);

  const contracts = await prisma.subscriptionContract.findMany({
    where: {
      ...affectedContractsWhere(batch.shopId, variantIds),
      grandfatheredPricing: false,
    },
    include: { lines: true },
  });

  let contractsNotified = 0;
  let failures = 0;

  for (const contract of contracts) {
    const changes = contract.lines
      .filter((l) => !l.isGift && itemByVariant.has(l.variantId))
      .map((l) => {
        const item = itemByVariant.get(l.variantId)!;
        return {
          variantId: l.variantId,
          title: l.title,
          oldPriceCents: item.oldPriceCents,
          newPriceCents: item.newPriceCents,
        };
      });
    if (changes.length === 0) continue;

    const first = changes[0]!;
    try {
      await sendNotification({
        shopId: batch.shopId,
        contractId: contract.id,
        template: "price_change_notice",
        vars: {
          product_title: first.title,
          old_price: formatMoney(
            first.oldPriceCents,
            contract.currencyCode,
            contract.locale,
          ),
          new_price: formatMoney(
            first.newPriceCents,
            contract.currencyCode,
            contract.locale,
          ),
          change_count: changes.length,
          effective_date: formatShopDate(effectiveAt, tz, contract.locale),
        },
      });
      contractsNotified += 1;
    } catch (err) {
      failures += 1;
      console.error(
        "[contracts] price change notice failed",
        contract.id,
        err,
      );
    }

    await logEvent({
      shopId: batch.shopId,
      contractId: contract.id,
      customerId: contract.customerId,
      email: contract.email,
      type: "contract.price_propagated",
      source: resolveSource(options),
      actor: resolveActor(options),
      payload: {
        batchId: batch.id,
        scheduled: true,
        effectiveAt: effectiveAt.toISOString(),
        changes,
      },
    });
  }

  const updated = await prisma.priceChangeBatch.update({
    where: { id: batch.id },
    data: {
      noticeSentAt: now,
      effectiveAt,
      status: "NOTICE_SENT",
      contractsAffected: contracts.length,
    },
  });

  return { batch: updated, contractsNotified, failures };
}

// ── Apply ────────────────────────────────────────────────────────────────────

export interface ApplyBatchResult {
  batch: PriceChangeBatch;
  contractsUpdated: number;
  contractsGrandfathered: number;
  failures: number;
}

/**
 * Apply the batch. GRANDFATHER: mark every affected ACTIVE contract
 * grandfatheredPricing and never touch its prices. PROPAGATE_WITH_NOTICE:
 * only after effectiveAt, move each affected non-grandfathered contract's
 * matching lines to the new price minus its ongoing subscription discount.
 * Idempotent: an APPLIED batch is returned unchanged.
 */
export async function applyPriceChangeBatch(
  batchId: string,
  options?: ServiceOptions,
): Promise<ApplyBatchResult> {
  const batch = await prisma.priceChangeBatch.findUniqueOrThrow({
    where: { id: batchId },
  });
  if (batch.status === "APPLIED") {
    return { batch, contractsUpdated: 0, contractsGrandfathered: 0, failures: 0 };
  }
  if (batch.status === "CANCELLED") {
    throw new Error(`PriceChangeBatch ${batch.id} is cancelled`);
  }

  const now = new Date();
  if (batch.mode === "PROPAGATE_WITH_NOTICE") {
    if (batch.status !== "NOTICE_SENT" || !batch.effectiveAt) {
      throw new Error(
        `PriceChangeBatch ${batch.id}: notices must be sent before applying`,
      );
    }
    if (now.getTime() < batch.effectiveAt.getTime()) {
      throw new Error(
        `PriceChangeBatch ${batch.id}: notice period runs until ${batch.effectiveAt.toISOString()}`,
      );
    }
  }

  const items = parseBatchItems(batch);
  const itemByVariant = new Map(items.map((i) => [i.variantId, i]));
  const variantIds = items.map((i) => i.variantId);

  const shop = await prisma.shop.findUniqueOrThrow({
    where: { id: batch.shopId },
  });

  const contracts = await prisma.subscriptionContract.findMany({
    where: affectedContractsWhere(batch.shopId, variantIds),
    include: { lines: true },
  });

  let contractsUpdated = 0;
  let contractsGrandfathered = 0;
  let failures = 0;

  if (batch.mode === "GRANDFATHER") {
    for (const contract of contracts) {
      if (contract.grandfatheredPricing) continue; // idempotent
      await prisma.subscriptionContract.update({
        where: { id: contract.id },
        data: { grandfatheredPricing: true },
      });
      contractsGrandfathered += 1;
      await logEvent({
        shopId: batch.shopId,
        contractId: contract.id,
        customerId: contract.customerId,
        email: contract.email,
        type: "contract.price_grandfathered",
        source: resolveSource(options),
        actor: resolveActor(options),
        payload: { batchId: batch.id, variantIds },
      });
    }
  } else {
    const admin = await adminClientForShop(shop.domain);

    for (const contract of contracts) {
      if (contract.grandfatheredPricing) continue; // grandfathered elsewhere

      // Target price per line: new catalog price minus the ongoing discount.
      const lineTargets: Array<{
        lineId: string;
        shopifyLineId: string;
        variantId: string;
        oldPriceCents: number;
        newPriceCents: number;
        targetPriceCents: number;
      }> = [];
      for (const line of contract.lines) {
        if (line.isGift || line.isOneTimeAddon) continue;
        const item = itemByVariant.get(line.variantId);
        if (!item) continue;

        const pct = await ongoingDiscountPctForProduct(
          batch.shopId,
          line.productId,
        );
        const target =
          pct != null
            ? applyDiscountPct(item.newPriceCents, pct)
            : proportionalPriceCents(item.newPriceCents, line);
        if (line.currentPriceCents === target) continue; // already applied

        if (!line.shopifyLineId) {
          console.error(
            "[contracts] applyPriceChangeBatch: line has no Shopify line id — price not propagated; resync required",
            contract.id,
            line.id,
          );
          continue;
        }
        lineTargets.push({
          lineId: line.id,
          shopifyLineId: line.shopifyLineId,
          variantId: line.variantId,
          oldPriceCents: line.currentPriceCents,
          newPriceCents: item.newPriceCents,
          targetPriceCents: target,
        });
      }
      if (lineTargets.length === 0) continue;

      try {
        await withContractDraft(
          admin,
          contract.shopifyContractId,
          async (draftId, run) => {
            for (const target of lineTargets) {
              await draftLineUpdate(run, draftId, target.shopifyLineId, {
                currentPriceCents: target.targetPriceCents,
              });
            }
          },
        );

        for (const target of lineTargets) {
          await prisma.contractLine.update({
            where: { id: target.lineId },
            data: {
              currentPriceCents: target.targetPriceCents,
              compareAtPriceCents: target.newPriceCents,
            },
          });
        }
        contractsUpdated += 1;

        await logEvent({
          shopId: batch.shopId,
          contractId: contract.id,
          customerId: contract.customerId,
          email: contract.email,
          type: "contract.price_propagated",
          source: resolveSource(options),
          actor: resolveActor(options),
          payload: {
            batchId: batch.id,
            applied: true,
            changes: lineTargets.map((t) => ({
              variantId: t.variantId,
              oldPriceCents: t.oldPriceCents,
              newPriceCents: t.targetPriceCents,
            })),
          },
        });
      } catch (err) {
        failures += 1;
        console.error(
          "[contracts] applyPriceChangeBatch: contract update failed",
          contract.id,
          err,
        );
      }
    }
  }

  const updated = await prisma.priceChangeBatch.update({
    where: { id: batch.id },
    data: { appliedAt: now, status: "APPLIED" },
  });

  return {
    batch: updated,
    contractsUpdated,
    contractsGrandfathered,
    failures,
  };
}
