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
  TextNode,
  cancelTimer,
  flushTimers,
  parseHtml,
  resetDomState,
  scheduleTimer,
} from "./helpers/hostile-dom";
import { FIXTURE, renderWidget } from "./liquid/harness";

/**
 * EVENT-INDEPENDENT VARIANT TRACKING (v1.6.8) — the detection half of the
 * live bug, reproduced against the REAL Liquid render and the REAL
 * buy-box.js.
 *
 * The merchant's theme ("Sleepify", cellexialabs.com) sells jar packs as
 * three separate variants switched by its own pill buttons: the theme sets
 * its current-variant state programmatically (jQuery `.val()`), fires NO
 * native change event, writes NO ?variant= — so every listener the widget
 * had (form `change`, URL watcher, popstate) stayed silent, and every price
 * the widget shows stayed frozen on the landing variant while the theme and
 * the cart moved on. One price on the page, another at checkout.
 *
 * The fix is layered, and each layer is asserted here on its own:
 *   - a 600ms poll of the theme's `[name="id"]` field (visibility-gated)
 *     catches ANY switching mechanism, including pure-JS themes — the
 *     programmatic-switch tests drive ONLY the poll;
 *   - click delegation over the product area schedules a re-read on the
 *     next macrotask and again at +350ms — the click tests drive ONLY that
 *     path (no poll tick is fired);
 *   - the re-read is authoritative in order: the theme's `[name="id"]`
 *     input-or-select (bound form first, then a read-only document-wide
 *     scan), then ?variant=, then keep the current variant.
 *
 * On a change, EVERY price surface must re-render from the island matrix —
 * option card prices, first-order line, then-line, savings, per-delivery,
 * the subscription_max quiet link — AND the root's data-cellexia-money-*
 * attributes must re-anchor so the theme add-to-cart price sync swaps the
 * NEW variant's strings into the theme's button.
 *
 * The MUTATION CHECK at the end disables the poll in the loaded source and
 * proves the programmatic-switch test fails without it — the poll is
 * load-bearing, not decorative.
 */

const BUY_BOX_JS = join(
  fileURLToPath(new URL("../extensions/cellexia-buy-box/assets/", import.meta.url)),
  "buy-box.js",
);

const JAR1 = String(FIXTURE.jarVariantIds.jar1);
const JAR2 = String(FIXTURE.jarVariantIds.jar2);
const JAR3 = String(FIXTURE.jarVariantIds.jar3);

/** Fixture money (CHF, 20% off first order, 10% off ongoing). */
const M = {
  jar1: { oneTime: "CHF 64.00", first: "CHF 51.20", ongoing: "CHF 57.60", save: "Save CHF 12.80" },
  jar2: { oneTime: "CHF 108.80", first: "CHF 87.04", ongoing: "CHF 97.92", save: "Save CHF 21.76" },
  jar3: { oneTime: "CHF 153.60", first: "CHF 122.88", ongoing: "CHF 138.24", save: "Save CHF 30.72" },
} as const;

function submaxConfig(): Record<string, unknown> {
  const config = widgetDesignConfigSchema.parse({
    ...DEFAULT_DESIGN_CONFIG,
    preset: "subscription_max",
  });
  return JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
}

/** The real server renders, once per suite. */
let CLASSIC_MARKUP = "";
let SUBMAX_MARKUP = "";

beforeAll(async () => {
  CLASSIC_MARKUP = await renderWidget({
    jarVariants: true,
    blockSettings: { savings_format: "absolute" },
  });
  SUBMAX_MARKUP = await renderWidget({
    jarVariants: true,
    config: submaxConfig(),
  });
});

interface Page {
  document: DocumentNode & { visibilityState?: string };
  widget: ElementNode;
  idInput: ElementNode;
  /** The quick-buy modal's own field — only when `modalField` was given. */
  modalInput: ElementNode | null;
  atcButton: ElementNode;
  atcText: TextNode;
  pill: ElementNode;
  /** Count of setInterval registrations the file made (poll non-vacuity). */
  intervalCount: () => number;
  /** Registered delays (ms) of the LIVE intervals — pins the poll period. */
  intervalDelays: () => number[];
  /** Fire every registered interval callback once, then drain timers. */
  pollTick: () => void;
  /** Fire the file's window-level listeners for `type` (pagehide etc.). */
  firePageEvent: (type: string) => void;
  /** The public CellexiaSubs.resync() — the embed's mount/re-render hook. */
  resync: () => void;
  flush: () => void;
  text: (selector: string) => string;
  attr: (name: string) => string | null;
  state: () => Record<string, unknown> | null;
  sourceChanged: boolean;
}

