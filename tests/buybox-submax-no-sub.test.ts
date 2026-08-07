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
import { renderWidget } from "./liquid/harness";

/**
 * SUBSCRIPTION_MAX × A VARIANT WITH NO SUBSCRIPTION ALLOCATION (--no-sub).
 *
 * THE DEFECT THIS SUITE PINS
 * --------------------------
 * A subscription_max product where one variant carries no allocation in OUR
 * group (plan synced before the variant was added). buy-box.js toggles
 * cx-buybox--no-sub, hides the subscription card and forces one_time — but
 * the one-time picked row's "Switch back to subscription" label stayed
 * VISIBLE (no .cx-buybox--no-sub rule covered it) and stayed WIRED to the
 * display:none subscription radio. Clicking it fired the hidden radio's
 * change → setMode('subscription') with no render() after it: the one-time
 * wrap lost is-selected, the subscription card stayed hidden, and the widget
 * showed NO selected option at all while state.mode said 'subscription' and
 * the cart would have received a one-time line (currentPlan() null).
 *
 * Two halves of the fix, both asserted here against the REAL shipped assets:
 *   1. CSS — the switch-back affordance is display:none in the no-sub state,
 *      with enough specificity to beat the is-selected swap that shows it;
 *   2. JS — setMode refuses mode='subscription' when the current variant has
 *      no plan at all (the render() fallback, applied at the entry point),
 *      so even a programmatic activation of the hidden radio cannot wedge
 *      the widget into the nothing-selected state.
 *
 * The vacuity half: on a variant WITH an allocation the same activation MUST
 * still switch to subscription — the guard may not be over-broad.
 */

const ASSETS = fileURLToPath(
  new URL("../extensions/cellexia-buy-box/assets/", import.meta.url),
);
const BUY_BOX_JS = join(ASSETS, "buy-box.js");

const NO_ALLOC_VARIANT = "4411100011101"; // FIXTURE.variantIds.small, emptied
const ALLOC_VARIANT = "4411100011102"; // FIXTURE.variantIds.large, full plans

/** subscription_max exactly as the designer publishes it (quiet defaults). */
function submaxConfig(): Record<string, unknown> {
  const config = widgetDesignConfigSchema.parse({
    ...DEFAULT_DESIGN_CONFIG,
    preset: "subscription_max",
    layout: {
      ...DEFAULT_DESIGN_CONFIG.layout,
      showBadge: false,
      showFrequency: false,
    },
  });
  return JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
}

/** The real Liquid render: page opens on the variant with NO allocation. */
let MARKUP = "";

beforeAll(async () => {
  MARKUP = await renderWidget({
    config: submaxConfig(),
    selectedVariantHasNoAllocations: true,
    launchStatus: "live",
  });
});

interface Page {
  document: DocumentNode;
  widget: ElementNode;
  subRadio: ElementNode;
  oneTimeRadio: ElementNode;
  oneTimeWrap: ElementNode;
  planInput: () => ElementNode | null;
  idInput: ElementNode;
  state: () => Record<string, unknown> | null;
  flush: () => void;
}

function buildPage(): Page {
  resetDomState();

  const documentNode = new DocumentNode();
  const html = new ElementNode("html");
  documentNode.appendChild(html);
  const body = new ElementNode("body");
  html.appendChild(body);
  documentNode.body = body;
  documentNode.documentElement = html;

  // A plain Dawn-style product form the widget adopts (ownership proven by
  // the [name="id"] variant id), then the REAL server-rendered widget markup.
  parseHtml(
    '<main><div class="product__info">' +
      '<form action="/cart/add" method="post">' +
      `<input type="hidden" name="id" value="${NO_ALLOC_VARIANT}">` +
      '<button type="submit">Add to cart</button>' +
      "</form></div></main>",
    body,
  );
  parseHtml(MARKUP, body);

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
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(BUY_BOX_JS, "utf8"), sandbox, {
    filename: "buy-box.js",
  });
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
    subRadio: widget.querySelector(
      'input[data-cellexia-option="subscription"]',
    ) as ElementNode,
    oneTimeRadio: widget.querySelector(
      'input[data-cellexia-option="one_time"]',
    ) as ElementNode,
    oneTimeWrap: widget.querySelector(
      '[data-cellexia-option-wrap="one_time"]',
    ) as ElementNode,
    planInput: () =>
      documentNode.querySelector("input[data-cellexia-plan-input]"),
    idInput: documentNode.querySelector('input[name="id"]') as ElementNode,
    state: () => subs.widgets[0].getState(),
    flush: () => flushTimers(),
  };
}

/** A label click on a radio, as browsers deliver it: check + change event. */
function activate(page: Page, radio: ElementNode, other: ElementNode): void {
  other.checked = false;
  radio.checked = true;
  radio.dispatchEvent(new EventShim("change", { bubbles: true }));
  page.flush();
}

/** The theme's variant picker landing on `variantId`. */
function switchVariant(page: Page, variantId: string): void {
  page.idInput.value = variantId;
  page.idInput.dispatchEvent(new EventShim("change", { bubbles: true }));
  page.flush();
}

