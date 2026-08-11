import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { beforeAll, describe, expect, it } from "vitest";

import {
  CustomEventShim,
  DocumentNode,
  ElementNode,
  EventShim,
  MutationObserverShim,
  TextNode,
  cancelTimer,
  flushTimers,
  parseHtml,
  resetDomState,
  scheduleTimer,
} from "./helpers/hostile-dom";
import { FIXTURE, renderWidget } from "./liquid/harness";

/**
 * PER-VARIANT DEFAULT FREQUENCY (v1.14.0) — the JS half, against the REAL
 * Liquid render and the REAL buy-box.js (same rig as the variant-tracking
 * suite: no jsdom, the hostile-DOM shims, the theme switching variants
 * programmatically with no events).
 *
 * The island's per-variant `defaultPlan` (resolved by the Liquid from the
 * cellexia.variant_defaults metafield) must be ADOPTED when the shopper
 * lands on or switches to that variant — 1 jar every 8 weeks, 2 jars every
 * 4 weeks — through every switching mechanism the widget knows (the poll is
 * the one exercised here; all mechanisms funnel into onVariantMaybeChanged).
 *
 * The one rule that outranks the default: an EXPLICIT cadence choice. Once
 * the shopper picks a frequency themselves, pack-size clicks stop moving it
 * — a widget that re-decides an answered question fights the customer.
 *
 * The MUTATION CHECK at the end cuts the adoption call and proves the
 * switch test fails without it: load-bearing, not decorative.
 */

const BUY_BOX_JS = join(
  fileURLToPath(new URL("../extensions/cellexia-buy-box/assets/", import.meta.url)),
  "buy-box.js",
);

const JAR1 = String(FIXTURE.jarVariantIds.jar1);
const JAR2 = String(FIXTURE.jarVariantIds.jar2);
const JAR3 = String(FIXTURE.jarVariantIds.jar3);
const WEEKS4 = String(FIXTURE.planIds.weeks4);
const WEEKS6 = String(FIXTURE.planIds.weeks6);
const WEEKS8 = String(FIXTURE.planIds.weeks8);

/**
 * The published shape: a group default (8 weeks — the revert target every
 * un-overridden variant folds to) plus jar 2's explicit 4-week override.
 * jar 1 and jar 3 therefore carry defaultPlan = weeks 8 via the fold.
 */
const DEFAULTS_METAFIELD = {
  v: 1,
  default: { unit: "WEEK", count: 8 },
  byVariant: {
    [JAR2]: { unit: "WEEK", count: 4 },
  },
};

/** byVariant only, NO group default — the degrade shape (nothing to revert to). */
const NO_REVERT_METAFIELD = {
  v: 1,
  byVariant: {
    [JAR2]: { unit: "WEEK", count: 4 },
  },
};

let MARKUP = "";
let NO_REVERT_MARKUP = "";

beforeAll(async () => {
  MARKUP = await renderWidget({
    jarVariants: true,
    variantDefaults: DEFAULTS_METAFIELD,
  });
  NO_REVERT_MARKUP = await renderWidget({
    jarVariants: true,
    variantDefaults: NO_REVERT_METAFIELD,
  });
});

interface Page {
  document: DocumentNode & { visibilityState?: string };
  widget: ElementNode;
  idInput: ElementNode;
  atcText: TextNode;
  freqSelect: ElementNode;
  pollTick: () => void;
  flush: () => void;
  text: (selector: string) => string;
  state: () => Record<string, unknown> | null;
  sourceChanged: boolean;
}

