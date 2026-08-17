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
 * THE SECOND LIVE DEFECT (v1.11.0) — ONE CLICK BEHIND
 * ---------------------------------------------------
 * The same page later grew two more hostile facts, verified in a real
 * browser on the live PDP:
 *   - the size pills moved to `data-val-id` (NOT data-variant-id), the
 *     ACTIVE pill wears class "active", and one pill ships its id with
 *     TRAILING WHITESPACE inside the attribute value;
 *   - yet another vendor's frequently-bought-together widget renders
 *     <li class="cx-az-fbt__row" data-variant-id=…> rows after .pdp__grey,
 *     and its FIRST row tracks the theme's current variant — updating on
 *     ITS OWN SCHEDULE, ~100ms after the click.
 * There is still NO input[name="id"] anywhere. The pre-fix re-read raced
 * that bystander row: 60ms after every pill click it read the row's STALE
 * id and pushed the PREVIOUS variant — a widget permanently one click
 * behind the shopper, quoting one price while the cart charged another.
 * The fix is layered (data-val-id in the marker vocabulary + immediate
 * push, active-signal tiers above passive bystanders, staggered re-reads
 * that make a late bystander update corrective instead of corruptive), and
 * the mutation check below cuts every layer and watches the one-behind
 * defect return.
 *
 * WHAT THIS SUITE MEASURES
 * ------------------------
 * The real page, not a paraphrase of it: the theme's real structure (no
 * <form action="/cart/add"> — their add-to-cart is a jQuery XHR), the foreign
 * widgets in their real positions, the foreign script ids, and OUR OWN
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
 *      the _cellexia_design attribution — plus, since v1.26.0, the
 *      _cellexia_seen exposure stamp ("<preset>|<s|o|u>"), which is ALSO the
 *      only thing stamped when the shopper chose one-time (the take-rate
 *      denominator), and is absent, like everything else, while the widget
 *      is gated;
 *   g. a pill click lands on the CLICKED variant even while the bystander
 *      FBT row still names the previous one — and the dirty, whitespace-
 *      padded pill id is trimmed before it reaches the widget;
 *   h. the theme's MAIN price display (.pdp__price) shows the subscription
 *      money while subscription is selected, touching ONLY the current-price
 *      span — compare-at and per-unit strings stay byte-identical — and
 *      gives the theme its exact text back on one-time.
 *
 * VACUITY GUARDS and MUTATION CHECKS re-introduce both live defects (the
 * bare pre-rename lookup, then the ownership assertion neutered; then the
 * variant-tracking layers cut) and prove the assertions above depend on the
 * fixes rather than on the fixture.
 */

const ASSETS_DIR = fileURLToPath(
  new URL("../extensions/cellexia-buy-box/assets/", import.meta.url),
);
const BUY_BOX_JS = join(ASSETS_DIR, "buy-box.js");
const EMBED_JS = join(ASSETS_DIR, "buy-box-embed.js");

const ONE_TIME_MONEY = "CHF 64.00";
const SUB_MONEY = "CHF 51.20";
/** The island's one-time money for the OTHER (50 ml) variant. */
const OTHER_ONE_TIME_MONEY = "CHF 98.00";
const COMPARE_MONEY = "CHF 80.00";
const PER_UNIT_TEXT = "CHF 32.00 / per unit";
const OUR_VARIANT = "4411100011101";
const OTHER_VARIANT = "4411100011102";
const FOREIGN_VARIANT = "9999999999999";
/** The FBT widget's second row: another product entirely, never ours. */
const FBT_FOREIGN_VARIANT = "9999999999901";
const PLAN_ID = "6881100003";
/**
 * The design-measurement exposure stamp the REAL widget produces here: the
 * harness renders the default design (preset "classic") with the
 * subscription preselected → "classic|s".
 */
const SEEN = "classic|s";
const ATC_LABEL = `Add to cart - ${ONE_TIME_MONEY}`;
/**
 * The OTHER pill's data-val-id EXACTLY as the live page ships it: the id
 * followed by a newline and indentation spaces, inside the attribute value.
 * Everything that reads it must trim, or the widget compares
 * "4411100011102\n      " against the island keys and finds nothing.
 */
const DIRTY_OTHER_VARIANT = `${OTHER_VARIANT}\n      `;

