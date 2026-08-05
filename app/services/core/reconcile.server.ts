/**
 * Reconciliation: compare the local billing mirror (BillingAttempt SUCCESS
 * rows + contract totals) against Shopify subscription orders and record any
 * discrepancy to the audit log (action RECONCILE_DISCREPANCY).
 */
import prisma from "~/db.server";
import { appendAudit } from "~/services/audit.server";
import { getOfflineAdmin, runGraphql } from "~/services/core/shopifyClient.server";
import { RECONCILE_ORDERS_QUERY } from "~/graphql/billing";
import {
  diffReconcile,
  type ReconcileLocalAttempt,
  type ReconcileShopifyOrder,
} from "~/services/core/pure";
import { addDays, isoDate } from "~/lib/dates";
import { toCents } from "~/lib/money";
import { logger } from "~/lib/logger.server";

const LOOKBACK_DAYS = 30;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

export interface ReconcileShopSummary {
  shop: string;
  ordersChecked: number;
  attemptsChecked: number;
  ordersWithoutAttempt: number;
  attemptsWithoutOrder: number;
  amountMismatches: number;
  /** SUCCESS attempts recorded with no amount (local revenue drifted low). */
  unpricedAttempts: number;
  /** True when the order scan hit the page limit — coverage was incomplete. */
  truncated: boolean;
}

export interface ReconcileSummary {
  ranAt: string;
  lookbackDays: number;
  shops: ReconcileShopSummary[];
}

interface ReconcileOrdersPage {
  orders: {
    edges: Array<{
      node: {
        id: string;
        name: string;
        createdAt: string;
        sourceName: string | null;
        tags: string[];
        totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
        customer: { id: string } | null;
      };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

async function fetchSubscriptionOrders(
  shop: string,
  since: Date,
): Promise<{ orders: ReconcileShopifyOrder[]; truncated: boolean }> {
  const { graphql } = await getOfflineAdmin(shop);
  // Narrow server-side so busy shops fit inside the page budget; the
  // client-side isSubscriptionOrder check below stays as a safety net.
  const query = `created_at:>=${isoDate(since)} AND (source_name:subscription_contract OR tag:subscription)`;
  const orders: ReconcileShopifyOrder[] = [];
  let after: string | null = null;
  let hasMore = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const data: ReconcileOrdersPage = await runGraphql<ReconcileOrdersPage>(
      graphql,
      RECONCILE_ORDERS_QUERY,
      {
        first: PAGE_SIZE,
        after,
        query,
      },
    );

    for (const edge of data.orders.edges) {
      const node = edge.node;
      const isSubscriptionOrder =
        node.sourceName === "subscription_contract" ||
        node.tags.some((t) => t.toLowerCase() === "subscription");
      if (!isSubscriptionOrder) continue;
      orders.push({
        id: node.id,
        totalCents: toCents(node.totalPriceSet.shopMoney.amount),
      });
    }
    if (!data.orders.pageInfo.hasNextPage || !data.orders.pageInfo.endCursor) {
      hasMore = false;
      break;
    }
    hasMore = true;
    after = data.orders.pageInfo.endCursor;
  }
  // hasMore survives the loop only when the page limit cut the scan short.
  return { orders, truncated: hasMore };
}

async function reconcileShop(
  shop: string,
  since: Date,
): Promise<ReconcileShopSummary> {
  const successAttempts = await prisma.billingAttempt.findMany({
    where: { shop, status: "SUCCESS", occurredAt: { gte: since } },
    select: { contractId: true, orderId: true, amountCents: true },
  });
  const attempts: ReconcileLocalAttempt[] = successAttempts.map((a) => ({
    contractId: a.contractId,
    orderId: a.orderId,
    amountCents: a.amountCents,
  }));

  const { orders, truncated } = await fetchSubscriptionOrders(shop, since);
  const diff = diffReconcile(attempts, orders);

  // A truncated scan cannot prove an attempt's order is missing on Shopify —
  // it may simply lie beyond the cutoff. Report those separately instead of
  // flagging them as discrepancies.
  const attemptsWithoutOrder = truncated ? [] : diff.attemptsWithoutOrder;

  if (truncated) {
    logger.warn("reconcile scan truncated", {
      shop,
      maxOrders: PAGE_SIZE * MAX_PAGES,
    });
  }

  const summary: ReconcileShopSummary = {
    shop,
    ordersChecked: orders.length,
    attemptsChecked: attempts.length,
    ordersWithoutAttempt: diff.ordersWithoutAttempt.length,
    attemptsWithoutOrder: attemptsWithoutOrder.length,
    amountMismatches: diff.amountMismatches.length,
    unpricedAttempts: diff.unpricedAttempts.length,
    truncated,
  };

  const hasDiscrepancy =
    diff.ordersWithoutAttempt.length > 0 ||
    attemptsWithoutOrder.length > 0 ||
    diff.amountMismatches.length > 0 ||
    diff.unpricedAttempts.length > 0;

  if (hasDiscrepancy) {
    await appendAudit({
      shop,
      actorType: "SYSTEM",
      action: "RECONCILE_DISCREPANCY",
      subjectType: "ReconcileRun",
      payload: {
        since: since.toISOString(),
        ordersWithoutAttempt: diff.ordersWithoutAttempt,
        attemptsWithoutOrder,
        amountMismatches: diff.amountMismatches,
        unpricedAttempts: diff.unpricedAttempts,
        truncated,
        ...(truncated
          ? { unverifiedAttempts: diff.attemptsWithoutOrder }
          : {}),
      },
    });
    logger.warn("reconcile discrepancies", { ...summary });
  } else {
    logger.info("reconcile clean", { ...summary });
  }
  return summary;
}

/**
 * Job entry (`/jobs/reconcile`). When `shop` is omitted, reconciles every
 * shop that has settings or contracts.
 */
export async function runReconcileJob(shop?: string): Promise<ReconcileSummary> {
  const since = addDays(new Date(), -LOOKBACK_DAYS);
  let shops: string[];
  if (shop) {
    shops = [shop];
  } else {
    const [settings, contractShops] = await Promise.all([
      prisma.shopSettings.findMany({ select: { shop: true } }),
      prisma.subscriptionContract.findMany({
        select: { shop: true },
        distinct: ["shop"],
      }),
    ]);
    shops = Array.from(
      new Set([...settings.map((s) => s.shop), ...contractShops.map((c) => c.shop)]),
    );
  }

  const summaries: ReconcileShopSummary[] = [];
  for (const s of shops) {
    try {
      summaries.push(await reconcileShop(s, since));
    } catch (e) {
      logger.error("reconcile failed for shop", {
        shop: s,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return {
    ranAt: new Date().toISOString(),
    lookbackDays: LOOKBACK_DAYS,
    shops: summaries,
  };
}
