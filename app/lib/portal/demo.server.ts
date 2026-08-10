import crypto from "node:crypto";
import { z } from "zod";
import type { Prisma, Shop } from "@prisma/client";
import prisma from "~/db.server";
import { adminClientForShop } from "~/shopify.server";
import { addDaysTz } from "~/lib/dates.server";
import { applyDiscountPct } from "~/lib/money";
import { logEvent } from "~/lib/events/log.server";
import { getPortalCatalog } from "~/lib/portal/catalog.server";
import { OWNERSHIP_OURS } from "~/lib/ownership/ownership.server";

/**
 * Local-only demo subscription for the admin portal preview.
 *
 * While the app is in setup mode the merchant has no real subscribers yet, so
 * the launch checklist offers a one-click demo contract to preview the portal
 * against: `isDemo: true`, a fake Shopify GID, and a `.invalid` email — never
 * billed, never notified, excluded from analytics/Klaviyo (every consumer
 * filters on `isDemo: false`). Portal queries include it on purpose.
 *
 * Line items reuse the merchant's real products (first synced selling plan →
 * portal catalog) so the preview shows their own titles, images and
 * subscription pricing; when nothing is synced yet, two plausible skincare
 * placeholders keep the preview meaningful.
 */

const DEMO_EMAIL = "preview@cellexia-demo.invalid";
const DEMO_FIRST_NAME = "Alex";
const DEMO_INTERVAL_WEEKS = 8;
const DEMO_ORDERS_COUNT = 2;
const DEMO_NEXT_BILLING_DAYS = 12;
const DEMO_FIRST_CHARGE_DAYS_AGO = 10 * 7;
// > nextBillingDate + 10 days, so the "not running low?" prompt renders.
const DEMO_PREDICTED_EMPTY_DAYS = 25;
const DEMO_GIFT_TITLE = "Surprise gift — thank you";

function demoGid(kind: string): string {
  return `gid://cellexia/demo/${kind}/${crypto.randomBytes(9).toString("base64url")}`;
}

type DemoLineInput = Omit<Prisma.ContractLineCreateManyContractInput, "contractId">;

const productIdsSchema = z.array(z.string());

/** Placeholder items when no selling plan / catalog is available yet. */
function placeholderLines(): DemoLineInput[] {
  return [
    {
      productId: demoGid("product"),
      variantId: demoGid("variant"),
      title: "Cell Renewal Serum",
      quantity: 1,
      currentPriceCents: 5400,
      compareAtPriceCents: 6000,
    },
    {
      productId: demoGid("product"),
      variantId: demoGid("variant"),
      title: "Hydrating Day Cream",
      quantity: 1,
      currentPriceCents: 3600,
      compareAtPriceCents: 4000,
    },
  ];
}

/**
 * Real lines from the first synced selling plan: its first two products, at
 * the plan's ongoing subscription price. Null when nothing usable is synced —
 * the caller falls back to placeholders. Never throws.
 */
async function linesFromCatalog(shop: Shop): Promise<DemoLineInput[] | null> {
  try {
    const plan = await prisma.sellingPlanConfig.findFirst({
      where: { shopId: shop.id, syncStatus: "SYNCED", active: true },
      orderBy: { createdAt: "asc" },
    });
    if (!plan) return null;

    const parsed = productIdsSchema.safeParse(plan.productIds);
    if (!parsed.success || parsed.data.length === 0) return null;

    const admin = await adminClientForShop(shop.domain);
    const catalog = await getPortalCatalog(admin, shop.id);
    const byId = new Map(catalog.map((p) => [p.id, p]));

    const lines: DemoLineInput[] = [];
    for (const productId of parsed.data) {
      if (lines.length >= 2) break;
      const product = byId.get(productId);
      const variant = product?.variants[0];
      if (!product || !variant) continue;
      const pct = plan.ongoingDiscountPct;
      lines.push({
        productId: product.id,
        variantId: variant.id,
        title: product.title,
        variantTitle: variant.title,
        imageUrl: product.imageUrl,
        quantity: 1,
        currentPriceCents:
          pct > 0 ? applyDiscountPct(variant.priceCents, pct) : variant.priceCents,
        compareAtPriceCents: pct > 0 ? variant.priceCents : null,
      });
    }
    return lines.length > 0 ? lines : null;
  } catch (err) {
    console.error("[portal] demo lines from catalog failed", shop.id, err);
    return null;
  }
}

