import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { beforeAll, describe, expect, it } from "vitest";

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
  serialize,
} from "./helpers/hostile-dom";
import { renderWidget } from "./liquid/harness";

/**
 * THE CROSS-SELL QUICK-ADD IN OUR OWN SECTION — findProductForm, evaluated.
 *
 * The in-section fallback existed for ONE case: a theme that stores a
 * non-variant token in [name="id"], where ownership can neither be proven nor
 * disproven and the block's placement (the app block renders in the product
 * section) vouches for the form. But the fallback used to fire for a very
 * different shape too: a section whose ONLY /cart/add form belongs to ANOTHER
 * product — a cross-sell / complementary-products quick-add card (numeric
 * [name="id"], submit button) while the main add-to-cart is JS-driven. That
 * form is PROVABLY foreign (a digits-only variant id either is in our island
 * or it is not), yet `pickOwnedForm(scoped) || scoped[0]` adopted it anyway —
 * and applySellingPlan then injected our selling_plan and
 * properties[_cellexia_design] into product B's form while the subscription
 * was selected, so the shopper's quick-add of product B was 422-rejected by
 * Shopify. Another product's add-to-cart, broken by our widget, invisibly.
 *
 * This suite drives the REAL assets/buy-box.js over the REAL server-rendered
 * section markup and pins the distinction: conclusively-foreign forms are
 * never bound (in the section OR document-wide), the token form still is
 * (in-section only), and an own form still wins over everything. A vacuity
 * guard rebuilds the pre-fix fallback and watches the poisoning come back, so
 * the assertions cannot quietly stop depending on the fix.
 */

const BUY_BOX_JS = fileURLToPath(
  new URL("../extensions/cellexia-buy-box/assets/buy-box.js", import.meta.url),
);

// The Liquid harness fixture's ids (see tests/liquid/harness.ts).
const OUR_VARIANT = "4411100011101";
const PLAN_ID = "6881100003";
/** Product B's variant: numeric, plausible, NOT in our JSON island. */
const FOREIGN_VARIANT = "9999999999999";
const SECTION_ID = "template--1__main"; // harness default → data-section-id

/** A cross-sell quick-add card's form: product B, complete with submit. */
const FOREIGN_QUICK_ADD =
  '<div class="complementary-products"><form method="post" action="/cart/add" class="quick-add-form">' +
  `<input type="hidden" name="id" value="${FOREIGN_VARIANT}">` +
  '<button type="submit" name="add">Quick add</button>' +
  "</form></div>";

/** A theme storing a non-variant token in [name="id"] — the inconclusive case. */
const TOKEN_FORM =
  '<form method="post" action="/cart/add" class="token-form">' +
  '<input type="hidden" name="id" value="bundle-serum-default">' +
  '<button type="submit">Add to cart</button>' +
  "</form>";

/** The product's own form (our variant id, in the island). */
const OWN_FORM =
  '<form method="post" action="/cart/add" class="own-form">' +
  `<input type="hidden" name="id" value="${OUR_VARIANT}">` +
  '<button type="submit" name="add">Add to cart</button>' +
  "</form>";

let WIDGET_MARKUP = "";

beforeAll(async () => {
  WIDGET_MARKUP = await renderWidget({ launchStatus: "live" });
});

interface RunOptions {
  /** Raw HTML placed INSIDE the block's own shopify-section, before the widget. */
  sectionHtml?: string;
  /** Raw HTML placed on the page OUTSIDE any section. */
  outsideHtml?: string;
  /** Put the widget in a section (default) or bare in <body> (doc-wide path). */
  widgetInSection?: boolean;
  /** Rewrite buy-box.js before it runs — used only by the vacuity guard. */
  mutate?: (source: string) => string;
  /** Alternative server-rendered widget markup (default: the live render). */
  widgetMarkup?: string;
}

interface RunResult {
  document: DocumentNode;
  window: Record<string, unknown>;
  widget: ElementNode | null;
  sourceChanged: boolean;
  form: (selector: string) => ElementNode;
}

