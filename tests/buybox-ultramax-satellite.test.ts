import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { beforeAll, describe, expect, it } from "vitest";

import {
  DEFAULT_DESIGN_CONFIG,
  widgetDesignConfigSchema,
} from "~/lib/widget/presets";

import {
  CustomEventShim,
  DocumentNode,
  ElementNode,
  EventShim,
  MutationObserverShim,
  cancelTimer,
  flushTimers,
  parseHtml,
  resetDomState,
  scheduleTimer,
} from "./helpers/hostile-dom";
import { FIXTURE, renderWidget } from "./liquid/harness";

/**
 * SUBSCRIPTION_ULTRA_MAX SATELLITE RELOCATION (v1.11.0) — functional, real
 * Liquid + real buy-box.js in the hostile DOM shim.
 *
 * THE CONTRACT THIS SUITE PINS
 * ----------------------------
 * The ultra_max preset's quiet "or buy once for {amount}" line must not sit
 * inside the widget card stack: on the client's PDP it belongs ALL THE WAY
 * UNDER the theme's buy area — below quantity, Add to cart and the trust
 * content (.pdp__grey). The Liquid deliberately renders that line INSIDE the
 * widget root (so a no-JS page and a launch-gated page are exactly as safe as
 * subscription_max), and buy-box.js relocates the ONE satellite element
 * (.cx-buybox-satellite[data-cellexia-satellite]) after the theme's buy area
 * whenever the widget is visible:
 *
 *   - anchor = the first .pdp__grey an ANCESTOR of the widget contains
 *     (skipped if it contains the widget itself), else the bound /cart/add
 *     form, else nothing — the line then simply stays where the Liquid put
 *     it, which is the subscription_max layout;
 *   - the radios/wraps/prices were collected at init while the satellite was
 *     still inside the root, so the state machine keeps driving the moved
 *     line BY REFERENCE — clicking the relocated one-time radio must still
 *     flip the widget's mode;
 *   - the launch gate is an ancestor [hidden]: outside the root that
 *     ancestry is gone, so a gated widget must keep its satellite INSIDE the
 *     root and stamp the satellite's own hidden attribute — a hidden widget
 *     must never leave a visible one-time line on the page;
 *   - a relocated radio must never JOIN a theme form's radio group, and when
 *     it lands OUTSIDE any form it must not carry a stray form="" attribute
 *     either;
 *   - a ghost (the widget's markup replaced under a live JS object) must not
 *     leave its relocated line behind: the variant poll's detach branch
 *     removes the satellite from the document.
 *
 * The MUTATION CHECK at the end voids satelliteAnchor() in the shipped
 * source and shows the failure mode return: with the anchor walk dead the
 * quiet line stays trapped inside the widget on the exact page it was built
 * for — the walk is load-bearing, not decorative.
 */

const BUY_BOX_JS = join(
  fileURLToPath(new URL("../extensions/cellexia-buy-box/assets/", import.meta.url)),
  "buy-box.js",
);

const SMALL = String(FIXTURE.variantIds.small);
const LARGE = String(FIXTURE.variantIds.large);

/** ultra_max exactly as the designer publishes it (everything quiet). */
function ultraConfig(): Record<string, unknown> {
  const config = widgetDesignConfigSchema.parse({
    ...DEFAULT_DESIGN_CONFIG,
    preset: "subscription_ultra_max",
    layout: {
      ...DEFAULT_DESIGN_CONFIG.layout,
      showBadge: false,
      showFrequency: false,
      showSavings: false,
      showReassurance: false,
    },
  });
  return JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
}

/** The real server renders, once per suite. */
let LIVE_MARKUP = "";
let GATED_MARKUP = "";

beforeAll(async () => {
  LIVE_MARKUP = await renderWidget({
    config: ultraConfig(),
    launchStatus: "live",
  });
  GATED_MARKUP = await renderWidget({
    config: ultraConfig(),
    launchStatus: "setup",
  });
});

