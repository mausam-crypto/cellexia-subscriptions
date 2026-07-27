import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { beforeEach, describe, expect, it } from "vitest";

/**
 * CART-REQUEST INJECTION contract for extensions/cellexia-buy-box/assets/
 * buy-box-embed.js.
 *
 * On cellexialabs.com's "Sleepify" theme there is NO <form action="/cart/add">:
 * add-to-cart is a jQuery XHR, so the ONLY thing that can carry the selected
 * selling plan into the cart is this file's fetch/XHR body patch. Two ways it
 * can fail are both silent and both unacceptable:
 *
 *   - it patches nothing (the shopper who chose "Subscribe" gets a one-time
 *     line, no contract, no error anywhere); this is exactly what happened for
 *     the jQuery `{ items: [{ id, quantity }] }` payload, which serializes to
 *     "items[0][id]=…" and never matched the flat `id` lookup;
 *   - it patches somebody ELSE's request (the page's bundle widget or an
 *     upsell posting a different product), which Shopify rejects with a 422 —
 *     a broken add-to-cart button on a live storefront.
 *
 * The file is plain theme JS with no exports, so it is exercised here the way
 * a browser does: evaluated in a sandbox with a minimal window/document, then
 * driven through the public seam (window.fetch / XMLHttpRequest.send). The
 * assertions are on REQUEST BODIES, never on file contents.
 */

const EMBED_JS = join(
  fileURLToPath(new URL("../extensions/cellexia-buy-box/assets/", import.meta.url)),
  "buy-box-embed.js",
);

const OUR_VARIANT = "4411100011101";
const OTHER_VARIANT = "4411100011102";
const FOREIGN_VARIANT = "9999999999999";
const PLAN_ID = "6881100003";

interface SentRequest {
  url: string;
  body: unknown;
}

interface Sandbox {
  window: Record<string, unknown> & {
    fetch: (url: string, init?: Record<string, unknown>) => unknown;
    CellexiaSubs: Record<string, unknown>;
  };
  sent: SentRequest[];
  setState: (state: Record<string, unknown> | null) => void;
}

/**
 * The DOM surface buy-box-embed.js touches while loading. Deliberately small
 * and explicit: with no widget wrapper in the document the mount step finds
 * nothing to do and returns immediately, so only the wiring below is needed.
 * (If a future edit makes the module touch more of the DOM at load time, this
 * throws a clear TypeError instead of failing mysteriously.)
 */
function loadEmbedScript(): Sandbox {
  const sent: SentRequest[] = [];
  let state: Record<string, unknown> | null = null;

  const noop = (): void => {};
  const emptyList: unknown[] = [];

  const element = {
    className: "",
    textContent: "",
    setAttribute: noop,
    removeAttribute: noop,
    getAttribute: () => null,
    appendChild: noop,
    querySelector: () => null,
    querySelectorAll: () => emptyList,
    closest: () => null,
  };

  const documentStub = {
    readyState: "complete",
    body: { ...element },
    documentElement: { ...element },
    addEventListener: noop,
    removeEventListener: noop,
    querySelector: () => null,
    querySelectorAll: () => emptyList,
    createElement: () => ({ ...element }),
  };

  function originalFetch(url: string, init?: Record<string, unknown>): unknown {
    sent.push({ url, body: init ? init.body : undefined });
    return Promise.resolve({ ok: true });
  }

  class FakeXhr {
    open(): void {}
    send(body?: unknown): void {
      sent.push({ url: this.__url ?? "", body });
    }
    __url?: string;
  }

  const windowStub: Record<string, unknown> = {
    fetch: originalFetch,
    XMLHttpRequest: FakeXhr,
    location: { origin: "https://cellexialabs.com", search: "" },
    addEventListener: noop,
    removeEventListener: noop,
    setTimeout: (fn: () => void) => {
      void fn;
      return 0; /* deferred work is not what this suite measures */
    },
    clearTimeout: noop,
    sessionStorage: {
      getItem: () => null,
      setItem: noop,
      removeItem: noop,
    },
    URLSearchParams,
    FormData,
    URL,
  };
  windowStub.window = windowStub;

  const sandbox = {
    window: windowStub,
    document: documentStub,
    console: { warn: noop, error: noop, log: noop },
    URLSearchParams,
    FormData,
    URL,
    Promise,
    Object,
    String,
    Number,
    Array,
    JSON,
    RegExp,
    isFinite,
  };

  vm.createContext(sandbox);
  vm.runInContext(readFileSync(EMBED_JS, "utf8"), sandbox, {
    filename: "buy-box-embed.js",
  });

  const subs = windowStub.CellexiaSubs as Record<string, unknown>;
  subs.getState = () => state;

  return {
    window: windowStub as Sandbox["window"],
    sent,
    setState: (next) => {
      state = next;
    },
  };
}

/** A widget with the subscription selected on one of ITS OWN two variants. */
function subscriptionState(): Record<string, unknown> {
  return {
    mode: "subscription",
    design: "classic",
    variantId: OUR_VARIANT,
    variantIds: [OUR_VARIANT, OTHER_VARIANT],
    sellingPlanId: PLAN_ID,
  };
}

