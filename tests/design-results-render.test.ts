// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppProvider } from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";

/**
 * Server-side render smoke test for the Buy box designer's Results tab
 * (app/components/design-results.tsx).
 *
 * The repo has no browser test harness, and this component is the one
 * merchant-facing surface v1.26.0 adds — a Polaris prop typo, a `.map` over
 * an undefined field or a formatting helper choking on a null would only
 * show up as a blank tab in the admin. Rendering it to static markup with
 * the fetcher/App Bridge hooks mocked catches every render-time throw for
 * the states the tab has: loading (no data yet), empty (zero orders: the
 * settings form, sessions editor and design calendar MUST still render so a
 * pre-launch merchant can set the start date and staff emails), empty
 * because every order was staff-excluded, and a full scoreboard with
 * matured and immature cells (kept cell prints "held of matureSubscribed"),
 * guardrail verdicts, hygiene counts, a calendar and typed-in sessions.
 *
 * v1.27.0 adds the visit-based cells (visits, conversion, subscription
 * conversion, kept subscribers per 100 visits), the "Compare against the
 * reference" card, the guardrail basis column and the data-quality visit
 * lines. Pinned here in both directions: with visits present the numbers and
 * headings render; with visits ABSENT (row.visits null, totals.visits 0,
 * totals.visitsRecorded false) every visit cell reads "no visits yet" and a
 * banner explains it, and when the store is live with buy-box orders but
 * zero visits the banner is a warning about the beacon (extension not
 * deployed / app embed disabled). A THIRD state is pinned apart from those
 * two: the shop records visits (visitsRecorded true) but none matched the
 * selected market and range (rows carry zeros): an info note, never the
 * beacon warning.
 *
 * Review-wave pins (v1.27.0): the per-100 cells are printed from the raw
 * counts on the row (ordersCounted ÷ visits) with 2 real decimals, never a
 * second decimal of a server value rounded to one; the "Compare against the
 * reference" card is computed in the browser against the SAME reference the
 * "chance it beats the reference" column uses (the Select's pick, default
 * the row with most orders) with one gating rule ("too early" while either
 * side has under 30 orders), and scoreboard.comparison is never read; and
 * "N orders counted since <day>" appears under Conversion when the visit
 * window starts after the range does.
 *
 * Effects (the fetcher load on mount) do not run in renderToStaticMarkup;
 * that is fine — the wiring is pinned by tests/design-results-route.test.ts.
 * The reference is derived synchronously (not seeded in an effect), which is
 * why the column and the card have a reference in a static render at all.
 */

const fetcherState = vi.hoisted(() => ({
  data: undefined as unknown,
  state: "idle" as string,
}));

vi.mock("@remix-run/react", () => ({
  useFetcher: () => ({
    data: fetcherState.data,
    state: fetcherState.state,
    load: vi.fn(),
    submit: vi.fn(),
  }),
}));

vi.mock("@shopify/app-bridge-react", () => ({
  useAppBridge: () => ({ toast: { show: vi.fn() } }),
}));

import {
  DesignResults,
  chanceSuffix,
  compareAgainstReference,
  conversionCell,
  fmtDeltaPts,
  fmtVisitCoverage,
  keptPer100Cell,
  ordersSinceNote,
  pickGuardrailVerdicts,
  rangeStartDay,
  rowRates,
  visitsEmptyWord,
} from "~/components/design-results";
import type {
  ConversionBlock,
  Scoreboard,
  VariantRow,
} from "~/lib/design-measurement/types";
import { probabilityBetterThan } from "~/lib/design-measurement/types";

/** Every conversion field null / zero: what the scoreboard emits when visits are null (or zero). */
const NO_CONVERSION: ConversionBlock = {
  ordersPer100Visits: null,
  subscriptionsPer100Visits: null,
  keptSubscribersPer100VisitsD30: null,
  addToCartPct: null,
  subscriptionPickPct: null,
  ordersCounted: 0,
  subscribedCounted: 0,
  keptCounted: 0,
  maturedVisits: 0,
  firstVisitDay: null,
};

/** Zero visits on a real row: the shop records visits, none carried this stamp. */
const ZERO_VISITS = { visits: 0, views: 0, engaged: 0, addedToCart: 0, addedSubscription: 0 };

function row(over: Partial<VariantRow> & { key: string; label: string }): VariantRow {
  return {
    designKey: "subscription_max",
    preselect: "sub",
    revisionId: "rev_1",
    orders: 120,
    subscribed: 30,
    oneTime: 90,
    takeRatePct: 25,
    held: {
      d30: { matureOrders: 100, matureSubscribed: 25, heldSubscribed: 22, pct: 88 },
      // Matured orders, none of them subscribed: "no subscribers yet", not "not yet".
      d60: { matureOrders: 40, matureSubscribed: 0, heldSubscribed: 0, pct: null },
      d90: { matureOrders: 0, matureSubscribed: 0, heldSubscribed: 0, pct: null },
    },
    quickCancel14: { matureSubscribed: 25, cancelled: 2, pct: 8 },
    ltgp: { m3: 3150, m6: null, m12: null, contracts: 30 },
    grade: "direction_only",
    weekly: [
      { week: "2026-W35", orders: 60, subscribed: 15, oneTime: 45, visits: 1200 },
      { week: "2026-W36", orders: 60, subscribed: 15, oneTime: 45, visits: 1200 },
    ],
    hygiene: {
      promo: 3,
      mixed: 1,
      transition: 2,
      noExposure: 0,
      foreignPlan: 0,
      staffExcluded: 1,
      calendarDisagree: 0,
    },
    aovCents: 6800,
    // v1.27.0: 2,400 visitor-days, all 120 orders on covered days → 5.00 per
    // 100; 30 subscribed → 1.25 per 100; 22 kept subscribers over 2,400
    // matured visits → 0.9167 (printed 0.92 per 100). Every server rate here
    // is exactly what the raw counts produce at 2 decimals; the visits start
    // on the range start (2026-09-01), so no "orders counted since" note.
    visits: { visits: 2400, views: 3100, engaged: 900, addedToCart: 288, addedSubscription: 90 },
    conversion: {
      ordersPer100Visits: 5,
      subscriptionsPer100Visits: 1.25,
      keptSubscribersPer100VisitsD30: 0.92,
      addToCartPct: 12,
      subscriptionPickPct: 31.3,
      ordersCounted: 120,
      subscribedCounted: 30,
      keptCounted: 22,
      maturedVisits: 2400,
      firstVisitDay: "2026-09-01",
    },
    ...over,
  };
}

