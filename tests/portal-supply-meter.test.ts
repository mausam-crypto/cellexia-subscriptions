import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * P2.9 — days-of-supply meter (v1.28.0, portal UI):
 *
 *  - `daysOfSupplyLeft` = whole days to the churn model's predictedEmptyDate
 *    (ceil, never below 1); null without a prediction or once it passed —
 *    the meter never states "0 days left" as a fact;
 *  - the detail page renders it only when settings.portalGrowth.supplyMeter
 *    is on and the contract is ACTIVE; named after the single recurring
 *    product ("About N day(s) of {product} left"), generic with several;
 *  - linked to the run-out prompt: when the supply ends before the next
 *    order lands (runoutDue) the meter carries a "See your options" anchor
 *    to the prompt (#cxs-runout);
 *  - copy: an estimate, said so; never names cancellation.
 *
 * Full-page rendering is pinned in tests/portal-flex-ui.test.ts.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

import { daysOfSupplyLeft } from "~/lib/portal/flex.server";
import { t } from "~/lib/i18n/i18n.server";
import en from "~/lib/i18n/locales/en.json";

const enMap = en as Record<string, string>;
const DAY = 86_400_000;
const NOW = new Date("2026-08-17T10:00:00Z");

describe("daysOfSupplyLeft", () => {
  it("counts whole days ahead (ceil), never below 1, null when unknown or passed", () => {
    expect(daysOfSupplyLeft(new Date(NOW.getTime() + 4.5 * DAY), NOW)).toBe(5);
    expect(daysOfSupplyLeft(new Date(NOW.getTime() + 4 * DAY), NOW)).toBe(4);
    expect(daysOfSupplyLeft(new Date(NOW.getTime() + 3600_000), NOW)).toBe(1);
    expect(daysOfSupplyLeft(NOW, NOW)).toBeNull();
    expect(daysOfSupplyLeft(new Date(NOW.getTime() - DAY), NOW)).toBeNull();
    expect(daysOfSupplyLeft(null, NOW)).toBeNull();
    expect(daysOfSupplyLeft(new Date("nope"), NOW)).toBeNull();
  });
});

describe("meter copy", () => {
  it("names the product, says it is an estimate, links to the run-out prompt — never cancellation", () => {
    // Two keys so every locale keeps placeholder parity: `meter_product`
    // carries {days, product}; `meter` (several products) only {days}.
    expect(t("en", "portal.supply.meter_product", { days: 5, product: "Cellexia Serum" })).toBe(
      "About 5 day(s) of Cellexia Serum left, at your usual pace",
    );
    expect(t("en", "portal.supply.meter", { days: 3 })).toBe(
      "About 3 day(s) of product left, at your usual pace",
    );
    expect(enMap["portal.supply.meter_estimate"]).toMatch(/estimate/i);
    for (const key of [
      "portal.supply.meter",
      "portal.supply.meter_product",
      "portal.supply.meter_runout_link",
      "portal.supply.meter_estimate",
    ]) {
      expect(enMap[key], key).toBeTruthy();
      expect(enMap[key].toLowerCase(), key).not.toMatch(/cancel/);
    }
  });
});

describe("detail page (source pins)", () => {
  const src = readSource("app/routes/proxy.subscription.$id.tsx");
  const block = src.slice(
    src.indexOf("// Days-of-supply meter (v1.28.0, P2.9)"),
    src.indexOf("body += itemsCardHtml(ctx"),
  );

  it("renders only for growth.supplyMeter + ACTIVE, from daysOfSupplyLeft, named after the single recurring product", () => {
    expect(block).toContain("if (growth.supplyMeter && isActive)");
    expect(block).toContain("daysOfSupplyLeft(contract.predictedEmptyDate, new Date())");
    expect(block).toContain("if (days != null)");
    expect(block).toMatch(/recurring\.length === 1 && recurring\[0\]\.title\s*\?\s*t\(locale, "portal\.supply\.meter_product", \{ days, product: recurring\[0\]\.title \}\)\s*:\s*t\(locale, "portal\.supply\.meter", \{ days \}\)/);
    expect(block).toContain('class="cxs-supply cxs-muted cxs-small"');
  });

  it("links to the run-out prompt when the supply ends before the next order (runoutDue), and the prompt carries the anchor", () => {
    expect(block).toMatch(/const link = runoutDue\s*\?/);
    expect(block).toContain('href="#cxs-runout"');
    expect(block).toContain('"portal.supply.meter_runout_link"');
    expect(src).toContain('class="cxs-banner cxs-banner--runout" id="cxs-runout"');
    // runoutDue is the existing prompt's own condition (prediction before the next order).
    expect(src).toMatch(/const runoutDue =\s*growth\.runoutPrompt &&\s*isActive &&\s*!lock\.locked &&\s*!preparing &&\s*runsOutBeforeNextDelivery\(/);
    // The meter block never posts anything itself (no form) — the prompt owns the fixes.
    expect(block).not.toContain("<form");
  });

  it("the merchant switch exists in the registry (portalGrowth.supplyMeter, default on)", () => {
    const registry = readSource("app/lib/settings/registry.server.ts");
    expect(registry).toContain("supplyMeter: z.boolean().default(true)");
  });
});
