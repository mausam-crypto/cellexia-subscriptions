import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

/**
 * BEHAVIOUR of the theme add-to-cart price sync in
 * extensions/cellexia-buy-box/assets/buy-box.js.
 *
 * The defect, observed live on cellexialabs.com: with the SUBSCRIPTION option
 * preselected (CHF 51.20 first order) the theme's own button still read
 * "ADD TO CART - CHF 64.00". The fix swaps the money STRING inside that
 * button's text nodes — which means this module writes into markup the app
 * does not own, on the last click before the cart. Everything that makes that
 * safe is behaviour, not shape, so it is asserted here by running the REAL
 * file:
 *
 *   - it swaps only the exact one-time money string, and only in text nodes;
 *   - a button with no price is left byte-identical (no currency guessing);
 *   - one-time / hidden / gated restores the theme's own text exactly;
 *   - a theme that rewrites the button (Sleepify does, on every variant
 *     change) is followed, and reverting then restores the theme's NEWEST
 *     text, never a stale one;
 *   - the header cart pill and the cart drawer are never touched;
 *   - a theme that fights back cannot cause an infinite ping-pong: the module
 *     switches itself off and gives the button back.
 *
 * The DOM shim below is deliberately tiny and its own semantics are asserted
 * first, so a shim bug can never be mistaken for the subject passing. The
 * selector engine supports exactly what the module uses: comma lists,
 * descendant combinators, tag / .class / #id / [attr] / [attr="value"].
 */

const BUY_BOX_JS = fileURLToPath(
  new URL("../extensions/cellexia-buy-box/assets/buy-box.js", import.meta.url),
);

// ── A minimal, honest node tree ──────────────────────────────────────────────

type AnyNode = ElementShim | TextShim;

class TextShim {
  nodeType = 3;
  nodeName = "#text";
  parentNode: ElementShim | null = null;
  private value: string;
  /** Every write notifies the MutationObserver registry, like a browser. */
  constructor(value: string) {
    this.value = value;
  }
  get nodeValue(): string {
    return this.value;
  }
  set nodeValue(next: string) {
    this.value = next;
    notifyMutation(this);
  }
  get isConnected(): boolean {
    return this.parentNode ? this.parentNode.isConnected : false;
  }
}

class ElementShim {
  nodeType = 1;
  nodeName: string;
  attributes: Record<string, string> = {};
  childNodes: AnyNode[] = [];
  parentNode: ElementShim | null = null;
  /** Set on the one element that stands in for <body>. */
  isBody = false;

  constructor(nodeName: string, attributes: Record<string, string> = {}) {
    this.nodeName = nodeName.toUpperCase();
    this.attributes = { ...attributes };
  }

  append(...children: AnyNode[]): this {
    for (const child of children) {
      child.parentNode = this;
      this.childNodes.push(child);
    }
    return this;
  }

  getAttribute(name: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.attributes, name)
      ? this.attributes[name]
      : null;
  }

  get isConnected(): boolean {
    if (this.isBody) return true;
    return this.parentNode ? this.parentNode.isConnected : false;
  }

  contains(node: AnyNode | null): boolean {
    let current: AnyNode | null = node;
    while (current) {
      if (current === (this as unknown as AnyNode)) return true;
      current = current.parentNode;
    }
    return false;
  }

  closest(selectorList: string): ElementShim | null {
    let current: ElementShim | null = this;
    while (current) {
      if (matchesList(current, selectorList)) return current;
      current = current.parentNode;
    }
    return null;
  }

  querySelectorAll(selectorList: string): ElementShim[] {
    const out: ElementShim[] = [];
    for (const el of descendants(this)) {
      if (matchesList(el, selectorList)) out.push(el);
    }
    return out;
  }

  /** Test convenience: the element's rendered text. */
  get text(): string {
    let out = "";
    for (const child of this.childNodes) {
      out += child instanceof TextShim ? child.nodeValue : child.text;
    }
    return out;
  }
}