function board(over: Partial<Scoreboard> = {}): Scoreboard {
  return {
    computedAt: "2026-09-08T10:00:00.000Z",
    cached: false,
    rangeDays: null,
    startedAt: "2026-09-01",
    marketHandle: null,
    groupBy: "variant",
    totals: {
      orders: 200,
      subscribed: 45,
      excludedStaff: 2,
      excludedForeignOnly: 0,
      noExposure: 5,
      unattributedSubscribed: 1,
      seenCoveragePct: 96.5,
      calendarAgreementPct: 99,
      visits: 4000,
      visitsRecorded: true,
      visitsUnscoped: 4000,
      visitCoverageDays: 0.6,
      visitDaysCovered: 18,
      visitDaysInRange: 30,
      lastVisitAt: "2026-09-08T09:58:00.000Z",
    },
    rows: [
      row({ key: "subscription_max|sub", label: "Subscription max · sub preselected" }),
      row({
        key: "toggle|one",
        label: "Toggle · one-time preselected",
        designKey: "toggle",
        preselect: "one",
        orders: 75,
        subscribed: 12,
        oneTime: 63,
        takeRatePct: 16,
        ltgp: null,
        grade: "direction_only",
        held: {
          d30: { matureOrders: 0, matureSubscribed: 0, heldSubscribed: 0, pct: null },
          d60: { matureOrders: 0, matureSubscribed: 0, heldSubscribed: 0, pct: null },
          d90: { matureOrders: 0, matureSubscribed: 0, heldSubscribed: 0, pct: null },
        },
        quickCancel14: { matureSubscribed: 0, cancelled: 0, pct: null },
        weekly: [
          { week: "2026-W35", orders: 0, subscribed: 0, oneTime: 0, visits: 0 },
          { week: "2026-W36", orders: 75, subscribed: 12, oneTime: 63, visits: 1600 },
        ],
        // Visits present but the 30-day horizon has not matured: kept per 100
        // is "not yet". 75 ÷ 1,600 = 4.6875 → "4.69 per 100"; 12 ÷ 1,600 = 0.75.
        visits: { visits: 1600, views: 1900, engaged: 500, addedToCart: 160, addedSubscription: 30 },
        conversion: {
          ordersPer100Visits: 4.69,
          subscriptionsPer100Visits: 0.75,
          keptSubscribersPer100VisitsD30: null,
          addToCartPct: 10,
          subscriptionPickPct: 18.8,
          ordersCounted: 75,
          subscribedCounted: 12,
          keptCounted: 0,
          maturedVisits: 0,
          firstVisitDay: "2026-09-01",
        },
      }),
      row({
        key: "no_exposure",
        label: "No widget exposure",
        designKey: null,
        preselect: null,
        orders: 5,
        subscribed: 3,
        oneTime: 2,
        takeRatePct: 60,
        grade: "too_early",
        ltgp: null,
        // Synthetic rows can never carry visits.
        visits: null,
        conversion: NO_CONVERSION,
      }),
    ],
    weeks: ["2026-W35", "2026-W36"],
    guardrail: {
      maxOrderDropPct: 10,
      minOrdersPerWeek: 20,
      // The scoreboard ships BOTH bases for the reference (conversion first),
      // and orders-only for the challenger (not enough visit weeks): the tab
      // must print one line per design and prefer the conversion basis.
      verdicts: [
        { key: "subscription_max|sub", status: "ok", basis: "conversion", detail: "Reference design (most orders): 5.0 orders per 100 visits per week over 2 full weeks." },
        { key: "subscription_max|sub", status: "ok", basis: "orders", detail: "Reference design (most orders): 60 orders per week over 2 full weeks." },
        { key: "toggle|one", status: "insufficient", basis: "orders", detail: "Only 1 full week with orders for this design. Guardrails need 2." },
      ],
    },
    // The server-side comparison is deliberately POISONED: it names the wrong
    // reference and carries numbers no row can produce. The tab computes the
    // card in the browser against the Select's reference and must never read
    // this field (one reference on the screen, review finding #11).
    comparison: [
      {
        key: "subscription_max|sub",
        vsKey: "toggle|one",
        deltas: {
          conversionPts: 99.9,
          subscriptionConversionPts: 99.9,
          takeRatePts: 99.9,
          kept30Pts: 99.9,
          keptPer100VisitsD30: 99.9,
        },
        chance: { conversion: 0.99, takeRate: 0.99, kept30: 0.99 },
      },
    ],
    conversion: [
      { week: "2026-W35", sessions: 4000, orders: 60, subscribed: 15, conversionPct: 1.5, subscriptionConversionPct: 0.38, dominantKey: "subscription_max|sub" },
      { week: "2026-W36", sessions: null, orders: 135, subscribed: 27, conversionPct: null, subscriptionConversionPct: null, dominantKey: "toggle|one" },
    ],
    calendar: [
      {
        revisionId: "rev_2",
        label: "Test 1: one-time preselected",
        preset: "toggle",
        preselect: "one",
        marketHandle: null,
        from: new Date("2026-09-07T00:00:00Z"),
        to: null,
      },
      {
        revisionId: "rev_1",
        label: null,
        preset: "subscription_max",
        preselect: "sub",
        marketHandle: "eu",
        from: new Date("2026-08-31T00:00:00Z"),
        to: new Date("2026-09-07T00:00:00Z"),
      },
    ],
    markets: [{ handle: "eu", name: "Europe", orders: 150 }],
    ...over,
  };
}