function buildPage(
  markup: string,
  options: {
    /** true = Dawn-shaped page with a real /cart/add form; false = the
        Sleepify shape: NO form, just the theme's bare [name="id"] field. */
    withForm: boolean;
    /** A SECOND bare [name="id"] field for this product, FIRST in document
        order and OUTSIDE the product section — the quick-buy-modal shape
        whose stale value must never freeze or flip the widget. */
    modalField?: string;
    /** Initial value of the theme's main [name="id"] field (default jar 1). */
    mainFieldValue?: string;
    /** "select" renders the theme's field as a <select name="id"> with one
        <option> per jar — the dropdown-picker theme shape. Default input. */
    fieldKind?: "input" | "select";
    /** Renders the THEME's own <select name="selling_plan"> inside the form
        (one option per plan + the "" one-time option, "" preselected) — the
        OS 2.0 native purchase-options shape. The widget must ADOPT it, never
        create a second named field beside it. Requires withForm. */
    sellingPlanSelect?: boolean;
    /** v1.11.0, the SECOND live Sleepify shape: NO [name="id"] anywhere.
        The pills carry data-val-id (jar 2's value is padded with trailing
        whitespace, exactly like the live page) and the theme marks the
        selected one with class "active"; a bystander widget's row OUTSIDE
        the picker carries data-variant-id for the current variant and
        updates on its own schedule. Ignores withForm/fieldKind. */
    markerTheme?: boolean;
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

  // A theme's quick-buy modal: same product, its own [name="id"] field —
  // parsed FIRST so a naive first-match scan would land on it, and placed
  // OUTSIDE the product section like real modals are.
  if (options.modalField) {
    parseHtml(
      '<div class="quick-buy-modal">' +
        `<input type="hidden" name="id" value="${options.modalField}">` +
        "</div>",
      body,
    );
  }

  // The theme's PDP. The pill buttons live OUTSIDE any product form and
  // OUTSIDE .pdp__options (the one picker class the embed knows) — nothing
  // event-shaped reaches the widget when the theme flips its state.
  const mainValue = options.mainFieldValue ?? JAR1;
  const mainField =
    options.fieldKind === "select"
      ? '<select name="id">' +
        [JAR1, JAR2, JAR3]
          .map(
            (id) =>
              `<option value="${id}"${id === mainValue ? " selected" : ""}>` +
              `${id}</option>`,
          )
          .join("") +
        "</select>"
      : `<input type="hidden" name="id" value="${mainValue}">`;
  // The theme's own purchase-options control (OS 2.0 renders every selling
  // plan group as a select or radios inside the product form): an option per
  // plan of OUR group plus the "" one-time option the theme preselects.
  const planSelect = options.sellingPlanSelect
    ? '<select name="selling_plan">' +
      '<option value="" selected>One-time purchase</option>' +
      [
        FIXTURE.planIds.weeks4,
        FIXTURE.planIds.weeks6,
        FIXTURE.planIds.weeks8,
      ]
        .map((id) => `<option value="${id}">Delivery plan ${id}</option>`)
        .join("") +
      "</select>"
    : "";
  const idField = options.markerTheme
    ? ""
    : options.withForm
      ? '<form action="/cart/add" method="post">' +
        mainField +
        planSelect +
        '<button type="submit">Add to cart</button>' +
        "</form>"
      : mainField;
  const packs = options.markerTheme
    ? '<div class="pdp__packs">' +
      `<button type="button" class="btn pdp__pack-pill active" data-val-id="${JAR1}">1 Jar</button>` +
      `<button type="button" class="btn pdp__pack-pill" data-val-id="${JAR2}\n      ">2 Jars - 15% Off</button>` +
      `<button type="button" class="btn pdp__pack-pill" data-val-id="${JAR3}">3 Jars - 20% Off</button>` +
      "</div>"
    : '<div class="pdp__packs">' +
      '<button type="button" class="pdp__pack-pill">2 Jars - 15% Off</button>' +
      "</div>";
  parseHtml(
    '<main><div class="shopify-section"><div class="pdp__info">' +
      idField +
      packs +
      '<div class="pdp__grey"><div class="pdp__actions"><div class="action--atc">' +
      '<button class="btn btn--primary btn--atc">ADD TO CART - CHF 64.00</button>' +
      "</div></div></div>" +
      (options.markerTheme
        ? '<div class="rec-rail">' +
          `<div class="rec-rail__row" data-variant-id="${JAR1}">Sleep Jar</div>` +
          '<div class="rec-rail__row" data-variant-id="9999999999901">Serum</div>' +
          "</div>"
        : "") +
      "</div></div></main>",
    body,
  );
  const buyColumn = documentNode.querySelector(".pdp__info") as ElementNode;
  parseHtml(markup, buyColumn);

  // Interval shim: the poll registers here; pollTick() fires one round.
  // The registered delay is RECORDED so the suite can pin the 600ms period —
  // a poll that regressed to e.g. 60s would still pass every tick-driven
  // test (pollTick() ignores the delay), so the figure is asserted directly.
  const intervals: Array<{
    id: number;
    fn: () => void;
    delay: number;
    live: boolean;
  }> = [];
  let intervalSeq = 0;

  // Window-level listeners (pagehide, popstate, …) — RECORDED, so a test can
  // fire the page lifecycle the file wired itself to.
  const windowListeners = new Map<string, Array<(event: unknown) => void>>();

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
      intervals.push({ id: intervalSeq, fn, delay: Number(delay), live: true });
      return intervalSeq;
    },
    clearInterval: (id: number) => {
      for (const entry of intervals) if (entry.id === id) entry.live = false;
    },
    MutationObserver: MutationObserverShim,
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      const list = windowListeners.get(String(type)) ?? [];
      list.push(fn);
      windowListeners.set(String(type), list);
    },
    removeEventListener: (type: string, fn: (event: unknown) => void) => {
      const list = windowListeners.get(String(type));
      if (list) {
        windowListeners.set(
          String(type),
          list.filter((entry) => entry !== fn),
        );
      }
    },
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
    resync: () => void;
  };

  return {
    document: documentNode,
    widget,
    // The MAIN field is the one inside the product section — with a modal on
    // the page a bare first-match would grab the modal's instead.
    idInput: documentNode.querySelector(
      options.fieldKind === "select"
        ? '.pdp__info select[name="id"]'
        : '.pdp__info input[name="id"]',
    ) as ElementNode,
    modalInput: documentNode.querySelector('.quick-buy-modal input[name="id"]'),
    atcButton,
    atcText: atcButton.childNodes[0] as TextNode,
    pill: documentNode.querySelector(".pdp__pack-pill") as ElementNode,
    sourceChanged: source !== original,
    intervalCount: () => intervals.filter((entry) => entry.live).length,
    intervalDelays: () =>
      intervals.filter((entry) => entry.live).map((entry) => entry.delay),
    pollTick: () => {
      for (const entry of intervals.slice()) if (entry.live) entry.fn();
      flushTimers();
    },
    firePageEvent: (type: string) => {
      const list = windowListeners.get(type) ?? [];
      const event = new EventShim(type);
      for (const fn of list.slice()) fn(event);
      flushTimers();
    },
    resync: () => {
      subs.resync();
      flushTimers();
    },
    flush: () => flushTimers(),
    text: (selector: string) =>
      (widget.querySelector(selector)?.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim(),
    attr: (name: string) => widget.getAttribute(name),
    state: () => subs.widgets[0].getState(),
  };
}