function run(options: RunOptions = {}): RunResult {
  resetDomState();

  const documentNode = new DocumentNode();
  const html = new ElementNode("html");
  documentNode.appendChild(html);
  const body = new ElementNode("body");
  html.appendChild(body);
  documentNode.body = body;
  documentNode.documentElement = html;

  const widgetInSection = options.widgetInSection !== false;
  const widgetMarkup = options.widgetMarkup ?? WIDGET_MARKUP;
  const sectionInner = (options.sectionHtml ?? "") + (widgetInSection ? widgetMarkup : "");
  parseHtml(
    `<main><div id="shopify-section-${SECTION_ID}" class="shopify-section">` +
      `<h1>Cellexia Serum</h1>${sectionInner}</div></main>`,
    body,
  );
  if (options.outsideHtml) {
    parseHtml(options.outsideHtml, body);
  }
  if (!widgetInSection) {
    // Bare widget at body end: getElementById misses (its section wrapper is
    // this widget-less one only if ids matched — strip the match by placing
    // the widget outside), closest('.shopify-section') misses, so
    // findProductForm takes the document-wide PROVE-ownership path.
    const holder = new ElementNode("div");
    parseHtml(widgetMarkup, holder);
    for (const child of [...holder.childNodes]) {
      body.appendChild(child);
    }
    const section = documentNode.querySelector(".shopify-section") as ElementNode;
    section.setAttribute("id", "shopify-section-somewhere-else");
  }

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

  const original = readFileSync(BUY_BOX_JS, "utf8");
  const source = options.mutate ? options.mutate(original) : original;
  vm.runInContext(source, sandbox, { filename: "buy-box.js" });
  flushTimers();

  return {
    document: documentNode,
    window: windowStub,
    widget: documentNode.querySelector(".cx-buybox[data-cellexia-buybox]"),
    sourceChanged: source !== original,
    form: (selector: string) => {
      const found = documentNode.querySelector(selector);
      if (!found) throw new Error(`no form matches ${selector}`);
      return found;
    },
  };
}

/**
 * Everything applySellingPlan/applyDesignProp could have written into a form
 * — the plan field, the design property and (v1.26.0) the always-on
 * `_cellexia_seen` exposure property, which is stamped on one-time adds too
 * and so would poison a foreign form even while one-time is selected.
 */
function poison(form: ElementNode): string[] {
  const findings: string[] = [];
  for (const input of form.querySelectorAll("input")) {
    const name = input.getAttribute("name") ?? "";
    if (name === "selling_plan") findings.push(`selling_plan=${input.value}`);
    if (name.indexOf("_cellexia_design") !== -1) findings.push(name);
    if (name.indexOf("_cellexia_seen") !== -1) findings.push(name);
    for (const attribute of input.attributes.keys()) {
      if (attribute.startsWith("data-cellexia-")) findings.push(attribute);
    }
  }
  return findings;
}

/** The widget's own radios, by mode value. */
function radioFor(page: RunResult, mode: "subscription" | "one_time"): ElementNode {
  const radio = page.widget!.querySelector(
    `input[data-cellexia-option="${mode}"]`,
  );
  if (!radio) throw new Error(`no ${mode} radio in the widget`);
  return radio;
}

/** Click a purchase option exactly as the browser reports it. */
function selectMode(page: RunResult, mode: "subscription" | "one_time"): void {
  const wanted = radioFor(page, mode);
  const other = radioFor(page, mode === "subscription" ? "one_time" : "subscription");
  other.checked = false;
  wanted.checked = true;
  wanted.dispatchEvent(new EventShim("change", { bubbles: true }));
  flushTimers();
}

describe("a section whose only form is another product's quick-add", () => {
  it("binds NOTHING: the foreign form is byte-for-byte untouched while subscription is selected", () => {
    const page = run({ sectionHtml: FOREIGN_QUICK_ADD });
    const foreign = page.form(".quick-add-form");
    const before = serialize(foreign);

    // The widget booted (this is not a dormant-widget artefact)…
    expect(page.widget).not.toBeNull();
    expect(page.widget!.getAttribute("data-cellexia-init")).toBe("true");

    // …and wrote nothing into product B's form: no selling_plan, no design
    // property, no data-cellexia-* marker — the quick-add still posts exactly
    // what the theme rendered, so Shopify accepts it.
    expect(poison(foreign)).toEqual([]);
    expect(serialize(foreign)).toBe(before);
    // Nor anywhere else: OUR plan input exists only inside our own widget.
    for (const input of page.document.querySelectorAll(
      'input[name="selling_plan"]',
    )) {
      expect(page.widget!.contains(input)).toBe(true);
    }
  });

  it("still binds the product's OWN form when one is present alongside the foreign card", () => {
    const page = run({ sectionHtml: FOREIGN_QUICK_ADD + OWN_FORM });
    const own = page.form(".own-form");
    const foreign = page.form(".quick-add-form");

    // The subscription preselect wrote our plan into OUR form…
    const planInput = own.querySelector('input[name="selling_plan"]');
    expect(planInput).not.toBeNull();
    expect(planInput!.value).toBe(PLAN_ID);
    expect(planInput!.getAttribute("data-cellexia-plan-input")).toBe("own");
    // …and product B's stayed clean.
    expect(poison(foreign)).toEqual([]);
  });
});