async function createFreshDemoContract(
  shopId: string,
): Promise<{ contractId: string }> {
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) throw new Error(`Shop not found for demo contract: ${shopId}`);

  const now = new Date();
  const tz = shop.ianaTimezone;
  const lines = (await linesFromCatalog(shop)) ?? placeholderLines();
  const subtotalCents = lines.reduce(
    (sum, l) => sum + l.currentPriceCents * (l.quantity ?? 1),
    0,
  );

  const contract = await prisma.subscriptionContract.create({
    data: {
      shopId: shop.id,
      isDemo: true,
      // Explicit, not inherited from the column default: the portal renders
      // OURS contracts only (a contract from the store's other subscription
      // app must never open a Cellexia portal), and the preview has to show
      // the merchant the real portal. `isDemo` is what keeps it out of
      // billing / notifications / analytics — never the ownership value.
      ownership: OWNERSHIP_OURS,
      shopifyContractId: demoGid("contract"),
      customerId: demoGid("customer"),
      email: DEMO_EMAIL,
      firstName: DEMO_FIRST_NAME,
      lastName: "Morgan",
      status: "ACTIVE",
      locale: "en",
      currencyCode: shop.currencyCode,
      // Week cadence with its exact unit/count mirror (v1.8.0) — the portal
      // reads the mirror first via contractFrequency.
      intervalWeeks: DEMO_INTERVAL_WEEKS,
      billingIntervalUnit: "WEEK",
      billingIntervalCount: DEMO_INTERVAL_WEEKS,
      nextBillingDate: addDaysTz(now, DEMO_NEXT_BILLING_DAYS, tz),
      firstChargeAt: addDaysTz(now, -DEMO_FIRST_CHARGE_DAYS_AGO, tz),
      ordersCount: DEMO_ORDERS_COUNT,
      predictedEmptyDate: addDaysTz(now, DEMO_PREDICTED_EMPTY_DAYS, tz),
      lifetimeRevenueCents: subtotalCents * DEMO_ORDERS_COUNT,
      deliveryAddress: {
        firstName: DEMO_FIRST_NAME,
        lastName: "Morgan",
        address1: "12 Orchard Lane",
        city: "London",
        zip: "N1 7GU",
        countryCode: "GB",
      },
      deliveryMethodTitle: "Standard shipping",
      cardBrand: "visa",
      cardLast4: "4242",
      cardExpiryMonth: 12,
      cardExpiryYear: now.getFullYear() + 1,
      lines: {
        create: [
          ...lines,
          {
            productId: demoGid("product"),
            variantId: demoGid("variant"),
            title: DEMO_GIFT_TITLE,
            quantity: 1,
            currentPriceCents: 0,
            isGift: true,
            addedVia: "GIFT_ENGINE",
          },
        ],
      },
    },
  });

  // A scheduled gift on the upcoming cycle when the merchant has gift rules —
  // so the preview shows the gift experience they configured.
  const rule = await prisma.giftRule.findFirst({
    where: { shopId: shop.id, active: true },
    orderBy: { createdAt: "asc" },
  });
  if (rule) {
    await prisma.giftGrant.create({
      data: {
        contractId: contract.id,
        ruleId: rule.id,
        cycleIndex: DEMO_ORDERS_COUNT + 1,
        variantId: rule.variantId,
        status: "SCHEDULED",
      },
    });
  }

  // Audit only: events-map skips setup mode, demo contracts and .invalid
  // emails, so nothing reaches Klaviyo.
  await logEvent({
    shopId: shop.id,
    contractId: contract.id,
    customerId: contract.customerId,
    email: contract.email,
    type: "admin.action",
    source: "ADMIN",
    actor: "system",
    payload: { action: "demo_contract_created", lines: lines.length + 1 },
  });

  return { contractId: contract.id };
}

/**
 * The shop's demo contract for the portal preview — reused when one already
 * exists, created otherwise.
 */
export async function createDemoContract(
  shopId: string,
): Promise<{ contractId: string }> {
  const existing = await prisma.subscriptionContract.findFirst({
    where: { shopId, isDemo: true },
    select: { id: true, ownership: true },
  });
  if (existing) {
    // A demo contract created before ownership existed was backfilled to
    // UNKNOWN by migration 0003 like every other pre-existing row, and the
    // re-classification pass skips demo fixtures on purpose. Repair it here
    // rather than leaving the merchant with a portal preview that opens empty.
    if (existing.ownership !== OWNERSHIP_OURS) {
      await prisma.subscriptionContract.update({
        where: { id: existing.id },
        data: { ownership: OWNERSHIP_OURS },
      });
    }
    return { contractId: existing.id };
  }
  return createFreshDemoContract(shopId);
}

/** Delete + recreate the demo contract — used when its data has drifted. */
export async function resetDemoContract(
  shopId: string,
): Promise<{ contractId: string }> {
  // Events FIRST: SubscriberEvent.contractId is onDelete: SetNull, so
  // deleting the contract alone would orphan its demo events as
  // contractId-NULL rows — provenance lost forever, and every contract-less
  // surface (the audit page/CSV, any future contract-less counter) would
  // have no way to filter them (the deletion invariant documented in
  // ARCHITECTURE.md's demo passage: demo contracts are the ONLY contracts
  // ever deleted, and their events die with them).
  await prisma.subscriberEvent.deleteMany({
    where: { shopId, contract: { is: { isDemo: true } } },
  });
  await prisma.subscriptionContract.deleteMany({
    where: { shopId, isDemo: true },
  });
  await logEvent({
    shopId,
    type: "admin.action",
    source: "ADMIN",
    actor: "system",
    payload: { action: "demo_contract_reset" },
  });
  return createFreshDemoContract(shopId);
}
