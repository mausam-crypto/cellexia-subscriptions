import prisma from "~/db.server";
import { logEvent } from "~/lib/events/log.server";
import { getSetting } from "~/lib/settings/settings.server";
import { draftLineAdd, withContractDraft } from "~/lib/graphql/index.server";
import { cancelContract } from "./service.server";
import {
  eventIdentity,
  loadContractContext,
  reloadContract,
  resolveActor,
  resolveSource,
  withMirrorGuard,
  type LocalContractLine,
  type LocalContractWithLines,
  type ServiceOptions,
} from "./shared.server";

/**
 * Shipment consolidation ("routine box"): merge several of a customer's
 * contracts into one so everything bills and ships together — fewer parcels,
 * fewer charges, fewer chances to churn.
 */

// ── Manual / engine merge ────────────────────────────────────────────────────

/**
 * Merge `otherLocalIds` into `primaryLocalId`: move each source contract's
 * recurring non-gift lines onto the primary at their preserved ongoing
 * prices, cancel the sources (reason "MERGED", cancelSource SYSTEM, no
 * win-back — the customer is still subscribed), and stamp `mergeGroupId` on
 * every involved contract. Idempotent: sources already cancelled into this
 * merge group are skipped.
 */
export async function mergeContracts(
  shopDomain: string,
  primaryLocalId: string,
  otherLocalIds: string[],
  options?: ServiceOptions,
): Promise<LocalContractWithLines> {
  const ctx = await loadContractContext(shopDomain, primaryLocalId);
  const { shop, contract: primary, admin } = ctx;
  if (primary.status !== "ACTIVE") {
    throw new Error(
      `Merge primary ${primary.id} is not ACTIVE (status ${primary.status})`,
    );
  }

  // Load + validate sources.
  const sources: LocalContractWithLines[] = [];
  for (const otherId of otherLocalIds) {
    if (otherId === primaryLocalId) continue;
    const other = await prisma.subscriptionContract.findUnique({
      where: { id: otherId },
      include: { lines: true },
    });
    if (!other || other.shopId !== shop.id) {
      throw new Error(`Merge source contract not found: ${otherId}`);
    }
    if (other.customerId !== primary.customerId) {
      throw new Error(
        `Merge source ${otherId} belongs to a different customer than primary ${primary.id}`,
      );
    }
    if (other.status === "CANCELLED" && other.mergeGroupId === primary.id) {
      continue; // already merged into this primary — idempotent skip
    }
    if (other.status !== "ACTIVE") {
      throw new Error(
        `Merge source ${otherId} is not ACTIVE (status ${other.status})`,
      );
    }
    sources.push(other);
  }
  if (sources.length === 0) return reloadContract(primary.id);

  // Move recurring, non-gift lines (gift lines are re-earned on the primary;
  // one-time-addon mirrors belong to a source billing cycle and do not move).
  const moves: Array<{ source: LocalContractWithLines; line: LocalContractLine }> =
    [];
  for (const source of sources) {
    for (const line of source.lines) {
      if (line.isGift || line.isOneTimeAddon) continue;
      moves.push({ source, line });
    }
  }

  const addedShopifyIds: Array<string | null> = [];
  if (moves.length > 0) {
    await withContractDraft(
      admin,
      primary.shopifyContractId,
      async (draftId, run) => {
        for (const { line } of moves) {
          const id = await draftLineAdd(run, draftId, {
            productVariantId: line.variantId,
            quantity: line.quantity,
            currentPriceCents: line.currentPriceCents, // ongoing price preserved
          });
          addedShopifyIds.push(id);
        }
      },
    );
  }

  await withMirrorGuard("mergeContracts", ctx, options, async () => {
    for (let i = 0; i < moves.length; i++) {
      const { line } = moves[i]!;
      await prisma.contractLine.create({
        data: {
          contractId: primary.id,
          shopifyLineId: addedShopifyIds[i] ?? null,
          productId: line.productId,
          variantId: line.variantId,
          title: line.title,
          variantTitle: line.variantTitle,
          sku: line.sku,
          imageUrl: line.imageUrl,
          quantity: line.quantity,
          currentPriceCents: line.currentPriceCents,
          compareAtPriceCents: line.compareAtPriceCents,
          unitCostCents: line.unitCostCents,
          isGift: false,
          isOneTimeAddon: false,
          addedVia: line.addedVia,
        },
      });
    }
  });

  // Cancel sources (no win-back — the subscriber is still with us) and stamp
  // the merge group. Failures are collected so one bad source cannot strand
  // the others silently.
  const failures: Array<{ contractId: string; error: string }> = [];
  const mergedIds: string[] = [];
  for (const source of sources) {
    try {
      await cancelContract(shopDomain, source.id, "MERGED", {
        source: resolveSource(options),
        actor: resolveActor(options),
        cancelSource: "SYSTEM",
        scheduleWinback: false,
      });
      await prisma.subscriptionContract.update({
        where: { id: source.id },
        data: { mergeGroupId: primary.id },
      });
      mergedIds.push(source.id);
      await logEvent({
        shopId: shop.id,
        contractId: source.id,
        customerId: source.customerId,
        email: source.email,
        type: "contract.merged",
        source: resolveSource(options),
        actor: resolveActor(options),
        payload: {
          mergedInto: primary.id,
          movedLineCount: source.lines.filter(
            (l) => !l.isGift && !l.isOneTimeAddon,
          ).length,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ contractId: source.id, error: message });
      console.error(
        "[contracts] mergeContracts: failed to cancel merged source — its lines were already copied to the primary",
        source.id,
        err,
      );
    }
  }

  await prisma.subscriptionContract.update({
    where: { id: primary.id },
    data: { mergeGroupId: primary.id },
  });

  await logEvent({
    ...eventIdentity(shop, primary),
    type: "contract.merged",
    source: resolveSource(options),
    actor: resolveActor(options),
    payload: {
      mergedContractIds: mergedIds,
      movedLineCount: moves.length,
      ...(failures.length > 0 ? { failures } : {}),
    },
  });

  if (failures.length > 0) {
    throw new Error(
      `mergeContracts: ${failures.length} source contract(s) could not be cancelled after their lines were moved: ${failures
        .map((f) => f.contractId)
        .join(", ")}`,
    );
  }

  return reloadContract(primary.id);
}

// ── Automatic consolidation (daily job) ──────────────────────────────────────

export interface AutoConsolidationResult {
  customersEvaluated: number;
  clustersMerged: number;
  contractsMerged: number;
  failures: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When settings.consolidation.autoMergeAlignedContracts is on: group a
 * customer's ACTIVE pay-per-cycle contracts by intervalWeeks and merge those
 * whose nextBillingDate falls within alignmentWindowDays of the earliest one
 * — into that earliest contract. Called by the daily job.
 */
export async function runAutoConsolidation(
  shopId: string,
): Promise<AutoConsolidationResult> {
  const result: AutoConsolidationResult = {
    customersEvaluated: 0,
    clustersMerged: 0,
    contractsMerged: 0,
    failures: 0,
  };

  const settings = await getSetting(shopId, "consolidation");
  if (!settings.autoMergeAlignedContracts) return result;

  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) throw new Error(`Shop not found: ${shopId}`);

  // Prepaid contracts are excluded: their billing/delivery rhythms differ and
  // merging would break the deliveries-remaining accounting.
  const contracts = await prisma.subscriptionContract.findMany({
    where: {
      shopId,
      status: "ACTIVE",
      isPrepaid: false,
      isDemo: false,
      nextBillingDate: { not: null },
    },
    orderBy: { nextBillingDate: "asc" },
  });

  const groups = new Map<string, typeof contracts>();
  for (const contract of contracts) {
    const key = `${contract.customerId}:${contract.intervalWeeks}`;
    const list = groups.get(key);
    if (list) list.push(contract);
    else groups.set(key, [contract]);
  }

  const windowMs = settings.alignmentWindowDays * DAY_MS;
  const customersSeen = new Set<string>();

  for (const group of groups.values()) {
    customersSeen.add(group[0]!.customerId);
    if (group.length < 2) continue;

    // Cluster by billing-date proximity (group is sorted ascending); merge
    // each cluster into its earliest-billing contract.
    let cluster: typeof contracts = [group[0]!];
    const clusters: Array<typeof contracts> = [];
    for (let i = 1; i < group.length; i++) {
      const contract = group[i]!;
      const anchor = cluster[0]!.nextBillingDate!;
      if (contract.nextBillingDate!.getTime() - anchor.getTime() <= windowMs) {
        cluster.push(contract);
      } else {
        clusters.push(cluster);
        cluster = [contract];
      }
    }
    clusters.push(cluster);

    for (const c of clusters) {
      if (c.length < 2) continue;
      const [primary, ...rest] = c;
      try {
        await mergeContracts(
          shop.domain,
          primary!.id,
          rest.map((r) => r.id),
          { source: "SCHEDULER", actor: "system" },
        );
        result.clustersMerged += 1;
        result.contractsMerged += rest.length;
      } catch (err) {
        result.failures += 1;
        console.error(
          "[contracts] runAutoConsolidation: cluster merge failed",
          primary!.id,
          err,
        );
      }
    }
  }

  result.customersEvaluated = customersSeen.size;
  return result;
}
