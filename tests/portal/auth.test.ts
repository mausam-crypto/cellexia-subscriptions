/**
 * Portal unit tests — magic-link token hashing round-trip, expiry logic, and
 * the portal's pure decision/display helpers.
 *
 * db.server and shopify.server are mocked so importing the auth module never
 * touches Prisma or the Shopify runtime.
 */
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.MAGIC_LINK_SECRET = "test-secret";
});
vi.mock("~/db.server", () => ({ default: {} }));
vi.mock("~/shopify.server", () => ({
  authenticate: {},
  unauthenticated: {},
  default: {},
}));

import { generateToken, hashToken } from "~/lib/crypto.server";
import {
  MAGIC_LINK_TTL_MINUTES,
  customerIdVariants,
  isSameOriginClaim,
  isTokenUsable,
  liveMagicLinkTokenWhere,
  magicLinkUrl,
} from "~/services/portal/auth.server";
import {
  buildFontFaceCss,
  cadenceOptionsFromConfigs,
  canRemoveLine,
  chooseDeliveryDateAction,
  clampQuantity,
  describeSupplyRemaining,
  estimateSavingsCentsPerDelivery,
  lifetimeSavingsCents,
  normalizeRankedAddOns,
  parseDateInput,
  parseGuardrailsForm,
  pauseResumeDate,
  skipSupplyNote,
  sortOffersStructuralFirst,
  treatmentWeekLabel,
} from "~/components/portal/logic";
import type { SaveOffer } from "~/types/domain";

const NOW = new Date("2026-07-21T10:00:00.000Z");

// ─────────────────────────────── Token hashing ────────────────────────────

describe("magic-link token hashing", () => {
  it("keeps the 30-minute single-use policy", () => {
    expect(MAGIC_LINK_TTL_MINUTES).toBe(30);
  });

  it("round-trips deterministically: same token, same hash", () => {
    const token = generateToken();
    expect(hashToken(token)).toBe(hashToken(token));
  });

  it("produces URL-safe tokens distinct from their stored hash", () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/); // base64url — safe in a path
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
    expect(hashToken(token)).not.toBe(token);
  });

  it("different tokens hash differently", () => {
    expect(hashToken(generateToken())).not.toBe(hashToken(generateToken()));
  });

  it("builds the verification link on the portal base URL", () => {
    expect(magicLinkUrl("https://app.cellexia.com/", "abc123")).toBe(
      "https://app.cellexia.com/portal/magic/abc123",
    );
    expect(magicLinkUrl("https://app.cellexia.com", "abc123")).toBe(
      "https://app.cellexia.com/portal/magic/abc123",
    );
  });
});

// ─────────────────────────────── Token expiry ─────────────────────────────

describe("isTokenUsable", () => {
  const future = new Date(NOW.getTime() + 10 * 60_000);
  const past = new Date(NOW.getTime() - 1);

  it("accepts an unused, unexpired token", () => {
    expect(isTokenUsable({ expiresAt: future, usedAt: null }, NOW)).toBe(true);
  });

  it("rejects an expired token", () => {
    expect(isTokenUsable({ expiresAt: past, usedAt: null }, NOW)).toBe(false);
  });

  it("rejects exactly at the expiry instant (strictly before)", () => {
    expect(isTokenUsable({ expiresAt: NOW, usedAt: null }, NOW)).toBe(false);
  });

  it("rejects a used token even when unexpired", () => {
    expect(isTokenUsable({ expiresAt: future, usedAt: past }, NOW)).toBe(false);
  });
});

// ─────────────────────────────── Claim-POST origin binding ────────────────