/**
 * The theme's pill click, exactly as Sleepify performs it: its own JS sets
 * the current-variant field programmatically — NO change event, NO
 * ?variant= — and rewrites its own add-to-cart button label. `click` is
 * optional because the state write can also come from anywhere (a carousel,
 * a bundle widget): the poll must catch it even with no interaction at all.
 */
function themeSwitches(
  page: Page,
  variantId: string,
  oneTime: string,
  options: { click?: boolean } = {},
): void {
  page.idInput.value = variantId; // property write — nothing dispatched
  page.atcText.nodeValue = `ADD TO CART - ${oneTime}`; // the theme's own label
  if (options.click) {
    page.pill.dispatchEvent(new EventShim("click", { bubbles: true }));
  }
}

/** Every classic-preset price surface for one variant, in one place. */
function expectClassicPrices(page: Page, key: keyof typeof M): void {
  const money = M[key];
  expect(page.text("[data-cellexia-sub-price]")).toBe(money.first);
  expect(page.text("[data-cellexia-onetime-price]")).toBe(money.oneTime);
  expect(page.text("[data-cellexia-then]")).toBe(
    `then ${money.ongoing} every 8 weeks`,
  );
  expect(page.text("[data-cellexia-save]")).toBe(money.save);
  // The ATC price-sync anchors (island-backed, but the attributes are the
  // contract external readers and the sync fallback share).
  expect(page.attr("data-cellexia-money-onetime")).toBe(money.oneTime);
  expect(page.attr("data-cellexia-money-sub")).toBe(money.first);
  // …and the theme's button quotes the SUBSCRIPTION price of that variant.
  expect(page.atcButton.textContent).toBe(`ADD TO CART - ${money.first}`);
}

describe("boot sanity (real render, real JS, jar fixture)", () => {
  it("mounts on jar 1 and anchors every price surface + the theme button", () => {
    const page = buildPage(CLASSIC_MARKUP, { withForm: true });
    expect(page.state()).toMatchObject({ variantId: JAR1, mode: "subscription" });
    expectClassicPrices(page, "jar1");
    // The poll is armed (non-vacuity for everything below).
    expect(page.intervalCount()).toBeGreaterThanOrEqual(1);
  });
});

describe("programmatic variant switch — the poll backstop (classic)", () => {
  it("catches a jQuery-style state write with NO event and NO URL change", () => {
    const page = buildPage(CLASSIC_MARKUP, { withForm: true });
    themeSwitches(page, JAR2, M.jar2.oneTime); // no click
    // Nothing may move before the poll fires — there was no event to hear.
    expect(page.state()).toMatchObject({ variantId: JAR1 });

    page.pollTick();
    expect(page.state()).toMatchObject({ variantId: JAR2 });
    expectClassicPrices(page, "jar2");
  });

  it("keeps a sold-out variant consistent: prices render, theme owns ATC", () => {
    const page = buildPage(CLASSIC_MARKUP, { withForm: true });
    themeSwitches(page, JAR3, M.jar3.oneTime);
    page.pollTick();
    expect(page.state()).toMatchObject({ variantId: JAR3 });
    expectClassicPrices(page, "jar3");
  });

  it("polls only while the page is visible", () => {
    const page = buildPage(CLASSIC_MARKUP, { withForm: true });
    page.document.visibilityState = "hidden";
    themeSwitches(page, JAR2, M.jar2.oneTime);
    page.pollTick();
    expect(page.state()).toMatchObject({ variantId: JAR1 });

    page.document.visibilityState = "visible";
    page.pollTick();
    expect(page.state()).toMatchObject({ variantId: JAR2 });
  });
});

describe("click delegation — the fast path (classic, no poll tick fired)", () => {
  it("a pill click anywhere in the product area triggers the re-read", () => {
    const page = buildPage(CLASSIC_MARKUP, { withForm: true });
    themeSwitches(page, JAR2, M.jar2.oneTime, { click: true });
    // Only the click-scheduled timers run — the poll is never ticked.
    page.flush();
    expect(page.state()).toMatchObject({ variantId: JAR2 });
    expectClassicPrices(page, "jar2");
  });
});