function render(launchMode = "LIVE"): string {
  return renderToStaticMarkup(
    createElement(
      AppProvider,
      { i18n: enTranslations },
      createElement(DesignResults, {
        markets: [{ handle: "eu", name: "Europe" }],
        launchMode,
      }),
    ),
  );
}

const SETTINGS = {
  startedAt: "2026-09-01",
  excludeEmails: ["me@cellexia.test"],
  guardrailMaxOrderDropPct: 10,
  guardrailMinOrdersPerWeek: 20,
  weeklySessions: { "2026-W35": 4000 },
};

/** A board whose shop has recorded NO visits at all (pre-v1.27.0 extension or app embed off). */
function boardWithoutVisits(): Scoreboard {
  const b = board();
  return {
    ...b,
    totals: {
      ...b.totals,
      visits: 0,
      visitsRecorded: false,
      visitsUnscoped: 0,
      visitCoverageDays: 0,
      visitDaysCovered: 0,
      visitDaysInRange: 30,
      lastVisitAt: null,
    },
    rows: b.rows.map((r) => ({
      ...r,
      visits: null,
      conversion: NO_CONVERSION,
      weekly: r.weekly.map((w) => ({ ...w, visits: 0 })),
    })),
    guardrail: {
      ...b.guardrail,
      verdicts: b.guardrail.verdicts.filter((v) => v.basis === "orders"),
    },
    comparison: [],
  };
}

/**
 * The shop records visits (visitsRecorded true) but none matched the selected
 * market and range: every real row carries ZEROS, totals.visits is 0. Neither
 * "not recorded yet" nor the beacon warning applies.
 */
function boardWithVisitsElsewhere(): Scoreboard {
  const b = board();
  return {
    ...b,
    marketHandle: "de",
    totals: {
      ...b.totals,
      visits: 0,
      visitsRecorded: true,
      visitsUnscoped: 4000,
      visitCoverageDays: 0.6,
      visitDaysCovered: 18,
      visitDaysInRange: 30,
    },
    rows: b.rows.map((r) =>
      r.visits == null
        ? r
        : {
            ...r,
            visits: ZERO_VISITS,
            conversion: NO_CONVERSION,
            weekly: r.weekly.map((w) => ({ ...w, visits: 0 })),
          },
    ),
    guardrail: {
      ...b.guardrail,
      verdicts: b.guardrail.verdicts.filter((v) => v.basis === "orders"),
    },
    comparison: [],
  };
}

/** The reference's take-rate chance as the tab must print it (client-side, same inputs). */
const TOGGLE_TAKE_RATE_CHANCE = Math.round(probabilityBetterThan(30, 120, 12, 75) * 100);
const TOGGLE_CONVERSION_CHANCE = Math.round(probabilityBetterThan(120, 2400, 75, 1600) * 100);

function setData(scoreboard: Scoreboard) {
  fetcherState.state = "idle";
  // Simulate what JSON transport does to Date fields (strings), which is
  // what the component actually receives from the fetcher.
  fetcherState.data = {
    scoreboard: JSON.parse(JSON.stringify(scoreboard)) as Scoreboard,
    settings: SETTINGS,
    markets: [{ handle: "eu", name: "Europe" }],
    currencyCode: "EUR",
    query: { range: "all", market: "", group: "variant" },
  };
}

