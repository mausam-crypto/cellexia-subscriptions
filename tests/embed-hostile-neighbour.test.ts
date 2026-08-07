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
  allElements,
  cancelTimer,
  flushTimers,
  parseHtml,
  resetDomState,
  scheduleTimer,
  serialize,
  serializeChildren,
} from "./helpers/hostile-dom";
import { renderEmbed } from "./liquid/harness";

/**
 * THE HOSTILE NEIGHBOUR — cellexialabs.com, reproduced.
 *
 * WHAT WENT WRONG ON THE CLIENT'S LIVE STORE
 * ------------------------------------------
 * Their product page already hosts an UNRELATED vendor that owns the "cx"
 * namespace. Inside .pdp__info (the buy column) that vendor renders
 *     <div class="cx cx--self-contained" data-cx-embed …>
 * and the page also carries its cx-i18n / cx-pdp-config / cx-embed-config
 * script ids and a .sm-rc-widget.
 *
 * Our wrapper attribute used to be `data-cx-embed` too, and buy-box-embed.js
 * found its own wrapper with a bare attribute lookup. That selector returned
 * THEIR element — it appears EARLIER in the DOM than our body-end wrapper —
 * with two consequences, both observed live:
 *   1. we wrote our mount marker onto, and adopted, another vendor's element;
 *   2. the mount check then answered "already mounted" forever, so OUR
 *      wrapper never left the end of <body>: [hidden], 0px tall, an invisible
 *      buy box on the one store this app has to work on.
 *
 * WHAT THIS SUITE MEASURES
 * ------------------------
 * The real page, not a paraphrase of it: the theme's real structure (no
 * <form action="/cart/add"> — their add-to-cart is a jQuery XHR), the foreign
 * widget in its real position, the foreign script ids, and OUR OWN
 * server-rendered markup straight out of the Liquid harness. Then the REAL
 * assets/buy-box.js and assets/buy-box-embed.js are run over it, and:
 *
 *   a. our wrapper mounts immediately before .pdp__grey inside .pdp__info;
 *   b. it is unhidden when the shop is live, and STILL hidden in setup mode
 *      (the launch gate is not a mount concern and must not be bypassed);
 *   c. the foreign element is byte-for-byte untouched — same parent, same
 *      next sibling, same attributes, same innerHTML;
 *   d. every data-cellexia-* attribute in the document is inside our wrapper,
 *      and nothing inside our wrapper carries a data-cx-* attribute;
 *   e. the theme's own add-to-cart price follows the selection, and the
 *      foreign widget's identical price string is left alone;
 *   f. the cart request the theme fires by XHR carries the selling plan and
 *      the _cellexia_design attribution — and is byte-identical when the
 *      shopper chose one-time.
 *
 * Two VACUITY GUARDS re-introduce the defect (the bare, pre-rename lookup;
 * then the same lookup with the ownership assertion neutered) and prove the
 * assertions above depend on the fix rather than on the fixture.
 */

const ASSETS_DIR = fileURLToPath(
  new URL("../extensions/cellexia-buy-box/assets/", import.meta.url),
);
const BUY_BOX_JS = join(ASSETS_DIR, "buy-box.js");
const EMBED_JS = join(ASSETS_DIR, "buy-box-embed.js");

const ONE_TIME_MONEY = "CHF 64.00";
const SUB_MONEY = "CHF 51.20";
const OUR_VARIANT = "4411100011101";
const OTHER_VARIANT = "4411100011102";
const FOREIGN_VARIANT = "9999999999999";
const PLAN_ID = "6881100003";
const ATC_LABEL = `Add to cart - ${ONE_TIME_MONEY}`;

/**
 * The client's PDP, minus our app embed. Everything here is theirs: the
 * foreign cx-namespace widget FIRST inside the buy column (earlier in the DOM
 * than our body-end wrapper, exactly as observed live), that vendor's config
 * script ids, their .sm-rc-widget, the size picker, and the grey panel whose
 * button prints the one-time price. There is deliberately NO
 * <form action="/cart/add"> — on this theme add-to-cart is a jQuery XHR.
 */