// ── The theme-form seen stamp (v1.26.0) ─────────────────────────────────────
//
// The form path is the second writer of `properties[_cellexia_seen]` (the
// first is buy-box-embed.js's cart-request patch, for formless themes). Its
// contract mirrors the patcher's: the input is enabled with
// "<preset>|<s|o|u>" whenever the widget is visible — one-time selected or
// not — while `_cellexia_design` keeps its subscription-only gate, and both
// are released with the form when the widget hides.

describe("the seen exposure input in the product's OWN form", () => {
  function seenInput(form: ElementNode): ElementNode | null {
    return form.querySelector('input[name="properties[_cellexia_seen]"]');
  }
  function designInput(form: ElementNode): ElementNode | null {
    return form.querySelector("input[data-cellexia-design-prop]");
  }

  it("is stamped with <preset>|s at boot (subscription preselected) next to the design prop", () => {
    const page = run({ sectionHtml: OWN_FORM });
    const own = page.form(".own-form");
    const seen = seenInput(own);
    expect(seen).not.toBeNull();
    expect(seen!.getAttribute("type")).toBe("hidden");
    expect(seen!.value).toBe("classic|s");
    expect(seen!.disabled).toBe(false);
    // Exactly one seen input, however many times the write path re-ran.
    expect(own.querySelectorAll('input[name="properties[_cellexia_seen]"]')).toHaveLength(1);
    // The design prop is there too, enabled, with the preset alone.
    expect(designInput(own)!.value).toBe("classic");
    expect(designInput(own)!.disabled).toBe(false);
  });

  it("stays enabled on a one-time selection while the design prop is disabled", () => {
    const page = run({ sectionHtml: OWN_FORM });
    const own = page.form(".own-form");
    selectMode(page, "one_time");

    // One-time: no plan, no design attribution — but the visitor SAW the
    // design, so the exposure still travels with the add-to-cart.
    expect(own.querySelector('input[name="selling_plan"]')!.value).toBe("");
    expect(designInput(own)!.disabled).toBe(true);
    expect(designInput(own)!.value).toBe("");
    expect(seenInput(own)!.disabled).toBe(false);
    expect(seenInput(own)!.value).toBe("classic|s");

    // …and back: everything is reinstated, still exactly one seen input.
    selectMode(page, "subscription");
    expect(own.querySelector('input[name="selling_plan"]')!.value).toBe(PLAN_ID);
    expect(designInput(own)!.disabled).toBe(false);
    expect(seenInput(own)!.value).toBe("classic|s");
    expect(own.querySelectorAll('input[name="properties[_cellexia_seen]"]')).toHaveLength(1);
  });

  it("is never written into a foreign quick-add form, in either mode", () => {
    const page = run({ sectionHtml: FOREIGN_QUICK_ADD + OWN_FORM });
    const foreign = page.form(".quick-add-form");
    expect(seenInput(foreign)).toBeNull();
    selectMode(page, "one_time");
    expect(seenInput(foreign)).toBeNull();
    expect(poison(foreign)).toEqual([]);
    // Product A's own form still carries it.
    expect(seenInput(page.form(".own-form"))!.value).toBe("classic|s");
  });

  it("is released (disabled, blanked) with the design prop when the widget hides", () => {
    const page = run({ sectionHtml: OWN_FORM });
    const own = page.form(".own-form");
    expect(seenInput(own)!.disabled).toBe(false);

    // Hide the widget the way the launch gate does and re-run the write path
    // through the public seam: applySellingPlan releases the form.
    page.widget!.setAttribute("hidden", "hidden");
    const subs = page.window.CellexiaSubs as { resync: () => void };
    subs.resync();
    flushTimers();

    expect(seenInput(own)!.disabled).toBe(true);
    expect(seenInput(own)!.value).toBe("");
    expect(designInput(own)!.disabled).toBe(true);
    expect(own.querySelector('input[name="selling_plan"]')).toBeNull();

    // Revealed again: reinstated, same single input.
    page.widget!.removeAttribute("hidden");
    subs.resync();
    flushTimers();
    expect(seenInput(own)!.disabled).toBe(false);
    expect(seenInput(own)!.value).toBe("classic|s");
    expect(own.querySelectorAll('input[name="properties[_cellexia_seen]"]')).toHaveLength(1);
  });

  it("is absent from the theme form while the shop is in setup mode (write gate)", async () => {
    const gated = await renderWidget({ launchStatus: "setup" });
    const page = run({ sectionHtml: OWN_FORM, widgetMarkup: gated });
    const own = page.form(".own-form");
    expect(page.widget!.hasAttribute("hidden")).toBe(true);
    expect(seenInput(own)).toBeNull();
    expect(poison(own)).toEqual([]);
  });

  // ── The preselect suffix, derived from the island (not assumed) ──────────
  //
  // Preselect is the experiment's second variable (merchant decision
  // v1.26.0: tracked on its own). Every render above has subscription
  // preselected, so a buy-box.js that hard-wired the suffix to "s" would
  // pass them all; the two cases below render the REAL Liquid with the block
  // setting "Preselect subscription" OFF, and once with an island that has
  // no `preselect` field, so the derivation itself is measured.

  it("reads <preset>|o when the block setting preselects one-time (real Liquid render)", async () => {
    const oneTimeMarkup = await renderWidget({
      launchStatus: "live",
      blockSettings: { preselect_subscription: false },
    });
    // Vacuity guard: same preset, only the island's preselect flag flipped.
    expect(oneTimeMarkup).not.toBe(WIDGET_MARKUP);
    expect(oneTimeMarkup).toMatch(/"preselect":\s*false/);
    expect(WIDGET_MARKUP).toMatch(/"preselect":\s*true/);

    const page = run({ sectionHtml: OWN_FORM, widgetMarkup: oneTimeMarkup });
    const own = page.form(".own-form");
    const subs = page.window.CellexiaSubs as {
      getState: () => Record<string, unknown> | null;
    };
    // The widget's public state carries the render decision as a boolean.
    expect(subs.getState()).toMatchObject({
      preselect: false,
      design: "classic",
      mode: "one_time",
    });
    // One-time is the checked option at boot: seen "classic|o" enabled, no
    // plan, design prop disabled.
    expect(seenInput(own)!.value).toBe("classic|o");
    expect(seenInput(own)!.disabled).toBe(false);
    expect(own.querySelector('input[name="selling_plan"]')?.value ?? "").toBe("");
    expect(designInput(own)?.disabled ?? true).toBe(true);

    // Switching TO subscription does not rewrite history: the suffix says
    // what was RENDERED, the mode says what was CHOSEN.
    selectMode(page, "subscription");
    expect(subs.getState()).toMatchObject({ preselect: false, mode: "subscription" });
    expect(own.querySelector('input[name="selling_plan"]')!.value).toBe(PLAN_ID);
    expect(designInput(own)!.value).toBe("classic");
    expect(designInput(own)!.disabled).toBe(false);
    expect(seenInput(own)!.value).toBe("classic|o");
    expect(own.querySelectorAll('input[name="properties[_cellexia_seen]"]')).toHaveLength(1);
  });

  it("reads <preset>|u when the island carries no `preselect` field (unknown, never a guess)", () => {
    // An island without the flag (hand-edited or foreign markup): the form
    // path derives the suffix from the raw island, so it can and must say
    // "unknown" instead of fabricating a value for the tracked variable.
    const legacy = WIDGET_MARKUP.replace(/"preselect":\s*true,\s*/, "");
    expect(legacy).not.toBe(WIDGET_MARKUP); // vacuity guard: the field was there
    expect(legacy).not.toMatch(/"preselect"/);

    const page = run({ sectionHtml: OWN_FORM, widgetMarkup: legacy });
    const own = page.form(".own-form");
    const subs = page.window.CellexiaSubs as {
      getState: () => Record<string, unknown> | null;
    };
    // getState() keeps its boolean contract (absent reads as false)…
    expect(subs.getState()).toMatchObject({ preselect: false, design: "classic" });
    // …while the form stamp says unknown, in both modes.
    expect(seenInput(own)!.value).toBe("classic|u");
    expect(seenInput(own)!.disabled).toBe(false);
    selectMode(page, "one_time");
    expect(seenInput(own)!.value).toBe("classic|u");
    expect(seenInput(own)!.disabled).toBe(false);
    expect(own.querySelectorAll('input[name="properties[_cellexia_seen]"]')).toHaveLength(1);
  });
});