describe("isSameOriginClaim — the magic claim POST is login-CSRF-guarded", () => {
  const APP = "https://app.cellexia.com";

  it("accepts the claim page's own confirm-button POST", () => {
    expect(isSameOriginClaim(APP, "same-origin", APP)).toBe(true);
    expect(isSameOriginClaim(APP, null, APP)).toBe(true);
  });

  it("rejects a cross-site auto-submitting form (session-fixation vector)", () => {
    // OLD BUG: any POST to /portal/magic/<token> claimed the token, so an
    // attacker page could force a victim's browser to consume an
    // attacker-minted handoff token and pin their portal session to the
    // attacker's account.
    expect(isSameOriginClaim("https://evil.example", "cross-site", APP)).toBe(
      false,
    );
    expect(isSameOriginClaim("https://evil.example", null, APP)).toBe(false);
    // Opaque origin (sandboxed iframe / data: page) serialises as "null".
    expect(isSameOriginClaim("null", null, APP)).toBe(false);
  });

  it("Origin carries the enforcement even when Sec-Fetch-Site lies", () => {
    expect(
      isSameOriginClaim("https://evil.example", "same-origin", APP),
    ).toBe(false);
  });

  it("falls back to Sec-Fetch-Site only when Origin is absent", () => {
    expect(isSameOriginClaim(null, "same-origin", APP)).toBe(true);
    expect(isSameOriginClaim(null, "none", APP)).toBe(true);
    expect(isSameOriginClaim(null, "cross-site", APP)).toBe(false);
    expect(isSameOriginClaim(null, "same-site", APP)).toBe(false);
    expect(isSameOriginClaim(null, null, APP)).toBe(false);
  });
});

// ─────────────────────────────── Cooldown lookup shape ────────────────────

describe("liveMagicLinkTokenWhere — the one-live-link cooldown predicate", () => {
  it("matches only unused tokens strictly before expiry (isTokenUsable semantics)", () => {
    const now = new Date("2026-08-02T12:00:00.000Z");
    expect(
      liveMagicLinkTokenWhere("shop.myshopify.com", ["marie@x.com"], now),
    ).toEqual({
      shop: "shop.myshopify.com",
      email: { in: ["marie@x.com"] },
      usedAt: null,
      expiresAt: { gt: now },
    });
  });

  it("carries every lookup candidate so any stored casing suppresses a re-mint", () => {
    const where = liveMagicLinkTokenWhere(
      "shop.myshopify.com",
      ["marie@x.com", "Marie@X.com"],
      NOW,
    );
    expect(where.email.in).toEqual(["marie@x.com", "Marie@X.com"]);
  });
});

describe("customerIdVariants", () => {
  it("expands a numeric id to include the GID form", () => {
    expect(customerIdVariants("123")).toEqual([
      "123",
      "gid://shopify/Customer/123",
    ]);
  });

  it("expands a GID to include the numeric tail", () => {
    expect(customerIdVariants("gid://shopify/Customer/123")).toEqual([
      "gid://shopify/Customer/123",
      "123",
    ]);
  });
});

// ─────────────────────────────── Timeline & supply ────────────────────────

describe("treatmentWeekLabel", () => {
  it("is Week 1 on day zero and day six", () => {
    const start = new Date("2026-07-21T00:00:00.000Z");
    expect(treatmentWeekLabel(start, new Date("2026-07-21T12:00:00.000Z"))).toBe(
      "Week 1 of your treatment",
    );
    expect(treatmentWeekLabel(start, new Date("2026-07-27T00:00:00.000Z"))).toBe(
      "Week 1 of your treatment",
    );
  });

  it("reaches Week 14 after 13 full weeks", () => {
    const start = new Date("2026-04-14T00:00:00.000Z");
    const now = new Date(start.getTime() + 13 * 7 * 24 * 60 * 60 * 1000);
    expect(treatmentWeekLabel(start, now)).toBe("Week 14 of your treatment");
  });

  it("is null without a start date or before it", () => {
    expect(treatmentWeekLabel(null, NOW)).toBeNull();
    expect(
      treatmentWeekLabel(new Date(NOW.getTime() + 86_400_000 * 2), NOW),
    ).toBeNull();
  });
});

describe("describeSupplyRemaining", () => {
  const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

  it("speaks in weeks when there is a week or more", () => {
    expect(describeSupplyRemaining(days(21), NOW)).toBe("about 3 weeks left");
    expect(describeSupplyRemaining(days(7), NOW)).toBe("about 1 week left");
  });

  it("speaks in days under a week", () => {
    expect(describeSupplyRemaining(days(3), NOW)).toBe("about 3 days left");
    expect(describeSupplyRemaining(days(1), NOW)).toBe("about 1 day left");
  });

  it("handles run-out and unknown", () => {
    expect(describeSupplyRemaining(days(-2), NOW)).toBe("likely running low");
    expect(describeSupplyRemaining(null, NOW)).toBeNull();
  });
});

