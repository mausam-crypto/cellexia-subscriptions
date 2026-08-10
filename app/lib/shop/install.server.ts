import prisma from "~/db.server";
import { adminClientForShop } from "~/shopify.server";
import { logEvent } from "~/lib/events/log.server";

const SHOP_INFO_QUERY = `#graphql
  query CellexiaShopInfo {
    shop {
      name
      currencyCode
      ianaTimezone
      contactEmail
      primaryDomain { host }
    }
    shopLocales {
      locale
      primary
      published
    }
  }
`;

/** Idempotent install/refresh: upsert the Shop row and sync shop metadata. */
export async function onAppInstalled(shopDomain: string): Promise<void> {
  const shop = await prisma.shop.upsert({
    where: { domain: shopDomain },
    create: { domain: shopDomain },
    update: { uninstalledAt: null },
  });

  try {
    const admin = await adminClientForShop(shopDomain);
    const response = await admin.graphql(SHOP_INFO_QUERY);
    const body = (await response.json()) as {
      data?: {
        shop?: {
          name?: string;
          currencyCode?: string;
          ianaTimezone?: string;
          contactEmail?: string;
          primaryDomain?: { host?: string };
        };
        shopLocales?: Array<{
          locale: string;
          primary: boolean;
          published: boolean;
        }>;
      };
    };

    const info = body.data?.shop;
    if (info) {
      await prisma.shop.update({
        where: { id: shop.id },
        data: {
          name: info.name,
          currencyCode: info.currencyCode ?? undefined,
          ianaTimezone: info.ianaTimezone ?? undefined,
          contactEmail: info.contactEmail ?? undefined,
          primaryDomain: info.primaryDomain?.host ?? undefined,
          enabledLocales: (body.data?.shopLocales ?? []) as object,
          // lastFullSyncAt is deliberately NOT written here: metadata sync is
          // not a contract sync. backfillAllContracts stamps it on completion
          // (the only writer), which is what makes the backfill gate below
          // retry-safe.
        },
      });
    }

    await logEvent({
      shopId: shop.id,
      type: "shop.installed",
      source: "SYSTEM",
      payload: { domain: shopDomain },
    });
  } catch (err) {
    // Install must not fail because metadata sync failed; the shop/update
    // webhook re-syncs currency/timezone/locales when the shop changes them.
    console.error("[install] shop metadata sync failed", err);
  }

  try {
    // Mirror the launch mode into the cellexia.launch_status metafield so a
    // fresh install is dark by default (SETUP hides the buy-box block).
    // Idempotent on re-auth: the stored setting wins, so a shop already LIVE
    // is never flipped back. Lazy import keeps the module graph acyclic;
    // syncLaunchMetafield itself never throws.
    const { getLaunchState, syncLaunchMetafield } = await import(
      "~/lib/launch/launch.server"
    );
    const launch = await getLaunchState(shop.id);
    await syncLaunchMetafield(shopDomain, launch.mode);
  } catch (err) {
    console.error("[install] launch metafield sync failed", err);
  }

  try {
    // ── Initial contract backfill ────────────────────────────────────────────
    // Contracts that exist BEFORE install never fire a webhook, so without a
    // full sweep they are invisible to billing and analytics until some later
    // webhook happens to touch them. Fire-and-forget on purpose: an
    // established shop takes minutes to page through and afterAuth must
    // answer the OAuth callback promptly — the sweep's own per-contract sync
    // events are the audit trail, and its completion stamp is the gate.
    // Gated on lastFullSyncAt, which ONLY backfillAllContracts writes (on
    // completion): a re-auth never re-runs the sweep, while a crash mid-sweep
    // leaves the stamp null and the next auth retries it. Shops installed
    // before the gate existed carry a metadata-time stamp and are covered by
    // the daily full_sync_reconcile job instead. Lazy import: the contracts
    // module imports requireShop from this file.
    const current = await prisma.shop.findUnique({
      where: { id: shop.id },
      select: { lastFullSyncAt: true },
    });
    if (!current?.lastFullSyncAt) {
      const { backfillAllContracts } = await import(
        "~/lib/contracts/sync.server"
      );
      void backfillAllContracts(shopDomain)
        .then((result) => {
          console.log(
            "[install] initial contract backfill finished",
            shopDomain,
            `total=${result.total} synced=${result.synced} failed=${result.failed}`,
          );
        })
        .catch((err) => {
          // Contained: a failed backfill must never break install — the gate
          // stays null, so the next auth (or the daily job) retries.
          console.error("[install] initial contract backfill failed", err);
        });
    }
  } catch (err) {
    console.error("[install] initial contract backfill launch failed", err);
  }
}

export async function requireShop(shopDomain: string) {
  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop) throw new Error(`Shop not found: ${shopDomain}`);
  return shop;
}

/** The single-merchant install; used by background jobs that have no request. */
export async function getPrimaryShop() {
  const shop = await prisma.shop.findFirst({
    where: { uninstalledAt: null },
    orderBy: { installedAt: "desc" },
  });
  return shop;
}