describe("Results tab renders in every state without throwing", () => {
  it("loading state (no data yet) shows the spinner copy", () => {
    fetcherState.data = undefined;
    fetcherState.state = "loading";
    const html = render();
    expect(html).toContain("Computing take rate, kept rates and guardrails.");
    expect(html).toContain("Refresh now");
  });

  it("empty state (zero orders) explains what will be measured", () => {
    fetcherState.state = "idle";
    fetcherState.data = {
      // Pre-launch store: nothing recorded at all (not even staff orders, and
      // no visits either: a store in Setup mode sends no beacon).
      scoreboard: board({
        totals: {
          ...board().totals,
          orders: 0,
          subscribed: 0,
          excludedStaff: 0,
          excludedForeignOnly: 0,
          noExposure: 0,
          unattributedSubscribed: 0,
          visits: 0,
          visitsRecorded: false,
          visitsUnscoped: 0,
          visitCoverageDays: 0,
          visitDaysCovered: 0,
          lastVisitAt: null,
        },
        rows: [],
        comparison: [],
      }),
      settings: {
        startedAt: null,
        excludeEmails: [],
        guardrailMaxOrderDropPct: 10,
        guardrailMinOrdersPerWeek: 20,
        weeklySessions: {},
      },
      markets: [],
      currencyCode: "EUR",
      query: { range: "all", market: "", group: "variant" },
    };
    const html = render();
    expect(html).toContain("No orders to read yet");
    expect(html).toContain("Which buy box design the shopper saw");
    // The settings, the sessions editor and the design calendar must be
    // reachable BEFORE the first order (pre-launch store): the merchant sets
    // the start date and staff emails now, not after subscriber #1. An
    // earlier draft gated every card behind totals.orders > 0 while the
    // banner pointed at "Guardrails and settings below".
    expect(html).toContain("Guardrails and settings");
    expect(html).toContain("Staff and test buyer emails");
    expect(html).toContain("Measurement start date");
    expect(html).toContain("Tolerated weekly order drop");
    expect(html).toContain("Save settings");
    // v1.27.0 relabelled the typed-in sessions as a cross-check of the beacon.
    expect(html).toContain("Optional cross-check: Shopify sessions");
    expect(html).toContain("Design calendar");
    // The fixture's calendar (a publish happened, no order yet) is listed.
    expect(html).toContain("Test 1: one-time preselected");
    expect(html).toContain("How to read this");
    // The tables that need orders wait for them.
    expect(html).not.toContain("Chance it beats the reference");
    expect(html).not.toContain("Data quality");
    expect(html).toContain("Guardrail verdicts appear once");
    expect(html).toContain("The week by week table fills in once orders arrive.");
    // The banner sentence is true now: the form IS below.
    expect(html).toContain("You can already set the measurement start date");
  });

  it("empty state after every order was staff-excluded says so, and still shows the data quality card with the excluded count", () => {
    fetcherState.state = "idle";
    fetcherState.data = {
      scoreboard: board({
        totals: { ...board().totals, orders: 0, subscribed: 0, excludedStaff: 7 },
        rows: [],
      }),
      settings: {
        startedAt: null,
        excludeEmails: ["me@cellexia.test"],
        guardrailMaxOrderDropPct: 10,
        guardrailMinOrdersPerWeek: 20,
        weeklySessions: {},
      },
      markets: [],
      currencyCode: "EUR",
      query: { range: "all", market: "", group: "variant" },
    };
    const html = render();
    expect(html).toContain("Every order in this range (7) came from the staff and test emails you listed");
    expect(html).toContain("Data quality");
    expect(html).toContain("Staff and test orders (left out)");
    expect(html).toContain("me@cellexia.test");
    expect(html).toContain("Save settings");
  });

  it("full scoreboard: matured + immature cells, verdicts, hygiene, calendar, sessions", () => {
    fetcherState.state = "idle";
    // Simulate what JSON transport does to Date fields (strings), which is
    // what the component actually receives from the fetcher.
    const b = JSON.parse(JSON.stringify(board())) as Scoreboard;
    fetcherState.data = {
      scoreboard: b,
      settings: {
        startedAt: "2026-09-01",
        excludeEmails: ["me@cellexia.test"],
        guardrailMaxOrderDropPct: 10,
        guardrailMinOrdersPerWeek: 20,
        weeklySessions: { "2026-W35": 4000 },
      },
      markets: [{ handle: "eu", name: "Europe" }],
      currencyCode: "EUR",
      query: { range: "all", market: "", group: "variant" },
    };
    const html = render();
    expect(html).toContain("Subscription max · sub preselected");
    expect(html).toContain("No widget exposure");
    expect(html).toContain("not yet"); // immature kept / quick-cancel cells
    // Kept cell prints the pair behind the percentage (held of matureSubscribed)
    // plus the matured population, so 88% and its fraction agree; and a
    // matured-but-no-subscribers cell is "no subscribers yet", not "not yet".
    expect(html).toContain("88.0% (22 of 25 subscribers still active; 100 orders old enough)");
    expect(html).toContain("no subscribers yet (40 orders old enough)");
    expect(html).not.toContain("22 still active, 100 orders old enough");
    expect(html).toContain("Guardrails need 2");
    expect(html).toContain("2026-W35");
    expect(html).toContain("Test 1: one-time preselected");
    expect(html).toContain("Sessions");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("NaN");
    // Merchant-facing copy rule for the new tab: no em dashes.
    expect(html).not.toContain("—");
  });
});

// ── v1.27.0: visits, conversion, comparison, guardrail basis ────────────────