interface Page {
  document: DocumentNode & { visibilityState?: string };
  widget: ElementNode;
  info: ElementNode;
  grey: ElementNode | null;
  form: ElementNode | null;
  /** Live document query — null once the ghost cleanup removed it. */
  satellite: () => ElementNode | null;
  /** Fire every registered interval callback once, then drain timers. */
  pollTick: () => void;
  flush: () => void;
  state: () => Record<string, unknown> | null;
  sourceChanged: boolean;
}

/**
 * The client's PDP, client-shaped and FORMLESS by default: price, the size
 * pills (data-val-id — the theme's own variant vocabulary, which the widget
 * must scan around, never through, once its satellite sits among them), the
 * REAL rendered widget, then the theme's grey buy area (Add to cart + a
 * .cx-guarantee trust placeholder — the OTHER cx-* vendor's namespace,
 * sitting right where the satellite lands).
 */
function buildPage(
  markup: string,
  options: {
    /** What sits AFTER the widget: the client's .pdp__grey buy area, a
        generic Dawn-style /cart/add form, or nothing at all. */
    anchor: "grey" | "form" | "none";
    mutate?: (source: string) => string;
  },
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

  parseHtml(
    '<main><div class="shopify-section"><div class="pdp__info"></div></div></main>',
    body,
  );
  const info = documentNode.querySelector(".pdp__info") as ElementNode;

  // Above the widget: the theme's price and its own variant pills.
  parseHtml(
    '<div class="pdp__price">CHF 64.00</div>' +
      '<div class="pdp__options">' +
      `<button type="button" class="pdp__pill" data-val-id="${SMALL}">30 ml</button>` +
      `<button type="button" class="pdp__pill" data-val-id="${LARGE}">50 ml</button>` +
      "</div>",
    info,
  );

  // The REAL widget markup, in document order BEFORE the buy area.
  parseHtml(markup, info);

  // Below the widget: the anchor the satellite must land after (or nothing).
  if (options.anchor === "grey") {
    parseHtml(
      '<div class="pdp__grey">' +
        '<div class="pdp__actions">' +
        '<button class="btn btn--primary btn--atc">ADD TO CART - CHF 64.00</button>' +
        "</div>" +
        '<div class="cx-guarantee">60-day money-back guarantee</div>' +
        "</div>",
      info,
    );
  } else if (options.anchor === "form") {
    parseHtml(
      '<form action="/cart/add" method="post">' +
        `<input type="hidden" name="id" value="${SMALL}">` +
        '<button type="submit">Add to cart</button>' +
        "</form>",
      info,
    );
  }

  // Interval shim: the variant poll registers here; pollTick() fires a round.
  const intervals: Array<{ id: number; fn: () => void; live: boolean }> = [];
  let intervalSeq = 0;

  const noop = (): void => {};
  const windowStub: Record<string, unknown> = {
    location: {
      origin: "https://cellexialabs.com",
      href: "https://cellexialabs.com/products/cellexia-serum",
      search: "",
    },
    history: {},
    document: documentNode,
    setTimeout: scheduleTimer,
    clearTimeout: cancelTimer,
    setInterval: (fn: () => void, _delay?: number) => {
      intervalSeq += 1;
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
  const subs = windowStub.CellexiaSubs as {
    widgets: Array<{ getState: () => Record<string, unknown> | null }>;
  };

  return {
    document: documentNode,
    widget,
    info,
    grey: documentNode.querySelector(".pdp__grey"),
    form: documentNode.querySelector("form"),
    satellite: () =>
      documentNode.querySelector(".cx-buybox-satellite[data-cellexia-satellite]"),
    sourceChanged: source !== original,
    pollTick: () => {
      for (const entry of intervals.slice()) if (entry.live) entry.fn();
      flushTimers();
    },
    flush: () => flushTimers(),
    state: () => subs.widgets[0].getState(),
  };
}

/** A node's position among its parent's childNodes. */
function indexAmongSiblings(node: ElementNode): number {
  return node.parentNode ? node.parentNode.childNodes.indexOf(node) : -1;
}

/** Every element in the document carrying data-cellexia-satellite. */
function allSatellites(page: Page): ElementNode[] {
  return page.document.querySelectorAll("[data-cellexia-satellite]");
}

describe("live boot on the client's .pdp__grey PDP", () => {
  it("relocates the one-time line to the sibling AFTER the buy area, visible and outside the widget", () => {
    const page = buildPage(LIVE_MARKUP, { anchor: "grey" });
    const satellite = page.satellite() as ElementNode;
    const grey = page.grey as ElementNode;
    expect(satellite).not.toBeNull();

    // The quiet line sits directly under the theme's ENTIRE buy area — same
    // parent as .pdp__grey, immediately after it.
    expect(satellite.parentNode).toBe(grey.parentNode);
    expect(indexAmongSiblings(satellite)).toBe(indexAmongSiblings(grey) + 1);
    expect(page.widget.contains(satellite)).toBe(false);
    expect(satellite.hasAttribute("hidden")).toBe(false);

    // The subscription card stays home in the widget, preselected.
    expect(page.widget.querySelector(".cx-buybox__ultramax-card")).not.toBeNull();
    expect(
      page.widget.querySelector('[data-cellexia-option-wrap="subscription"]'),
    ).not.toBeNull();
    expect(page.state()).toMatchObject({ mode: "subscription" });
    // …and the quiet link quotes the one-time price where the shopper reads it.
    expect(
      (satellite.querySelector(".cx-buybox__submax-link")?.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim(),
    ).toContain("CHF 64.00");
  });

  it("the variant scan skips the relocated satellite and the pills stay mere options: a poll tick changes nothing", () => {
    // The satellite now lives among the theme's own DOM, one sibling away
    // from pills that carry data-val-id. The pills are unpicked options and
    // the satellite carries only data-cellexia-* hooks, so a scan pass must
    // leave the widget exactly where it booted.
    const page = buildPage(LIVE_MARKUP, { anchor: "grey" });
    expect(page.state()).toMatchObject({ variantId: SMALL });
    page.pollTick();
    expect(page.state()).toMatchObject({ variantId: SMALL, mode: "subscription" });
  });

  it("the moved radio still drives the state machine (wired by reference at init)", () => {
    const page = buildPage(LIVE_MARKUP, { anchor: "grey" });
    const satellite = page.satellite() as ElementNode;
    const oneTimeRadio = satellite.querySelector(
      'input[data-cellexia-option="one_time"]',
    ) as ElementNode;
    const subRadio = page.widget.querySelector(
      'input[data-cellexia-option="subscription"]',
    ) as ElementNode;
    // The two halves of the radio group live in different subtrees now.
    expect(page.widget.contains(oneTimeRadio)).toBe(false);
    expect(satellite.contains(subRadio)).toBe(false);

    // The shopper picks the quiet one-time line, under the buy area.
    subRadio.checked = false;
    oneTimeRadio.checked = true;
    oneTimeRadio.dispatchEvent(new EventShim("change", { bubbles: true }));
    page.flush();
    expect(page.state()).toMatchObject({ mode: "one_time", sellingPlanId: null });
    expect(satellite.classList.contains("is-selected")).toBe(true);

    // …and back to the subscription card inside the widget.
    oneTimeRadio.checked = false;
    subRadio.checked = true;
    subRadio.dispatchEvent(new EventShim("change", { bubbles: true }));
    page.flush();
    expect(page.state()).toMatchObject({ mode: "subscription" });
    expect(satellite.classList.contains("is-selected")).toBe(false);
  });
});

describe("launch-gate safety (launchStatus 'setup')", () => {
  it("a gated widget keeps its satellite inside, hidden in its own right", () => {
    // The gate is an ancestor [hidden] on the root. If the satellite left the
    // root while gated, that ancestry would no longer cover it and a
    // pre-launch page would show a working "or buy once" line with no widget
    // around it. It must stay home AND carry its own hidden attribute.
    const page = buildPage(GATED_MARKUP, { anchor: "grey" });
    expect(page.widget.hasAttribute("hidden")).toBe(true);
    expect(page.widget.getAttribute("data-cellexia-gated")).toBe("true");

    const satellite = page.satellite() as ElementNode;
    expect(satellite).not.toBeNull();
    expect(page.widget.contains(satellite)).toBe(true);
    expect(satellite.hasAttribute("hidden")).toBe(true);

    // Nothing satellite-shaped escaped the root anywhere on the page.
    for (const node of allSatellites(page)) {
      expect(page.widget.contains(node)).toBe(true);
    }
  });
});

describe("anchor discovery", () => {
  it("no .pdp__grey and no form: the line stays where the Liquid put it (subscription_max layout)", () => {
    const page = buildPage(LIVE_MARKUP, { anchor: "none" });
    const satellite = page.satellite() as ElementNode;
    expect(satellite).not.toBeNull();
    expect(page.widget.contains(satellite)).toBe(true);
    // Visible in place — the widget is live and the layout simply degrades.
    expect(satellite.hasAttribute("hidden")).toBe(false);
    expect(page.state()).toMatchObject({ mode: "subscription" });
  });

  it("generic theme: lands AFTER the bound /cart/add form, and gains NO form attribute outside it", () => {
    const page = buildPage(LIVE_MARKUP, { anchor: "form" });
    const satellite = page.satellite() as ElementNode;
    const form = page.form as ElementNode;

    // Sibling AFTER the form — under the theme's buy buttons.
    expect(satellite.parentNode).toBe(form.parentNode);
    expect(indexAmongSiblings(satellite)).toBe(indexAmongSiblings(form) + 1);
    expect(page.widget.contains(satellite)).toBe(false);
    expect(form.contains(satellite)).toBe(false);

    // The form="" pointer exists ONLY to keep the radio out of a theme
    // form's radio group when a FORM becomes an ancestor. Here the satellite
    // is a sibling of the form, so its input must NOT carry one — a stray
    // form attribute would re-associate the radio with whatever form a theme
    // gives that id later.
    const radio = satellite.querySelector(
      'input[data-cellexia-option="one_time"]',
    ) as ElementNode;
    expect(radio).not.toBeNull();
    expect(radio.hasAttribute("form")).toBe(false);

    // The moved radio still works from there too.
    const subRadio = page.widget.querySelector(
      'input[data-cellexia-option="subscription"]',
    ) as ElementNode;
    subRadio.checked = false;
    radio.checked = true;
    radio.dispatchEvent(new EventShim("change", { bubbles: true }));
    page.flush();
    expect(page.state()).toMatchObject({ mode: "one_time", sellingPlanId: null });
  });
});

describe("ghost cleanup — a replaced widget must not strand its satellite", () => {
  it("the poll's detach branch removes the relocated line from the document", () => {
    const page = buildPage(LIVE_MARKUP, { anchor: "grey" });
    const satellite = page.satellite() as ElementNode;
    // Relocated OUTSIDE the root: removing the root alone strands the line…
    expect(page.widget.contains(satellite)).toBe(false);
    page.widget.remove();
    expect(page.satellite()).not.toBeNull(); // …until the poll notices.

    page.pollTick();

    // The detach branch swept it: no satellite anywhere in the document — a
    // successor widget renders (and relocates) its own.
    expect(page.satellite()).toBeNull();
    expect(allSatellites(page)).toHaveLength(0);
  });
});

describe("MUTATION CHECK: the anchor walk is load-bearing", () => {
  const voidAnchor = (source: string): string =>
    source.replace(
      "function satelliteAnchor() {",
      "function satelliteAnchor() { if (1) return null;",
    );

  it("with satelliteAnchor voided, the quiet line stays trapped inside the widget on the .pdp__grey page", () => {
    const page = buildPage(LIVE_MARKUP, { anchor: "grey", mutate: voidAnchor });
    expect(page.sourceChanged).toBe(true);

    const satellite = page.satellite() as ElementNode;
    const grey = page.grey as ElementNode;
    expect(satellite).not.toBeNull();
    // The failure mode: the one-time line renders INSIDE the card stack on
    // the exact PDP the preset was built for — the green test's placement
    // never happens.
    expect(page.widget.contains(satellite)).toBe(true);
    expect(indexAmongSiblings(satellite)).not.toBe(indexAmongSiblings(grey) + 1);

    // The mutant killed ONLY placement — the widget itself still works, so
    // the assertion above is about the walk, not about a broken boot.
    expect(page.state()).toMatchObject({ mode: "subscription", variantId: SMALL });
  });
});