describe("skipSupplyNote", () => {
  it("builds the reassuring skip context from the first known supply", () => {
    expect(skipSupplyNote([null, "about 2 weeks left"])).toBe(
      "You may still have about 2 weeks of product — skipping might suit you.",
    );
  });

  it("returns null when no supply estimate exists", () => {
    expect(skipSupplyNote([null, "likely running low"])).toBeNull();
    expect(skipSupplyNote([])).toBeNull();
  });
});

// ─────────────────────────────── Savings ──────────────────────────────────

describe("estimateSavingsCentsPerDelivery", () => {
  it("derives savings from the signed-up discount", () => {
    // 4900 at 20% off → one-time 6125 → saves 1225 per delivery.
    expect(
      estimateSavingsCentsPerDelivery(
        [{ quantity: 1, currentPriceCents: 4900 }],
        20,
      ),
    ).toBe(1225);
  });

  it("multiplies across quantities and lines", () => {
    expect(
      estimateSavingsCentsPerDelivery(
        [
          { quantity: 2, currentPriceCents: 4900 },
          { quantity: 1, currentPriceCents: 2450 },
        ],
        20,
      ),
    ).toBe(Math.round(12250 / 0.8) - 12250);
  });

  it("is zero without a meaningful discount", () => {
    const lines = [{ quantity: 1, currentPriceCents: 4900 }];
    expect(estimateSavingsCentsPerDelivery(lines, null)).toBe(0);
    expect(estimateSavingsCentsPerDelivery(lines, 0)).toBe(0);
    expect(estimateSavingsCentsPerDelivery(lines, 100)).toBe(0);
  });

  it("accumulates over successful orders", () => {
    expect(lifetimeSavingsCents(1225, 14)).toBe(17150);
    expect(lifetimeSavingsCents(1225, 0)).toBe(0);
  });
});

// ─────────────────────────────── Options & guards ─────────────────────────

describe("cadenceOptionsFromConfigs", () => {
  it("collects unique sorted interval weeks across configs", () => {
    const a = JSON.stringify([
      { name: "4w", intervalWeeks: 4, percentOff: 15 },
      { name: "8w", intervalWeeks: 8, percentOff: 10 },
    ]);
    const b = JSON.stringify([
      { name: "8w", intervalWeeks: 8 },
      { name: "12w", intervalWeeks: 12 },
    ]);
    expect(cadenceOptionsFromConfigs([a, b])).toEqual([4, 8, 12]);
  });

  it("ignores malformed JSON and bad values", () => {
    expect(
      cadenceOptionsFromConfigs([
        "not-json",
        JSON.stringify([{ intervalWeeks: 0 }, { intervalWeeks: "x" }, null]),
        JSON.stringify([{ intervalWeeks: 6 }]),
      ]),
    ).toEqual([6]);
  });
});

describe("guards", () => {
  it("keeps at least one product in a plan", () => {
    expect(canRemoveLine(2)).toBe(true);
    expect(canRemoveLine(1)).toBe(false);
  });

  it("clamps quantities to a sensible range", () => {
    expect(clampQuantity(0)).toBe(1);
    expect(clampQuantity(5)).toBe(5);
    expect(clampQuantity(99)).toBe(12);
    expect(clampQuantity(Number.NaN)).toBe(1);
  });

  it("chooses bring-forward for earlier dates, reschedule otherwise", () => {
    const current = new Date("2026-08-10T00:00:00.000Z");
    expect(
      chooseDeliveryDateAction(current, new Date("2026-08-01T00:00:00.000Z")),
    ).toBe("BRING_FORWARD");
    expect(
      chooseDeliveryDateAction(current, new Date("2026-08-20T00:00:00.000Z")),
    ).toBe("SET_DATE");
    expect(
      chooseDeliveryDateAction(null, new Date("2026-08-20T00:00:00.000Z")),
    ).toBe("SET_DATE");
  });

  it("parses only well-formed date inputs", () => {
    expect(parseDateInput("2026-08-28")?.toISOString()).toBe(
      "2026-08-28T00:00:00.000Z",
    );
    expect(parseDateInput("28/08/2026")).toBeNull();
    expect(parseDateInput("")).toBeNull();
    expect(parseDateInput(null)).toBeNull();
  });

  it("resolves pause options to resume dates", () => {
    expect(pauseResumeDate("30", NOW)?.getTime()).toBe(
      NOW.getTime() + 30 * 86_400_000,
    );
    expect(pauseResumeDate("custom", NOW, "2026-09-01")?.toISOString()).toBe(
      "2026-09-01T00:00:00.000Z",
    );
    expect(pauseResumeDate("custom", NOW, "2020-01-01")).toBeNull();
    expect(pauseResumeDate("45", NOW)).toBeNull();
  });
});

