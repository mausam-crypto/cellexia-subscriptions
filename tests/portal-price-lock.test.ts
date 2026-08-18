import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Price lock + price-change surfaces (v1.28.0, P4.6) —
 * app/lib/portal/price-lock.server.ts.
 *
 * Pinned:
 *  - "Member price · locked" pill ONLY when the contract is grandfathered
 *    AND no price-change notice is pending — exactly what the engine
 *    guarantees (grandfathered contracts are skipped by notice + apply);
 *  - the saving line only when EVERY recurring line mirrors a compare-at
 *    price above its plan price (add-ons / gifts ignored); member/one-off
 *    are Σ over recurring lines × qty;
 *  - pending price change = a NOTICE_SENT outcome on a NOTICE_SENT batch
 *    with an effective date, not APPLIED for this contract, restating the
 *    batch's own old → new figures for the contract's matching lines; the
 *    currency guard mirrors the engines; contained on read failure;
 *  - the items card header carries the pill + saving line (source pin).
 */

const mocks = vi.hoisted(() => ({
  outcomeFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  batchFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
}));

vi.mock("~/db.server", () => ({
  default: {
    priceChangeContractOutcome: { findMany: mocks.outcomeFindMany },
    priceChangeBatch: { findMany: mocks.batchFindMany },
  },
}));

import {
  loadPendingPriceChange,
  priceLockPillHtml,
  priceLockView,
  priceSavingLineHtml,
} from "~/lib/portal/price-lock.server";
import en from "../app/lib/i18n/locales/en.json";

function readSource(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

const EFFECTIVE = new Date("2026-09-15T00:00:00.000Z");

function contract(over: Record<string, unknown> = {}) {
  return {
    id: "cm_1",
    currencyCode: "GBP",
    grandfatheredPricing: true,
    lines: [
      { variantId: "v1", title: "Serum", quantity: 2, currentPriceCents: 2000, compareAtPriceCents: 2500, isGift: false, isOneTimeAddon: false },
      { variantId: "v2", title: "Cream", quantity: 1, currentPriceCents: 1500, compareAtPriceCents: 1800, isGift: false, isOneTimeAddon: false },
      { variantId: "v3", title: "Kit", quantity: 1, currentPriceCents: 900, compareAtPriceCents: null, isGift: false, isOneTimeAddon: true },
      { variantId: "v4", title: "Mini", quantity: 1, currentPriceCents: 0, compareAtPriceCents: null, isGift: true, isOneTimeAddon: false },
    ],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.outcomeFindMany.mockResolvedValue([]);
  mocks.batchFindMany.mockResolvedValue([]);
});

describe("priceLockView", () => {
  it("locks only when grandfathered AND nothing is pending", () => {
    expect(priceLockView(contract(), null).locked).toBe(true);
    expect(priceLockView(contract({ grandfatheredPricing: false }), null).locked).toBe(false);
    const pending = { batchId: "b", effectiveAt: EFFECTIVE, currencyCode: "GBP", changes: [{ variantId: "v1", title: "Serum", oldPriceCents: 1, newPriceCents: 2 }] };
    expect(priceLockView(contract(), pending).locked).toBe(false);
  });

  it("saving line = Σ recurring lines (member vs compare-at), add-ons and gifts ignored", () => {
    const view = priceLockView(contract(), null);
    // Serum 2×2000 + Cream 1500 = 5500 member; 2×2500 + 1800 = 6800 one-off.
    expect(view.saving).toEqual({ memberCents: 5500, oneOffCents: 6800 });
    expect(priceSavingLineHtml("en", "GBP", view)).toContain(
      "Your member price is £55.00 instead of £68.00 one-off per order.",
    );
  });

  it("no saving line when any recurring line lacks a compare-at above its price", () => {
    const c = contract();
    (c.lines[1] as { compareAtPriceCents: number | null }).compareAtPriceCents = null;
    expect(priceLockView(c, null).saving).toBeNull();
    expect(priceSavingLineHtml("en", "GBP", priceLockView(c, null))).toBe("");
    const c2 = contract();
    (c2.lines[0] as { compareAtPriceCents: number | null }).compareAtPriceCents = 2000; // equal, not above
    expect(priceLockView(c2, null).saving).toBeNull();
  });

  it("pill html: cxs- class, i18n copy, empty when unlocked", () => {
    const html = priceLockPillHtml("en", priceLockView(contract(), null));
    expect(html).toContain("cxs-price-lock");
    expect(html).toContain(en["portal.price.locked_pill"]);
    expect(html).not.toMatch(/class="[^"]*\bcx-/);
    expect(priceLockPillHtml("en", priceLockView(contract({ grandfatheredPricing: false }), null))).toBe("");
  });
});

