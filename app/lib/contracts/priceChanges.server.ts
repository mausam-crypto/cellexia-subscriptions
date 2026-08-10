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
import { OURS_ONLY } from "~/lib/ownership/ownership.server";
import {
  PRICE_CHANGE_NOTICE_DAYS_MAX,
  PRICE_CHANGE_NOTICE_DAYS_MIN,
} from "~/lib/settings/registry.server";

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
 * "Affected" always means: ACTIVE, NON-DEMO contracts OWNED BY THIS APP
 * having a line with one of the batch's variantIds. Another subscription app
 * running on the same shop sells the same variants; notifying or repricing
 * its subscribers would be editing contracts we do not manage. And the
 * portal-preview demo contract is ACTIVE + OURS with REAL catalog variant
 * ids on a fake Shopify GID — including it would inflate the count, emit a
 * price-increase notice to its .invalid fixture address and hand apply a
 * guaranteed Shopify failure. Both are excluded from the count, the notice
 * batch and the apply batch alike via the one shared where below.
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
    ...OURS_ONLY,
    isDemo: false,
    status: "ACTIVE" as const,
    lines: { some: { variantId: { in: variantIds } } },
  };
}

// ── Per-contract outcome ledger (migration 0016) ─────────────────────────────

type OutcomeStatus =
  | "APPLIED"
  | "FAILED"
  | "SKIPPED_NULL_LINE"
  | "NOTICE_SENT"
  | "NOTICE_FAILED";

/** Notice-phase vs apply-phase rows — each phase retries off its own set. */
const NOTICE_STATUSES: OutcomeStatus[] = ["NOTICE_SENT", "NOTICE_FAILED"];
const APPLY_STATUSES: OutcomeStatus[] = ["APPLIED", "FAILED", "SKIPPED_NULL_LINE"];

/**
 * Append one per-contract outcome row. Best-effort: the ledger documents the
 * engine run, it must never abort it — a failed write costs one retry (the
 * contract looks unprocessed next run and its idempotent path re-verifies).
 */
async function recordOutcome(
  batchId: string,
  contractId: string,
  status: OutcomeStatus,
  error?: string,
): Promise<void> {
  try {
    await prisma.priceChangeContractOutcome.create({
      data: { batchId, contractId, status, error: error ?? null },
    });
  } catch (err) {
    console.error(
      "[contracts] price change outcome write failed",
      batchId,
      contractId,
      status,
      err,
    );
  }
}

/**
 * Latest outcome per contract for one batch phase. Rows are append-only
 * (each retry adds one), so "latest wins" is the per-contract verdict.
 */
