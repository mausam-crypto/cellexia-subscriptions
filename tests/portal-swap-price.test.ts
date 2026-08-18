import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

/**
 * ONE SWAP-PRICING RULE — portal items card (v1.28.0)
 *
 * `swapPriceCentsSync` (shared.server) is the pure form of the service's
 * `swapPriceCentsFor`; the subscription page prices its swap dropdown through
 * it so a grandfathered contract sees its locked line price on a same-product
 * swap (what swapLineVariant bills), a covered product sees the ongoing
 * discount off catalog, and an uncovered one the line's proportional ratio.
 */

vi.mock("~/db.server", () => ({
  default: {
    sellingPlanConfig: {
      findMany: vi.fn(async (): Promise<unknown[]> => [
        {
          productIds: ["gid://shopify/Product/9"],
          ongoingDiscountPct: 10,
        },
      ]),
    },
  },
}));

vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/graphql/client.server", () => ({
  gql: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: vi.fn() }));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (): Promise<unknown> => ({})),
}));

import { swapPriceCentsSync } from "~/lib/contracts/shared.server";
import { swapPriceCentsFor } from "~/lib/contracts/service.server";
import { applyDiscountPct } from "~/lib/money";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (rel: string) =>
  fs.readFileSync(path.join(ROOT, rel), "utf8");

const PRODUCT = "gid://shopify/Product/9";
const line = {
  productId: PRODUCT,
  currentPriceCents: 4000,
  compareAtPriceCents: 5000, // ratio 0.8
};

describe("swapPriceCentsSync", () => {
  it("grandfathered + same product, same/smaller size → min(locked, repriced): the lock shields catalog rises, a cheaper size is never dearer", () => {
    // Same size at a risen catalog price (5000 → still ≤ original 5000): locked.
    expect(
      swapPriceCentsSync(
        { grandfatheredPricing: true },
        line,
        { productId: PRODUCT, priceCents: 5000 },
        10,
      ),
    ).toBe(4000);
    // Smaller size (3000, repriced 2700 < locked 4000): the cheaper number.
    expect(
      swapPriceCentsSync(
        { grandfatheredPricing: true },
        line,
        { productId: PRODUCT, priceCents: 3000 },
        10,
      ),
    ).toBe(2700);
    // Small size whose repriced value would exceed the lock: locked wins.
    expect(
      swapPriceCentsSync(
        { grandfatheredPricing: true },
        line,
        { productId: PRODUCT, priceCents: 4900 },
        10,
      ),
    ).toBe(4000);
  });

  it("grandfathered + same product, BIGGER size (catalog above the original) → repriced, never the small-size locked price", () => {
    expect(
      swapPriceCentsSync(
        { grandfatheredPricing: true },
        line,
        { productId: PRODUCT, priceCents: 9900 },
        10,
      ),
    ).toBe(applyDiscountPct(9900, 10));
    // Without a compareAt the current price is the original catalog anchor.
    expect(
      swapPriceCentsSync(
        { grandfatheredPricing: true },
        { productId: PRODUCT, currentPriceCents: 4000, compareAtPriceCents: null },
        { productId: PRODUCT, priceCents: 8000 },
        null,
      ),
    ).toBe(8000);
  });

  it("covering config → ongoing percent off the catalog price", () => {
    expect(
      swapPriceCentsSync(
        { grandfatheredPricing: false },
        line,
        { productId: PRODUCT, priceCents: 3000 },
        10,
      ),
    ).toBe(applyDiscountPct(3000, 10));
  });

  it("no covering config → the line's proportional ratio", () => {
    expect(
      swapPriceCentsSync(
        { grandfatheredPricing: false },
        line,
        { productId: PRODUCT, priceCents: 3000 },
        null,
      ),
    ).toBe(2400);
  });

  it("grandfathered but a different product → priced like any swap", () => {
    expect(
      swapPriceCentsSync(
        { grandfatheredPricing: true },
        line,
        { productId: "gid://shopify/Product/10", priceCents: 3000 },
        null,
      ),
    ).toBe(2400);
  });

  it("the async service helper resolves the percent and delegates to the same rule", async () => {
    const applied = await swapPriceCentsFor(
      "shop_1",
      { grandfatheredPricing: false },
      line,
      { productId: PRODUCT, priceCents: 3000 },
    );
    expect(applied).toBe(
      swapPriceCentsSync(
        { grandfatheredPricing: false },
        line,
        { productId: PRODUCT, priceCents: 3000 },
        10,
      ),
    );
    const locked = await swapPriceCentsFor(
      "shop_1",
      { grandfatheredPricing: true },
      line,
      { productId: PRODUCT, priceCents: 3000 },
    );
    expect(locked).toBe(
      swapPriceCentsSync(
        { grandfatheredPricing: true },
        line,
        { productId: PRODUCT, priceCents: 3000 },
        10,
      ),
    );
    expect(locked).toBe(2700);
    const same = await swapPriceCentsFor(
      "shop_1",
      { grandfatheredPricing: true },
      line,
      { productId: PRODUCT, priceCents: 5000 },
    );
    expect(same).toBe(4000);
  });
});

describe("subscription page swap dropdown", () => {
  it("source pin: options are priced through swapPriceCentsSync (loader map), catalog price only as fallback", () => {
    const src = readSource("app/routes/proxy.subscription.$id.tsx");
    expect(src).toContain("swapPriceCentsSync(");
    expect(src).toContain("swapPrices.set(line.id, byVariant)");
    expect(src).toContain(
      "resolved?.get(v.id) ?? discountedCents(v.priceCents, discountPct)",
    );
    const service = readSource("app/lib/contracts/service.server.ts");
    expect(service).toContain("return swapPriceCentsSync(contract, line, variant, pct)");
  });
});