describe("Results tab with visits recorded (v1.27.0)", () => {
  it("scoreboard shows the visit columns with numbers, kept per 100 visits, and no 'no visits' banner", () => {
    setData(board());
    const html = render("LIVE");
    // Columns after Take rate and after Kept 90d.
    expect(html).toContain("Visits");
    expect(html).toContain("Conversion (orders per 100 visits)");
    expect(html).toContain("Subscription conversion (per 100 visits)");
    expect(html).toContain("Kept subscribers per 100 visits (30d)");
    // Cells: visits with the add-to-cart share, conversion, subscription conversion.
    expect(html).toContain("2,400 (12% added to cart)");
    expect(html).toContain("5.00 per 100");
    expect(html).toContain("1.25 per 100");
    // Kept per 100 visits: matured row prints the rate + the kept count, and
    // NOT "of 2,400 visits" (the denominator is the matured subset only).
    expect(html).toContain("0.92 per 100 (22 kept subscribers)");
    expect(html).not.toContain("of 2,400 visits");
    // The challenger has visits but no matured 30-day horizon: "not yet",
    // never "no visits yet".
    expect(html).toContain("4.69 per 100");
    expect(html).not.toContain("no visits yet");
    expect(html).not.toContain("Visits are not recorded yet");
    expect(html).not.toContain("No visits recorded although orders arrived");
    // Summary line carries the visit total and the overall conversion.
    expect(html).toContain("4,000 visits");
    // Synthetic row: "n/a", never a number.
    expect(html).toContain("n/a");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("—");
  });

  it("'Compare against the reference' card is computed in the browser against the Select's reference (default: most orders), never from scoreboard.comparison", () => {
    setData(board());
    const html = render("LIVE");
    expect(html).toContain("Compare against the reference");
    // The reference is the row with the most orders (the Select's default),
    // named in the helper text as the "Compare against" pick.
    expect(html).toContain("Each design against &quot;Subscription max · sub preselected&quot;, the design chosen under &quot;Compare against&quot; above");
    expect(html).not.toContain("Each design against &quot;Toggle");
    // Conversion delta from the raw counts (4.6875 - 5 = -0.3125 → 2 decimals)
    // with its chance; subscription conversion 0.75 - 1.25; take rate delta
    // (1 decimal) with its chance. The chances are probabilityBetterThan over
    // the row counts, exactly what the column prints.
    expect(html).toContain(`-0.31 pts, ${TOGGLE_CONVERSION_CHANCE}% chance better`);
    expect(html).toContain("-0.50 pts");
    expect(html).toContain(`-9.0 pts, ${TOGGLE_TAKE_RATE_CHANCE}% chance better`);
    // Kept 30d not matured on the challenger: "not yet", no chance suffix.
    expect(html).toContain("not yet");
    expect(html).not.toContain("not yet, ");
    // The poisoned server comparison (wrong reference, +99.9 everywhere) must
    // leave no trace: the fix computes the card client-side.
    expect(html).not.toContain("99.9");
    expect(html).not.toContain("99% chance better");
    // The reference row itself is not listed as a comparison line: the only
    // comparison line is the toggle design, so no "+0.0 pts" appears.
    expect(html).not.toContain("+0.0 pts");
  });

  it("the 'chance it beats the reference' column and the card agree: same reference, same number, same gate", () => {
    setData(board());
    let html = render("LIVE");
    // Column: reference row reads "reference"; the toggle row prints the same
    // take-rate chance the card prints with "chance better".
    expect(html).toContain(">reference<");
    expect(html).toContain(`>${TOGGLE_TAKE_RATE_CHANCE}%<`);
    expect(html).toContain(`${TOGGLE_TAKE_RATE_CHANCE}% chance better`);

    // Same board, but the challenger is "too early" (under 30 orders): ONE
    // gate closes both the column ("too early") and every chance in the card
    // ("too early to say"); the deltas still print. Without the shared rule
    // the card kept printing chances for a 20-order design.
    const b = board();
    b.rows[1] = { ...b.rows[1], orders: 20, subscribed: 3, oneTime: 17, takeRatePct: 15, grade: "too_early" };
    setData(b);
    html = render("LIVE");
    expect(html).toContain(">too early<");
    expect(html).toContain("-10.0 pts, too early to say");
    expect(html).not.toContain("% chance better");
  });

  it("guardrails call their fixed baseline 'the design with the most orders (the guardrail baseline)', not 'the reference'", () => {
    setData(board());
    const html = render("LIVE");
    expect(html).toContain("the design with the most orders (the guardrail baseline");
    expect(html).toContain("How far below the guardrail baseline (the design with the most orders)");
    expect(html).not.toContain("compared with the reference (the design with the most orders)");
  });

  it("per-100 cells print two REAL decimals from the raw counts, never a second decimal of a one-decimal server value", () => {
    // A payload whose server rate is rounded to one decimal (30 ÷ 2,400 =
    // 1.25 shipped as 1.3) must still print 1.25: the tab divides the counts
    // itself. Without the fix the cell read "1.30 per 100".
    const b = board();
    b.rows[0] = {
      ...b.rows[0],
      conversion: { ...b.rows[0].conversion, subscriptionsPer100Visits: 1.3, ordersPer100Visits: 5 },
    };
    setData(b);
    const html = render("LIVE");
    expect(html).toContain("1.25 per 100");
    expect(html).not.toContain("1.30 per 100");
    // Weekly table: 75 ÷ 1,600 client-side with 2 decimals.
    expect(html).toContain("1,600 (4.69 per 100)");
    // The overall line uses the same numerators: (120 + 75) ÷ (2,400 + 1,600) = 4.875.
    expect(html).toContain("4.88 orders per 100 visits overall");
  });

  it("'N orders counted since <day>' appears under Conversion (and in the card) when the visit window starts after the range start", () => {
    // Range starts 2026-09-01 (startedAt, "since measurement start"); the
    // beacon went live on 2026-09-05, so the reference's conversion counts
    // only the 40 orders since then: 40 ÷ 2,400 = 1.67 per 100, and the row
    // says so. The challenger's window starts on the range start: no note.
    const b = board();
    b.rows[0] = {
      ...b.rows[0],
      conversion: {
        ...b.rows[0].conversion,
        ordersPer100Visits: 1.67,
        subscriptionsPer100Visits: 0.42,
        ordersCounted: 40,
        subscribedCounted: 10,
        firstVisitDay: "2026-09-05",
      },
    };
    setData(b);
    const html = render("LIVE");
    expect(html).toContain("1.67 per 100");
    expect(html).toContain("40 orders counted since 05 Sep 2026");
    expect(html).not.toContain("75 orders counted since"); // the challenger's window starts with the range
    expect(html).toContain("Conversion differences use each design&#x27;s orders from its first day with visits");
    expect(html).toContain("&quot;Orders counted since&quot; under Conversion");
  });

  it("guardrails: one line per design, conversion basis preferred, Basis column + explanatory line say which rule judged", () => {
    setData(board());
    const html = render("LIVE");
    expect(html).toContain("Basis");
    // The reference has both verdicts; the conversion one wins and the orders detail is not printed.
    expect(html).toContain("5.0 orders per 100 visits per week over 2 full weeks");
    expect(html).not.toContain("60 orders per week over 2 full weeks");
    expect(html).toContain("Conversion (orders per 100 visits)");
    // The challenger only has an orders verdict: shown with the "Weekly orders" basis.
    expect(html).toContain("Weekly orders");
    expect(html).toContain("Guardrails need 2");
    // The explanatory line names the basis rule.
    expect(html).toContain("the verdict compares weekly conversion (orders per 100 visits)");
  });

  it("weekly table gains visits + conversion per design and the sessions section is relabelled as an optional cross-check", () => {
    setData(board());
    const html = render("LIVE");
    expect(html).toContain("visits (orders per 100 visits)");
    // W35: 60 orders over 1,200 visits = 5.00 per 100.
    expect(html).toContain("1,200 (5.00 per 100)");
    // Toggle had 0 visits in W35 → "0 visits", not a division by zero.
    expect(html).toContain("0 visits");
    expect(html).toContain("Optional cross-check: Shopify sessions");
    expect(html).toContain("Sessions (typed in)");
    expect(html).not.toContain("Product page sessions (optional)");
  });

  it("data quality shows visits recorded, days covered (N of M) and the last visit time; no beacon warning", () => {
    setData(board());
    const html = render("LIVE");
    expect(html).toContain("Visits recorded");
    expect(html).toContain("4,000");
    expect(html).toContain("Days with visits");
    expect(html).toContain("60% of days (18 of 30)");
    expect(html).toContain("Last visit");
    expect(html).not.toContain("none yet");
    expect(html).not.toContain("Visit beacon: nothing received");
  });

  it("guide text explains visits, conversion and why kept subscribers per 100 visits is the number to compare on", () => {
    // The guide lives inside a closed Collapsible, which static markup does
    // not render, so the copy is pinned at the source (same as the em dash
    // rule in tests/design-results-route.test.ts).
    const source = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app/components/design-results.tsx"),
      "utf8",
    );
    expect(source).toContain("<strong>Visits:</strong> a visitor who saw the buy box, counted once per day per design and preselected option");
    expect(source).toContain("<strong>Conversion:</strong> orders per 100 visits of the same design.");
    expect(source).toContain("<strong>Subscription conversion:</strong> subscription orders per 100 visits.");
    expect(source).toContain("Why kept subscribers per 100 visits is the number to compare designs on");
    // The metric ladder now starts with conversion and ends with kept per 100 visits before LTGP.
    expect(source).toContain("first conversion and orders per week must hold (guardrail), then take rate, then kept 30/60/90, then kept subscribers per 100 visits, then LTGP");
  });
});