describe("loadPendingPriceChange", () => {
  it("returns the batch's old → new figures for the contract's matching recurring lines", async () => {
    mocks.outcomeFindMany.mockResolvedValue([{ batchId: "b1", status: "NOTICE_SENT" }]);
    mocks.batchFindMany.mockResolvedValue([
      {
        id: "b1",
        status: "NOTICE_SENT",
        effectiveAt: EFFECTIVE,
        currencyCode: "GBP",
        items: [
          { variantId: "v1", oldPriceCents: 2500, newPriceCents: 2700 },
          { variantId: "v3", oldPriceCents: 900, newPriceCents: 950 }, // add-on: ignored
          { variantId: "v9", oldPriceCents: 1, newPriceCents: 2 }, // not on contract
        ],
      },
    ]);
    const pending = await loadPendingPriceChange(contract(), "GBP");
    expect(pending).toEqual({
      batchId: "b1",
      effectiveAt: EFFECTIVE,
      currencyCode: "GBP",
      changes: [{ variantId: "v1", title: "Serum", oldPriceCents: 2500, newPriceCents: 2700 }],
    });
    expect(mocks.batchFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ["b1"] }, status: "NOTICE_SENT" }),
      }),
    );
  });

  it("an APPLIED outcome for the batch, a foreign currency, or no matching line means nothing pending", async () => {
    mocks.outcomeFindMany.mockResolvedValue([
      { batchId: "b1", status: "NOTICE_SENT" },
      { batchId: "b1", status: "APPLIED" },
    ]);
    expect(await loadPendingPriceChange(contract(), "GBP")).toBeNull();
    expect(mocks.batchFindMany).not.toHaveBeenCalled();

    mocks.outcomeFindMany.mockResolvedValue([{ batchId: "b2", status: "NOTICE_SENT" }]);
    mocks.batchFindMany.mockResolvedValue([
      { id: "b2", status: "NOTICE_SENT", effectiveAt: EFFECTIVE, currencyCode: "EUR", items: [{ variantId: "v1", oldPriceCents: 1, newPriceCents: 2 }] },
    ]);
    expect(await loadPendingPriceChange(contract(), "GBP")).toBeNull();

    mocks.batchFindMany.mockResolvedValue([
      { id: "b2", status: "NOTICE_SENT", effectiveAt: EFFECTIVE, currencyCode: null, items: [{ variantId: "v9", oldPriceCents: 1, newPriceCents: 2 }] },
    ]);
    expect(await loadPendingPriceChange(contract(), "GBP")).toBeNull();
  });

  it("is contained: a read failure yields null (no pill, no banner)", async () => {
    mocks.outcomeFindMany.mockRejectedValue(new Error("db down"));
    expect(await loadPendingPriceChange(contract(), "GBP")).toBeNull();
  });
});

describe("route wiring (source pins)", () => {
  it("the items card header carries the pill and the saving line; the hero receives the pending notice", () => {
    const source = readSource("app/routes/proxy.subscription.$id.tsx");
    expect(source).toContain("priceLockPillHtml(locale, ctx.priceLock)");
    expect(source).toContain("priceSavingLineHtml(locale, contract.currencyCode, ctx.priceLock)");
    expect(source).toContain("loadPendingPriceChange(contract, shop.currencyCode)");
    expect(source).toContain("priceChange: ctx.priceLock.pending");
  });
});