/**
 * The client's PDP, minus our app embed — the CURRENT live shape, verified
 * in a real browser. Everything here is theirs: the foreign cx-namespace
 * widget FIRST inside the buy column (earlier in the DOM than our body-end
 * wrapper), that vendor's config script ids, their .sm-rc-widget, the main
 * price block (current price + struck compare-at + per-unit) ABOVE the
 * options, the size pills carrying data-val-id (one of them whitespace-
 * padded, the active one wearing class "active"), the grey panel whose
 * button prints the one-time price, and — after the grey panel — a THIRD
 * vendor's frequently-bought-together rows, the first of which tracks the
 * theme's current variant on its own schedule. There is deliberately NO
 * <form action="/cart/add"> and NO input[name="id"] — on this theme
 * add-to-cart is a jQuery XHR.
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
    <div class="pdp__price">
      <span sm-rc-current-price="">${ONE_TIME_MONEY}</span>
      <span class="price__discount" sm-rc-compare-price="">${COMPARE_MONEY}</span>
      <div class="unit-wrap"><span class="per-unit">${PER_UNIT_TEXT}</span></div>
    </div>
    <div class="pdp__options">
      <div class="option__wrap option__wrap--buttons" data-option="sm-rc-option1-selector">
        <button data-units="1" data-cans="${ONE_TIME_MONEY}" data-val="30 ml" data-val-id="${OUR_VARIANT}" class="btn btn--outline btn--flex active">30 ml</button>
        <button data-units="1" data-cans="${OTHER_ONE_TIME_MONEY}" data-val="50 ml" data-val-id="${DIRTY_OTHER_VARIANT}" class="btn btn--outline btn--flex">50 ml</button>
      </div>
    </div>
    <div class="pdp__grey">
      <div class="pdp__qty"><input type="number" class="pdp__qty-input" value="1"></div>
      <div class="pdp__actions">
        <div class="action--atc">
          <button type="button" class="btn btn--primary btn--atc">${ATC_LABEL}</button>
        </div>
      </div>
    </div>
    <ul class="cx-az-fbt">
      <li class="cx-az-fbt__row" data-variant-id="${OUR_VARIANT}"><span class="cx-az-fbt__name">Cellexia Serum</span></li>
      <li class="cx-az-fbt__row" data-variant-id="${FBT_FOREIGN_VARIANT}"><span class="cx-az-fbt__name">Night Cream</span></li>
    </ul>
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
/**
 * The same embed rendered with the OTHER value of the experiment's second
 * variable: a published design whose behavior.preselect is "one_time" (the
 * embed block hard-codes preselect_subscription: true, so the published
 * config is the only way the app embed renders one-time as the default).
 * Same preset ("classic"), so every difference below is the preselect alone.
 */
let EMBED_LIVE_ONE_TIME = "";