describe("the inconclusive token form (what the fallback existed for)", () => {
  it("is still adopted in-section: placement vouches where identity cannot", () => {
    const page = run({ sectionHtml: TOKEN_FORM });
    const token = page.form(".token-form");

    const planInput = token.querySelector('input[name="selling_plan"]');
    expect(planInput).not.toBeNull();
    expect(planInput!.value).toBe(PLAN_ID);
  });

  it("is NEVER adopted document-wide, where nothing vouches for it", () => {
    const page = run({
      widgetInSection: false,
      outsideHtml: TOKEN_FORM,
    });
    expect(page.widget).not.toBeNull();
    expect(poison(page.form(".token-form"))).toEqual([]);
  });
});

// ── Vacuity guard: the pre-fix fallback, put back ────────────────────────────

/** Rebuild `pickOwnedForm(scoped, variants) || scoped[0]` — the old fallback. */
const OLD_FALLBACK_ONLY = (source: string): string =>
  source.replace(
    /var owned = pickOwnedForm\(scoped, variants\);[\s\S]*?return null;\n {4}\}/,
    "return pickOwnedForm(scoped, variants) || scoped[0];\n    }",
  );

/**
 * The old fallback AND the v1.6.8 un-synced park disarmed. The park is a
 * SECOND, independent net over the very same shape: a bound form whose
 * [name="id"] is numeric-but-not-ours makes the boot re-read park the widget
 * and RELEASE the form, so with the park alive the old fallback's poison is
 * cleaned up right after it lands (see the two-nets test below). Reproducing
 * the pre-fix 422 therefore needs both nets cut.
 */
