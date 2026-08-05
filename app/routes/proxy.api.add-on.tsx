/**
 * App-proxy storefront API: POST /apps/cellexia-subscriptions/api/add-on
 *
 * Adds a one-time / recurring / N-delivery add-on to the customer's own
 * treatment plan from portal-adjacent storefront surfaces. Body (JSON):
 *   { contract_id, variant_id, product_id, mode, deliveries?, nonce? }
 * (`title` / `price_cents` may still be sent by older widgets — they are
 * IGNORED: price and title always come from the shop's catalog, never from
 * the client. "Never trust prices from the form" applies doubly here.)
 * `nonce` (portal.treatment convention) scopes idempotency to one widget
 * submission so a customer can intentionally add the same variant twice;
 * nonce-less callers fall back to a short-TTL date-scoped key that only
 * guards the double-submit window, and a replayed request says so instead
 * of pretending a second item was added.
 *
 * Identity comes exclusively from the HMAC-verified `logged_in_customer_id`
 * proxy parameter — the customer must own the contract. The product must be
 * an active, subscribable ProductMeta and the variant must be one of that
 * product's currently sellable variants. Writes go through withIdempotency
 * (double-submit safe), append a CUSTOMER audit entry and emit PRODUCT_ADDED.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import { appendAudit } from "~/services/audit.server";
import { emitLifecycleEvent } from "~/services/events.server";
import { withIdempotency } from "~/services/idempotency.server";
import {
  getOfflineAdmin,
  gidTail,
  toGid,
} from "~/services/core/shopifyClient.server";
import {
  fetchVariantsByProduct,
  trackPortal,
  type PortalVariantOption,
} from "~/services/portal/auth.server";
import { storefrontAddOnKey } from "~/services/offers/addOnFulfillment.server";
import { logger } from "~/lib/logger.server";
import { ADD_ON_MODES } from "~/types/domain";
import type { AddOnMode, ContractStatus } from "~/types/domain";

const ACTIVE: ContractStatus = "ACTIVE";

function asNonEmptyString(value: unknown, maxLength = 200): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxLength) : null;
}

function asNonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function isAddOnMode(value: unknown): value is AddOnMode {
  return (
    typeof value === "string" &&
    (ADD_ON_MODES as readonly string[]).includes(value)
  );
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.public.appProxy(request);
  return json({ error: "Method not allowed" }, { status: 405 });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) {
    return json({ error: "App not installed" }, { status: 404 });
  }
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const url = new URL(request.url);
  const loggedInCustomerId =
    url.searchParams.get("logged_in_customer_id") || null;
  if (!loggedInCustomerId) {
    return json(
      { error: "Please sign in to adjust your treatment plan." },
      { status: 401 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const contractId = asNonEmptyString(body.contract_id, 64);
  const variantId = asNonEmptyString(body.variant_id, 100);
  const productId = asNonEmptyString(body.product_id, 100);
  const mode = isAddOnMode(body.mode) ? body.mode : null;
  // Optional client nonce (portal.treatment convention): scopes idempotency
  // to one widget submission so deliberate repeat adds of the same variant
  // are not silently swallowed.
  const nonce = asNonEmptyString(body.nonce, 32);
  // body.title and body.price_cents are deliberately NOT read: catalog only.

  if (!contractId || !variantId || !productId || !mode) {
    return json(
      {
        error:
          "Missing or invalid fields: contract_id, variant_id, product_id and mode are required.",
      },
      { status: 400 },
    );
  }

  let remainingDeliveries: number | null = null;
  if (mode === "N_DELIVERIES") {
    const deliveries = asNonNegativeInt(body.deliveries);
    if (!deliveries || deliveries < 1) {
      return json(
        { error: "deliveries (>= 1) is required for N_DELIVERIES mode." },
        { status: 400 },
      );
    }
    remainingDeliveries = deliveries;
  }

  const contract = await prisma.subscriptionContract.findFirst({
    where: { id: contractId, shop: session.shop },
  });
  // Same response for "not found" and "not yours" — never leak existence.
  if (
    !contract ||
    gidTail(contract.shopifyCustomerId) !== gidTail(loggedInCustomerId)
  ) {
    return json({ error: "Treatment plan not found." }, { status: 404 });
  }
  if (contract.status !== ACTIVE) {
    return json(
      { error: "This treatment plan is not active right now." },
      { status: 409 },
    );
  }

  // Catalog validation: only shop-approved, subscribable products, and only
  // a variant that genuinely belongs to that product AND is sellable today.
  const meta = await prisma.productMeta.findFirst({
    where: {
      shop: session.shop,
      subscribable: true,
      active: true,
      shopifyProductId: { in: [productId, toGid("Product", productId)] },
    },
  });
  if (!meta) {
    return json(
      { error: "That product isn't available to add right now." },
      { status: 400 },
    );
  }

  const productGid = toGid("Product", meta.shopifyProductId);
  let variants: PortalVariantOption[] | undefined;
  try {
    const { graphql } = await getOfflineAdmin(session.shop);
    variants = (await fetchVariantsByProduct(graphql, [productGid]))[
      productGid
    ];
  } catch (error) {
    logger.warn("storefront add-on variant validation unavailable", {
      shop: session.shop,
      error: String(error),
    });
    variants = undefined;
  }
  // Without a validated server-side price we never store one — the request
  // is refused rather than trusting the client.
  const variant = variants?.find(
    (v) => gidTail(v.id) === gidTail(variantId),
  );
  if (!variant) {
    return json(
      { error: "That option isn't available to add right now." },
      { status: variants === undefined ? 503 : 400 },
    );
  }

  // Canonical, server-derived identity + price + title.
  const canonicalVariantId = variant.id;
  const title =
    variant.title && variant.title !== "Default Title"
      ? `${meta.title} — ${variant.title}`
      : meta.title;
  const priceCents = variant.priceCents;

  // With a nonce the key is per-submission (default TTL); without one, a
  // date-scoped fallback with a short TTL guards only the double-submit
  // window — a customer may legitimately add the same variant/mode again
  // later the same day (quantity is hard-coded to 1, so adding twice is the
  // only way to get two). Key + TTL rule live in the pure, unit-tested
  // storefrontAddOnKey helper (offers/addOnFulfillment.server).
  const { key: idempotencyKey, ttlMs } = storefrontAddOnKey(
    contract.id,
    canonicalVariantId,
    mode,
    remainingDeliveries,
    nonce,
    new Date(),
  );
  const { result, replayed } = await withIdempotency(
    idempotencyKey,
    "storefront-add-on",
    async () => {
      const created = await prisma.addOnItem.create({
        data: {
          contractId: contract.id,
          shopifyProductId: productGid,
          shopifyVariantId: canonicalVariantId,
          title,
          quantity: 1,
          priceCents,
          mode,
          remainingDeliveries,
          source: "STOREFRONT",
        },
      });

      await appendAudit({
        shop: session.shop,
        actorType: "CUSTOMER",
        actorId: contract.shopifyCustomerId,
        action: "ADD_PRODUCT",
        subjectType: "SubscriptionContract",
        subjectId: contract.id,
        payload: {
          addOnItemId: created.id,
          productId: productGid,
          variantId: canonicalVariantId,
          title,
          priceCents,
          mode,
          remainingDeliveries,
          source: "STOREFRONT",
        },
      });

      await emitLifecycleEvent({
        shop: session.shop,
        name: "PRODUCT_ADDED",
        contractId: contract.id,
        shopifyCustomerId: contract.shopifyCustomerId,
        email: contract.customerEmail,
        payload: {
          productId: productGid,
          variantId: canonicalVariantId,
          title,
          priceCents,
          mode,
          remainingDeliveries,
          source: "STOREFRONT",
        },
      });

      return { addOnId: created.id };
    },
    ttlMs,
  );

  if (!replayed) {
    await trackPortal(
      session.shop,
      contract.shopifyCustomerId,
      contract.id,
      "ACTION",
      `add-on:storefront:${mode}`,
    );
  }

  // Honest copy on replay: nothing new was created, so never claim a fresh
  // add — a widget that ignores the `replayed` flag would otherwise show
  // "added" while the customer's second unit silently never materialises.
  if (replayed) {
    return json({
      ok: true,
      addOnId: result.addOnId,
      replayed,
      message: "This item was already added — check your next delivery.",
    });
  }

  const message =
    mode === "RECURRING"
      ? "Added to your treatment plan. It will arrive with every delivery."
      : mode === "N_DELIVERIES"
        ? `Added to your next ${remainingDeliveries} deliveries.`
        : "Added to your next delivery.";

  return json({ ok: true, addOnId: result.addOnId, replayed, message });
};