const THEME_PAGE = `
<main class="pdp">
  <div class="pdp__media"><img src="/serum.jpg" alt="Cellexia Serum"></div>
  <div class="pdp__info">
    <div class="cx cx--self-contained" data-cx-embed data-cx-buybox data-cx-preset="classic">
      <div class="cx__inner">
        <p class="cx__title">Bundle &amp; save</p>
        <span class="cx__price">${ONE_TIME_MONEY}</span>
      </div>
    </div>
    <h1 class="pdp__title">Cellexia Serum</h1>
    <div class="pdp__options">
      <button type="button" class="pdp__swatch is-active" data-variant-id="${OUR_VARIANT}">30 ml</button>
      <button type="button" class="pdp__swatch" data-variant-id="${OTHER_VARIANT}">50 ml</button>
    </div>
    <div class="pdp__grey">
      <div class="pdp__qty"><input type="number" class="pdp__qty-input" value="1"></div>
      <div class="pdp__actions">
        <div class="action--atc">
          <button type="button" class="btn btn--primary btn--atc">${ATC_LABEL}</button>
        </div>
      </div>
    </div>
  </div>
</main>
<div class="sm-rc-widget"><span class="sm-rc-widget__stars">4.8</span></div>
<script type="application/json" id="cx-i18n">{"addToCart":"Add to cart"}</script>
<script type="application/json" id="cx-pdp-config">{"productId":"7712300000001"}</script>
<script type="application/json" id="cx-embed-config">{"mode":"self-contained"}</script>
`;

/**
 * THE NEXT collision, not the one we already survived.
 *
 * The rename to data-cellexia-* is only the FIRST of the fix's three layers,
 * and on its own it is a bet that no future element will ever carry our
 * attribute — a bet a merchant pasting a stale copy of our own older markup
 * into their theme, a page builder duplicating the wrapper, or simply the
 * next app to like the name would lose. This element carries our ATTRIBUTES
 * but not our CLASS, and it sits ahead of everything in the buy column, so
 * only the class qualification and isOwnWrapper() can keep us off it.
 */
const FUTURE_COLLISION =
  '<div class="cx cx--v3" data-cellexia-embed data-cellexia-buybox ' +
  'data-cellexia-preset="tiles"><span class="cx__label">Bundle builder</span></div>';

// The app embed's server-rendered markup, rendered once from the real Liquid.
let EMBED_LIVE = "";
let EMBED_SETUP = "";

beforeAll(async () => {
  EMBED_LIVE = await renderEmbed({ launchStatus: "live" });
  EMBED_SETUP = await renderEmbed({ launchStatus: "setup" });
});

// ── Building and running one page ────────────────────────────────────────────

interface SentRequest {
  url: string;
  method: string;
  body: unknown;
}

interface Page {
  document: DocumentNode;
  body: ElementNode;
  subs: Record<string, unknown>;
  /** Our app-embed wrapper (.cx-buybox-embed), or null if the Liquid emitted none. */
  wrapper: ElementNode | null;
  /** Our widget root (.cx-buybox). */
  widget: ElementNode | null;
  /** The other vendor's element. */
  foreign: ElementNode;
  /** Its exact state as the server sent it, captured before either asset ran. */
  foreignBefore: NodeSnapshot;
  buyColumn: ElementNode;
  grey: ElementNode;
  atcButton: ElementNode;
  sent: SentRequest[];
  xhrPost: (body: unknown, url?: string) => unknown;
  flush: () => void;
  /** True only when `mutate` actually rewrote a source (the vacuity guard). */
  sourceChanged: boolean;
}

interface BuildOptions {
  launchStatus?: "live" | "setup";
  /** Rewrite buy-box-embed.js before it runs — used only by the vacuity guards. */
  mutateEmbed?: (source: string) => string;
  /**
   * false leaves the page exactly as the server sent it, with neither asset
   * evaluated. The shim self-tests use it so they measure the PARSER and not
   * the subject's effects on the parsed page.
   */
  runAssets?: boolean;
  /** Also put an element carrying OUR attributes (not our class) first. */
  futureCollision?: boolean;
}