beforeAll(async () => {
  EMBED_LIVE = await renderEmbed({ launchStatus: "live" });
  EMBED_SETUP = await renderEmbed({ launchStatus: "setup" });
  EMBED_LIVE_ONE_TIME = await renderEmbed({
    launchStatus: "live",
    config: { preset: "classic", behavior: { preselect: "one_time" } },
  });
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
  /** True only when `mutateEmbed` actually rewrote the source (vacuity guard). */
  sourceChanged: boolean;
  /** True only when `mutateBuyBox` actually rewrote buy-box.js. */
  buyBoxSourceChanged: boolean;
}

interface BuildOptions {
  launchStatus?: "live" | "setup";
  /** Rewrite buy-box-embed.js before it runs — used only by the vacuity guards. */
  mutateEmbed?: (source: string) => string;
  /** Rewrite buy-box.js before it runs — the one-behind mutation check. */
  mutateBuyBox?: (source: string) => string;
  /**
   * false leaves the page exactly as the server sent it, with neither asset
   * evaluated. The shim self-tests use it so they measure the PARSER and not
   * the subject's effects on the parsed page.
   */
  runAssets?: boolean;
  /** Also put an element carrying OUR attributes (not our class) first. */
  futureCollision?: boolean;
  /**
   * Alternative server-rendered embed markup (default: EMBED_LIVE, or
   * EMBED_SETUP under launchStatus "setup"). Used to run the REAL assets over
   * a render whose preselect differs (EMBED_LIVE_ONE_TIME) or over a legacy
   * island (see the preselect describe block).
   */
  embedMarkup?: string;
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
    options.embedMarkup ??
      (options.launchStatus === "setup" ? EMBED_SETUP : EMBED_LIVE),
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

  const buyBoxOriginal = readFileSync(BUY_BOX_JS, "utf8");
  const buyBoxSource = options.mutateBuyBox
    ? options.mutateBuyBox(buyBoxOriginal)
    : buyBoxOriginal;
  const embedOriginal = readFileSync(EMBED_JS, "utf8");
  const embedSource = options.mutateEmbed
    ? options.mutateEmbed(embedOriginal)
    : embedOriginal;

  if (options.runAssets !== false) {
    // Load order is the shipped one: buy-box.js first, then its companion.
    vm.runInContext(buyBoxSource, sandbox, {
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
    buyBoxSourceChanged: buyBoxSource !== buyBoxOriginal,
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
    // The size pills, exactly as the live page ships them: data-val-id (NOT
    // data-variant-id), the ACTIVE pill wearing class "active" — and the
    // OTHER pill's id padded with a trailing newline + spaces, preserved
    // byte-for-byte by the parser so the trim tests below are non-vacuous.
    const pills = page.document.querySelectorAll(".option__wrap [data-val-id]");
    expect(pills).toHaveLength(2);
    expect(pills[0].getAttribute("data-val-id")).toBe(OUR_VARIANT);
    expect(pills[0].classList.contains("active")).toBe(true);
    expect(pills[0].hasAttribute("data-variant-id")).toBe(false);
    expect(pills[1].getAttribute("data-val-id")).toBe(DIRTY_OTHER_VARIANT);
    expect(pills[1].getAttribute("data-val-id")).not.toBe(OTHER_VARIANT);
    expect(pills[1].classList.contains("active")).toBe(false);
    // The theme's main price block, above the options.
    expect(
      page.document.querySelector(".pdp__price [sm-rc-current-price]")
        ?.textContent,
    ).toBe(ONE_TIME_MONEY);
    expect(
      page.document.querySelector(".pdp__price .price__discount")?.textContent,
    ).toBe(COMPARE_MONEY);
    // The bystander FBT rows, after the grey panel: the first tracks OUR
    // current variant, the second names another product entirely.
    const fbtRows = page.document.querySelectorAll(".cx-az-fbt__row");
    expect(fbtRows).toHaveLength(2);
    expect(fbtRows[0].getAttribute("data-variant-id")).toBe(OUR_VARIANT);
    expect(fbtRows[1].getAttribute("data-variant-id")).toBe(
      FBT_FOREIGN_VARIANT,
    );
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
    // The variant-signal vocabulary both modules scan, on the CURRENT page
    // shape: 2 size pills carry data-val-id, 2 bystander FBT rows carry
    // data-variant-id, and there is NO [name="id"] field anywhere — nothing
    // of ours contributes a match (our namespace is data-cellexia-*).
    expect(
      doc.querySelectorAll(
        'input[name="id"], [data-variant-id], [data-val-id]',
      ),
    ).toHaveLength(4);
    expect(doc.querySelectorAll('input[name="id"]')).toEqual([]);
    expect(doc.querySelectorAll("[data-val-id]")).toHaveLength(2);
    expect(doc.querySelectorAll("[data-variant-id]")).toHaveLength(2);
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

/** The two size pills, document order: [our 30 ml pill, the dirty 50 ml pill]. */
function sizePills(page: Page): { current: ElementNode; other: ElementNode } {
  const pills = page.document.querySelectorAll(".option__wrap [data-val-id]");
  return { current: pills[0], other: pills[1] };
}

/** The bystander FBT widget's first row — the one tracking the theme. */
function fbtTrackerRow(page: Page): ElementNode {
  return page.document.querySelector(".cx-az-fbt__row") as ElementNode;
}

/**
 * A pill click EXACTLY as the live page performs it:
 *   1. the theme's own click handler moves class "active" from the current
 *      pill to the clicked one, synchronously, before anything else runs;
 *   2. the bystander FBT widget re-points its first row at the new variant
 *      ~100ms later, ON ITS OWN SCHEDULE — inside the sandbox's virtual
 *      clock (scheduleTimer IS the page's window.setTimeout), so it races
 *      our 60ms re-read exactly as observed live;
 *   3. the click bubbles up from the pill.
 */
function clickOtherPill(page: Page): void {
  const pills = sizePills(page);
  pills.current.setAttribute("class", "btn btn--outline btn--flex");
  pills.other.setAttribute("class", "btn btn--outline btn--flex active");
  scheduleTimer(() => {
    fbtTrackerRow(page).setAttribute("data-variant-id", OTHER_VARIANT);
  }, 100);
  pills.other.dispatchEvent(new EventShim("click", { bubbles: true }));
  page.flush();
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

// ── g: the size pills and the bystander that updates late ────────────────────

/**
 * THE ONE-CLICK-BEHIND DEFECT, measured on the markup that produced it.
 *
 * On the live PDP a pill click leaves THREE generations of variant evidence
 * on the page at once: the clicked pill's own data-val-id (correct,
 * immediately), the theme's "active" class (correct, painted synchronously
 * by the theme's click handler), and the bystander FBT widget's first row
 * (STALE for ~100ms, then correct). The pre-fix re-read fired once at 60ms
 * and took the first match in document order — the stale bystander row —
 * so the widget pushed the PREVIOUS variant after every click and stayed
 * one behind forever. These tests drive the REAL files over that exact
 * race, and the mutation check at the end cuts the fix's layers and
 * watches the one-behind defect return.
 */
describe("the size pills (data-val-id) and the racing bystander marker", () => {
  it("a pill click drives the widget to the CLICKED variant despite a stale bystander row", () => {
    const page = buildPage();
    expect(currentState(page)).toMatchObject({ variantId: OUR_VARIANT });

    clickOtherPill(page);

    // The widget followed the SHOPPER, not the bystander's stale row: the
    // clicked pill's id (and the theme's own "active" paint) outrank a
    // passive marker that was still naming the previous variant when the
    // 60ms re-read fired.
    expect(currentState(page)).toMatchObject({ variantId: OTHER_VARIANT });
    // …and the theme's button still shows a coherent money string. The
    // fixture theme never repaints its own button (a real Sleepify prints
    // the new variant's price itself), so the only honest display is the
    // theme's OWN text — the island's small-variant subscription price
    // (CHF 51.20) must be gone, never left stale beside a 50 ml selection.
    expect(page.atcButton.textContent).toBe(ATC_LABEL);
    expect(page.atcButton.textContent).not.toContain(SUB_MONEY);
  });

  it("the dirty (whitespace-padded) pill id is trimmed", () => {
    const page = buildPage();
    const pills = sizePills(page);
    // Non-vacuous: the attribute really is padded on the pill we click.
    expect(pills.other.getAttribute("data-val-id")).toBe(DIRTY_OTHER_VARIANT);

    clickOtherPill(page);

    // The widget landed on the CLEAN id: an untrimmed read would have
    // compared "4411100011102\n      " against the island keys, found
    // nothing, and left the widget frozen on the 30 ml variant.
    const state = currentState(page) as Record<string, unknown>;
    expect(state.variantId).toBe(OTHER_VARIANT);
  });

  it("one-time keeps the theme's button text after a pill switch", () => {
    const page = buildPage();
    selectMode(page, "one_time");
    expect(page.atcButton.textContent).toBe(ATC_LABEL);

    clickOtherPill(page);

    // The variant followed the click, but with one-time selected the theme's
    // button is not ours to rewrite — its own text stays, byte-identical.
    expect(currentState(page)).toMatchObject({
      mode: "one_time",
      variantId: OTHER_VARIANT,
    });
    expect(page.atcButton.textContent).toBe(ATC_LABEL);
  });

  /* ── MUTATION CHECK: cut every fix layer, watch one-behind return ─────────
     The fix is layered across BOTH files, and each cut below removes one
     layer from the shipped source (each replacement is asserted to really
     change it):
       a. markerId() loses the data-val-id vocabulary — the pills' ids
          become invisible to the embed's click handler and DOM re-read;
       b. markerActiveSignal() (embed) and markerActive() (buy-box.js) are
          neutered — the theme's own "active" paint stops outranking the
          bystander row, in both files' tier lists;
       c. the staggered re-reads that let a LATE bystander update be
          corrective are removed: the embed's 350ms/900ms passes, and the
          same layer in buy-box.js's click delegation (its second, +350ms
          pass — the one that would re-read AFTER the bystander settles).
     What remains is exactly the pre-fix behavior: one 60ms re-read racing
     a bystander that updates at 100ms. */

  const CUT_PILL_VOCABULARY = (source: string): string =>
    source.replace("el.getAttribute('data-val-id') ||\n", "");

  const NEUTER_EMBED_ACTIVE_SIGNAL = (source: string): string =>
    source.replace(
      "function markerActiveSignal(el) {",
      "function markerActiveSignal(el) { if (1) return false;",
    );

  const CUT_EMBED_RE_READS = (source: string): string =>
    source
      .replace("window.setTimeout(reReadVariant, 350);", "")
      .replace("window.setTimeout(reReadVariant, 900);", "");

  const NEUTER_BUYBOX_ACTIVE_SIGNAL = (source: string): string =>
    source.replace(
      "function markerActive(el) {",
      "function markerActive(el) { if (1) return false;",
    );

  const CUT_BUYBOX_LATE_RE_READ = (source: string): string =>
    source.replace(
      "window.setTimeout(function () {\n        reReadVariant(true);\n      }, 350);",
      "",
    );

  const MUTATE_EMBED = (source: string): string =>
    CUT_EMBED_RE_READS(NEUTER_EMBED_ACTIVE_SIGNAL(CUT_PILL_VOCABULARY(source)));

  const MUTATE_BUY_BOX = (source: string): string =>
    CUT_BUYBOX_LATE_RE_READ(NEUTER_BUYBOX_ACTIVE_SIGNAL(source));

  it("MUTATION CHECK: with the fix layers cut, the same click lands ONE BEHIND", () => {
    // Every cut really rewrites the file it claims to rewrite (vacuity).
    const embedOriginal = readFileSync(EMBED_JS, "utf8");
    expect(CUT_PILL_VOCABULARY(embedOriginal)).not.toBe(embedOriginal);
    expect(NEUTER_EMBED_ACTIVE_SIGNAL(embedOriginal)).not.toBe(embedOriginal);
    expect(CUT_EMBED_RE_READS(embedOriginal)).not.toBe(embedOriginal);
    const buyBoxOriginal = readFileSync(BUY_BOX_JS, "utf8");
    expect(NEUTER_BUYBOX_ACTIVE_SIGNAL(buyBoxOriginal)).not.toBe(buyBoxOriginal);
    expect(CUT_BUYBOX_LATE_RE_READ(buyBoxOriginal)).not.toBe(buyBoxOriginal);

    const page = buildPage({
      mutateEmbed: MUTATE_EMBED,
      mutateBuyBox: MUTATE_BUY_BOX,
    });
    expect(page.sourceChanged).toBe(true);
    expect(page.buyBoxSourceChanged).toBe(true);
    expect(currentState(page)).toMatchObject({ variantId: OUR_VARIANT });

    clickOtherPill(page);

    // The live defect, reproduced: with the pill vocabulary cut the click
    // itself carries no id; with the active tiers cut and the late re-reads
    // gone, the only remaining evidence is the bystander row — read at 60ms,
    // 40ms BEFORE it updates. The widget is one click behind the shopper:
    // it still answers with the 30 ml variant after a 50 ml click, which is
    // exactly the wrong selling plan and the wrong price at the cart. The
    // green tests above therefore depend on the fix layers, not the fixture.
    expect(currentState(page)).toMatchObject({ variantId: OUR_VARIANT });
  });
});

// ── h: the theme's MAIN price display ────────────────────────────────────────

/**
 * The price under the product title (.pdp__price) is the FIRST price a
 * shopper reads, and before v1.11.0 it kept quoting the one-time price while
 * the widget (subscription preselected) and the cart charged the
 * subscription price — two different numbers on one screen. The sync swaps
 * the exact one-time money string for the subscription one, and ONLY that:
 * the struck compare-at and the per-unit line are not the one-time string
 * and must stay byte-identical (this module never computes money), and the
 * other vendor's copy of the SAME string is not a target at all.
 */
describe("theme main price display", () => {
  it("shows the subscription money in the current-price span after boot", () => {
    // Byte-level baselines, captured from the page as the server sent it.
    const raw = buildPage({ runAssets: false });
    const rawDiscount = serialize(
      raw.document.querySelector(".pdp__price .price__discount") as ElementNode,
    );
    const rawUnitWrap = serialize(
      raw.document.querySelector(".pdp__price .unit-wrap") as ElementNode,
    );

    const page = buildPage();
    // Subscription is preselected (classic default), so the headline price
    // must agree with the widget and the cart…
    expect(
      page.document.querySelector(".pdp__price [sm-rc-current-price]")
        ?.textContent,
    ).toBe(SUB_MONEY);
    // …while the struck compare-at and the per-unit line — inside the SAME
    // synced block — are byte-for-byte what the server sent.
    expect(
      serialize(
        page.document.querySelector(
          ".pdp__price .price__discount",
        ) as ElementNode,
      ),
    ).toBe(rawDiscount);
    expect(
      serialize(
        page.document.querySelector(".pdp__price .unit-wrap") as ElementNode,
      ),
    ).toBe(rawUnitWrap);
    // The other vendor's identical money string is not a target.
    expect(page.foreign.querySelector(".cx__price")?.textContent).toBe(
      ONE_TIME_MONEY,
    );
  });

  it("returns the theme's exact original text when the shopper picks one-time", () => {
    const page = buildPage();
    expect(
      page.document.querySelector(".pdp__price [sm-rc-current-price]")
        ?.textContent,
    ).toBe(SUB_MONEY);

    selectMode(page, "one_time");

    // The theme owns its price again — headline and button both restored to
    // the byte-exact strings it printed, nothing else disturbed.
    expect(
      page.document.querySelector(".pdp__price [sm-rc-current-price]")
        ?.textContent,
    ).toBe(ONE_TIME_MONEY);
    expect(page.atcButton.textContent).toBe(ATC_LABEL);
    expect(
      page.document.querySelector(".pdp__price .price__discount")?.textContent,
    ).toBe(COMPARE_MONEY);
    expect(
      page.document.querySelector(".pdp__price .per-unit")?.textContent,
    ).toBe(PER_UNIT_TEXT);
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

  it("reports the rendered preselect through getState() (the seen stamp's source)", () => {
    // The harness renders the default design: subscription preselected. The
    // flag is the widget's RENDER decision, so it must not follow the mode.
    const page = buildPage();
    expect(currentState(page)).toMatchObject({ preselect: true, design: "classic" });
    selectMode(page, "one_time");
    expect(currentState(page)).toMatchObject({ preselect: true, mode: "one_time" });
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
    expect(out.get("items[0][properties][_cellexia_seen]")).toBe(SEEN);
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
    expect(out.get("items[0][properties][_cellexia_seen]")).toBe(SEEN);
    expect(out.get("items[0][id]")).toBe(OUR_VARIANT);
    expect(form.get("items[0][selling_plan]")).toBeNull();
    expect(form.get("items[0][properties][_cellexia_seen]")).toBeNull();
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
    expect(out.items[0].properties).toEqual({
      _cellexia_design: "classic",
      _cellexia_seen: SEEN,
    });
    expect(out.items[0].id).toBe(Number(OUR_VARIANT));
  });

  it("injects into the flat urlencoded body themes also use", () => {
    const page = buildPage();
    const out = new URLSearchParams(
      String(page.xhrPost(`id=${OUR_VARIANT}&quantity=1`)),
    );
    expect(out.get("selling_plan")).toBe(PLAN_ID);
    expect(out.get("properties[_cellexia_design]")).toBe("classic");
    expect(out.get("properties[_cellexia_seen]")).toBe(SEEN);
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

  /**
   * Some theme JS reads the widget's selection into a hand-built payload:
   * the adopted selling_plan field travels, the properties input does not.
   * The order would be perfectly right and the design attribution silently
   * gone — a per-theme hole in take-rate-by-design that nothing else can
   * see (checkout.subscribable and the contract still count). So the
   * patcher completes such a line instead of skipping it: the design is
   * stamped, the theme's own plan value is untouched, and a plan id that is
   * not ours keeps the byte-identical pass-through.
   */
  it("completes a body that already carries OUR selling plan with the design (and seen)", () => {
    const page = buildPage();
    const original =
      `items%5B0%5D%5Bid%5D=${OUR_VARIANT}&items%5B0%5D%5Bquantity%5D=1` +
      `&items%5B0%5D%5Bselling_plan%5D=${PLAN_ID}`;
    const out = new URLSearchParams(String(page.xhrPost(original)));

    expect(out.get("items[0][properties][_cellexia_design]")).toBe("classic");
    expect(out.get("items[0][properties][_cellexia_seen]")).toBe(SEEN);
    // Completed, not rewritten: the theme's plan value survives, exactly once.
    expect(out.getAll("items[0][selling_plan]")).toEqual([PLAN_ID]);
    expect(out.get("items[0][id]")).toBe(OUR_VARIANT);
    expect(out.get("items[0][quantity]")).toBe("1");
    expect(String(page.sent[page.sent.length - 1].body)).not.toContain(
      "_cx_design",
    );
  });

  it("leaves a body carrying another app's selling plan byte-identical", () => {
    const page = buildPage();
    // Another app's line: no plan rewrite, no design, and no seen stamp
    // either — a foreign subscription is not our exposure to record.
    const original =
      `items%5B0%5D%5Bid%5D=${OUR_VARIANT}&items%5B0%5D%5Bselling_plan%5D=123`;
    expect(page.xhrPost(original)).toBe(original);
  });

  it("never stamps a design once the shopper picked one-time, even over our plan id", () => {
    const page = buildPage();
    selectMode(page, "one_time");
    // A stale plan the theme kept serializing is not provably this page
    // view's choice once one-time is selected — and stripping it is not the
    // patcher's job either. Not provably ours ⇒ no seen stamp either.
    const original =
      `items%5B0%5D%5Bid%5D=${OUR_VARIANT}&items%5B0%5D%5Bselling_plan%5D=${PLAN_ID}`;
    expect(page.xhrPost(original)).toBe(original);
  });

  it("passes another vendor's add-to-cart through byte-identical", () => {
    const page = buildPage();
    // The page's OTHER cx-namespace widget posting its own product: rewriting
    // it would 422 their checkout — and it gets no exposure stamp either.
    const original =
      `items%5B0%5D%5Bid%5D=${FOREIGN_VARIANT}&items%5B0%5D%5Bquantity%5D=1`;
    expect(page.xhrPost(original)).toBe(original);

    const form = new FormData();
    form.append("id", FOREIGN_VARIANT);
    expect(page.xhrPost(form)).toBe(form);

    // …in both modes.
    selectMode(page, "one_time");
    expect(page.xhrPost(original)).toBe(original);
    expect(page.xhrPost(form)).toBe(form);
  });

  it("stamps ONLY the exposure once the shopper picks one-time (the take-rate denominator)", () => {
    const page = buildPage();
    selectMode(page, "one_time");
    expect(currentState(page)).toMatchObject({
      mode: "one_time",
      sellingPlanId: null,
      preselect: true,
    });

    const encoded = new URLSearchParams(
      String(
        page.xhrPost(
          `items%5B0%5D%5Bid%5D=${OUR_VARIANT}&items%5B0%5D%5Bquantity%5D=1`,
        ),
      ),
    );
    expect(encoded.get("items[0][properties][_cellexia_seen]")).toBe(SEEN);
    expect(encoded.get("items[0][id]")).toBe(OUR_VARIANT);
    expect(encoded.get("items[0][quantity]")).toBe("1");

    const flat = new URLSearchParams(
      String(page.xhrPost(`id=${OUR_VARIANT}&quantity=1`)),
    );
    expect(flat.get("properties[_cellexia_seen]")).toBe(SEEN);

    const json = JSON.parse(
      String(
        page.xhrPost(
          JSON.stringify({ items: [{ id: Number(OUR_VARIANT), quantity: 1 }] }),
        ),
      ),
    ) as { items: Array<Record<string, unknown>> };
    expect(json.items[0]).toEqual({
      id: Number(OUR_VARIANT),
      quantity: 1,
      properties: { _cellexia_seen: SEEN },
    });

    const form = new FormData();
    form.append("items[0][id]", OUR_VARIANT);
    form.append("items[0][quantity]", "1");
    const formOut = page.xhrPost(form) as FormData;
    expect(formOut).toBeInstanceOf(FormData);
    expect(formOut.get("items[0][properties][_cellexia_seen]")).toBe(SEEN);
    expect(form.get("items[0][properties][_cellexia_seen]")).toBeNull();

    // No subscription and no design attribution went out on any of them.
    for (const request of page.sent) {
      const body =
        request.body instanceof FormData
          ? new URLSearchParams(
              [...request.body.entries()].map(([k, v]) => [k, String(v)]),
            ).toString()
          : String(request.body);
      expect(body).not.toContain("selling_plan");
      expect(body).not.toContain("_cellexia_design");
    }
  });

  it("never overwrites a seen value that already travelled", () => {
    const page = buildPage();
    selectMode(page, "one_time");
    const stamped =
      `items%5B0%5D%5Bid%5D=${OUR_VARIANT}` +
      `&items%5B0%5D%5Bproperties%5D%5B_cellexia_seen%5D=tiles%7Co`;
    expect(page.xhrPost(stamped)).toBe(stamped);

    selectMode(page, "subscription");
    const out = new URLSearchParams(String(page.xhrPost(stamped)));
    expect(out.getAll("items[0][properties][_cellexia_seen]")).toEqual(["tiles|o"]);
    expect(out.get("items[0][selling_plan]")).toBe(PLAN_ID);
    expect(out.get("items[0][properties][_cellexia_design]")).toBe("classic");
  });

  it("touches nothing while the shop is still in setup mode", () => {
    const page = buildPage({ launchStatus: "setup" });
    // The visitor cannot see a purchase option, so nothing may reach the
    // cart: no plan, no design — and no seen stamp, so an order placed with
    // the widget hidden stays distinguishable from one that saw it.
    expect(currentState(page)).toBeNull();
    for (const original of [
      `items%5B0%5D%5Bid%5D=${OUR_VARIANT}&items%5B0%5D%5Bquantity%5D=1`,
      `id=${OUR_VARIANT}&quantity=1`,
      JSON.stringify({ items: [{ id: Number(OUR_VARIANT), quantity: 1 }] }),
    ]) {
      expect(page.xhrPost(original)).toBe(original);
    }
    const form = new FormData();
    form.append("id", OUR_VARIANT);
    expect(page.xhrPost(form)).toBe(form);
  });

  it("leaves requests that are not a cart add alone", () => {
    const page = buildPage();
    const original = `items%5B0%5D%5Bid%5D=${OUR_VARIANT}`;
    expect(page.xhrPost(original, "/cart/change.js")).toBe(original);
  });
});

// ── The preselect variable, rendered the OTHER way ───────────────────────────

/**
 * Preselect is the experiment's second variable (merchant decision v1.26.0:
 * tracked on its own, never inferred from the mode). Every other real render
 * in this file has the subscription preselected, so a buy-box.js that
 * hard-wired getState().preselect to true and the seen suffix to "s" would
 * pass all of them: this block renders the REAL Liquid with one-time
 * preselected (and once with a legacy island that has no `preselect` field
 * at all) and drives the REAL assets, so the derivation itself is measured.
 */
describe("the preselect variable, rendered the other way", () => {
  /** The suffix the widget derives from the island for THIS render. */
  const SEEN_ONE_TIME = "classic|o";
  const SEEN_UNKNOWN = "classic|u";

  it("the one-time-preselected render is a real render of the same preset", () => {
    // Vacuity guard: the two renders differ ONLY in the island's preselect
    // flag (and whatever the Liquid keys off it), never in the preset.
    expect(EMBED_LIVE_ONE_TIME).not.toBe(EMBED_LIVE);
    expect(EMBED_LIVE).toMatch(/"preselect":\s*true/);
    expect(EMBED_LIVE_ONE_TIME).toMatch(/"preselect":\s*false/);
    expect(EMBED_LIVE_ONE_TIME).not.toMatch(/"preselect":\s*true/);
  });

  it("reports preselect false through getState() and stamps <preset>|o on a one-time add", () => {
    const page = buildPage({ embedMarkup: EMBED_LIVE_ONE_TIME });
    expect(page.widget).not.toBeNull();
    // The rendered default IS one-time here, so mode and preselect agree
    // at boot — and both are false/one_time for different reasons.
    expect(currentState(page)).toMatchObject({
      preselect: false,
      design: "classic",
      mode: "one_time",
      sellingPlanId: null,
    });

    const flat = new URLSearchParams(
      String(page.xhrPost(`id=${OUR_VARIANT}&quantity=1`)),
    );
    expect(flat.get("properties[_cellexia_seen]")).toBe(SEEN_ONE_TIME);
    expect(flat.get("selling_plan")).toBeNull();
    expect(flat.get("properties[_cellexia_design]")).toBeNull();

    const encoded = new URLSearchParams(
      String(
        page.xhrPost(
          `items%5B0%5D%5Bid%5D=${OUR_VARIANT}&items%5B0%5D%5Bquantity%5D=1`,
        ),
      ),
    );
    expect(encoded.get("items[0][properties][_cellexia_seen]")).toBe(SEEN_ONE_TIME);

    const json = JSON.parse(
      String(
        page.xhrPost(
          JSON.stringify({ items: [{ id: Number(OUR_VARIANT), quantity: 1 }] }),
        ),
      ),
    ) as { items: Array<Record<string, unknown>> };
    expect(json.items[0].properties).toEqual({ _cellexia_seen: SEEN_ONE_TIME });
  });

  it("keeps the |o suffix after the shopper switches TO subscription (render decision, not the mode)", () => {
    const page = buildPage({ embedMarkup: EMBED_LIVE_ONE_TIME });
    selectMode(page, "subscription");
    expect(currentState(page)).toMatchObject({
      preselect: false,
      mode: "subscription",
      sellingPlanId: PLAN_ID,
    });

    const out = new URLSearchParams(
      String(page.xhrPost(`id=${OUR_VARIANT}&quantity=1`)),
    );
    // Subscription add: plan + design + seen — and seen still says the
    // widget was rendered with one-time preselected.
    expect(out.get("selling_plan")).toBe(PLAN_ID);
    expect(out.get("properties[_cellexia_design]")).toBe("classic");
    expect(out.get("properties[_cellexia_seen]")).toBe(SEEN_ONE_TIME);
    expect(out.get("properties[_cellexia_seen]")).not.toBe(SEEN);
  });

  /**
   * The AJAX path's "u": buy-box-embed.js documents it as "a buy-box.js that
   * predates the field" — the CDN edge skew this store is known for (one
   * asset version per edge), where the NEW companion patches requests over a
   * pre-v1.26.0 buy-box.js whose getState() has no `preselect` key. The
   * island itself has carried `preselect` since the v1.9.0 baseline, so an
   * island without it is not a production state on this path (getState()
   * coerces it to a boolean anyway); the theme-form path's own island
   * derivation, where "u" IS reachable, is pinned in
   * tests/buybox-foreign-section-form.test.ts.
   */
  it("a getState() without a `preselect` key (older buy-box.js under the new companion) yields <preset>|u, never a guess", () => {
    const page = buildPage({
      mutateBuyBox: (source) =>
        source.replace(
          /\n\s*preselect: data\.preselect === true,\n/,
          "\n",
        ),
    });
    expect(page.buyBoxSourceChanged).toBe(true); // vacuity guard
    expect(page.widget).not.toBeNull();
    const state = currentState(page) as Record<string, unknown>;
    expect(state).not.toHaveProperty("preselect");
    expect(state).toMatchObject({ design: "classic", mode: "subscription" });

    // Subscription add: plan + design + seen "…|u".
    const out = new URLSearchParams(
      String(page.xhrPost(`id=${OUR_VARIANT}&quantity=1`)),
    );
    expect(out.get("selling_plan")).toBe(PLAN_ID);
    expect(out.get("properties[_cellexia_design]")).toBe("classic");
    expect(out.get("properties[_cellexia_seen]")).toBe(SEEN_UNKNOWN);

    // One-time add: seen "…|u" alone.
    selectMode(page, "one_time");
    const oneTime = new URLSearchParams(
      String(page.xhrPost(`id=${OUR_VARIANT}&quantity=1`)),
    );
    expect(oneTime.get("properties[_cellexia_seen]")).toBe(SEEN_UNKNOWN);
    expect(oneTime.get("selling_plan")).toBeNull();
    expect(oneTime.get("properties[_cellexia_design]")).toBeNull();
  });
});