describe("subscription_max on the formless Sleepify shape", () => {
  it("the poll reads the theme's bare [name=id] field (no form anywhere)", () => {
    const page = buildPage(SUBMAX_MARKUP, { withForm: false });
    expect(page.state()).toMatchObject({ variantId: JAR1 });
    expect(page.text(".cx-buybox__submax-link")).toContain(M.jar1.oneTime);

    themeSwitches(page, JAR2, M.jar2.oneTime);
    page.pollTick();

    expect(page.state()).toMatchObject({ variantId: JAR2 });
    expect(page.text("[data-cellexia-sub-price]")).toBe(M.jar2.first);
    expect(page.text("[data-cellexia-then]")).toBe(
      `then ${M.jar2.ongoing} every 8 weeks`,
    );
    // The quiet one-time link re-quotes the NEW variant's one-time price.
    expect(page.text(".cx-buybox__submax-link")).toContain(M.jar2.oneTime);
    expect(page.text("[data-cellexia-onetime-price]")).toBe(M.jar2.oneTime);
    // Money attributes re-anchor and the theme button follows.
    expect(page.attr("data-cellexia-money-onetime")).toBe(M.jar2.oneTime);
    expect(page.attr("data-cellexia-money-sub")).toBe(M.jar2.first);
    expect(page.atcButton.textContent).toBe(`ADD TO CART - ${M.jar2.first}`);
  });

  it("click delegation works there too", () => {
    const page = buildPage(SUBMAX_MARKUP, { withForm: false });
    themeSwitches(page, JAR2, M.jar2.oneTime, { click: true });
    page.flush();
    expect(page.state()).toMatchObject({ variantId: JAR2 });
    expect(page.text(".cx-buybox__submax-link")).toContain(M.jar2.oneTime);
  });
});

/** A numeric variant id of THIS product that the island has NO row for —
    the shape of a variant added after the last plan sync. */
const UNSYNCED = "4411100011299";

describe("several [name=id] fields for one product (quick-buy modal on the page)", () => {
  it("a stale duplicate FIRST in document order cannot freeze the widget", () => {
    // Pre-fix, the document-wide scan returned the FIRST island-known field:
    // the modal's stale jar-1 value would answer every re-read and the pill
    // switch would never land — the original frozen-price symptom, one form
    // over. The CHANGED field must win the disagreement instead.
    const page = buildPage(CLASSIC_MARKUP, {
      withForm: false,
      modalField: JAR1,
    });
    expect(page.state()).toMatchObject({ variantId: JAR1 });

    themeSwitches(page, JAR2, M.jar2.oneTime); // main field only; modal stays jar 1
    page.pollTick();
    expect(page.state()).toMatchObject({ variantId: JAR2 });
    expectClassicPrices(page, "jar2");
  });

  it("…and cannot flip the widget back on later, change-free polls", () => {
    const page = buildPage(CLASSIC_MARKUP, {
      withForm: false,
      modalField: JAR1,
    });
    themeSwitches(page, JAR2, M.jar2.oneTime);
    page.pollTick();
    expect(page.state()).toMatchObject({ variantId: JAR2 });

    // The stale modal field still says jar 1, the fields still disagree, and
    // nothing changed since — the in-section field keeps the answer at jar 2.
    page.pollTick();
    page.pollTick();
    expect(page.state()).toMatchObject({ variantId: JAR2 });
    expect(page.text("[data-cellexia-sub-price]")).toBe(M.jar2.first);
  });

  it("with no change evidence at boot, the field in the widget's own section wins", () => {
    // The modal remembers jar 1; the PDP's own field says jar 2 (the theme
    // restored its state). Document order would pick the modal — placement
    // must pick the section's field.
    const page = buildPage(CLASSIC_MARKUP, {
      withForm: false,
      modalField: JAR1,
      mainFieldValue: JAR2,
    });
    expect(page.state()).toMatchObject({ variantId: JAR2 });
    expect(page.text("[data-cellexia-sub-price]")).toBe(M.jar2.first);
    expect(page.attr("data-cellexia-money-onetime")).toBe(M.jar2.oneTime);
    expect(page.attr("data-cellexia-money-sub")).toBe(M.jar2.first);
  });

  it("a field added later is scanned again after the cache window, and its next change drives the widget", () => {
    const page = buildPage(CLASSIC_MARKUP, { withForm: false });
    expect(page.state()).toMatchObject({ variantId: JAR1 });

    // A quick-buy modal opens without any click reaching our delegation
    // (injected programmatically): its field says jar 2.
    const extra = page.document.createElement("input");
    extra.setAttribute("type", "hidden");
    extra.setAttribute("name", "id");
    extra.value = JAR2;
    page.document.body.appendChild(extra);

    // Its mere EXISTENCE never flips the widget: with no change evidence the
    // in-section field (jar 1) keeps the answer — through the cached polls
    // AND after the periodic re-scan has picked the new field up.
    for (let tick = 0; tick < 11; tick += 1) page.pollTick();
    expect(page.state()).toMatchObject({ variantId: JAR1 });

    // But once the shopper drives THAT field, its change wins the re-read.
    extra.value = JAR3;
    page.pollTick();
    expect(page.state()).toMatchObject({ variantId: JAR3 });
    expect(page.text("[data-cellexia-sub-price]")).toBe(M.jar3.first);
  });
});