function descendants(root: ElementShim): ElementShim[] {
  const out: ElementShim[] = [];
  for (const child of root.childNodes) {
    if (child.nodeType === 1) {
      out.push(child as ElementShim);
      out.push(...descendants(child as ElementShim));
    }
  }
  return out;
}

function el(
  nodeName: string,
  attributes: Record<string, string> = {},
  ...children: AnyNode[]
): ElementShim {
  return new ElementShim(nodeName, attributes).append(...children);
}

function text(value: string): TextShim {
  return new TextShim(value);
}

// ── Selector engine (comma lists, descendants, tag/.class/#id/[attr]) ────────

interface SimpleSelector {
  tag: string | null;
  id: string | null;
  classes: string[];
  attributes: Array<{ name: string; value: string | null }>;
}

function parseSimple(source: string): SimpleSelector {
  const parsed: SimpleSelector = {
    tag: null,
    id: null,
    classes: [],
    attributes: [],
  };
  let rest = source.trim();
  const tag = /^[a-zA-Z][\w-]*/.exec(rest);
  if (tag) {
    parsed.tag = tag[0].toUpperCase();
    rest = rest.slice(tag[0].length);
  }
  while (rest.length) {
    let match = /^\.([\w-]+)/.exec(rest);
    if (match) {
      parsed.classes.push(match[1]);
      rest = rest.slice(match[0].length);
      continue;
    }
    match = /^#([\w-]+)/.exec(rest);
    if (match) {
      parsed.id = match[1];
      rest = rest.slice(match[0].length);
      continue;
    }
    match = /^\[([\w-]+)(?:=("?)([^\]"]*)\2)?\]/.exec(rest);
    if (match) {
      parsed.attributes.push({
        name: match[1],
        value: match[3] === undefined ? null : match[3],
      });
      rest = rest.slice(match[0].length);
      continue;
    }
    throw new Error(`unsupported selector fragment: ${rest}`);
  }
  return parsed;
}

function matchesSimple(element: ElementShim, selector: SimpleSelector): boolean {
  if (selector.tag && element.nodeName !== selector.tag) return false;
  if (selector.id && element.getAttribute("id") !== selector.id) return false;
  const classes = (element.getAttribute("class") ?? "").split(/\s+/);
  for (const className of selector.classes) {
    if (classes.indexOf(className) === -1) return false;
  }
  for (const attribute of selector.attributes) {
    const value = element.getAttribute(attribute.name);
    if (value === null) return false;
    if (attribute.value !== null && value !== attribute.value) return false;
  }
  return true;
}

/** Descendant combinators only — the module uses nothing else. */
function matchesCompound(element: ElementShim, compound: string): boolean {
  const parts = compound.trim().split(/\s+/).map(parseSimple);
  const last = parts.pop() as SimpleSelector;
  if (!matchesSimple(element, last)) return false;
  let current = element.parentNode;
  for (let i = parts.length - 1; i >= 0; i--) {
    let found = false;
    while (current) {
      if (matchesSimple(current, parts[i])) {
        found = true;
        current = current.parentNode;
        break;
      }
      current = current.parentNode;
    }
    if (!found) return false;
  }
  return true;
}

function matchesList(element: ElementShim, selectorList: string): boolean {
  for (const compound of selectorList.split(",")) {
    if (compound.trim() === "") continue;
    if (matchesCompound(element, compound)) return true;
  }
  return false;
}

// ── MutationObserver shim ────────────────────────────────────────────────────

interface Registration {
  target: ElementShim;
  callback: () => void;
  observer: MutationObserverShim;
}

let registry: Registration[] = [];

class MutationObserverShim {
  private callback: () => void;
  constructor(callback: () => void) {
    this.callback = callback;
  }
  observe(target: ElementShim): void {
    registry.push({ target, callback: this.callback, observer: this });
  }
  disconnect(): void {
    registry = registry.filter((entry) => entry.observer !== this);
  }
}

/**
 * Timers scheduled by the shim or by the module under test that have not run
 * yet. Every async hop in this file goes through here, which is what lets
 * `tick` below be a real barrier instead of a guess about wall-clock timing.
 */