const PRE_FIX_FALLBACK = (source: string): string =>
  OLD_FALLBACK_ONLY(source).replace(
    "function parkUnsynced() {",
    "function parkUnsynced() { return;",
  );

describe("vacuity guard (the defect, put back)", () => {
  it("the old `|| scoped[0]` fallback (park disarmed) poisons the foreign quick-add again", () => {
    const page = run({
      sectionHtml: FOREIGN_QUICK_ADD,
      mutate: PRE_FIX_FALLBACK,
    });
    expect(page.sourceChanged).toBe(true);

    // Exactly the live failure: our selling_plan lands in product B's form,
    // so its quick-add would be 422-rejected while a subscription is selected.
    const findings = poison(page.form(".quick-add-form"));
    expect(findings).toContain(`selling_plan=${PLAN_ID}`);
  });

  it("the un-synced park alone already defuses the old fallback (two independent nets)", () => {
    // Only the first net is cut: the old fallback binds product B's form and
    // applySellingPlan poisons it at boot — then the boot re-read sees a
    // numeric [name="id"] the island does not know in the BOUND form, parks
    // the widget and releases the form. No enabled selling_plan survives, so
    // product B's quick-add posts cleanly again.
    const page = run({
      sectionHtml: FOREIGN_QUICK_ADD,
      mutate: OLD_FALLBACK_ONLY,
    });
    expect(page.sourceChanged).toBe(true);

    const findings = poison(page.form(".quick-add-form"));
    expect(findings).not.toContain(`selling_plan=${PLAN_ID}`);
    expect(page.widget!.getAttribute("data-cellexia-unsynced")).toBe("true");
    expect(page.widget!.hasAttribute("hidden")).toBe(true);
  });

  it("proves the guards rewrite the file they claim to rewrite", () => {
    const original = readFileSync(BUY_BOX_JS, "utf8");
    const fallbackOnly = OLD_FALLBACK_ONLY(original);
    expect(fallbackOnly).not.toBe(original);
    expect(PRE_FIX_FALLBACK(original)).not.toBe(fallbackOnly);
  });
});