describe("un-synced variant: a numeric id the island has no row for", () => {
  it("formless: the widget parks (hidden, no state served) instead of freezing wrong prices", () => {
    const page = buildPage(SUBMAX_MARKUP, { withForm: false });
    expect(page.state()).toMatchObject({ variantId: JAR1 });

    // The theme switches to a variant added AFTER plan sync — the field we
    // watched hold island ids now holds a numeric id we cannot price.
    themeSwitches(page, UNSYNCED, "CHF 199.00");
    page.pollTick();

    // Parked: invisible, no getState() answer (so the embed's cart patcher
    // carries no selling plan either), theme button left with ITS OWN text.
    expect(page.widget.getAttribute("data-cellexia-unsynced")).toBe("true");
    expect(page.widget.hasAttribute("hidden")).toBe(true);
    expect(page.state()).toBeNull();
    expect(page.atcButton.textContent).toBe("ADD TO CART - CHF 199.00");

    // Back on a synced variant: the widget un-parks and repaints in full.
    themeSwitches(page, JAR2, M.jar2.oneTime);
    page.pollTick();
    expect(page.widget.hasAttribute("hidden")).toBe(false);
    expect(page.widget.getAttribute("data-cellexia-unsynced")).toBeNull();
    expect(page.state()).toMatchObject({ variantId: JAR2 });
    expect(page.text("[data-cellexia-sub-price]")).toBe(M.jar2.first);
    expect(page.atcButton.textContent).toBe(`ADD TO CART - ${M.jar2.first}`);
  });

  it("with a bound form: parking RELEASES the form (no selling_plan left to 422 the new variant)", () => {
    const page = buildPage(CLASSIC_MARKUP, { withForm: true });
    const form = page.document.querySelector("form") as ElementNode;
    const planAtBoot = form.querySelector('input[name="selling_plan"]');
    expect(planAtBoot).not.toBeNull();
    expect(planAtBoot!.value).not.toBe("");

    themeSwitches(page, UNSYNCED, "CHF 199.00");
    page.pollTick();

    // Parked and released: no selling_plan field survives in the theme's
    // form (ours was created, so it is removed), and the design property is
    // disabled — the theme sells the new variant one-time, untouched.
    expect(page.widget.getAttribute("data-cellexia-unsynced")).toBe("true");
    expect(form.querySelector('input[name="selling_plan"]')).toBeNull();
    const designProp = form.querySelector("input[data-cellexia-design-prop]");
    expect(designProp!.disabled).toBe(true);
    expect(page.state()).toBeNull();

    // The theme returns to a synced variant: everything is reinstated.
    themeSwitches(page, JAR3, M.jar3.oneTime);
    page.pollTick();
    expect(page.state()).toMatchObject({ variantId: JAR3, mode: "subscription" });
    const planAfter = form.querySelector('input[name="selling_plan"]');
    expect(planAfter).not.toBeNull();
    expect(planAfter!.value).not.toBe("");
    expect(
      (form.querySelector("input[data-cellexia-design-prop]") as ElementNode)
        .disabled,
    ).toBe(false);
    expectClassicPrices(page, "jar3");
  });

  it("with the theme's own <select name=selling_plan>: parking empties the ADOPTED select too", () => {
    // The OS 2.0 native purchase-options shape: the theme renders its own
    // <select name="selling_plan"> inside the /cart/add form. Pre-fix,
    // releaseForm() queried only input[data-cellexia-plan-input] — a <select>
    // can never match an `input` type selector — so the plan id survived the
    // hidden-widget write gate and the invisible widget kept a subscription
    // in the theme's form (422 on an uncovered variant, or a silent
    // subscription line).
    const page = buildPage(CLASSIC_MARKUP, {
      withForm: true,
      sellingPlanSelect: true,
    });
    const form = page.document.querySelector("form") as ElementNode;
    const select = form.querySelector(
      'select[name="selling_plan"]',
    ) as ElementNode;
    expect(select).not.toBeNull();

    // Adoption, not duplication: the theme's select is tagged and drives the
    // cart; NO hidden input is created beside it (two named fields would let
    // the cart read one while the widget writes the other).
    expect(select.getAttribute("data-cellexia-plan-input")).toBe("adopted");
    expect(form.querySelector('input[name="selling_plan"]')).toBeNull();
    expect(select.value).not.toBe("");
    expect(select.value).toBe(String(page.state()!.sellingPlanId));

    themeSwitches(page, UNSYNCED, "CHF 199.00");
    page.pollTick();

    // Parked and released: the ADOPTED select is EMPTIED — the theme keeps
    // its own control, but no selling_plan value survives the hide — and the
    // design property is disabled, exactly like the own-input path above.
    expect(page.widget.getAttribute("data-cellexia-unsynced")).toBe("true");
    expect(select.value).toBe("");
    expect(select.getAttribute("data-cellexia-plan-input")).toBe("adopted");
    const designProp = form.querySelector("input[data-cellexia-design-prop]");
    expect(designProp!.disabled).toBe(true);
    expect(page.state()).toBeNull();

    // Back on a synced variant: the SAME select is re-filled through the
    // adopted tag — still no second field.
    themeSwitches(page, JAR3, M.jar3.oneTime);
    page.pollTick();
    expect(page.state()).toMatchObject({ variantId: JAR3, mode: "subscription" });
    expect(select.value).not.toBe("");
    expect(select.value).toBe(String(page.state()!.sellingPlanId));
    expect(form.querySelector('input[name="selling_plan"]')).toBeNull();
  });

  it("another product's foreign numeric id (never seen holding our ids) does NOT park the widget", () => {
    // A cross-sell's field holds a foreign product's variant id from the
    // start: no island row, but also no history of OUR ids — inconclusive,
    // so the widget keeps its current variant and stays visible.
    const page = buildPage(CLASSIC_MARKUP, {
      withForm: false,
      modalField: "9999999999999",
    });
    page.pollTick();
    page.pollTick();
    expect(page.widget.hasAttribute("hidden")).toBe(false);
    expect(page.state()).toMatchObject({ variantId: JAR1 });
    expectClassicPrices(page, "jar1");
  });
});