const liveTimers = new Set<ReturnType<typeof setTimeout>>();

function trackedSetTimeout(
  callback: () => void,
  ms?: number,
): ReturnType<typeof setTimeout> {
  const handle: ReturnType<typeof setTimeout> = setTimeout(() => {
    liveTimers.delete(handle);
    callback();
  }, ms);
  liveTimers.add(handle);
  return handle;
}

function trackedClearTimeout(handle: ReturnType<typeof setTimeout>): void {
  liveTimers.delete(handle);
  clearTimeout(handle);
}

function notifyMutation(node: AnyNode): void {
  for (const entry of registry.slice()) {
    if (entry.target.contains(node)) {
      trackedSetTimeout(entry.callback, 0);
    }
  }
}

/**
 * Wait until everything the test just provoked has actually finished.
 *
 * The chain is two timers deep: a text write notifies the observer on a
 * timer, and the module answers that notification with another
 * `setTimeout(…, 0)` of its own before it re-syncs. A fixed sleep is NOT a
 * barrier for that chain. Under load — a cold first run, a GC pause — the
 * event loop can stall long enough that the chain's first timer and the
 * sleep both come due in the same timers phase; the sleep then resolves in
 * that phase, one step ahead of the re-sync, and the assertion reads the
 * button before the module has rewritten it. That was the whole of the
 * intermittent failure here, and it lived in this harness, never in the
 * shipped file. So drain rather than sleep: yield a full timers phase at a
 * time until nothing is pending, which is a barrier on any machine at any
 * load. The deadline only stops a runaway rescheduler from hanging the run.
 */
const tick = async (): Promise<void> => {
  const deadline = Date.now() + 1000;
  do {
    await new Promise((resolve) => setTimeout(resolve, 0));
  } while (liveTimers.size > 0 && Date.now() < deadline);
};

// ── Loading the real file ────────────────────────────────────────────────────

/**
 * The price-sync module is internal to buy-box.js's IIFE (nothing in a theme
 * app extension is importable). ONE documented seam: an assignment appended
 * just inside the IIFE's closing `})();` hands the factory to the test. The
 * file itself is otherwise byte-for-byte what ships.
 */
function loadPriceSyncFactory(document: unknown, windowShim: unknown): {
  createPriceSync: (
    root: ElementShim,
    api: Record<string, () => unknown>,
  ) => { sync: () => void };
} {
  const source = readFileSync(BUY_BOX_JS, "utf8");
  const closing = source.lastIndexOf("})();");
  expect(
    closing,
    "buy-box.js must be a single closed IIFE for the test seam to apply",
  ).toBeGreaterThan(0);
  const instrumented =
    source.slice(0, closing) +
    "  globalThis.__cxPriceSyncFactory = createPriceSync;\n" +
    source.slice(closing);

  const context = vm.createContext({
    window: windowShim,
    document,
    console: { warn() {}, error() {}, log() {} },
  });
  vm.runInContext(instrumented, context);
  const factory = (context as { __cxPriceSyncFactory?: unknown })
    .__cxPriceSyncFactory;
  expect(typeof factory, "the seam must expose createPriceSync").toBe(
    "function",
  );
  return { createPriceSync: factory as never };
}

// ── Fixture: the Sleepify PDP shape from the bug report ──────────────────────

const ONE_TIME = "CHF 64.00";
const SUB_FIRST = "CHF 51.20";

interface Fixture {
  body: ElementShim;
  widget: ElementShim;
  button: ElementShim;
  buttonText: TextShim;
  sync: () => void;
  state: {
    hidden: boolean;
    subscription: boolean;
    oneTime: string;
    sub: string;
  };
}