describe("buy-box-embed cart-request injection", () => {
  let env: Sandbox;

  beforeEach(() => {
    env = loadEmbedScript();
    env.setState(subscriptionState());
  });

  /** POST a body to /cart/add.js through the patched fetch; return what went out. */
  function post(body: unknown, url = "/cart/add.js"): unknown {
    env.window.fetch(url, { method: "POST", body });
    return env.sent[env.sent.length - 1].body;
  }

  function params(body: unknown): URLSearchParams {
    return new URLSearchParams(String(body));
  }

  // ── The jQuery items[] shape (the Sleepify cart path) ──────────────────────

  it("injects into an urlencoded items[0][id] body (jQuery $.param of items[])", () => {
    const original = `items%5B0%5D%5Bid%5D=${OUR_VARIANT}&items%5B0%5D%5Bquantity%5D=1`;
    const out = params(post(original));

    expect(out.get("items[0][selling_plan]")).toBe(PLAN_ID);
    expect(out.get("items[0][properties][_cellexia_design]")).toBe("classic");
    // …without disturbing what the theme sent.
    expect(out.get("items[0][id]")).toBe(OUR_VARIANT);
    expect(out.get("items[0][quantity]")).toBe("1");
  });

  it("injects into every OUR-product item and leaves the others alone", () => {
    const original =
      `items%5B0%5D%5Bid%5D=${FOREIGN_VARIANT}&items%5B0%5D%5Bquantity%5D=1` +
      `&items%5B1%5D%5Bid%5D=${OUR_VARIANT}&items%5B1%5D%5Bquantity%5D=2`;
    const out = params(post(original));

    expect(out.get("items[1][selling_plan]")).toBe(PLAN_ID);
    expect(out.get("items[0][selling_plan]")).toBeNull();
    expect(out.get("items[0][properties][_cellexia_design]")).toBeNull();
  });

  it("never touches an item that already carries a selling_plan", () => {
    const original =
      `items%5B0%5D%5Bid%5D=${OUR_VARIANT}&items%5B0%5D%5Bselling_plan%5D=123`;
    expect(post(original)).toBe(original);
  });

  it("passes another vendor's items[] request through byte-identical", () => {
    const original = `items%5B0%5D%5Bid%5D=${FOREIGN_VARIANT}&items%5B0%5D%5Bquantity%5D=1`;
    expect(post(original)).toBe(original);
  });

  it("handles the same shape in FormData", () => {
    const form = new FormData();
    form.append("items[0][id]", OUR_VARIANT);
    form.append("items[0][quantity]", "1");

    const out = post(form) as FormData;
    expect(out).toBeInstanceOf(FormData);
    expect(out.get("items[0][selling_plan]")).toBe(PLAN_ID);
    expect(out.get("items[0][properties][_cellexia_design]")).toBe("classic");
    expect(out.get("items[0][id]")).toBe(OUR_VARIANT);
    // The caller's own object is never mutated.
    expect(form.get("items[0][selling_plan]")).toBeNull();
  });

  it("passes a foreign FormData items[] request through untouched", () => {
    const form = new FormData();
    form.append("items[0][id]", FOREIGN_VARIANT);
    expect(post(form)).toBe(form);
  });

  // ── The shapes that already worked (regression cover) ──────────────────────

  it("still injects into a flat urlencoded body", () => {
    const out = params(post(`id=${OUR_VARIANT}&quantity=1`));
    expect(out.get("selling_plan")).toBe(PLAN_ID);
    expect(out.get("properties[_cellexia_design]")).toBe("classic");
  });

  it("still injects into JSON items[]", () => {
    const out = JSON.parse(
      String(post(JSON.stringify({ items: [{ id: Number(OUR_VARIANT), quantity: 1 }] }))),
    ) as { items: Array<Record<string, unknown>> };
    expect(out.items[0].selling_plan).toBe(Number(PLAN_ID));
    expect(out.items[0].properties).toEqual({ _cellexia_design: "classic" });
  });

  it("still injects into flat JSON { id, quantity }", () => {
    const out = JSON.parse(
      String(post(JSON.stringify({ id: OUR_VARIANT, quantity: 1 }))),
    ) as Record<string, unknown>;
    expect(out.selling_plan).toBe(Number(PLAN_ID));
  });

  it("still injects into a flat FormData", () => {
    const form = new FormData();
    form.append("id", OUR_VARIANT);
    const out = post(form) as FormData;
    expect(out.get("selling_plan")).toBe(PLAN_ID);
  });

  // ── Never act for a selection the visitor cannot see or did not make ───────

  it("touches nothing while one-time is selected", () => {
    env.setState({ ...subscriptionState(), mode: "one_time", sellingPlanId: null });
    const original = `items%5B0%5D%5Bid%5D=${OUR_VARIANT}&items%5B0%5D%5Bquantity%5D=1`;
    expect(post(original)).toBe(original);
  });

  it("touches nothing while the widget is hidden (launch gate / unmounted)", () => {
    // getState() returns null for a widget the visitor cannot see.
    env.setState(null);
    const original = `id=${OUR_VARIANT}&quantity=1`;
    expect(post(original)).toBe(original);
  });

  it("touches nothing on a request that is not a cart add", () => {
    const original = `items%5B0%5D%5Bid%5D=${OUR_VARIANT}`;
    expect(post(original, "/cart/change.js")).toBe(original);
  });
});