describe("<select name=id> pickers — the dropdown-theme shape", () => {
  it("formless: the document-wide scan reads the theme's select; the poll catches a programmatic option flip", () => {
    // No form anywhere, so the bound-form branch is out: only the scan's
    // 'select[name=\"id\"]' half can see the theme's state.
    const page = buildPage(CLASSIC_MARKUP, {
      withForm: false,
      fieldKind: "select",
    });
    expect(page.state()).toMatchObject({ variantId: JAR1 });
    expectClassicPrices(page, "jar1");

    // The theme flips the selected option via the value property — no change
    // event, no ?variant= (jQuery .val() on a dropdown does exactly this).
    themeSwitches(page, JAR2, M.jar2.oneTime);
    expect(page.state()).toMatchObject({ variantId: JAR1 }); // nothing to hear

    page.pollTick();
    expect(page.state()).toMatchObject({ variantId: JAR2 });
    expectClassicPrices(page, "jar2");
  });

  it("bound form: ownership is proven THROUGH the select and the re-read follows it", () => {
    const page = buildPage(CLASSIC_MARKUP, {
      withForm: true,
      fieldKind: "select",
    });
    // Non-vacuity: the widget really bound the form via the select's value —
    // the selling_plan write only happens into a bound, owned form.
    const form = page.document.querySelector("form") as ElementNode;
    const plan = form.querySelector('input[name="selling_plan"]');
    expect(plan).not.toBeNull();
    expect(plan!.value).not.toBe("");

    themeSwitches(page, JAR3, M.jar3.oneTime);
    page.pollTick();
    expect(page.state()).toMatchObject({ variantId: JAR3 });
    expectClassicPrices(page, "jar3");
  });

  const cutSelectScan = (source: string): string =>
    source.replace(
      "'input[name=\"id\"], select[name=\"id\"], [data-variant-id], [data-val-id], [data-variant]'",
      "'input[name=\"id\"], [data-variant-id], [data-val-id], [data-variant]'",
    );

  it("MUTATION CHECK: with the scan's select half cut, the dropdown theme is missed", () => {
    const page = buildPage(CLASSIC_MARKUP, {
      withForm: false,
      fieldKind: "select",
      mutate: cutSelectScan,
    });
    expect(page.sourceChanged).toBe(true);
    themeSwitches(page, JAR2, M.jar2.oneTime);
    page.pollTick();
    // Frozen on jar 1 — the select branch is load-bearing for these themes.
    expect(page.state()).toMatchObject({ variantId: JAR1 });
    expect(page.text("[data-cellexia-sub-price]")).toBe(M.jar1.first);
  });

  it("MUTATION CHECK: the mutant kills ONLY the select half (input themes still work)", () => {
    const page = buildPage(CLASSIC_MARKUP, {
      withForm: false,
      mutate: cutSelectScan,
    });
    expect(page.sourceChanged).toBe(true);
    themeSwitches(page, JAR2, M.jar2.oneTime);
    page.pollTick();
    expect(page.state()).toMatchObject({ variantId: JAR2 });
  });
});

describe("pagehide teardown + resync re-arm of the poll", () => {
  it("pagehide clears the ONE interval; resync() re-arms it and the poll works again", () => {
    const page = buildPage(CLASSIC_MARKUP, { withForm: true });
    // Exactly one interval per widget (the file's single setInterval site),
    // registered at the documented 600ms period. Pinned as a VALUE, not a
    // comment: pollTick() ignores the delay, so without this assertion a
    // poll regressed to e.g. 60s would still pass every tick-driven test.
    expect(page.intervalCount()).toBe(1);
    expect(page.intervalDelays()).toEqual([600]);

    // bfcache navigation away: the wired pagehide listener must stop the
    // poll — a cached page must not keep a live timer.
    page.firePageEvent("pagehide");
    expect(page.intervalCount()).toBe(0);

    // With the poll dead a programmatic switch goes unseen (non-vacuity for
    // the teardown: the same driver moved the widget in every test above).
    themeSwitches(page, JAR2, M.jar2.oneTime);
    page.pollTick();
    expect(page.state()).toMatchObject({ variantId: JAR1 });

    // The documented re-arm path: resync() (the embed's mount / bfcache
    // restore hook) restarts the poll and re-reads the theme immediately.
    page.resync();
    expect(page.intervalCount()).toBe(1);
    expect(page.intervalDelays()).toEqual([600]); // re-armed at the same period
    expect(page.state()).toMatchObject({ variantId: JAR2 });
    expectClassicPrices(page, "jar2");

    // And the re-armed interval is genuinely live: a FURTHER programmatic
    // switch is caught by ticking it.
    themeSwitches(page, JAR3, M.jar3.oneTime);
    page.pollTick();
    expect(page.state()).toMatchObject({ variantId: JAR3 });
    expectClassicPrices(page, "jar3");
  });
});

describe("MUTATION CHECK: the disagreement rules are load-bearing", () => {
  const cutDisagreementRules = (source: string): string =>
    source
      .replace(
        "if (changedField !== null && !changedFieldConflict) {",
        "if (false && changedField !== null && !changedFieldConflict) {",
      )
      .replace(
        "if (sectionValue !== null && !sectionConflict) {",
        "if (false && sectionValue !== null && !sectionConflict) {",
      );

  it("with both rules cut, the stale-modal switch is missed (frozen on jar 1)", () => {
    const page = buildPage(CLASSIC_MARKUP, {
      withForm: false,
      modalField: JAR1,
      mutate: cutDisagreementRules,
    });
    expect(page.sourceChanged).toBe(true);

    themeSwitches(page, JAR2, M.jar2.oneTime);
    page.pollTick();
    // Disagreeing fields with the rules cut = "keep current": the pill
    // switch never lands, which is exactly what the shipped rules prevent.
    expect(page.state()).toMatchObject({ variantId: JAR1 });
    expect(page.text("[data-cellexia-sub-price]")).toBe(M.jar1.first);
  });

  it("the mutant leaves the single-field page working (it cuts ONLY the disagreement rules)", () => {
    const page = buildPage(CLASSIC_MARKUP, {
      withForm: false,
      mutate: cutDisagreementRules,
    });
    expect(page.sourceChanged).toBe(true);
    themeSwitches(page, JAR2, M.jar2.oneTime);
    page.pollTick();
    expect(page.state()).toMatchObject({ variantId: JAR2 });
  });
});