function makeFixture(
  rootAttributes: Record<string, string> = {},
  options: { buttonLabel?: string; extra?: (body: ElementShim) => void } = {},
): Fixture {
  registry = [];

  const buttonText = text(
    options.buttonLabel === undefined
      ? `ADD TO CART - ${ONE_TIME}`
      : options.buttonLabel,
  );
  const button = el(
    "button",
    { class: "btn btn--primary btn--atc", type: "submit" },
    buttonText,
  );

  const widget = el("div", {
    class: "cx-buybox",
    "data-cellexia-money-onetime": ONE_TIME,
    "data-cellexia-money-sub": SUB_FIRST,
    "data-cellexia-price-sync": "true",
    "data-cellexia-price-selector": "",
    ...rootAttributes,
  });

  const buyColumn = el(
    "div",
    { class: "pdp__info" },
    widget,
    el(
      "div",
      { class: "pdp__grey" },
      el(
        "div",
        { class: "pdp__actions" },
        el("div", { class: "action--atc" }, button),
      ),
    ),
  );

  const body = el("body", {}, el("main", {}, buyColumn));
  body.isBody = true;
  if (options.extra) options.extra(body);

  const document = {
    body,
    querySelectorAll: (selector: string) => body.querySelectorAll(selector),
    getElementById: () => null,
    readyState: "complete",
    addEventListener: () => {},
    dispatchEvent: () => true,
  };
  const windowShim: Record<string, unknown> = {
    /* Tracked, so `tick` can tell when the module's own deferred work is
       done — the module answers a theme mutation on a timer of its own. */
    setTimeout: trackedSetTimeout,
    clearTimeout: trackedClearTimeout,
    MutationObserver: MutationObserverShim,
    location: { search: "" },
    history: {},
    sessionStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    addEventListener: () => {},
    dispatchEvent: () => true,
  };
  windowShim.window = windowShim;

  const { createPriceSync } = loadPriceSyncFactory(document, windowShim);

  const state = {
    hidden: false,
    subscription: true,
    oneTime: ONE_TIME,
    sub: SUB_FIRST,
  };
  const instance = createPriceSync(widget, {
    isHidden: () => state.hidden,
    isSubscription: () => state.subscription,
    oneTimeMoney: () => state.oneTime,
    subMoney: () => state.sub,
  });

  return {
    body,
    widget,
    button,
    buttonText,
    state,
    sync: () => instance.sync(),
  };
}

// ── The shim's own semantics (so a shim bug cannot pass as a success) ────────

describe("DOM shim", () => {
  it("matches the selectors the module actually uses", () => {
    const fixture = makeFixture();
    expect(fixture.body.querySelectorAll(".pdp__actions .btn--atc")).toEqual([
      fixture.button,
    ]);
    expect(fixture.body.querySelectorAll('button[name="add"]')).toEqual([]);
    expect(fixture.button.closest(".pdp__grey")).not.toBeNull();
    expect(fixture.button.closest("header")).toBeNull();
    expect(fixture.button.text).toBe(`ADD TO CART - ${ONE_TIME}`);
  });

  it("reports connectedness and notifies observers on a text write", async () => {
    const fixture = makeFixture();
    expect(fixture.buttonText.isConnected).toBe(true);
    let fired = 0;
    const observer = new MutationObserverShim(() => {
      fired += 1;
    });
    observer.observe(fixture.button);
    fixture.buttonText.nodeValue = "changed";
    await tick();
    expect(fired).toBe(1);
    observer.disconnect();
    fixture.buttonText.nodeValue = "changed again";
    await tick();
    expect(fired).toBe(1);
  });
});

// ── The swap ─────────────────────────────────────────────────────────────────