async function latestOutcomeByContract(
  batchId: string,
  statuses: OutcomeStatus[],
): Promise<Map<string, string>> {
  const rows = await prisma.priceChangeContractOutcome.findMany({
    where: { batchId, status: { in: statuses } },
    // id (cuid) breaks same-millisecond createdAt ties in insert order.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { contractId: true, status: true },
  });
  const latest = new Map<string, string>();
  for (const row of rows) latest.set(row.contractId, row.status);
  return latest;
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

  // Registry invariant (settingsSchemas.priceChangePolicy.noticeDays),
  // enforced HERE so no caller can create a batch that violates it: the
  // per-batch override arrives from a form field, and a typed "0" or "3" (or
  // a crafted POST with a negative value) would otherwise flow verbatim into
  // sendPriceChangeNotices, whose effectiveAt = now + noticeDays lands today
  // or in the past — so applyPriceChangeBatch's only guard (now < effectiveAt)
  // passes immediately and subscribers are repriced the same day the
  // "advance notice" email went out, collapsing the compliance window the
  // 7-day registry floor exists to guarantee for stored-credential billing.
  if (
    !Number.isInteger(resolvedNoticeDays) ||
    resolvedNoticeDays < PRICE_CHANGE_NOTICE_DAYS_MIN ||
    resolvedNoticeDays > PRICE_CHANGE_NOTICE_DAYS_MAX
  ) {
    throw new Error(
      `Notice period must be a whole number between ${PRICE_CHANGE_NOTICE_DAYS_MIN} and ${PRICE_CHANGE_NOTICE_DAYS_MAX} days (got ${resolvedNoticeDays})`,
    );
  }

  const variantIds = validItems.map((i) => i.variantId);
  const contractsAffected = await prisma.subscriptionContract.count({
    where: affectedContractsWhere(shopId, variantIds),
  });

  // The items' old/new prices come from the admin catalog UI, i.e. they are
  // shop-currency cents. Stamped on the batch at creation (migration 0016)
  // so notice/apply can refuse contracts billed in another currency instead
  // of writing cross-currency cents onto them.
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });

  const batch = await prisma.priceChangeBatch.create({
    data: {
      shopId,
      mode: resolvedMode,
      noticeDays: resolvedNoticeDays,
      createdBy: options?.createdBy ?? resolveActor(options),
      status: "DRAFT",
      items: validItems as object,
      contractsAffected,
      currencyCode: shop.currencyCode,
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
      currencyCode: shop.currencyCode,
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
 * timezone) and move the batch to NOTICE_SENT. Every contract's verdict is
 * recorded in PriceChangeContractOutcome (NOTICE_SENT / NOTICE_FAILED), and
 * a call on a batch already NOTICE_SENT retries ONLY the NOTICE_FAILED
 * contracts — same-run re-clicks can never double-send, and a failed send is
 * no longer a number in a log line that nothing ever retries. An APPLIED
 * batch is returned unchanged.
 */
export async function sendPriceChangeNotices(
  batchId: string,
  options?: ServiceOptions,
): Promise<SendNoticesResult> {
  const batch = await prisma.priceChangeBatch.findUniqueOrThrow({
    where: { id: batchId },
  });
  if (batch.status === "APPLIED") {
    return { batch, contractsNotified: 0, failures: 0 }; // nothing left to notice
  }
  const retryRun = batch.status === "NOTICE_SENT";
  if (!retryRun && batch.status !== "DRAFT") {
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
  // The notice window anchors at the FIRST send: a retry reuses the stored
  // effectiveAt so retried subscribers get the exact date everyone else was
  // promised — recomputing would silently extend the batch per retry.
  const effectiveAt =
    retryRun && batch.effectiveAt
      ? batch.effectiveAt
      : addDaysTz(now, batch.noticeDays, tz);
  // Batch prices are shop-currency cents (stamped at creation; a pre-0016
  // batch predates the stamp and meant the shop currency).
  const batchCurrency = batch.currencyCode ?? shop.currencyCode;

  const contracts = await prisma.subscriptionContract.findMany({
    where: {
      ...affectedContractsWhere(batch.shopId, variantIds),
      grandfatheredPricing: false,
    },
    include: { lines: true },
  });

  const noticeOutcomes = retryRun
    ? await latestOutcomeByContract(batch.id, NOTICE_STATUSES)
    : new Map<string, string>();

  let contractsNotified = 0;
  let failures = 0;

  for (const contract of contracts) {
    // Retry runs touch exactly the contracts whose last send failed; anyone
    // already NOTICE_SENT (or newly affected since the first run — their
    // window never started) is left alone.
    if (retryRun && noticeOutcomes.get(contract.id) !== "NOTICE_FAILED") {
      continue;
    }

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

    // Currency guard: the batch's cents mean nothing on a contract billed in
    // another currency — never format them into its notice (a "£12.00 →
    // £14.00" email to a CHF-billed subscriber misstates both prices).
    // Recorded, not silently skipped, so the exclusion is visible per
    // contract; apply enforces the same guard on the write side.
    if (contract.currencyCode !== batchCurrency) {
      failures += 1;
      await recordOutcome(batch.id, contract.id, "NOTICE_FAILED", "currency_mismatch");
      continue;
    }

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
      await recordOutcome(batch.id, contract.id, "NOTICE_SENT");
      // The scheduled-propagation event ONLY on a successful send: it is the
      // compliance record that this subscriber actually received advance
      // notice — logging it for a failed send fabricated the notice trail.
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
    } catch (err) {
      failures += 1;
      await recordOutcome(
        batch.id,
        contract.id,
        "NOTICE_FAILED",
        err instanceof Error ? err.message : String(err),
      );
      console.error(
        "[contracts] price change notice failed",
        contract.id,
        err,
      );
    }
  }

  // A retry run leaves the batch row untouched — its window and count were
  // fixed by the first send.
  const updated = retryRun
    ? batch
    : await prisma.priceChangeBatch.update({
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
 * matching lines to the new price minus its ongoing subscription discount,
 * recording every contract's verdict in PriceChangeContractOutcome (APPLIED
 * / FAILED+error / SKIPPED_NULL_LINE). The batch is stamped APPLIED only
 * when a run ends with nothing failing — a half-applied batch stays
 * NOTICE_SENT and the next "Apply now" retries exactly the non-APPLIED
 * contracts (stamping early froze the batch APPLIED around failures that
 * only a log line ever saw). Idempotent: an APPLIED batch is returned
 * unchanged.
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
    // Batch prices are shop-currency cents (stamped at creation; a pre-0016
    // batch predates the stamp and meant the shop currency).
    const batchCurrency = batch.currencyCode ?? shop.currencyCode;
    // Contracts that already landed in an earlier run are skipped; everything
    // else (FAILED, SKIPPED_NULL_LINE, never attempted) is retried.
    const applyOutcomes = await latestOutcomeByContract(
      batch.id,
      APPLY_STATUSES,
    );

    for (const contract of contracts) {
      if (contract.grandfatheredPricing) continue; // grandfathered elsewhere
      if (applyOutcomes.get(contract.id) === "APPLIED") continue; // done earlier

      // Currency guard: the batch's cents are meaningless on a contract
      // billed in another currency — writing them would smuggle cross-
      // currency amounts past every "same currency only" analytics guard.
      // Recorded, never silently skipped; the mismatch also blocks the
      // APPLIED stamp below, so the exclusion stays visible on the batch.
      if (contract.currencyCode !== batchCurrency) {
        failures += 1;
        await recordOutcome(batch.id, contract.id, "FAILED", "currency_mismatch");
        continue;
      }

      // Target price per line: new catalog price minus the ongoing discount.
      const lineTargets: Array<{
        lineId: string;
        shopifyLineId: string;
        variantId: string;
        oldPriceCents: number;
        newPriceCents: number;
        targetPriceCents: number;
      }> = [];
      // Matching lines that CANNOT be written because the mirror has no
      // Shopify line id (imports, failed post-add stamps) — resync required.
      let nullLineSkips = 0;
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
          nullLineSkips += 1;
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
      if (lineTargets.length === 0) {
        if (nullLineSkips > 0) {
          // Nothing writable on this contract: recorded so the batch is
          // never silently "applied around" it, and a later re-run (after a
          // resync restores the line ids) retries it.
          failures += 1;
          await recordOutcome(batch.id, contract.id, "SKIPPED_NULL_LINE");
        } else {
          // Every matching line already sits at its target price — applied
          // in effect (e.g. an earlier run whose outcome write failed).
          // Recording APPLIED keeps re-runs convergent.
          await recordOutcome(batch.id, contract.id, "APPLIED");
        }
        continue;
      }

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
        await recordOutcome(batch.id, contract.id, "APPLIED");

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
        await recordOutcome(
          batch.id,
          contract.id,
          "FAILED",
          err instanceof Error ? err.message : String(err),
        );
        console.error(
          "[contracts] applyPriceChangeBatch: contract update failed",
          contract.id,
          err,
        );
      }
    }
  }

  // GRANDFATHER always stamps: its per-contract writes throw on error, so
  // reaching here means every contract was flagged. PROPAGATE stamps only
  // when nothing failed this run — otherwise the batch stays NOTICE_SENT and
  // "Apply now" remains available to retry the non-APPLIED contracts.
  const complete = batch.mode === "GRANDFATHER" || failures === 0;
  const updated = complete
    ? await prisma.priceChangeBatch.update({
        where: { id: batch.id },
        data: { appliedAt: now, status: "APPLIED" },
      })
    : batch;

  return {
    batch: updated,
    contractsUpdated,
    contractsGrandfathered,
    failures,
  };
}
