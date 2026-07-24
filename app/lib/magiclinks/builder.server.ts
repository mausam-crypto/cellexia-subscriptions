import prisma from "~/db.server";
import {
  createMagicToken,
  type CreateMagicLinkInput,
} from "~/lib/crypto/tokens.server";

/**
 * Magic link URL builders. Every URL is a signed, expiring, single-action token.
 * These are embedded in Klaviyo event properties so emails/SMS get one-tap verbs
 * with zero login.
 */

function appUrl(): string {
  const url = process.env.SHOPIFY_APP_URL;
  if (!url) throw new Error("SHOPIFY_APP_URL is not set");
  return url.replace(/\/$/, "");
}

export async function buildMagicUrl(
  input: CreateMagicLinkInput,
): Promise<string> {
  const token = await createMagicToken(input);
  return `${appUrl()}/magic/${token}`;
}

/** Portal URL on the shop's own domain via app proxy. */
export async function buildPortalUrl(
  shopId: string,
  path = "/",
): Promise<string> {
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  const host = shop?.primaryDomain ?? shop?.domain;
  if (!host) throw new Error("No shop domain available for portal URL");
  const clean = path.startsWith("/") ? path : `/${path}`;
  return `https://${host}/apps/cellexia-subscriptions${clean}`;
}

const DEFAULT_TTL_DAYS = 14;

/** Standard one-tap bundle attached to upcoming-order/dunning notifications. */
export async function buildActionLinkBundle(params: {
  contractId: string;
  customerId?: string;
  email?: string;
  createdVia: string;
  ttlDays?: number;
  addonVariantId?: string;
}): Promise<Record<string, string>> {
  const ttlSeconds = (params.ttlDays ?? DEFAULT_TTL_DAYS) * 24 * 3600;
  const base = {
    contractId: params.contractId,
    customerId: params.customerId,
    email: params.email,
    ttlSeconds,
    createdVia: params.createdVia,
  };

  const [skipUrl, delay1wUrl, delay3wUrl, updateCardUrl, pauseUrl] =
    await Promise.all([
      buildMagicUrl({ ...base, action: "SKIP_NEXT" }),
      buildMagicUrl({ ...base, action: "DELAY_NEXT", params: { weeks: 1 } }),
      buildMagicUrl({ ...base, action: "DELAY_NEXT", params: { weeks: 3 } }),
      buildMagicUrl({ ...base, action: "UPDATE_CARD", maxUses: 5 }),
      buildMagicUrl({ ...base, action: "PAUSE", params: { months: 1 } }),
    ]);

  const bundle: Record<string, string> = {
    skip_url: skipUrl,
    delay_1w_url: delay1wUrl,
    delay_3w_url: delay3wUrl,
    update_card_url: updateCardUrl,
    pause_url: pauseUrl,
  };

  if (params.addonVariantId) {
    bundle.addon_url = await buildMagicUrl({
      ...base,
      action: "ADD_TO_NEXT",
      params: { variantId: params.addonVariantId },
    });
  }

  return bundle;
}