describe("Results tab WITHOUT visits (beacon not deployed / app embed disabled)", () => {
  it("visits null → every visit cell reads 'no visits yet' and the info banner explains when tracking starts (store not live)", () => {
    setData(boardWithoutVisits());
    const html = render("SETUP");
    expect(html).toContain("no visits yet");
    expect(html).toContain("Visits are not recorded yet");
    expect(html).toContain("v1.27.0 extension is deployed with the app embed enabled");
    // Not the beacon warning: the store is not live, so zero visits is expected.
    expect(html).not.toContain("No visits recorded although orders arrived");
    expect(html).not.toContain("Visit beacon: nothing received");
    // No conversion number leaks through and nothing prints as NaN.
    expect(html).not.toContain(" per 100 (");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("undefined");
    // Take rate and kept cells are untouched by the missing beacon.
    expect(html).toContain("88.0% (22 of 25 subscribers still active; 100 orders old enough)");
    // The comparison card still renders the order-based deltas; the visit
    // deltas read "no visits yet".
    expect(html).toContain("Compare against the reference");
    expect(html).toContain(`-9.0 pts, ${TOGGLE_TAKE_RATE_CHANCE}% chance better`);
    // Guardrails: orders basis only, and the explanatory line says verdicts
    // switch to conversion once visits are recorded.
    expect(html).toContain("Weekly orders");
    expect(html).toContain("Basis: raw weekly orders.");
    // Weekly table has no visit columns; the sessions cross-check is offered.
    expect(html).not.toContain("visits (orders per 100 visits)");
    expect(html).toContain("Optional cross-check: Shopify sessions");
    // Data quality visit lines: zero, none yet.
    expect(html).toContain("Visits recorded");
    expect(html).toContain("none yet");
    expect(html).not.toContain("—");
  });

  it("LIVE store with buy-box orders and zero visits → the banner becomes a beacon WARNING, and data quality repeats it", () => {
    setData(boardWithoutVisits());
    const html = render("LIVE");
    expect(html).toContain("No visits recorded although orders arrived");
    expect(html).toContain("app embed enabled in your theme");
    expect(html).toContain("Visit beacon: nothing received");
    // 200 orders minus 5 without exposure.
    expect(html).toContain("195 orders that saw the buy box arrived");
    expect(html).toContain("widget_visits");
    expect(html).not.toContain("Visits are not recorded yet");
    expect(html).toContain("no visits yet");
    expect(html).not.toContain("No visits in this selection");
  });

  it("shop records visits but none matched this market (visitsRecorded true, rows zeros) → info note, cells 'no visits', NO beacon warning even when LIVE with orders", () => {
    setData(boardWithVisitsElsewhere());
    const html = render("LIVE");
    expect(html).toContain("No visits in this selection");
    expect(html).toContain("none were recorded for the market and range selected above");
    expect(html).toContain("none matched the selected market and range");
    // Not the beacon states: the beacon works, the market just has no visit.
    expect(html).not.toContain("No visits recorded although orders arrived");
    expect(html).not.toContain("Visit beacon: nothing received");
    expect(html).not.toContain("Visits are not recorded yet");
    expect(html).not.toContain("no visits yet");
    // Cells: zero visits, "no visits" for the per-100 rates, no NaN.
    expect(html).toContain(">no visits<");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("—");
  });

  it("visitsRecorded true overrides the older heuristic: rows without a visit block (revision view) read 'not available for this view', not the beacon warning", () => {
    // Before the presence flag, the tab decided "recorded" from the rows
    // themselves; a revision view with visits null on every row and a
    // market-scoped total of 0 then raised the beacon warning on a store
    // whose beacon works.
    const b = boardWithVisitsElsewhere();
    setData({
      ...b,
      groupBy: "revision",
      rows: b.rows.map((r) => ({ ...r, visits: null, conversion: NO_CONVERSION })),
    });
    const html = render("LIVE");
    expect(html).toContain("not available for this view");
    expect(html).not.toContain("No visits recorded although orders arrived");
    expect(html).not.toContain("Visit beacon: nothing received");
    expect(html).not.toContain("Visits are not recorded yet");
    expect(html).not.toContain("no visits yet");
  });

  it("empty state (no orders) mentions visits in the checklist and, when visits are already flowing, says so", () => {
    const b = boardWithoutVisits();
    setData({
      ...b,
      totals: { ...b.totals, orders: 0, subscribed: 0, excludedStaff: 0, noExposure: 0, unattributedSubscribed: 0 },
      rows: [],
      comparison: [],
    });
    let html = render("LIVE");
    expect(html).toContain("No orders to read yet");
    expect(html).toContain("How many visitors saw each design");
    expect(html).not.toContain("Visits are already being recorded");
    // Zero orders AND zero visits on a live store is not a beacon warning
    // (nothing arrived at all yet), and the data quality card stays hidden.
    expect(html).not.toContain("Visit beacon: nothing received");
    expect(html).not.toContain("Data quality");

    setData({
      ...b,
      totals: { ...b.totals, orders: 0, subscribed: 0, excludedStaff: 0, noExposure: 0, unattributedSubscribed: 0, visits: 350 },
      rows: [],
      comparison: [],
    });
    html = render("LIVE");
    expect(html).toContain("Visits are already being recorded: 350 so far in this range.");
    // Visits alone open the data quality card so the merchant can see the beacon is alive.
    expect(html).toContain("Data quality");
    expect(html).toContain("Visits recorded");
  });
});