// ─────────────────────────────── Guardrails & offers ──────────────────────

describe("parseGuardrailsForm", () => {
  it("converts euros to cents and clamps values", () => {
    expect(
      parseGuardrailsForm({
        maxCharge: "120.50",
        askBeforeAdding: "on",
        minIntervalWeeks: "4",
        notifyDaysBefore: "5",
      }),
    ).toEqual({
      maxChargeCents: 12050,
      askBeforeAdding: true,
      minIntervalWeeks: 4,
      notifyDaysBefore: 5,
    });
  });

  it("defaults sensibly on empty input", () => {
    expect(parseGuardrailsForm({})).toEqual({
      maxChargeCents: null,
      askBeforeAdding: false,
      minIntervalWeeks: null,
      notifyDaysBefore: 3,
    });
  });
});

describe("sortOffersStructuralFirst", () => {
  it("puts zero-cost offers first, preserving order within groups", () => {
    const offers: SaveOffer[] = [
      { type: "TEMPORARY_DISCOUNT", title: "d", description: "", costCents: 500, params: {} },
      { type: "CHANGE_FREQUENCY", title: "f", description: "", costCents: 0, params: {} },
      { type: "ACCOUNT_CREDIT", title: "c", description: "", costCents: 300, params: {} },
      { type: "TEMPORARY_PAUSE", title: "p", description: "", costCents: 0, params: {} },
    ];
    expect(sortOffersStructuralFirst(offers).map((o) => o.type)).toEqual([
      "CHANGE_FREQUENCY",
      "TEMPORARY_PAUSE",
      "TEMPORARY_DISCOUNT",
      "ACCOUNT_CREDIT",
    ]);
  });
});

// ─────────────────────────────── Add-on normalisation ─────────────────────

describe("normalizeRankedAddOns", () => {
  it("accepts well-formed candidates under several field spellings", () => {
    const result = normalizeRankedAddOns([
      {
        shopifyProductId: "gid://shopify/Product/1",
        shopifyVariantId: "gid://shopify/ProductVariant/11",
        title: "Niacinamide Serum",
        priceCents: 3900,
        reason: "Pairs with your retinol",
      },
      {
        productId: "gid://shopify/Product/2",
        variantId: "gid://shopify/ProductVariant/22",
        name: "Eye Cream",
        unitPriceCents: 2900,
      },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].title).toBe("Niacinamide Serum");
    expect(result[1].priceCents).toBe(2900);
  });

  it("drops candidates missing variant, title or price — and junk input", () => {
    expect(
      normalizeRankedAddOns([
        { shopifyProductId: "gid://shopify/Product/3", title: "No variant", priceCents: 100 },
        { shopifyVariantId: "v", title: "No product", priceCents: 100 },
        null,
        42,
      ]),
    ).toEqual([]);
    expect(normalizeRankedAddOns("nope")).toEqual([]);
    expect(normalizeRankedAddOns(undefined)).toEqual([]);
  });
});

// ─────────────────────────────── Fonts ────────────────────────────────────

describe("buildFontFaceCss", () => {
  it("emits both families from the configured base URL", () => {
    const css = buildFontFaceCss("https://cdn.cellexia.com/fonts/");
    expect(css).toContain('font-family:"Gobold"');
    expect(css).toContain('font-family:"argumentum"');
    expect(css).toContain("https://cdn.cellexia.com/fonts/Gobold.woff2");
    expect(css).not.toContain("fonts//");
  });

  it("is empty (safe) without a base URL", () => {
    expect(buildFontFaceCss(null)).toBe("");
  });
});