/** Dawn-shaped page (real /cart/add form) around the real widget markup. */
function buildPage(
  markup: string,
  options: {
    mainFieldValue?: string;
    mutate?: (source: string) => string;
  } = {},
): Page {
  resetDomState();

  const documentNode = new DocumentNode() as Page["document"];
  const html = new ElementNode("html");
  documentNode.appendChild(html);
  const body = new ElementNode("body");
  html.appendChild(body);
  documentNode.body = body;
  documentNode.documentElement = html;
  documentNode.visibilityState = "visible";

  const mainValue = options.mainFieldValue ?? JAR1;
  parseHtml(
    '<main><div class="shopify-section"><div class="pdp__info">' +
      '<form action="/cart/add" method="post">' +
      `<input type="hidden" name="id" value="${mainValue}">` +
      '<button type="submit">Add to cart</button>' +
      "</form>" +
      '<div class="pdp__grey"><div class="pdp__actions"><div class="action--atc">' +
      '<button class="btn btn--primary btn--atc">ADD TO CART - CHF 64.00</button>' +
      "</div></div></div>" +
      "</div></div></main>",
    body,
  );
  const buyColumn = documentNode.querySelector(".pdp__info") as ElementNode;
  parseHtml(markup, buyColumn);

  const intervals: Array<{ id: number; fn: () => void; live: boolean }> = [];
  let intervalSeq = 0;
  const noop = (): void => {};
  const windowStub: Record<string, unknown> = {
    location: {
      origin: "https://cellexialabs.com",
      href: "https://cellexialabs.com/products/sleep-jars",
      search: "",
    },
    history: {},
    document: documentNode,
    setTimeout: scheduleTimer,
    clearTimeout: cancelTimer,
    setInterval: (fn: () => void, delay?: number) => {
      intervalSeq += 1;
      void delay;
      intervals.push({ id: intervalSeq, fn, live: true });
      return intervalSeq;
    },
    clearInterval: (id: number) => {
      for (const entry of intervals) if (entry.id === id) entry.live = false;
    },
    MutationObserver: MutationObserverShim,
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: () => true,
    URLSearchParams,
    FormData,
    URL,
    Event: EventShim,
    CustomEvent: CustomEventShim,
  };
  windowStub.window = windowStub;

  const sandbox: Record<string, unknown> = {
    window: windowStub,
    document: documentNode,
    console: { warn: noop, error: noop, log: noop },
    Event: EventShim,
    CustomEvent: CustomEventShim,
    URLSearchParams,
    FormData,
    URL,
    Promise,
    Object,
    Array,
    String,
    Number,
    Boolean,
    JSON,
    RegExp,
    Date,
    Math,
    Error,
    TypeError,
    isFinite,
    parseInt,
    parseFloat,
  };
  const original = readFileSync(BUY_BOX_JS, "utf8");
  const source = options.mutate ? options.mutate(original) : original;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "buy-box.js" });
  flushTimers();

  const widget = documentNode.querySelector(
    ".cx-buybox[data-cellexia-buybox]",
  ) as ElementNode;
  const atcButton = documentNode.querySelector(
    ".action--atc .btn--atc",
  ) as ElementNode;
  const subs = windowStub.CellexiaSubs as {
    widgets: Array<{ getState: () => Record<string, unknown> | null }>;
  };

  return {
    document: documentNode,
    widget,
    idInput: documentNode.querySelector(
      '.pdp__info input[name="id"]',
    ) as ElementNode,
    atcText: atcButton.childNodes[0] as TextNode,
    freqSelect: widget.querySelector("[data-cellexia-freq]") as ElementNode,
    sourceChanged: source !== original,
    pollTick: () => {
      for (const entry of intervals.slice()) if (entry.live) entry.fn();
      flushTimers();
    },
    flush: () => flushTimers(),
    text: (selector: string) =>
      (widget.querySelector(selector)?.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim(),
    state: () => subs.widgets[0].getState(),
  };
}

/** The theme's programmatic switch: property write, NO event, NO URL. */
function themeSwitches(page: Page, variantId: string): void {
  page.idInput.value = variantId;
  page.atcText.nodeValue = "ADD TO CART - CHF 0.00";
}

/** The shopper's own cadence pick, through the real dropdown listener. */
function shopperPicks(page: Page, planId: string): void {
  page.freqSelect.value = planId;
  page.freqSelect.dispatchEvent(new EventShim("change", { bubbles: true }));
  page.flush();
}

describe("boot (real render, defaults metafield present)", () => {
  it("lands on jar 1 with its default (weeks 8) selected and the dropdown in agreement", () => {
    const page = buildPage(MARKUP);
    expect(page.state()).toMatchObject({
      variantId: JAR1,
      sellingPlanId: WEEKS8,
    });
    expect(String(page.freqSelect.value)).toBe(WEEKS8);
    expect(page.text("[data-cellexia-then]")).toContain("every 8 weeks");
  });

  it("a theme field that ALREADY disagrees at boot adopts THAT variant's default", () => {
    // Liquid preselected jar 1's default (weeks 8); the page arrives with the
    // theme's field on jar 2 (its default: weeks 4). Nothing was chosen yet,
    // so the widget must boot straight onto jar 2 + weeks 4 — no flash of the
    // wrong cadence, no first poll needed.
    const page = buildPage(MARKUP, { mainFieldValue: JAR2 });
    expect(page.state()).toMatchObject({
      variantId: JAR2,
      sellingPlanId: WEEKS4,
    });
    expect(String(page.freqSelect.value)).toBe(WEEKS4);
    expect(page.text("[data-cellexia-then]")).toContain("every 4 weeks");
  });
});