describe("MUTATION CHECK: the poll backstop is load-bearing", () => {
  const disablePoll = (source: string): string =>
    source.replace(
      "function startVariantPoll() {",
      "function startVariantPoll() { if (variantPoll === null) { return; }",
    );

  it("with the poll disabled, the programmatic switch is missed (the live bug)", () => {
    const page = buildPage(CLASSIC_MARKUP, {
      withForm: true,
      mutate: disablePoll,
    });
    expect(page.sourceChanged).toBe(true);
    expect(page.intervalCount()).toBe(0); // the mutant registered no interval

    themeSwitches(page, JAR2, M.jar2.oneTime);
    page.pollTick(); // nothing registered — same driver as the green test
    page.flush();

    // Frozen on jar 1 while the theme sells jar 2 — the reported defect.
    expect(page.state()).toMatchObject({ variantId: JAR1 });
    expect(page.text("[data-cellexia-sub-price]")).toBe(M.jar1.first);
    expect(page.attr("data-cellexia-money-sub")).toBe(M.jar1.first);
  });

  it("the mutant kills ONLY the poll: the click layer still works", () => {
    const page = buildPage(CLASSIC_MARKUP, {
      withForm: true,
      mutate: disablePoll,
    });
    expect(page.sourceChanged).toBe(true);
    themeSwitches(page, JAR2, M.jar2.oneTime, { click: true });
    page.flush();
    expect(page.state()).toMatchObject({ variantId: JAR2 });
  });
});

/**
 * v1.11.0 — THE SECOND LIVE SLEEPIFY DEFECT (the one-click-behind widget).
 *
 * The client's PDP changed shape: there is NO [name="id"] field anywhere any
 * more. The size pills carry the variant id only as a data-val-id ATTRIBUTE
 * (one of them padded with trailing whitespace, verbatim from the live
 * page), the theme paints the selection by moving an "active" class between
 * the pills, and the only other page-level signal is a bystander widget's
 * recommendation row whose data-variant-id tracks the current variant — on
 * ITS OWN schedule.
 *
 * Observed live: the widget followed that bystander row through a one-shot
 * re-read that raced its update, so every pill click left the widget quoting
 * the PREVIOUS variant's prices — "select 1 jar, see 2 jars' subscription
 * price" — with nothing ever correcting it. The fix teaches the scan the
 * marker vocabulary (data-variant-id / data-val-id / data-variant, trimmed)
 * and ranks the evidence: a value that CHANGED since the last read, then
 * real [name=id] fields, then the theme's own active-selection paint, then
 * passive bystander markers — and an unpicked swatch is never evidence at
 * all. These tests drive the REAL buy-box.js over that exact page shape.
 */