describe("theme price sync", () => {
  it("puts the subscription price on the theme's button", () => {
    const fixture = makeFixture();
    fixture.sync();
    expect(fixture.button.text).toBe(`ADD TO CART - ${SUB_FIRST}`);
  });

  it("swaps on an entity money format — the island carries parser-decoded characters", () => {
    // Shop money_format "{{amount}}&nbsp;CHF": the theme's button text node
    // holds a REAL non-breaking space (the parser decoded the entity), and
    // the Liquid island decodes its money at the boundary, so the strings
    // the module compares carry the same character.
    const NBSP = " ";
    const fixture = makeFixture(
      {},
      { buttonLabel: `ADD TO CART - 64.00${NBSP}CHF` },
    );
    fixture.state.oneTime = `64.00${NBSP}CHF`;
    fixture.state.sub = `51.20${NBSP}CHF`;
    fixture.sync();
    expect(fixture.button.text).toBe(`ADD TO CART - 51.20${NBSP}CHF`);
  });

  it("a literal-entity island string (the pre-fix defect) matches nothing — pinned as the failure mode", () => {
    // What the island used to carry: "64.00&nbsp;CHF" with a literal
    // ampersand. No parser-decoded button contains those bytes, so the swap
    // was silently dead on every entity-format shop. This test documents WHY
    // the island must decode.
    const NBSP = " ";
    const fixture = makeFixture(
      {},
      { buttonLabel: `ADD TO CART - 64.00${NBSP}CHF` },
    );
    fixture.state.oneTime = "64.00&nbsp;CHF";
    fixture.state.sub = "51.20&nbsp;CHF";
    fixture.sync();
    expect(fixture.button.text).toBe(`ADD TO CART - 64.00${NBSP}CHF`);
  });

  it("restores the theme's own text when one-time is selected", () => {
    const fixture = makeFixture();
    fixture.sync();
    expect(fixture.button.text).toBe(`ADD TO CART - ${SUB_FIRST}`);

    fixture.state.subscription = false;
    fixture.sync();
    expect(fixture.button.text).toBe(`ADD TO CART - ${ONE_TIME}`);
  });

  it("restores it when the widget is hidden (launch gate, unmounted embed)", () => {
    const fixture = makeFixture();
    fixture.sync();
    fixture.state.hidden = true;
    fixture.sync();
    expect(fixture.button.text).toBe(`ADD TO CART - ${ONE_TIME}`);
  });

  it("does NOTHING when the button shows no price", () => {
    const fixture = makeFixture({}, { buttonLabel: "ADD TO CART" });
    fixture.sync();
    // No currency regex, no guessing which number is the price.
    expect(fixture.button.text).toBe("ADD TO CART");
  });

  it("does nothing when the variant has no subscription price", () => {
    const fixture = makeFixture();
    fixture.state.sub = "";
    fixture.sync();
    expect(fixture.button.text).toBe(`ADD TO CART - ${ONE_TIME}`);
  });

  it("is inert when the design config switched it off", () => {
    const fixture = makeFixture({ "data-cellexia-price-sync": "false" });
    fixture.sync();
    expect(fixture.button.text).toBe(`ADD TO CART - ${ONE_TIME}`);
  });

  it("honours a merchant priceSelector", () => {
    const fixture = makeFixture({
      "data-cellexia-price-selector": ".pdp__actions .btn--atc",
    });
    fixture.sync();
    expect(fixture.button.text).toBe(`ADD TO CART - ${SUB_FIRST}`);
  });

  it("leaves the button alone when a custom selector matches nothing", () => {
    const fixture = makeFixture({
      "data-cellexia-price-selector": ".nothing-here",
    });
    fixture.sync();
    expect(fixture.button.text).toBe(`ADD TO CART - ${ONE_TIME}`);
  });

  it("never rewrites the widget's own price copy", () => {
    const fixture = makeFixture();
    const ours = el(
      "span",
      { class: "btn--atc" },
      text(`Cellexia says ${ONE_TIME}`),
    );
    fixture.widget.append(ours);
    fixture.sync();
    expect(ours.text).toBe(`Cellexia says ${ONE_TIME}`);
  });
});

// ── Scope: the product area, never the header or the cart drawer ─────────────

