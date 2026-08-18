import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * P2.7 — the run-out prompt's "Already out? Send my next order tomorrow"
 * branch (v1.28.0, portal UI):
 *
 *  - `alreadyOut` (the branch condition) is true only once the predicted-
 *    empty day has passed AND the next order is more than a day away —
 *    exclusive with the standing "runs out before next delivery" prompt;
 *  - the detail page renders the branch only when the merchant's runoutPrompt
 *    is on, the contract is ACTIVE, the order is NOT being prepared and no
 *    dunning case is open; the form posts `send_tomorrow` (an ACCELERATION —
 *    never lock-blocked; the dispatcher lists it ACTIVE-only) with the
 *    expected_next dedupe field;
 *  - the copy states the charge day honestly ("charged and prepared on
 *    {date}") and the toasts carry the exact new day(s); refusals are alerts.
 *
 * Dispatcher behaviour is pinned in tests/portal-flex-dispatcher.test.ts, the
 * service in tests/contracts-send-tomorrow.test.ts, full-page rendering in
 * tests/portal-flex-ui.test.ts.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

import { alreadyOut } from "~/lib/portal/flex.server";
import { runsOutBeforeNextDelivery } from "~/lib/portal/growth.server";
import { TOAST_ALERT_KEYS, TOAST_KEYS, resolveToast } from "~/lib/portal/layout.server";
import { addDaysTz, shopDayStartUtc } from "~/lib/dates.server";
import en from "~/lib/i18n/locales/en.json";

const enMap = en as Record<string, string>;
const TZ = "Europe/Zurich";
const DAY = 86_400_000;
const NOW = new Date("2026-08-17T10:00:00Z");

describe("alreadyOut ↔ runsOutBeforeNextDelivery", () => {
  it("is true only once the prediction passed and the next order is more than a day away", () => {
    const next = new Date(NOW.getTime() + 6 * DAY);
    expect(alreadyOut(new Date(NOW.getTime() - DAY), next, NOW, TZ)).toBe(true);
    expect(alreadyOut(NOW, next, NOW, TZ)).toBe(true);
    // Prediction still ahead ⇒ the standing prompt's territory, not this one.
    expect(alreadyOut(new Date(NOW.getTime() + DAY), next, NOW, TZ)).toBe(false);
    // Next order already tomorrow or sooner ⇒ nothing to pull.
    const tomorrow = addDaysTz(shopDayStartUtc(NOW, TZ), 1, TZ);
    expect(alreadyOut(new Date(NOW.getTime() - DAY), tomorrow, NOW, TZ)).toBe(false);
    expect(alreadyOut(new Date(NOW.getTime() - DAY), NOW, NOW, TZ)).toBe(false);
    // Unknowns ⇒ never offered.
    expect(alreadyOut(null, next, NOW, TZ)).toBe(false);
    expect(alreadyOut(new Date(NOW.getTime() - DAY), null, NOW, TZ)).toBe(false);
  });

  it("the two prompts are exclusive: a passed prediction is never 'runs out before next delivery'", () => {
    const next = new Date(NOW.getTime() + 6 * DAY);
    const passed = new Date(NOW.getTime() - DAY);
    expect(alreadyOut(passed, next, NOW, TZ)).toBe(true);
    expect(runsOutBeforeNextDelivery(passed, next, NOW)).toBe(false);
    const ahead = new Date(NOW.getTime() + 2 * DAY);
    expect(alreadyOut(ahead, next, NOW, TZ)).toBe(false);
    expect(runsOutBeforeNextDelivery(ahead, next, NOW)).toBe(true);
  });
});

describe("detail page branch (source pins)", () => {
  const src = readSource("app/routes/proxy.subscription.$id.tsx");
  const branch = src.slice(
    src.indexOf('// "Already out" branch (v1.28.0, P2.7)'),
    src.indexOf("// Days-of-supply meter (v1.28.0, P2.9)"),
  );

  it("is gated on runoutPrompt + ACTIVE + not preparing + no dunning case, and posts send_tomorrow with expected_next", () => {
    expect(branch).toMatch(/growth\.runoutPrompt &&\s*isActive &&\s*!preparing &&\s*!dunning &&\s*alreadyOut\(/);
    expect(branch).toContain('api(ctx, "send_tomorrow")');
    expect(branch).toContain('["expected_next", contract.nextBillingDate?.toISOString() ?? ""]');
    expect(branch).toContain('class="cxs-banner cxs-banner--already-out"');
    expect(branch).toContain('"portal.nudge.already_out_hint", { date: formatShopDate(tomorrow, ctx.tz, locale) }');
  });

  it("the dispatcher keeps send_tomorrow ACTIVE-only and never lock-blocked (an acceleration)", () => {
    const api = readSource("app/routes/proxy.api.$action.tsx");
    const activeOnly = api.slice(api.indexOf("const ACTIVE_ONLY = new Set(["), api.indexOf("]);", api.indexOf("const ACTIVE_ONLY = new Set([")));
    expect(activeOnly).toContain('"send_tomorrow"');
    const lockBlocked = api.slice(api.indexOf("const LOCK_BLOCKED = new Set(["), api.indexOf("]);", api.indexOf("const LOCK_BLOCKED = new Set([")));
    expect(lockBlocked).not.toContain('"send_tomorrow"');
    const preparingBlocked = api.slice(api.indexOf("const PREPARING_BLOCKED = new Set(["), api.indexOf("]);", api.indexOf("const PREPARING_BLOCKED = new Set([")));
    // The SERVICE refuses PREPARING (typed) — mapped to the same toast.
    expect(preparingBlocked).not.toContain('"send_tomorrow"');
    expect(api).toContain('case "PREPARING":');
    expect(api).toContain('return back("preparing")');
  });
});

describe("copy + toasts", () => {
  it("states the charge day honestly and never promises delivery timing or names cancellation", () => {
    expect(enMap["portal.nudge.already_out"]).toMatch(/tomorrow/i);
    expect(enMap["portal.nudge.already_out_cta"]).toBe("Send my next order tomorrow");
    expect(enMap["portal.nudge.already_out_hint"]).toContain("charged");
    expect(enMap["portal.nudge.already_out_hint"]).toContain("{date}");
    for (const key of [
      "portal.nudge.already_out",
      "portal.nudge.already_out_cta",
      "portal.nudge.already_out_hint",
      "portal.toast.send_tomorrow_done",
      "portal.toast.send_tomorrow_done_date",
      "portal.toast.send_tomorrow_done_dates",
      "portal.toast.send_tomorrow_soon",
      "portal.toast.send_tomorrow_payment",
    ]) {
      expect(enMap[key], key).toBeTruthy();
      expect(enMap[key].toLowerCase(), key).not.toMatch(/cancel/);
      // No "arrives tomorrow" / "delivered tomorrow" promise anywhere.
      expect(enMap[key].toLowerCase(), key).not.toMatch(/(arrive|deliver)\w* tomorrow/);
    }
  });

  it("send_tomorrow toasts are registered; done is date-aware and carries the Undo form; refusals are alerts", () => {
    for (const key of ["send_tomorrow_done", "send_tomorrow_soon", "send_tomorrow_payment"]) {
      expect(TOAST_KEYS.has(key)).toBe(true);
    }
    expect(TOAST_ALERT_KEYS.has("send_tomorrow_soon")).toBe(true);
    expect(TOAST_ALERT_KEYS.has("send_tomorrow_payment")).toBe(true);
    expect(TOAST_ALERT_KEYS.has("send_tomorrow_done")).toBe(false);
    const done = resolveToast(
      new Request("https://cellexialabs.com/x?toast=send_tomorrow_done&d1=2026-08-18&d2=2026-09-15"),
      "en",
    );
    expect(done?.toast.text).toContain("August 18, 2026");
    expect(done?.toast.text).toContain("September 15, 2026");
  });
});