// ── Pure helpers (exported for pinning) ─────────────────────────────────────

describe("visit helpers", () => {
  it("visitsEmptyWord: synthetic rows n/a, no visits anywhere → 'no visits yet', visits elsewhere → 'not available for this view'", () => {
    expect(visitsEmptyWord("no_exposure", true)).toBe("n/a");
    expect(visitsEmptyWord("unknown", false)).toBe("n/a");
    expect(visitsEmptyWord("subscription_max|sub", false)).toBe("no visits yet");
    expect(visitsEmptyWord("rev_9", true)).toBe("not available for this view");
  });

  it("keptPer100Cell: null visits → empty word; zero visits → 'no visits'; immature → 'not yet'; matured → rate + kept count only", () => {
    const base = row({ key: "k", label: "K" });
    expect(keptPer100Cell({ ...base, visits: null, conversion: NO_CONVERSION }, false)).toBe("no visits yet");
    expect(
      keptPer100Cell(
        { ...base, visits: { visits: 0, views: 0, engaged: 0, addedToCart: 0, addedSubscription: 0 }, conversion: NO_CONVERSION },
        true,
      ),
    ).toBe("no visits");
    // Immature: no matured visit day yet (maturedVisits 0), so the rate is null.
    expect(
      keptPer100Cell(
        {
          ...base,
          conversion: { ...base.conversion, keptSubscribersPer100VisitsD30: null, keptCounted: 0, maturedVisits: 0 },
        },
        true,
      ),
    ).toBe("not yet");
    expect(keptPer100Cell(base, true)).toBe("0.92 per 100 (22 kept subscribers)");
    // The kept count printed is the one that went into the rate (keptCounted,
    // day-matured), not held.d30.heldSubscribed (instant-matured).
    expect(
      keptPer100Cell(
        { ...base, conversion: { ...base.conversion, keptCounted: 20, keptSubscribersPer100VisitsD30: 0.83 } },
        true,
      ),
    ).toBe("0.83 per 100 (20 kept subscribers)");
  });

  it("rowRates: per-100 rates come from the raw counts (unrounded), the server rate is only a fallback when a count is missing", () => {
    const base = row({ key: "k", label: "K" });
    const r = rowRates(base);
    expect(r.visits).toBe(2400);
    expect(r.ordersCounted).toBe(120);
    expect(r.ordersPer100).toBeCloseTo(5, 10);
    expect(r.subscriptionsPer100).toBeCloseTo(1.25, 10);
    expect(r.keptPer100).toBeCloseTo(22 / 24, 10);
    expect(r.addToCartPct).toBeCloseTo(12, 10);
    // A one-decimal server rate is ignored while the counts are present.
    expect(rowRates({ ...base, conversion: { ...base.conversion, subscriptionsPer100Visits: 1.3 } }).subscriptionsPer100).toBeCloseTo(1.25, 10);
    expect(conversionCell({ ...base, conversion: { ...base.conversion, ordersPer100Visits: 4.9, ordersCounted: 117 } }, true)).toBe("4.88 per 100");
    // Older payload without the counts: the server rate is used, and the
    // plain row counts feed the chance maths.
    const legacy = {
      ...base,
      conversion: {
        ordersPer100Visits: 4.9,
        subscriptionsPer100Visits: 1.3,
        keptSubscribersPer100VisitsD30: 0.9,
        addToCartPct: 12,
        subscriptionPickPct: 31.3,
      } as ConversionBlock,
    };
    const l = rowRates(legacy);
    expect(l.ordersPer100).toBe(4.9);
    expect(l.keptPer100).toBe(0.9);
    expect(l.ordersCounted).toBe(120);
    expect(l.keptCounted).toBe(22);
    // No visits on the row: every rate null, visits null.
    const none = rowRates({ ...base, visits: null, conversion: NO_CONVERSION });
    expect(none.visits).toBeNull();
    expect(none.ordersPer100).toBeNull();
    // Zero visits: null rates, not Infinity.
    const zero = rowRates({ ...base, visits: ZERO_VISITS, conversion: NO_CONVERSION });
    expect(zero.ordersPer100).toBeNull();
    expect(zero.addToCartPct).toBeNull();
  });

  it("compareAgainstReference: deltas row minus reference from unrounded rates, chances over the raw counts, one 'too early' gate for every chance", () => {
    const ref = row({ key: "a", label: "A" });
    const other = row({
      key: "b",
      label: "B",
      orders: 75,
      subscribed: 12,
      oneTime: 63,
      takeRatePct: 16,
      held: {
        d30: { matureOrders: 50, matureSubscribed: 10, heldSubscribed: 6, pct: 60 },
        d60: { matureOrders: 0, matureSubscribed: 0, heldSubscribed: 0, pct: null },
        d90: { matureOrders: 0, matureSubscribed: 0, heldSubscribed: 0, pct: null },
      },
      visits: { visits: 1600, views: 1900, engaged: 500, addedToCart: 160, addedSubscription: 30 },
      conversion: {
        ...NO_CONVERSION,
        ordersPer100Visits: 4.69,
        subscriptionsPer100Visits: 0.75,
        keptSubscribersPer100VisitsD30: 0.5,
        ordersCounted: 75,
        subscribedCounted: 12,
        keptCounted: 6,
        maturedVisits: 1200,
        firstVisitDay: "2026-09-01",
      },
    });
    const cmp = compareAgainstReference(other, ref);
    expect(cmp.gate).toBe("ok");
    expect(cmp.deltas.conversionPts).toBeCloseTo(4.6875 - 5, 10);
    expect(cmp.deltas.subscriptionConversionPts).toBeCloseTo(0.75 - 1.25, 10);
    expect(cmp.deltas.takeRatePts).toBe(16 - 25);
    expect(cmp.deltas.kept30Pts).toBe(60 - 88);
    expect(cmp.deltas.keptPer100VisitsD30).toBeCloseTo(0.5 - 22 / 24, 10);
    expect(cmp.chance.conversion).toBeCloseTo(probabilityBetterThan(120, 2400, 75, 1600), 12);
    expect(cmp.chance.takeRate).toBeCloseTo(probabilityBetterThan(30, 120, 12, 75), 12);
    expect(cmp.chance.kept30).toBeCloseTo(probabilityBetterThan(22, 25, 6, 10), 12);
    // Mirror image: B against A and A against B add up to 1 and negate the deltas.
    const mirror = compareAgainstReference(ref, other);
    expect((mirror.chance.takeRate ?? 0) + (cmp.chance.takeRate ?? 0)).toBeCloseTo(1, 10);
    expect(mirror.deltas.takeRatePts).toBe(-(cmp.deltas.takeRatePts ?? 0));
    // Time-aligned numerator: the conversion chance uses ordersCounted, not row.orders.
    const aligned = compareAgainstReference(
      { ...other, conversion: { ...other.conversion, ordersCounted: 40, firstVisitDay: "2026-09-05" } },
      ref,
    );
    expect(aligned.chance.conversion).toBeCloseTo(probabilityBetterThan(120, 2400, 40, 1600), 12);
    expect(aligned.deltas.conversionPts).toBeCloseTo(2.5 - 5, 10);
    // Gate: either side too early → no chance at all, deltas still there.
    const early = compareAgainstReference({ ...other, orders: 20, grade: "too_early" }, ref);
    expect(early.gate).toBe("too_early");
    expect(early.chance).toEqual({ conversion: null, takeRate: null, kept30: null });
    expect(early.deltas.takeRatePts).toBe(16 - 25);
    expect(compareAgainstReference(other, { ...ref, grade: "too_early" }).gate).toBe("too_early");
    // Missing denominators below the gate: null chance, not 0.5.
    const noVisits = compareAgainstReference({ ...other, visits: null, conversion: NO_CONVERSION }, ref);
    expect(noVisits.chance.conversion).toBeNull();
    expect(noVisits.deltas.conversionPts).toBeNull();
    expect(noVisits.chance.takeRate).not.toBeNull();
    // chanceSuffix words.
    expect(chanceSuffix("ok", 0.724)).toBe(", 72% chance better");
    expect(chanceSuffix("ok", null)).toBe("");
    expect(chanceSuffix("too_early", 0.9)).toBe(", too early to say");
  });

  it("rangeStartDay + ordersSinceNote: the note appears only when the first visit day is later than the range start", () => {
    expect(rangeStartDay({ rangeDays: null, computedAt: "2026-09-08T10:00:00.000Z", startedAt: "2026-09-01" })).toBe("2026-09-01");
    expect(rangeStartDay({ rangeDays: null, computedAt: "2026-09-08T10:00:00.000Z", startedAt: null })).toBeNull();
    expect(rangeStartDay({ rangeDays: 30, computedAt: "2026-09-08T10:00:00.000Z", startedAt: "2026-01-01" })).toBe("2026-08-09");
    expect(rangeStartDay({ rangeDays: 30, computedAt: "not a date", startedAt: null })).toBeNull();
    expect(ordersSinceNote("2026-09-05", "2026-09-01", 40)).toBe("40 orders counted since 05 Sep 2026");
    expect(ordersSinceNote("2026-09-05", "2026-09-01")).toBe("orders counted since 05 Sep 2026");
    // Visits from the range start (or earlier): no note.
    expect(ordersSinceNote("2026-09-01", "2026-09-01", 120)).toBeNull();
    expect(ordersSinceNote("2026-08-20", "2026-09-01", 120)).toBeNull();
    // All-time range with no start date: any first visit day is later than "the beginning".
    expect(ordersSinceNote("2026-09-05", null, 7)).toBe("7 orders counted since 05 Sep 2026");
    expect(ordersSinceNote(null, "2026-09-01", 7)).toBeNull();
  });

  it("fmtDeltaPts: signed, fixed decimals, null → not yet, zero without a plus sign", () => {
    expect(fmtDeltaPts(2.14, 1)).toBe("+2.1 pts");
    expect(fmtDeltaPts(-0.306, 2)).toBe("-0.31 pts");
    expect(fmtDeltaPts(0, 1)).toBe("0.0 pts");
    // Rounds to zero: no sign either way (a "-0.0" would read as a real drop).
    expect(fmtDeltaPts(-0.04, 1)).toBe("0.0 pts");
    expect(fmtDeltaPts(0.04, 1)).toBe("0.0 pts");
    expect(fmtDeltaPts(null)).toBe("not yet");
    expect(fmtDeltaPts(Number.NaN)).toBe("not yet");
  });

  it("pickGuardrailVerdicts: one per key, conversion beats orders regardless of order, missing basis counts as orders", () => {
    const picked = pickGuardrailVerdicts([
      { key: "a", status: "ok", basis: "orders", detail: "a orders" },
      { key: "a", status: "watch", basis: "conversion", detail: "a conversion" },
      { key: "b", status: "breach", basis: "conversion", detail: "b conversion" },
      { key: "b", status: "ok", basis: "orders", detail: "b orders" },
      // Older scoreboard payload without a basis field.
      { key: "c", status: "insufficient", detail: "c legacy" } as never,
    ]);
    expect(picked.map((v) => `${v.key}:${v.detail}`)).toEqual([
      "a:a conversion",
      "b:b conversion",
      "c:c legacy",
    ]);
  });

  it("fmtVisitCoverage: fraction → percent of days with the counts when given; day count when above 1; n/a when missing", () => {
    expect(fmtVisitCoverage(0.6, 18, 30)).toBe("60% of days (18 of 30)");
    expect(fmtVisitCoverage(0.6)).toBe("60% of days");
    expect(fmtVisitCoverage(1, 30, 30)).toBe("100% of days (30 of 30)");
    expect(fmtVisitCoverage(0)).toBe("0% of days");
    expect(fmtVisitCoverage(18)).toBe("18 days");
    expect(fmtVisitCoverage(null)).toBe("n/a");
  });
});
