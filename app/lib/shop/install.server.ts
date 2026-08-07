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
          lastFullSyncAt: new Date(),
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
    // Install must not fail because metadata sync failed; jobs re-sync later.
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