describe("subscription_max on a no-allocation variant (functional, real assets)", () => {
  it("boots into an honest one-time state (--no-sub, one_time selected)", () => {
    const page = buildPage();
    expect(page.widget.classList.contains("cx-buybox--no-sub")).toBe(true);
    // The server preselects subscription (the preset's posture); the JS must
    // immediately demote it — there is nothing to subscribe to.
    expect(page.oneTimeRadio.checked).toBe(true);
    expect(page.subRadio.checked).toBe(false);
    expect(page.oneTimeWrap.classList.contains("is-selected")).toBe(true);
    expect(page.state()).toMatchObject({ mode: "one_time", sellingPlanId: null });
    // The form carries no plan — a one-time line, honestly.
    expect(page.planInput()?.value ?? "").toBe("");
  });

  it("DEFECT: activating the hidden subscription radio cannot wedge the widget", () => {
    // The switch-back label is wired to the display:none subscription radio
    // via its `for` attribute. Before the fix this activation flipped
    // state.mode to 'subscription', dropped is-selected from the one-time
    // wrap (the only visible option) and left NOTHING appearing selected —
    // while the cart would still have received a one-time line.
    const page = buildPage();
    activate(page, page.subRadio, page.oneTimeRadio);

    // The widget refused: one_time stays the selected, visible truth.
    expect(page.state()).toMatchObject({ mode: "one_time", sellingPlanId: null });
    expect(page.oneTimeWrap.classList.contains("is-selected")).toBe(true);
    expect(page.oneTimeRadio.checked).toBe(true);
    expect(page.subRadio.checked).toBe(false);
    expect(page.widget.classList.contains("cx-buybox--no-sub")).toBe(true);
    expect(page.planInput()?.value ?? "").toBe("");
  });

  it("VACUITY GUARD: the same activation still subscribes on a variant WITH allocation", () => {
    // The refusal must be about the missing allocation, not a blanket ban:
    // switch to the variant that has plans and the identical radio
    // activation must genuinely enter subscription mode with a real plan.
    const page = buildPage();
    switchVariant(page, ALLOC_VARIANT);
    expect(page.widget.classList.contains("cx-buybox--no-sub")).toBe(false);

    activate(page, page.subRadio, page.oneTimeRadio);
    const state = page.state() as Record<string, unknown>;
    expect(state.mode).toBe("subscription");
    expect(state.sellingPlanId).toBeTruthy();
    expect(page.subRadio.checked).toBe(true);
    expect(page.planInput()?.value).toBe(String(state.sellingPlanId));

    // …and switching BACK to the empty variant demotes honestly again.
    switchVariant(page, NO_ALLOC_VARIANT);
    expect(page.widget.classList.contains("cx-buybox--no-sub")).toBe(true);
    expect(page.state()).toMatchObject({ mode: "one_time", sellingPlanId: null });
    expect(page.oneTimeWrap.classList.contains("is-selected")).toBe(true);
    expect(page.planInput()?.value ?? "").toBe("");
  });
});

describe("the no-sub switch-back CSS contract (buy-box.css)", () => {
  const css = readFileSync(join(ASSETS, "buy-box.css"), "utf8");

  interface CssRule {
    selector: string;
    body: string;
  }

  /** Flat {selector, body} pairs — the regex cannot cross rule braces. */
  function rules(): CssRule[] {
    const out: CssRule[] = [];
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(css)) !== null) {
      out.push({ selector: match[1].trim(), body: match[2] });
    }
    return out;
  }

  /** Specificity proxy: class-selector count of one compound selector. */
  function classCount(selector: string): number {
    return (selector.match(/\./g) ?? []).length;
  }

  const showRule = rules().find(
    (rule) =>
      /\.cx-buybox__submax-onetime\.is-selected/.test(rule.selector) &&
      /\.cx-buybox__submax-switchback/.test(rule.selector) &&
      /display:\s*inline-flex/.test(rule.body),
  );
  const hideRule = rules().find(
    (rule) =>
      /\.cx-buybox--no-sub/.test(rule.selector) &&
      /\.cx-buybox__submax-switchback/.test(rule.selector) &&
      /display:\s*none/.test(rule.body),
  );

  it("hides .cx-buybox__submax-switchback in the no-sub state", () => {
    expect(
      hideRule,
      "a .cx-buybox--no-sub rule must hide the switch-back label",
    ).toBeDefined();
    // …and the base state the swap starts from still exists.
    expect(showRule, "the is-selected swap rule must still exist").toBeDefined();
  });

  it("out-specifies the is-selected swap that shows the label", () => {
    // The show rule (.cx-buybox .cx-buybox__submax-onetime.is-selected …)
    // carries 4 class selectors. The no-sub hide rule must cover the
    // is-selected state with MORE, so it wins whatever the source order —
    // a reordering refactor cannot quietly resurrect the dead affordance.
    const showSelector = (showRule as CssRule).selector;
    const hideSelector = (hideRule as CssRule).selector
      .split(",")
      .map((s) => s.trim())
      .find((s) => s.includes(".is-selected"));
    expect(
      hideSelector,
      "the no-sub hide rule must also cover the is-selected state",
    ).toBeDefined();
    expect(classCount(hideSelector as string)).toBeGreaterThan(
      classCount(showSelector),
    );
  });
});