describe("target scope", () => {
  it("never touches a header cart pill or a cart drawer", () => {
    let headerButton: ElementShim | null = null;
    let drawerButton: ElementShim | null = null;
    const fixture = makeFixture(
      // A selector that only matches OUTSIDE the product area, so the
      // ancestor walk fails and the document-wide fallback runs — which is
      // exactly the path the exclusion list guards.
      { "data-cellexia-price-selector": ".cart-total" },
      {
        extra: (body) => {
          headerButton = el(
            "span",
            { class: "cart-total" },
            text(`Cart: ${ONE_TIME}`),
          );
          drawerButton = el(
            "span",
            { class: "cart-total" },
            text(`Subtotal ${ONE_TIME}`),
          );
          body.append(
            el("header", { class: "site-header" }, headerButton),
            el("div", { class: "cart-drawer" }, drawerButton),
          );
        },
      },
    );

    fixture.sync();
    expect((headerButton as unknown as ElementShim).text).toBe(
      `Cart: ${ONE_TIME}`,
    );
    expect((drawerButton as unknown as ElementShim).text).toBe(
      `Subtotal ${ONE_TIME}`,
    );
  });

  it("prefers the widget's own product area over an identical button elsewhere", () => {
    let otherProduct: ElementShim | null = null;
    const fixture = makeFixture(
      {},
      {
        extra: (body) => {
          otherProduct = el(
            "button",
            { class: "btn--atc" },
            text(`ADD TO CART - ${ONE_TIME}`),
          );
          body.append(el("section", { class: "recommendations" }, otherProduct));
        },
      },
    );

    fixture.sync();
    expect(fixture.button.text).toBe(`ADD TO CART - ${SUB_FIRST}`);
    // A cross-sell card's button is another product's price — untouched.
    expect((otherProduct as unknown as ElementShim).text).toBe(
      `ADD TO CART - ${ONE_TIME}`,
    );
  });
});

// ── Following a theme that rewrites the button ───────────────────────────────

describe("theme rewrites", () => {
  it("re-applies after the theme rewrites the label (variant change)", async () => {
    const fixture = makeFixture();
    fixture.sync();
    expect(fixture.button.text).toBe(`ADD TO CART - ${SUB_FIRST}`);

    // Sleepify's own JS rewrites this text on every variant change.
    fixture.state.oneTime = "CHF 98.00";
    fixture.state.sub = "CHF 78.40";
    fixture.buttonText.nodeValue = "ADD TO CART - CHF 98.00";
    await tick();

    expect(fixture.button.text).toBe("ADD TO CART - CHF 78.40");
  });

  it("reverts to the theme's NEWEST text, never a stale one", async () => {
    const fixture = makeFixture();
    fixture.sync();

    fixture.state.oneTime = "CHF 98.00";
    fixture.state.sub = "CHF 78.40";
    fixture.buttonText.nodeValue = "ADD TO CART - CHF 98.00";
    await tick();
    expect(fixture.button.text).toBe("ADD TO CART - CHF 78.40");

    fixture.state.subscription = false;
    fixture.sync();
    expect(fixture.button.text).toBe("ADD TO CART - CHF 98.00");
  });

  it("does not hear its own writes (no ping-pong with itself)", async () => {
    const fixture = makeFixture();
    fixture.sync();
    const before = fixture.button.text;
    await tick();
    await tick();
    expect(fixture.button.text).toBe(before);
  });

  it("gives the button back and stops if a theme fights every write", () => {
    const fixture = makeFixture();
    // Each pass is a fresh price pair, so each one is an effective write.
    for (let i = 0; i < 30; i++) {
      fixture.state.oneTime = `CHF ${64 + i}.00`;
      fixture.state.sub = `CHF ${51 + i}.00`;
      fixture.buttonText.nodeValue = `ADD TO CART - CHF ${64 + i}.00`;
      fixture.sync();
    }
    // The module switched itself off; the theme's own text stands.
    expect(fixture.button.text).toBe("ADD TO CART - CHF 93.00");

    // …and it stays off, even for a perfectly ordinary sync.
    fixture.state.oneTime = "CHF 93.00";
    fixture.state.sub = SUB_FIRST;
    fixture.sync();
    expect(fixture.button.text).toBe("ADD TO CART - CHF 93.00");
  });
});
