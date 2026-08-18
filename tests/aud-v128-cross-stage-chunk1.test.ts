import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * v1.28.0 cross-stage audit — chunk 1 fixes (honesty / cycle ownership /
 * duplicate-subscription doors). Companion suites: aud-v128-redact-pii
 * (CUSTOMERS_REDACT), portal-sms-retry (SMS SETUP gate).
 *
 *  1. Scheduled cancel vs the mirror pointer: `hasFurtherOrders` is the one
 *     comparison the sweep makes; the upcoming-order reminder drops phantom
 *     orders (nextBillingDate >= cancelScheduledAt) in JS, and the portal
 *     home card / detail hero render "no further orders — ends on {date}"
 *     instead of a next order that will never bill (source pins).
 *  2. Open dunning case owns the cycle: the detail schedule card is hidden
 *     while a case is open and the dispatcher refuses skip / delay /
 *     next_date / frequency / per-line edits with a typed toast.
 *  3. MERGED (auto-consolidated) sources are not restartable anywhere: the
 *     welcome-back landing redirects, the reactivate verb refuses, the home /
 *     detail Restart doors are closed, and reactivateFromWinback throws.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// ── Reminder harness (mirrors tests/billing-reminders-skip-dedupe.test.ts) ──

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  contractFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  notificationLogFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  getPrimaryShop: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    domain: "cellexia-test.myshopify.com",
    ianaTimezone: "Europe/London",
  })),
  getSetting: vi.fn(async (_shopId: string, key: string): Promise<unknown> => {
    if (key === "notifications") {
      return {
        channels: { email: true, sms: true },
        upcomingOrderDaysBefore: 3,
        addonSuggestionEnabled: false,
        addonSuggestionVariantId: "",
      };
    }
    if (key === "portal") return { allowAddProducts: false };
    return {};
  }),
  sendNotification: vi.fn(async (_input: unknown): Promise<unknown> => ({
    status: "SENT",
    klaviyoEnqueued: true,
    directEmailSent: false,
  })),
}));

vi.mock("~/db.server", () => ({
  default: {
    subscriptionContract: { findMany: mocks.contractFindMany },
    notificationLog: { findFirst: mocks.notificationLogFindFirst },
  },
}));
vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: mocks.getPrimaryShop,
  requireShop: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("~/lib/settings/settings.server", () => ({ getSetting: mocks.getSetting }));
vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/graphql/index.server", () => ({
  getVariants: vi.fn(async (): Promise<unknown[]> => []),
}));
vi.mock("~/lib/portal/catalog.server", () => ({
  discountedCents: (cents: number, _pct: number) => cents,
  getPortalCatalog: vi.fn(async (): Promise<unknown[]> => []),
  ongoingDiscountPctByProduct: vi.fn(async (): Promise<Map<string, number>> => new Map()),
}));
vi.mock("~/lib/billing/discounts.server", () => ({
  getActiveDiscountForCycle: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("~/lib/i18n/i18n.server", () => ({
  t: (_locale: string, key: string) => key,
  normalizeLocale: (v: string) => v,
}));
vi.mock("~/lib/notifications/send.server", () => ({
  sendNotification: mocks.sendNotification,
  hasSentForCycle: vi.fn(async (): Promise<boolean> => false),
}));

import { hasFurtherOrders } from "~/lib/cancel/further-orders";
import { runUpcomingOrderReminders } from "~/lib/billing/reminders.server";

const SEP_1 = new Date("2026-09-01T09:00:00.000Z");
const AUG_30 = new Date("2026-08-30T00:00:00.000Z");

function contractFixture(over: Row = {}): Row {
  return {
    id: "cm_c1",
    shopId: "shop_1",
    ownership: "OURS",
    status: "ACTIVE",
    isDemo: false,
    ordersCount: 2,
    nextBillingDate: SEP_1,
    cancelScheduledAt: null,
    deliveryPriceCents: 0,
    currencyCode: "EUR",
    locale: "en",
    intervalWeeks: 4,
    billingIntervalUnit: "MONTH",
    billingIntervalCount: 1,
    lines: [
      {
        productId: "gid://shopify/Product/1",
        variantId: "gid://shopify/ProductVariant/1",
        title: "Serum",
        variantTitle: "",
        quantity: 1,
        currentPriceCents: 4900,
        isGift: false,
      },
    ],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.notificationLogFindFirst.mockResolvedValue(null);
});

// ── 1. Scheduled cancel vs the next pointer ─────────────────────────────────

describe("hasFurtherOrders — the sweep's comparison applied to the pointer", () => {
  it("no schedule → further orders; pointer before the end → further orders", () => {
    expect(hasFurtherOrders({ cancelScheduledAt: null, nextBillingDate: SEP_1 })).toBe(true);
    expect(hasFurtherOrders({ cancelScheduledAt: null, nextBillingDate: null })).toBe(true);
    expect(
      hasFurtherOrders({ cancelScheduledAt: SEP_1, nextBillingDate: AUG_30 }),
    ).toBe(true);
  });

  it("pointer at or after the scheduled end → no further order (the sweep excludes cancelScheduledAt <= now)", () => {
    expect(hasFurtherOrders({ cancelScheduledAt: AUG_30, nextBillingDate: SEP_1 })).toBe(false);
    expect(hasFurtherOrders({ cancelScheduledAt: SEP_1, nextBillingDate: SEP_1 })).toBe(false);
    expect(hasFurtherOrders({ cancelScheduledAt: AUG_30, nextBillingDate: null })).toBe(false);
  });
});

describe("upcoming-order reminder never announces a phantom order", () => {
  it("Jun-1 contract, lock 90d (unlock Aug 30), monthly: pointer Sep 1 after a scheduled cancel → no reminder, no one-tap links", async () => {
    mocks.contractFindMany.mockResolvedValue([
      contractFixture({ cancelScheduledAt: AUG_30, nextBillingDate: SEP_1 }),
    ]);
    const stats = await runUpcomingOrderReminders(new Date("2026-08-29T09:00:00.000Z"));
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(stats.sent).toBe(0);
    expect(stats.scanned).toBe(0);
  });

  it("a scheduled cancel that ends AFTER the next order still gets its reminder (that order bills)", async () => {
    mocks.contractFindMany.mockResolvedValue([
      contractFixture({
        cancelScheduledAt: new Date("2026-09-15T00:00:00.000Z"),
        nextBillingDate: SEP_1,
      }),
    ]);
    const stats = await runUpcomingOrderReminders(new Date("2026-08-29T09:00:00.000Z"));
    expect(stats.sent).toBe(1);
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
  });

  it("source pin: the reminder filters candidates through hasFurtherOrders after the query", () => {
    const src = readSource("app/lib/billing/reminders.server.ts");
    expect(src).toContain('import { hasFurtherOrders } from "~/lib/cancel/further-orders"');
    expect(src).toMatch(/const contracts = candidates\.filter\(\(c\) => hasFurtherOrders\(c\)\)/);
  });
});

describe("portal home card + detail hero say 'no further orders' instead of a phantom next order", () => {
  it("home card: the no-further-orders branch precedes the next-order branch and suppresses the duplicate 'Cancels on' line", () => {
    const src = readSource("app/routes/proxy._index.tsx");
    expect(src).toContain('import { hasFurtherOrders } from "~/lib/cancel/further-orders"');
    const noFurther = src.indexOf("} else if (noFurtherOrders && contract.cancelScheduledAt) {");
    const nextOrder = src.indexOf('} else if (contract.status === "ACTIVE" && contract.nextBillingDate) {');
    expect(noFurther).toBeGreaterThan(0);
    expect(nextOrder).toBeGreaterThan(noFurther);
    expect(src).toContain('t(locale, "portal.index.no_further_orders")');
    expect(src).toContain(
      'if (contract.cancelScheduledAt && contract.status !== "CANCELLED" && !noFurtherOrders) {',
    );
  });

  it("detail page: the hero branch is preceded by the no-further-orders card and the schedule card is hidden in that state", () => {
    const src = readSource("app/routes/proxy.subscription.$id.tsx");
    expect(src).toContain('import { hasFurtherOrders } from "~/lib/cancel/further-orders"');
    const noFurther = src.indexOf("} else if (noFurtherOrders && contract.cancelScheduledAt) {");
    const hero = src.indexOf("} else if (contract.nextBillingDate) {\n    // \"Your next delivery\" hero");
    expect(noFurther).toBeGreaterThan(0);
    expect(hero).toBeGreaterThan(noFurther);
    expect(src).toContain('t(locale, "portal.detail.no_further_orders", {');
    expect(src).toContain("if (!preparing && !dunning && !noFurtherOrders) {");
  });
});

// ── 2. Open dunning case owns the cycle ─────────────────────────────────────

describe("schedule verbs are refused while a dunning case is open", () => {
  it("dispatcher: DUNNING_BLOCKED covers skip/delay/frequency/next_date/per-line edits and answers payment_issue_schedule", () => {
    const src = readSource("app/routes/proxy.api.$action.tsx");
    const block = src.slice(src.indexOf("const DUNNING_BLOCKED = new Set(["), src.indexOf('return back("payment_issue_schedule")'));
    for (const verb of ["skip", "delay", "frequency", "next_date", "line_skip", "line_unskip", "line_qty_once"]) {
      expect(block, verb).toContain(`"${verb}"`);
    }
    expect(block).toContain("state: { in: OPEN_CASE_STATES }");
    expect(src).toContain('import { OPEN_CASE_STATES } from "~/lib/dunning/states"');
  });

  it("the toast key is registered (status list + alert tone) and every locale carries it", async () => {
    const { TOAST_KEYS, TOAST_ALERT_KEYS, toastTone } = await import("~/lib/portal/layout.server");
    expect(TOAST_KEYS.has("payment_issue_schedule")).toBe(true);
    expect(TOAST_ALERT_KEYS.has("payment_issue_schedule")).toBe(true);
    expect(toastTone("payment_issue_schedule")).toBe("alert");
    const { locales } = await import("~/lib/i18n/locales");
    for (const [code, catalog] of Object.entries(locales)) {
      expect(
        (catalog as Record<string, string>)["portal.toast.payment_issue_schedule"],
        code,
      ).toBeTruthy();
    }
  });
});

// ── 3. MERGED sources are not restartable ───────────────────────────────────

describe("MERGED (auto-consolidated) sources have no restart door", () => {
  it("welcome-back landing redirects a MERGED source to the detail page", () => {
    const src = readSource("app/routes/proxy.subscription.$id.restart.tsx");
    expect(src).toContain('if (contract.cancelReason === "MERGED") throw redirect(detailPath);');
  });

  it("api reactivate refuses a MERGED source before touching Shopify", () => {
    const src = readSource("app/routes/proxy.api.$action.tsx");
    const start = src.indexOf('case "reactivate": {');
    const guard = src.indexOf('if (contract.cancelReason === "MERGED") return back("error");', start);
    const call = src.indexOf("await reactivateWithCurrentOffer(contract", start);
    expect(guard).toBeGreaterThan(start);
    expect(call).toBeGreaterThan(guard);
  });

  it("home card and detail banner hide Restart for a MERGED source (detail explains the merge)", () => {
    const home = readSource("app/routes/proxy._index.tsx");
    expect(home).toContain('if (contract.status === "CANCELLED" && contract.cancelReason !== "MERGED") {');
    const detail = readSource("app/routes/proxy.subscription.$id.tsx");
    const merged = detail.indexOf('} else if (isCancelled && contract.cancelReason === "MERGED") {');
    const cancelled = detail.indexOf("} else if (isCancelled) {");
    expect(merged).toBeGreaterThan(0);
    expect(cancelled).toBeGreaterThan(merged);
    expect(detail).toContain('t(locale, "portal.detail.status_note.merged")');
  });

  it("reactivateFromWinback throws for a MERGED source (no future caller can double-bill)", () => {
    const src = readSource("app/lib/winback/engine.server.ts");
    const fn = src.indexOf("export async function reactivateFromWinback(");
    const guard = src.indexOf('if (contract.cancelReason === "MERGED") {', fn);
    const activate = src.indexOf("findUniqueOrThrow", fn);
    expect(guard).toBeGreaterThan(fn);
    expect(activate).toBeGreaterThan(guard);
    expect(src.slice(guard, guard + 400)).toContain("cannot be reactivated");
  });
});

// ── 4. KLAVIYO_SETUP.md documents every metric and one-tap link property ────

describe("KLAVIYO_SETUP.md covers every Klaviyo metric and link property the code emits", () => {
  const doc = readSource("docs/KLAVIYO_SETUP.md");

  it("every klaviyoMetric declared by a template appears in the metric catalog", () => {
    const templates = readSource("app/lib/notifications/templates.server.ts");
    const metrics = new Set(
      [...templates.matchAll(/klaviyoMetric:\s*"(Cellexia [^"]+)"/g)].map((m) => m[1]),
    );
    expect(metrics.size).toBeGreaterThan(20);
    for (const metric of metrics) {
      expect(doc, `${metric} missing from docs/KLAVIYO_SETUP.md`).toContain(`\`${metric}\``);
    }
  });

  it("every event→metric mapping (segmentation metrics included) appears in the doc", () => {
    const map = readSource("app/lib/klaviyo/events-map.server.ts");
    const metrics = new Set(
      [...map.matchAll(/^\s*"[a-z_.0-9]+":\s*"(Cellexia [^"]+)"/gm)].map((m) => m[1]),
    );
    expect(metrics.size).toBeGreaterThan(30);
    for (const metric of metrics) {
      expect(doc, `${metric} missing from docs/KLAVIYO_SETUP.md`).toContain(`\`${metric}\``);
    }
  });

  it("every one-tap link / block property listed in the email catalog appears in §2.2 and the §5 appendix", () => {
    const catalog = readSource("app/lib/notifications/catalog.server.ts");
    const links = new Set(
      [...catalog.matchAll(/"([a-z0-9_]+_url|[a-z0-9_]+_block)"/g)].map((m) => m[1]),
    );
    expect(links.size).toBeGreaterThan(15);
    const section22 = doc.slice(doc.indexOf("### 2.2 Magic-link properties"), doc.indexOf("### 2.3 Profile properties"));
    const appendix = doc.slice(doc.indexOf("## 5. Appendix"));
    for (const link of links) {
      expect(section22, `${link} missing from §2.2`).toContain(`\`${link}\``);
      expect(appendix, `${link} missing from §5 appendix`).toContain(`\`${link}\``);
    }
    // The win-back recipe names the restart link on the soft touch.
    const recipe = doc.slice(doc.indexOf("### 3.8 Win-back series"), doc.indexOf("### 3.9"));
    expect(recipe).toContain("{{ event.restart_url }}");
    // The Payment Method Updated row no longer says only "Card updated".
    expect(doc).not.toContain("| `Cellexia Payment Method Updated` | Card updated | snapshot |");
  });
});
