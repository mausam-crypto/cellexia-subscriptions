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
}

interface RunResult {
  document: DocumentNode;
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
  const sectionInner = (options.sectionHtml ?? "") + (widgetInSection ? WIDGET_MARKUP : "");
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
    parseHtml(WIDGET_MARKUP, holder);
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
    widget: documentNode.querySelector(".cx-buybox[data-cellexia-buybox]"),
    sourceChanged: source !== original,
    form: (selector: string) => {
      const found = documentNode.querySelector(selector);
      if (!found) throw new Error(`no form matches ${selector}`);
      return found;
    },
  };
}

/** Everything applySellingPlan/applyDesignProp could have written into a form. */
function poison(form: ElementNode): string[] {
  const findings: string[] = [];
  for (const input of form.querySelectorAll("input")) {
    const name = input.getAttribute("name") ?? "";
    if (name === "selling_plan") findings.push(`selling_plan=${input.value}`);
    if (name.indexOf("_cellexia_design") !== -1) findings.push(name);
    for (const attribute of input.attributes.keys()) {
      if (attribute.startsWith("data-cellexia-")) findings.push(attribute);
    }
  }
  return findings;
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
const PRE_FIX_FALLBACK = (source: string): string =>
  source.replace(
    /var owned = pickOwnedForm\(scoped, variants\);[\s\S]*?return null;\n {4}\}/,
    "return pickOwnedForm(scoped, variants) || scoped[0];\n    }",
  );

describe("vacuity guard (the defect, put back)", () => {
  it("the old `|| scoped[0]` fallback poisons the foreign quick-add again", () => {
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

  it("proves the guard rewrites the file it claims to rewrite", () => {
    const original = readFileSync(BUY_BOX_JS, "utf8");
    expect(PRE_FIX_FALLBACK(original)).not.toBe(original);
  });
});