describe("variant switch adopts the new variant's default (poll path — all mechanisms funnel the same way)", () => {
  it("jar 1 → jar 2 moves the selection onto weeks 4, prices and form follow", () => {
    const page = buildPage(MARKUP);
    themeSwitches(page, JAR2);
    page.pollTick();
    expect(page.state()).toMatchObject({
      variantId: JAR2,
      sellingPlanId: WEEKS4,
    });
    expect(String(page.freqSelect.value)).toBe(WEEKS4);
    expect(page.text("[data-cellexia-then]")).toContain("every 4 weeks");
    // The field the CART submits (the `selling_plan` input the JS maintains
    // inside the theme's form — the widget's own Liquid mirror is nameless
    // and dormant) must carry the adopted plan.
    const cartField = page.document.querySelector(
      "form input[data-cellexia-plan-input]",
    ) as ElementNode;
    expect(String(cartField.value)).toBe(WEEKS4);
  });

  it("a variant WITHOUT an override REVERTS to the plan default (jar 2 → jar 3 lands on weeks 8)", () => {
    // The admin form's promise: "Plan default" is what un-overridden
    // variants use — jar 2's override must not leak onto jar 3.
    const page = buildPage(MARKUP);
    themeSwitches(page, JAR2);
    page.pollTick();
    expect(page.state()).toMatchObject({ sellingPlanId: WEEKS4 });
    themeSwitches(page, JAR3);
    page.pollTick();
    expect(page.state()).toMatchObject({
      variantId: JAR3,
      sellingPlanId: WEEKS8,
    });
    expect(page.text("[data-cellexia-then]")).toContain("every 8 weeks");
  });

  it("switching BACK re-adopts: jar 2 (weeks 4) → jar 1 re-selects the plan default", () => {
    const page = buildPage(MARKUP);
    themeSwitches(page, JAR2);
    page.pollTick();
    themeSwitches(page, JAR1);
    page.pollTick();
    expect(page.state()).toMatchObject({
      variantId: JAR1,
      sellingPlanId: WEEKS8,
    });
  });

  it("without a published group default there is nothing to revert to — the selection stays", () => {
    // Degrade shape (e.g. a hand-edited metafield): jar 3 has no override
    // and no folded default, so its island defaultPlan is '' and the
    // current cadence carries over — never an invented selection.
    const page = buildPage(NO_REVERT_MARKUP);
    themeSwitches(page, JAR2);
    page.pollTick();
    expect(page.state()).toMatchObject({ sellingPlanId: WEEKS4 });
    themeSwitches(page, JAR3);
    page.pollTick();
    expect(page.state()).toMatchObject({
      variantId: JAR3,
      sellingPlanId: WEEKS4,
    });
  });
});

describe("an explicit cadence choice is sticky", () => {
  it("after the shopper picks weeks 6, pack-size switches stop moving the cadence", () => {
    const page = buildPage(MARKUP);
    shopperPicks(page, WEEKS6);
    expect(page.state()).toMatchObject({ sellingPlanId: WEEKS6 });

    themeSwitches(page, JAR2);
    page.pollTick();
    // jar 2's default is weeks 4 — but the shopper answered this question.
    expect(page.state()).toMatchObject({
      variantId: JAR2,
      sellingPlanId: WEEKS6,
    });
    expect(page.text("[data-cellexia-then]")).toContain("every 6 weeks");

    themeSwitches(page, JAR1);
    page.pollTick();
    expect(page.state()).toMatchObject({
      variantId: JAR1,
      sellingPlanId: WEEKS6,
    });
  });

  it("even re-picking the CURRENT cadence counts as explicit (a stated preference)", () => {
    const page = buildPage(MARKUP);
    shopperPicks(page, WEEKS8); // same as the landing default — still a choice
    themeSwitches(page, JAR2);
    page.pollTick();
    expect(page.state()).toMatchObject({
      variantId: JAR2,
      sellingPlanId: WEEKS8,
    });
  });
});

describe("MUTATION CHECK: the adoption call is load-bearing", () => {
  it("with maybeAdoptVariantDefault cut from the switch path, jar 2 keeps weeks 8", () => {
    const page = buildPage(MARKUP, {
      mutate: (source) =>
        source.replace(
          "maybeAdoptVariantDefault(nextId);",
          "/* mutant: adoption cut */",
        ),
    });
    expect(page.sourceChanged).toBe(true);
    themeSwitches(page, JAR2);
    page.pollTick();
    // The variant tracking still works — only the default adoption is gone.
    expect(page.state()).toMatchObject({
      variantId: JAR2,
      sellingPlanId: WEEKS8,
    });
  });
});