describe("marker theme (data-val-id pills + bystander row) — v1.11.0", () => {
  function pills(page: Page): ElementNode[] {
    return page.document.querySelectorAll(".pdp__pack-pill");
  }

  function bystanderRow(page: Page): ElementNode {
    return page.document.querySelector(".rec-rail__row") as ElementNode;
  }

  const JAR_KEYS = ["jar1", "jar2", "jar3"] as const;

  /** The theme's click, exactly as the live page performs it: the active
      class moves and the theme rewrites its OWN button label synchronously
      in its own handler; the bystander row follows ~100ms later (its own
      AJAX/render cycle). */
  function themePillClick(
    page: Page,
    index: number,
    options: { bystanderDelayMs?: number | null; bystanderTo?: string } = {},
  ): void {
    const all = pills(page);
    for (const pill of all) {
      pill.setAttribute("class", "btn pdp__pack-pill");
    }
    all[index].setAttribute("class", "btn pdp__pack-pill active");
    page.atcText.nodeValue = `ADD TO CART - ${M[JAR_KEYS[index]].oneTime}`;
    const delay = options.bystanderDelayMs;
    if (delay !== null) {
      const to =
        options.bystanderTo ??
        (all[index].getAttribute("data-val-id") ?? "").trim();
      scheduleTimer(() => {
        bystanderRow(page).setAttribute("data-variant-id", to);
      }, delay ?? 100);
    }
    all[index].dispatchEvent(new EventShim("click", { bubbles: true }));
  }

  it("boots on jar 1 with the poll armed, agreeing with the active pill", () => {
    const page = buildPage(CLASSIC_MARKUP, { withForm: false, markerTheme: true });
    expect(page.state()).toMatchObject({ variantId: JAR1 });
    expectClassicPrices(page, "jar1");
    expect(page.intervalDelays()).toContain(600);
  });

  it("the ACTIVE pill drives the widget — and the padded data-val-id is trimmed", () => {
    const page = buildPage(CLASSIC_MARKUP, { withForm: false, markerTheme: true });
    // Jar 2's pill ships its id with trailing whitespace inside the
    // attribute, verbatim from the live page.
    expect(pills(page)[1].getAttribute("data-val-id")).not.toBe(JAR2);
    expect((pills(page)[1].getAttribute("data-val-id") ?? "").trim()).toBe(JAR2);

    themePillClick(page, 1);
    page.flush();
    expect(page.state()).toMatchObject({ variantId: JAR2 });
    expectClassicPrices(page, "jar2");
  });

  it("a selection painted with NO interaction at all is caught by the poll", () => {
    const page = buildPage(CLASSIC_MARKUP, { withForm: false, markerTheme: true });
    const all = pills(page);
    for (const pill of all) pill.setAttribute("class", "btn pdp__pack-pill");
    all[2].setAttribute("class", "btn pdp__pack-pill active");
    page.atcText.nodeValue = `ADD TO CART - ${M.jar3.oneTime}`;
    page.pollTick();
    expect(page.state()).toMatchObject({ variantId: JAR3 });
    expectClassicPrices(page, "jar3");
  });

  it("THE DEFECT, fixed: a stale bystander row never drags the widget one click behind", () => {
    const page = buildPage(CLASSIC_MARKUP, { withForm: false, markerTheme: true });

    // Select 2 jars; the bystander row still says jar 1 until +100ms.
    themePillClick(page, 1, { bystanderDelayMs: 100 });
    page.flush();
    expect(page.state()).toMatchObject({ variantId: JAR2 });
    expectClassicPrices(page, "jar2");

    // …and back to 1 jar; the row still says jar 2 until +100ms. This is
    // the exact click sequence observed live ("select 1 jar, see the 2-jar
    // subscription price").
    themePillClick(page, 0, { bystanderDelayMs: 100 });
    page.flush();
    expect(page.state()).toMatchObject({ variantId: JAR1 });
    expectClassicPrices(page, "jar1");
  });

  it("a bystander settling LATE to the PREVIOUS variant cannot yank the widget back", () => {
    // The review-confirmed residual of the one-behind defect: quick clicks
    // pill 2 → pill 3, and the bystander row — which still remembered jar 1 —
    // settles to jar 2 (the PREVIOUS selection) long after the click
    // re-reads ran. Its change is the only "changed" signal at the next
    // poll, but a change competes only within its own tier: the unchanged
    // active pill (jar 3) the shopper is looking at must win.
    const page = buildPage(CLASSIC_MARKUP, { withForm: false, markerTheme: true });

    themePillClick(page, 1, { bystanderDelayMs: null });
    page.flush();
    expect(page.state()).toMatchObject({ variantId: JAR2 });

    themePillClick(page, 2, { bystanderDelayMs: 1500, bystanderTo: JAR2 });
    page.flush();
    expect(page.state()).toMatchObject({ variantId: JAR3 });

    page.pollTick();
    expect(page.state()).toMatchObject({ variantId: JAR3 });
    expectClassicPrices(page, "jar3");
  });

  it("a bystander row alone (no active paint) is still honoured as weakest evidence", () => {
    const page = buildPage(CLASSIC_MARKUP, { withForm: false, markerTheme: true });
    // A theme variant with no is-active convention: nothing is painted.
    for (const pill of pills(page)) {
      pill.setAttribute("class", "btn pdp__pack-pill");
    }
    // The row moves to jar 3 (a carousel, a bundle preview, …).
    bystanderRow(page).setAttribute("data-variant-id", JAR3);
    page.pollTick();
    expect(page.state()).toMatchObject({ variantId: JAR3 });
  });

  it("a bystander row switching to an unknown numeric id can NEVER park the widget", () => {
    const page = buildPage(CLASSIC_MARKUP, { withForm: false, markerTheme: true });
    // The row previously held one of OUR ids; now it names a variant the
    // island has no row for (another product, or the bystander reshuffling).
    // A FIELD doing this parks the widget (un-synced variant); a mere marker
    // must not — it is not evidence about this product's catalogue.
    bystanderRow(page).setAttribute("data-variant-id", "9999999999902");
    page.pollTick();
    expect(page.widget.getAttribute("data-cellexia-unsynced")).toBeNull();
    expect(page.widget.hasAttribute("hidden")).toBe(false);
    expect(page.state()).toMatchObject({ variantId: JAR1 });
  });

  const neuterActivePaint = (source: string): string =>
    source.replace(
      "function markerActive(el) {",
      "function markerActive(el) { if (1) return false;",
    );

  const cutSecondClickReRead = (source: string): string =>
    source.replace(
      /window\.setTimeout\(function \(\) \{\n\s*reReadVariant\(true\);\n\s*\}, 350\);/,
      "",
    );

  it("MUTATION CHECK: with the active tier + late re-read cut, the live defect returns", () => {
    const page = buildPage(CLASSIC_MARKUP, {
      withForm: false,
      markerTheme: true,
      mutate: (source) => cutSecondClickReRead(neuterActivePaint(source)),
    });
    expect(page.sourceChanged).toBe(true);

    themePillClick(page, 1, { bystanderDelayMs: 100 });
    page.flush();
    // One click behind: the only evidence left at re-read time was the
    // stale bystander row — exactly what the live store showed.
    expect(page.state()).toMatchObject({ variantId: JAR1 });

    // …and even in the mutant, the 600ms poll eventually catches the row's
    // own change: the layers are independent nets, not one mechanism.
    page.pollTick();
    expect(page.state()).toMatchObject({ variantId: JAR2 });
  });

  it("MUTATION CHECK: both mutations rewrite the source they claim to rewrite", () => {
    const original = readFileSync(BUY_BOX_JS, "utf8");
    expect(neuterActivePaint(original)).not.toBe(original);
    expect(cutSecondClickReRead(original)).not.toBe(original);
  });
});