function buildPage(options: BuildOptions = {}): Page {
  resetDomState();

  const documentNode = new DocumentNode();
  const html = new ElementNode("html");
  documentNode.appendChild(html);
  const body = new ElementNode("body");
  html.appendChild(body);
  documentNode.body = body;
  documentNode.documentElement = html;

  parseHtml(THEME_PAGE, body);
  if (options.futureCollision) {
    const column = body.querySelector(".pdp__info") as ElementNode;
    const holder = new ElementNode("div");
    parseHtml(FUTURE_COLLISION, holder);
    for (const child of [...holder.childNodes].reverse()) {
      column.insertBefore(child, column.firstChild);
    }
  }
  // Shopify prints an app embed at the very END of <body>, i.e. AFTER every
  // element the theme rendered — the ordering that made the bare lookup pick
  // the other vendor's element.
  parseHtml(
    options.launchStatus === "setup" ? EMBED_SETUP : EMBED_LIVE,
    body,
  );

  const buyColumn = documentNode.querySelector(".pdp__info") as ElementNode;
  const grey = documentNode.querySelector(".pdp__grey") as ElementNode;
  const atcButton = documentNode.querySelector(".btn--atc") as ElementNode;
  const foreign = documentNode.querySelector(".cx--self-contained") as ElementNode;
  /* Taken here, before a line of our JS has run: this is the ONLY honest
     baseline for "untouched", because it is the same node in the same tree. */
  const foreignBefore = snapshot(foreign);

  const sent: SentRequest[] = [];

  class FakeXhr {
    private requestUrl = "";
    private requestMethod = "";
    open(method: string, url: string): void {
      this.requestMethod = String(method);
      this.requestUrl = String(url);
    }
    send(payload?: unknown): void {
      sent.push({
        url: this.requestUrl,
        method: this.requestMethod,
        body: payload,
      });
    }
    setRequestHeader(): void {}
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
    XMLHttpRequest: FakeXhr,
    fetch: (url: string, init?: Record<string, unknown>) => {
      sent.push({
        url: String(url),
        method: String((init && init.method) || "GET"),
        body: init ? init.body : undefined,
      });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    },
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

  const embedOriginal = readFileSync(EMBED_JS, "utf8");
  const embedSource = options.mutateEmbed
    ? options.mutateEmbed(embedOriginal)
    : embedOriginal;

  if (options.runAssets !== false) {
    // Load order is the shipped one: buy-box.js first, then its companion.
    vm.runInContext(readFileSync(BUY_BOX_JS, "utf8"), sandbox, {
      filename: "buy-box.js",
    });
    vm.runInContext(embedSource, sandbox, { filename: "buy-box-embed.js" });
    flushTimers();
  }

  const xhrPost = (payload: unknown, url = "/cart/add.js"): unknown => {
    const request = new (windowStub.XMLHttpRequest as new () => {
      open: (method: string, url: string) => void;
      send: (body?: unknown) => void;
    })();
    request.open("POST", url);
    request.send(payload);
    return sent[sent.length - 1].body;
  };

  return {
    document: documentNode,
    body,
    subs: windowStub.CellexiaSubs as Record<string, unknown>,
    wrapper: documentNode.querySelector(".cx-buybox-embed"),
    widget: documentNode.querySelector(".cx-buybox"),
    foreign,
    foreignBefore,
    buyColumn,
    grey,
    atcButton,
    sent,
    xhrPost,
    flush: () => flushTimers(),
    sourceChanged: embedSource !== embedOriginal,
  };
}

/** A frozen record of everything "untouched" has to mean for a node. */
interface NodeSnapshot {
  parent: ElementNode | null;
  nextSibling: unknown;
  attributes: Array<[string, string]>;
  innerHtml: string;
  outerHtml: string;
}

function snapshot(element: ElementNode): NodeSnapshot {
  return {
    parent: element.parentNode,
    nextSibling: element.nextSibling,
    attributes: [...element.attributes.entries()],
    innerHtml: serializeChildren(element),
    outerHtml: serialize(element),
  };
}

function indexIn(parent: ElementNode, node: ElementNode): number {
  return parent.children.indexOf(node);
}

/** Elements carrying at least one attribute whose name starts with `prefix`. */
function elementsWithAttributePrefix(
  root: ElementNode,
  prefix: string,
): ElementNode[] {
  return allElements(root).filter((element) => {
    for (const name of element.attributes.keys()) {
      if (name.startsWith(prefix)) return true;
    }
    return false;
  });
}

// ── The shim's own semantics, before anything relies on them ─────────────────

describe("hostile-page DOM shim", () => {
  /** The page exactly as the server sent it — neither asset has run. */
  const rawPage = (): Page => buildPage({ runAssets: false });

  it("parses the theme fixture into the structure the modules look for", () => {
    const page = rawPage();
    expect(page.buyColumn).not.toBeNull();
    expect(page.foreign.classList.contains("cx")).toBe(true);
    expect(page.foreign.classList.contains("cx--self-contained")).toBe(true);
    expect(page.foreign.getAttribute("data-cx-preset")).toBe("classic");
    // A valueless attribute is present with an empty value, like a browser.
    expect(page.foreign.hasAttribute("data-cx-embed")).toBe(true);
    expect(page.foreign.getAttribute("data-cx-embed")).toBe("");
    // Entity decoding happens once, in text as well as attributes.
    expect(page.foreign.querySelector(".cx__title")?.textContent).toBe(
      "Bundle & save",
    );
    expect(page.atcButton.textContent).toBe(ATC_LABEL);
    // The client's theme has no product form — the whole reason the cart
    // request patch exists.
    expect(page.document.querySelectorAll('form[action*="/cart/add"]')).toEqual(
      [],
    );
  });

  it("supports every selector shape the two modules use", () => {
    const page = rawPage();
    const doc = page.document;
    // Descendant combinator (autoAnchor's cellexialabs.com heuristic).
    expect(doc.querySelector(".pdp__info .pdp__grey")).toBe(page.grey);
    // Class + attribute (the own-markup selectors).
    expect(doc.querySelector(".cx-buybox-embed[data-cellexia-embed]")).toBe(
      page.wrapper,
    );
    expect(doc.querySelector(".cx-buybox[data-cellexia-buybox]")).toBe(
      page.widget,
    );
    // Attribute-contains and quoted values, single and double.
    expect(() =>
      doc.querySelectorAll("form[action*='/cart/add'] [type='submit']"),
    ).not.toThrow();
    expect(doc.querySelectorAll('input[name="id"], [data-variant-id]')).toHaveLength(
      2,
    );
    // Comma list with tag / #id / [attr] parts (PRICE_SYNC_EXCLUDED).
    expect(
      page.atcButton.closest("header, [role=\"dialog\"], #cart-drawer, .cart-drawer"),
    ).toBeNull();
    expect(page.atcButton.closest(".pdp__actions")).not.toBeNull();
    // An unsupported combinator raises rather than silently matching nothing.
    expect(() => doc.querySelectorAll(".pdp__info > .pdp__grey")).toThrow();
  });

  it("moves nodes, tracks isConnected and serializes stably", () => {
    const root = new DocumentNode();
    const body = new ElementNode("body");
    root.appendChild(body);
    parseHtml('<div class="a"><span data-x="1">hi</span></div><p>tail</p>', body);
    const div = body.querySelector(".a") as ElementNode;
    const span = body.querySelector("span") as ElementNode;
    const paragraph = body.querySelector("p") as ElementNode;

    expect(serialize(div)).toBe('<div class="a"><span data-x="1">hi</span></div>');
    expect(span.isConnected).toBe(true);
    expect(div.nextSibling).toBe(paragraph);

    body.insertBefore(div, null);
    expect(div.nextSibling).toBeNull();
    body.removeChild(div);
    expect(span.isConnected).toBe(false);
  });

  it("dispatches events through capture, target and bubble phases", () => {
    const root = new DocumentNode();
    const body = new ElementNode("body");
    root.appendChild(body);
    parseHtml('<div class="outer"><input type="radio"></div>', body);
    const outer = body.querySelector(".outer") as ElementNode;
    const input = body.querySelector("input") as ElementNode;

    const seen: string[] = [];
    root.addEventListener("change", () => seen.push("document-capture"), true);
    outer.addEventListener("change", () => seen.push("outer-bubble"));
    input.addEventListener("change", () => seen.push("target"));

    input.dispatchEvent(new EventShim("change", { bubbles: true }));
    expect(seen).toEqual(["document-capture", "target", "outer-bubble"]);
  });
});

// ── Interacting with the widget the way a shopper does ───────────────────────

function radioFor(page: Page, mode: "subscription" | "one_time"): ElementNode {
  const widget = page.widget as ElementNode;
  return widget.querySelector(
    `input[data-cellexia-option="${mode}"]`,
  ) as ElementNode;
}

/** Click a purchase option: browsers flip the group, then fire `change`. */
function selectMode(page: Page, mode: "subscription" | "one_time"): void {
  const wanted = radioFor(page, mode);
  const other = radioFor(page, mode === "subscription" ? "one_time" : "subscription");
  other.checked = false;
  wanted.checked = true;
  wanted.dispatchEvent(new EventShim("change", { bubbles: true }));
  page.flush();
}

function currentState(page: Page): Record<string, unknown> | null {
  const getState = page.subs.getState as () => Record<string, unknown> | null;
  return getState();
}

// ── a + b: our wrapper mounts, and the launch gate still decides ─────────────

describe("mounting next to the other cx-namespace vendor", () => {
  it("mounts our wrapper immediately before .pdp__grey inside .pdp__info", () => {
    const page = buildPage();
    const wrapper = page.wrapper as ElementNode;

    expect(wrapper.parentNode).toBe(page.buyColumn);
    expect(indexIn(page.buyColumn, wrapper)).toBe(
      indexIn(page.buyColumn, page.grey) - 1,
    );
    expect(wrapper.getAttribute("data-cellexia-mounted")).toBe("true");
    expect(page.subs.embedMounted).toBe(true);
    // …and it is no longer the last thing in <body>, where the server put it.
    expect(page.body.children[page.body.children.length - 1]).not.toBe(wrapper);
  });

  it("unhides the wrapper when the shop is live", () => {
    const page = buildPage({ launchStatus: "live" });
    const wrapper = page.wrapper as ElementNode;
    const widget = page.widget as ElementNode;

    expect(wrapper.hasAttribute("hidden")).toBe(false);
    expect(widget.hasAttribute("hidden")).toBe(false);
    expect(widget.hasAttribute("data-cellexia-gated")).toBe(false);
    // The widget answers for itself, which is what the cart patch reads.
    expect(currentState(page)).toMatchObject({
      mode: "subscription",
      design: "classic",
      variantId: OUR_VARIANT,
      sellingPlanId: PLAN_ID,
    });
  });

  it("keeps the wrapper hidden in setup mode, mounted or not", () => {
    const page = buildPage({ launchStatus: "setup" });
    const wrapper = page.wrapper as ElementNode;
    const widget = page.widget as ElementNode;

    // Mounted — the wrapper reached the buy column, so a later validated
    // preview can reveal it…
    expect(wrapper.parentNode).toBe(page.buyColumn);
    expect(wrapper.getAttribute("data-cellexia-mounted")).toBe("true");
    // …but the launch gate is untouched and the wrapper stays hidden, so the
    // live PDP is exactly what it was before the embed was enabled.
    expect(widget.getAttribute("data-cellexia-gated")).toBe("true");
    expect(widget.hasAttribute("hidden")).toBe(true);
    expect(wrapper.hasAttribute("hidden")).toBe(true);
    // A visitor who cannot see the buy box never gets a subscription line.
    expect(currentState(page)).toBeNull();
  });
});

// ── c: the other vendor's element is never touched ───────────────────────────

describe("the other vendor's element", () => {
  it("is byte-for-byte untouched after our scripts run", () => {
    const page = buildPage();
    const before = page.foreignBefore;
    const after = snapshot(page.foreign);

    expect(after.parent).toBe(before.parent);
    expect(after.nextSibling).toBe(before.nextSibling);
    expect(after.attributes).toEqual(before.attributes);
    expect(after.innerHtml).toBe(before.innerHtml);
    expect(after.outerHtml).toBe(before.outerHtml);
    // Nothing was stamped on it, under either namespace.
    expect(page.foreign.hasAttribute("data-cellexia-mounted")).toBe(false);
    expect(page.foreign.hasAttribute("data-cx-mounted")).toBe(false);
    expect(page.foreign.hasAttribute("data-cellexia-init")).toBe(false);
  });

  it("stays exactly where the page put it, ahead of our widget", () => {
    const page = buildPage();
    // Still the buy column's first element…
    expect(page.foreign.parentNode).toBe(page.buyColumn);
    expect(indexIn(page.buyColumn, page.foreign)).toBe(0);
    // …with the same next sibling it had before we mounted (we inserted
    // ourselves further down, immediately before .pdp__grey).
    // (the raw next sibling is the whitespace text node between the two tags,
    // exactly as a browser reports it — hence the element check as well)
    expect(page.foreign.nextSibling).toBe(page.foreignBefore.nextSibling);
    expect(page.buyColumn.children[1].nodeName).toBe("H1");
    expect(indexIn(page.buyColumn, page.wrapper as ElementNode)).toBeGreaterThan(
      0,
    );
  });

  it("is not adopted even when a future element carries OUR attributes", () => {
    const page = buildPage({ futureCollision: true });
    const future = page.buyColumn.children[0];
    const wrapper = page.wrapper as ElementNode;

    // It looks like our wrapper to an attribute-only lookup and it comes
    // first — the exact shape of the original defect, one namespace later.
    expect(future.hasAttribute("data-cellexia-embed")).toBe(true);
    expect(future.classList.contains("cx-buybox-embed")).toBe(false);

    // Ours mounted anyway, in the right place…
    expect(wrapper.parentNode).toBe(page.buyColumn);
    expect(indexIn(page.buyColumn, wrapper)).toBe(
      indexIn(page.buyColumn, page.grey) - 1,
    );
    expect(wrapper.hasAttribute("hidden")).toBe(false);
    // …and theirs was neither marked, moved, nor initialised as a widget.
    expect(future.hasAttribute("data-cellexia-mounted")).toBe(false);
    expect(future.hasAttribute("data-cellexia-init")).toBe(false);
    expect(indexIn(page.buyColumn, future)).toBe(0);
    expect(future.textContent).toBe("Bundle builder");
  });

  it("keeps its own copy of the one-time price even while ours is swapped", () => {
    const page = buildPage();
    const foreignPrice = page.foreign.querySelector(".cx__price") as ElementNode;

    // The theme's real add-to-cart follows our selection…
    expect(page.atcButton.textContent).toBe(`Add to cart - ${SUB_MONEY}`);
    // …while the identical money string inside the other vendor's widget —
    // which our price sync could have matched on text alone — is left alone.
    expect(foreignPrice.textContent).toBe(ONE_TIME_MONEY);

    selectMode(page, "one_time");
    expect(page.atcButton.textContent).toBe(ATC_LABEL);
    expect(foreignPrice.textContent).toBe(ONE_TIME_MONEY);
  });
});

// ── d: the namespace is ours alone ───────────────────────────────────────────

describe("attribute namespaces on the live page", () => {
  it("puts every data-cellexia-* attribute inside our own wrapper", () => {
    const page = buildPage();
    const wrapper = page.wrapper as ElementNode;

    const ours = elementsWithAttributePrefix(page.document, "data-cellexia-");
    expect(ours.length).toBeGreaterThan(5); // non-vacuous
    const strays = ours.filter(
      (element) => element !== wrapper && !wrapper.contains(element),
    );
    expect(
      strays.map((element) => serialize(element).slice(0, 120)),
      "a data-cellexia-* attribute outside our wrapper means we wrote on DOM " +
        "we do not own (on this theme there is no product form, so the " +
        "plan-input / design-prop hooks have nowhere legitimate to go)",
    ).toEqual([]);
  });

  it("emits nothing in the colliding data-cx-* namespace", () => {
    const page = buildPage();
    const wrapper = page.wrapper as ElementNode;

    // Ours: not one data-cx-* attribute anywhere in the subtree.
    expect(
      elementsWithAttributePrefix(wrapper, "data-cx-").map((element) =>
        serialize(element).slice(0, 120),
      ),
    ).toEqual([]);

    // The page's only data-cx-* element is the other vendor's, unchanged.
    const foreignOwned = elementsWithAttributePrefix(page.document, "data-cx-");
    expect(foreignOwned).toEqual([page.foreign]);
  });
});

// ── Vacuity guards: put the defect back and watch the suite fail ─────────────

/**
 * These two rebuild the pre-fix file and assert the FAILURE modes, so the
 * assertions above cannot quietly stop depending on the fix. Stage 1 restores
 * the bare, pre-rename lookup; stage 2 also neuters the ownership assertion,
 * which is what actually reproduces the mutation of another vendor's DOM.
 */
const PRE_FIX_LOOKUP = (source: string): string =>
  source.replace(
    "var inPage = document.querySelector(OWN_WRAPPER);",
    "var inPage = document.querySelector('[data-cx-embed]');",
  );

const NEUTER_OWNERSHIP = (source: string): string =>
  source.replace(
    "  function isOwnWrapper(node) {\n    if (!node) {\n      return false;\n    }\n",
    "  function isOwnWrapper(node) {\n    if (!node) {\n      return false;\n    }\n    return true;\n",
  );

describe("vacuity guards (the defect, put back)", () => {
  it("stage 1: the bare pre-rename lookup strands our wrapper at body end", () => {
    const page = buildPage({ mutateEmbed: PRE_FIX_LOOKUP });
    expect(page.sourceChanged).toBe(true);
    const wrapper = page.wrapper as ElementNode;

    // The client's symptom: the buy box never reaches the buy column.
    expect(wrapper.parentNode).toBe(page.body);
    expect(wrapper.hasAttribute("data-cellexia-mounted")).toBe(false);
    expect(wrapper.hasAttribute("hidden")).toBe(true);
    expect(page.subs.embedMounted).toBe(false);
    // The ownership assertion is the independent second net: even with the
    // bare lookup back, the foreign element is neither marked nor moved.
    expect(page.foreign.hasAttribute("data-cellexia-mounted")).toBe(false);
    expect(indexIn(page.buyColumn, page.foreign)).toBe(0);
  });

  it("stage 2: without the ownership check we adopt and MOVE their element", () => {
    const page = buildPage({
      mutateEmbed: (source) => NEUTER_OWNERSHIP(PRE_FIX_LOOKUP(source)),
    });
    expect(page.sourceChanged).toBe(true);

    // Exactly what was observed live: their element carries our marker and
    // has been relocated into our anchor position…
    expect(page.foreign.getAttribute("data-cellexia-mounted")).toBe("true");
    expect(indexIn(page.buyColumn, page.foreign)).toBe(
      indexIn(page.buyColumn, page.grey) - 1,
    );
    // …and our own widget is still invisible at the end of <body>.
    const wrapper = page.wrapper as ElementNode;
    expect(wrapper.parentNode).toBe(page.body);
    expect(wrapper.hasAttribute("hidden")).toBe(true);
  });

  /**
   * The rename alone would make the two guards above pass on THIS fixture,
   * because the vendor observed live uses data-cx-*. So the same experiment is
   * run once more against an element that carries OUR attributes and not our
   * class: there, only the class qualification can save the mount, and
   * reverting it is fatal. This is the test that fails if anyone ever
   * "simplifies" the own-markup selectors back to a bare attribute.
   */
  it("stage 3: the bare lookup is fatal once anything else carries our attribute", () => {
    const fixed = buildPage({ futureCollision: true });
    expect(fixed.wrapper?.parentNode).toBe(fixed.buyColumn);

    const broken = buildPage({
      futureCollision: true,
      mutateEmbed: (source) =>
        source.replace(
          "var inPage = document.querySelector(OWN_WRAPPER);",
          "var inPage = document.querySelector('[data-cellexia-embed]');",
        ),
    });
    expect(broken.sourceChanged).toBe(true);
    expect(broken.wrapper?.parentNode).toBe(broken.body);
    expect(broken.wrapper?.hasAttribute("hidden")).toBe(true);
  });

  it("proves both guards are rewriting the file they claim to rewrite", () => {
    const original = readFileSync(EMBED_JS, "utf8");
    expect(PRE_FIX_LOOKUP(original)).not.toBe(original);
    expect(NEUTER_OWNERSHIP(original)).not.toBe(original);
  });
});

// ── f: the cart request, on the theme that has no product form ───────────────

/**
 * THE CLIENT'S CRITICAL PATH.
 *
 * Sleepify posts add-to-cart with jQuery — `$.ajax({ url: '/cart/add.js',
 * type: 'POST', data: { items: [{ id, quantity }] } })` — and there is no
 * <form action="/cart/add"> anywhere on the page, so buy-box.js binds to no
 * form at all and writes nothing. The ONLY thing that can carry the shopper's
 * subscription into the cart is buy-box-embed.js's XHR body patch.
 *
 * Unlike tests/embed-cart-injection.test.ts, nothing is stubbed here: the
 * state comes from the REAL widget, rendered by the real Liquid, mounted into
 * the hostile page by the real mount path. If the widget failed to mount, or
 * mounted but stayed hidden, or the shopper's click did not reach it, these
 * assertions fail — which is exactly the chain that broke on the live store.
 */
describe("cart requests from a theme with no product form", () => {
  it("binds to no product form at all (so the XHR patch is the only path)", () => {
    const page = buildPage();
    expect(page.document.querySelectorAll('form[action*="/cart/add"]')).toEqual(
      [],
    );
    expect(
      page.document.querySelectorAll("input[data-cellexia-plan-input]"),
      "there is no form to write a selling_plan input into",
    ).toEqual([]);
  });

  it("injects into the jQuery items[] urlencoded body", () => {
    const page = buildPage();
    const original =
      `items%5B0%5D%5Bid%5D=${OUR_VARIANT}&items%5B0%5D%5Bquantity%5D=1`;
    const out = new URLSearchParams(String(page.xhrPost(original)));

    expect(page.sent[page.sent.length - 1].url).toBe("/cart/add.js");
    expect(page.sent[page.sent.length - 1].method).toBe("POST");
    expect(out.get("items[0][selling_plan]")).toBe(PLAN_ID);
    expect(out.get("items[0][properties][_cellexia_design]")).toBe("classic");
    // …without disturbing what the theme sent.
    expect(out.get("items[0][id]")).toBe(OUR_VARIANT);
    expect(out.get("items[0][quantity]")).toBe("1");
    // The pre-rename property name never goes out.
    expect(String(page.sent[page.sent.length - 1].body)).not.toContain(
      "_cx_design",
    );
  });

  it("injects into a jQuery items[] FormData without mutating the caller's", () => {
    const page = buildPage();
    const form = new FormData();
    form.append("items[0][id]", OUR_VARIANT);
    form.append("items[0][quantity]", "1");

    const out = page.xhrPost(form) as FormData;
    expect(out).toBeInstanceOf(FormData);
    expect(out).not.toBe(form);
    expect(out.get("items[0][selling_plan]")).toBe(PLAN_ID);
    expect(out.get("items[0][properties][_cellexia_design]")).toBe("classic");
    expect(out.get("items[0][id]")).toBe(OUR_VARIANT);
    expect(form.get("items[0][selling_plan]")).toBeNull();
  });

  it("injects into a JSON items[] body", () => {
    const page = buildPage();
    const out = JSON.parse(
      String(
        page.xhrPost(
          JSON.stringify({ items: [{ id: Number(OUR_VARIANT), quantity: 1 }] }),
        ),
      ),
    ) as { items: Array<Record<string, unknown>> };

    expect(out.items[0].selling_plan).toBe(Number(PLAN_ID));
    expect(out.items[0].properties).toEqual({ _cellexia_design: "classic" });
    expect(out.items[0].id).toBe(Number(OUR_VARIANT));
  });

  it("injects into the flat urlencoded body themes also use", () => {
    const page = buildPage();
    const out = new URLSearchParams(
      String(page.xhrPost(`id=${OUR_VARIANT}&quantity=1`)),
    );
    expect(out.get("selling_plan")).toBe(PLAN_ID);
    expect(out.get("properties[_cellexia_design]")).toBe("classic");
  });

  it("carries the plan for the variant the shopper switched to", () => {
    const page = buildPage();
    (page.subs.setVariant as (id: string) => void)(OTHER_VARIANT);
    page.flush();
    expect(currentState(page)).toMatchObject({ variantId: OTHER_VARIANT });

    const out = new URLSearchParams(
      String(page.xhrPost(`id=${OTHER_VARIANT}&quantity=1`)),
    );
    expect(out.get("selling_plan")).toBe(PLAN_ID);
  });

  it("passes another vendor's add-to-cart through byte-identical", () => {
    const page = buildPage();
    // The page's OTHER cx-namespace widget posting its own product: rewriting
    // it would 422 their checkout.
    const original =
      `items%5B0%5D%5Bid%5D=${FOREIGN_VARIANT}&items%5B0%5D%5Bquantity%5D=1`;
    expect(page.xhrPost(original)).toBe(original);

    const form = new FormData();
    form.append("id", FOREIGN_VARIANT);
    expect(page.xhrPost(form)).toBe(form);
  });

  it("touches nothing at all once the shopper picks one-time", () => {
    const page = buildPage();
    selectMode(page, "one_time");
    expect(currentState(page)).toMatchObject({
      mode: "one_time",
      sellingPlanId: null,
    });

    const encoded =
      `items%5B0%5D%5Bid%5D=${OUR_VARIANT}&items%5B0%5D%5Bquantity%5D=1`;
    expect(page.xhrPost(encoded)).toBe(encoded);

    const flat = `id=${OUR_VARIANT}&quantity=1`;
    expect(page.xhrPost(flat)).toBe(flat);

    const json = JSON.stringify({
      items: [{ id: Number(OUR_VARIANT), quantity: 1 }],
    });
    expect(page.xhrPost(json)).toBe(json);

    const form = new FormData();
    form.append("items[0][id]", OUR_VARIANT);
    form.append("items[0][quantity]", "1");
    expect(page.xhrPost(form)).toBe(form);

    for (const request of page.sent) {
      expect(String(request.body)).not.toContain("selling_plan");
      expect(String(request.body)).not.toContain("_cellexia_design");
    }
  });

  it("touches nothing while the shop is still in setup mode", () => {
    const page = buildPage({ launchStatus: "setup" });
    const original =
      `items%5B0%5D%5Bid%5D=${OUR_VARIANT}&items%5B0%5D%5Bquantity%5D=1`;
    // The visitor cannot see a purchase option, so nothing may reach the cart.
    expect(page.xhrPost(original)).toBe(original);
  });

  it("leaves requests that are not a cart add alone", () => {
    const page = buildPage();
    const original = `items%5B0%5D%5Bid%5D=${OUR_VARIANT}`;
    expect(page.xhrPost(original, "/cart/change.js")).toBe(original);
  });
});
