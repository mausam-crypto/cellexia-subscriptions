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
 * v1.26.0 adds the design-measurement EXPOSURE stamp: every add of OUR
 * product's variants made while the widget is visible — one-time as much as
 * subscription — carries `properties[_cellexia_seen]` = "<preset>|<s|o|u>"
 * (s/o = subscription/one-time was preselected on the rendered widget, u =
 * unknown). Without it a one-time order and an order placed with the widget
 * hidden are indistinguishable, and take rate per design has no honest
 * denominator. `selling_plan` + `_cellexia_design` keep their exact previous
 * gate (subscription selected). Foreign lines stay byte-identical, an
 * existing non-empty seen value is never overwritten, and a hidden widget
 * stamps nothing.
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

/**
 * The seen value the widget state above produces: preset "classic",
 * subscription preselected (`preselect: true` → "s").
 */
const SEEN = "classic|s";

/** A widget with the subscription selected on one of ITS OWN two variants. */
function subscriptionState(): Record<string, unknown> {
  return {
    mode: "subscription",
    design: "classic",
    preselect: true,
    variantId: OUR_VARIANT,
    variantIds: [OUR_VARIANT, OTHER_VARIANT],
    sellingPlanId: PLAN_ID,
  };
}

/** The same widget with one-time selected (the visitor still SAW it). */
function oneTimeState(): Record<string, unknown> {
  return { ...subscriptionState(), mode: "one_time", sellingPlanId: null };
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
    expect(out.get("items[0][properties][_cellexia_seen]")).toBe(SEEN);
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
    expect(out.get("items[1][properties][_cellexia_seen]")).toBe(SEEN);
    expect(out.get("items[0][selling_plan]")).toBeNull();
    expect(out.get("items[0][properties][_cellexia_design]")).toBeNull();
    // The foreign line gets no exposure stamp either: it is not our product.
    expect(out.get("items[0][properties][_cellexia_seen]")).toBeNull();
  });

  it("never touches an item that already carries another app's selling_plan", () => {
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
    expect(out.get("items[0][properties][_cellexia_seen]")).toBe(SEEN);
    expect(out.get("items[0][id]")).toBe(OUR_VARIANT);
    // The caller's own object is never mutated.
    expect(form.get("items[0][selling_plan]")).toBeNull();
    expect(form.get("items[0][properties][_cellexia_seen]")).toBeNull();
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
    expect(out.get("properties[_cellexia_seen]")).toBe(SEEN);
  });

  it("still injects into JSON items[]", () => {
    const out = JSON.parse(
      String(post(JSON.stringify({ items: [{ id: Number(OUR_VARIANT), quantity: 1 }] }))),
    ) as { items: Array<Record<string, unknown>> };
    expect(out.items[0].selling_plan).toBe(Number(PLAN_ID));
    expect(out.items[0].properties).toEqual({
      _cellexia_design: "classic",
      _cellexia_seen: SEEN,
    });
  });

  it("still injects into flat JSON { id, quantity }", () => {
    const out = JSON.parse(
      String(post(JSON.stringify({ id: OUR_VARIANT, quantity: 1 }))),
    ) as Record<string, unknown>;
    expect(out.selling_plan).toBe(Number(PLAN_ID));
    expect(out.properties).toEqual({
      _cellexia_design: "classic",
      _cellexia_seen: SEEN,
    });
  });

  it("still injects into a flat FormData", () => {
    const form = new FormData();
    form.append("id", OUR_VARIANT);
    const out = post(form) as FormData;
    expect(out.get("selling_plan")).toBe(PLAN_ID);
    expect(out.get("properties[_cellexia_seen]")).toBe(SEEN);
  });

  // ── A line that already carries OUR plan is completed, never rewritten ─────
  //
  // Some theme JS serializes the widget's adopted selling_plan field into a
  // hand-built payload without copying the properties inputs: the plan is
  // already right, only the _cellexia_design attribution (and the seen
  // stamp) is missing. The patcher stamps exactly what is missing — the plan
  // value itself is untouched, a property that already travelled is never
  // overwritten, and any OTHER plan id keeps the byte-identical pass-through
  // above.

  it("completes a bracket item that already carries OUR plan (design + seen)", () => {
    const original =
      `items%5B0%5D%5Bid%5D=${OUR_VARIANT}&items%5B0%5D%5Bquantity%5D=1` +
      `&items%5B0%5D%5Bselling_plan%5D=${PLAN_ID}`;
    const out = params(post(original));

    expect(out.get("items[0][properties][_cellexia_design]")).toBe("classic");
    expect(out.get("items[0][properties][_cellexia_seen]")).toBe(SEEN);
    // The theme's own plan value survives, exactly once.
    expect(out.getAll("items[0][selling_plan]")).toEqual([PLAN_ID]);
    expect(out.get("items[0][id]")).toBe(OUR_VARIANT);
    expect(out.get("items[0][quantity]")).toBe("1");
  });

  it("completes the flat urlencoded body carrying OUR plan", () => {
    const out = params(post(`id=${OUR_VARIANT}&quantity=1&selling_plan=${PLAN_ID}`));
    expect(out.get("properties[_cellexia_design]")).toBe("classic");
    expect(out.get("properties[_cellexia_seen]")).toBe(SEEN);
    expect(out.getAll("selling_plan")).toEqual([PLAN_ID]);
  });

  it("leaves the flat body byte-identical when the existing plan is not ours", () => {
    // Another app's line: no plan rewrite, no design — and no seen stamp
    // either (a foreign selling plan is not our exposure to record).
    const original = `id=${OUR_VARIANT}&quantity=1&selling_plan=123`;
    expect(post(original)).toBe(original);
  });

  it("completes JSON items[] carrying OUR plan (String-compared)", () => {
    // The theme carries the plan NUMERIC while the widget state holds a
    // string — ours-vs-foreign must not hinge on the JSON type.
    const out = JSON.parse(
      String(
        post(
          JSON.stringify({
            items: [{ id: Number(OUR_VARIANT), quantity: 1, selling_plan: Number(PLAN_ID) }],
          }),
        ),
      ),
    ) as { items: Array<Record<string, unknown>> };
    expect(out.items[0].selling_plan).toBe(Number(PLAN_ID));
    expect(out.items[0].properties).toEqual({
      _cellexia_design: "classic",
      _cellexia_seen: SEEN,
    });
  });

  it("completes flat JSON carrying OUR plan", () => {
    const out = JSON.parse(
      String(post(JSON.stringify({ id: OUR_VARIANT, quantity: 1, selling_plan: PLAN_ID }))),
    ) as Record<string, unknown>;
    expect(out.selling_plan).toBe(PLAN_ID);
    expect(out.properties).toEqual({
      _cellexia_design: "classic",
      _cellexia_seen: SEEN,
    });
  });

  it("completes a flat FormData carrying OUR plan", () => {
    const form = new FormData();
    form.append("id", OUR_VARIANT);
    form.append("selling_plan", PLAN_ID);
    const out = post(form) as FormData;
    expect(out).toBeInstanceOf(FormData);
    expect(out.get("properties[_cellexia_design]")).toBe("classic");
    expect(out.get("properties[_cellexia_seen]")).toBe(SEEN);
    expect(out.getAll("selling_plan")).toEqual([PLAN_ID]);
    // The caller's own object is never mutated.
    expect(form.get("properties[_cellexia_design]")).toBeNull();
    expect(form.get("properties[_cellexia_seen]")).toBeNull();
  });

  it("completes a bracket FormData carrying OUR plan", () => {
    const form = new FormData();
    form.append("items[0][id]", OUR_VARIANT);
    form.append("items[0][selling_plan]", PLAN_ID);
    const out = post(form) as FormData;
    expect(out.get("items[0][properties][_cellexia_design]")).toBe("classic");
    expect(out.get("items[0][properties][_cellexia_seen]")).toBe(SEEN);
    expect(out.getAll("items[0][selling_plan]")).toEqual([PLAN_ID]);
  });

  it("never overwrites a design attribution that already travelled (adds only the missing seen)", () => {
    const out = params(
      post(
        `items%5B0%5D%5Bid%5D=${OUR_VARIANT}` +
          `&items%5B0%5D%5Bselling_plan%5D=${PLAN_ID}` +
          `&items%5B0%5D%5Bproperties%5D%5B_cellexia_design%5D=tiles`,
      ),
    );
    expect(out.getAll("items[0][properties][_cellexia_design]")).toEqual(["tiles"]);
    expect(out.get("items[0][properties][_cellexia_seen]")).toBe(SEEN);

    const json = JSON.parse(
      String(
        post(
          JSON.stringify({
            items: [
              {
                id: Number(OUR_VARIANT),
                selling_plan: Number(PLAN_ID),
                properties: { _cellexia_design: "tiles" },
              },
            ],
          }),
        ),
      ),
    ) as { items: Array<Record<string, unknown>> };
    expect(json.items[0].properties).toEqual({
      _cellexia_design: "tiles",
      _cellexia_seen: SEEN,
    });
  });

  it("passes a fully stamped subscription line through byte-identical", () => {
    // Plan, design and seen all present: nothing left to add, so the body
    // is not even re-encoded.
    const original =
      `items%5B0%5D%5Bid%5D=${OUR_VARIANT}` +
      `&items%5B0%5D%5Bselling_plan%5D=${PLAN_ID}` +
      `&items%5B0%5D%5Bproperties%5D%5B_cellexia_design%5D=tiles` +
      `&items%5B0%5D%5Bproperties%5D%5B_cellexia_seen%5D=tiles%7Co`;
    expect(post(original)).toBe(original);

    const json = JSON.stringify({
      items: [
        {
          id: Number(OUR_VARIANT),
          selling_plan: Number(PLAN_ID),
          properties: { _cellexia_design: "tiles", _cellexia_seen: "tiles|o" },
        },
      ],
    });
    expect(post(json)).toBe(json);

    const flat = `id=${OUR_VARIANT}&selling_plan=${PLAN_ID}&properties%5B_cellexia_design%5D=classic&properties%5B_cellexia_seen%5D=classic%7Cs`;
    expect(post(flat)).toBe(flat);
  });

  it("treats an empty design value as missing and fills it", () => {
    // No design is recorded either way — an empty property attributes
    // nothing, so completing it loses nobody's data.
    const out = params(
      post(`id=${OUR_VARIANT}&selling_plan=${PLAN_ID}&properties%5B_cellexia_design%5D=`),
    );
    expect(out.get("properties[_cellexia_design]")).toBe("classic");
    expect(out.getAll("properties[_cellexia_design]")).toEqual(["classic"]);
  });

  it("handles a mixed items[] body: completes ours, fills the plan-less, skips foreign", () => {
    const original =
      `items%5B0%5D%5Bid%5D=${OUR_VARIANT}&items%5B0%5D%5Bselling_plan%5D=${PLAN_ID}` +
      `&items%5B1%5D%5Bid%5D=${OTHER_VARIANT}&items%5B1%5D%5Bquantity%5D=1` +
      `&items%5B2%5D%5Bid%5D=${FOREIGN_VARIANT}&items%5B2%5D%5Bselling_plan%5D=555`;
    const out = params(post(original));

    expect(out.get("items[0][properties][_cellexia_design]")).toBe("classic");
    expect(out.get("items[0][properties][_cellexia_seen]")).toBe(SEEN);
    expect(out.getAll("items[0][selling_plan]")).toEqual([PLAN_ID]);
    expect(out.get("items[1][selling_plan]")).toBe(PLAN_ID);
    expect(out.get("items[1][properties][_cellexia_design]")).toBe("classic");
    expect(out.get("items[1][properties][_cellexia_seen]")).toBe(SEEN);
    expect(out.getAll("items[2][selling_plan]")).toEqual(["555"]);
    expect(out.get("items[2][properties][_cellexia_design]")).toBeNull();
    expect(out.get("items[2][properties][_cellexia_seen]")).toBeNull();
  });

  it("does not stamp a design while one-time is selected, even over our plan id", () => {
    // getState() knows no plan for a one-time selection, so a stale plan
    // the theme kept sending is not provably a choice the visitor made on
    // this page view — stripping it is not our job, and neither is
    // recording exposure on a line we cannot prove is ours.
    env.setState(oneTimeState());
    const original = `id=${OUR_VARIANT}&selling_plan=${PLAN_ID}`;
    expect(post(original)).toBe(original);
  });

  // ── One-time selected: exposure is stamped, nothing else (v1.26.0) ─────────
  //
  // The visitor SAW the design and chose one-time. That order is the take
  // rate's denominator, so `_cellexia_seen` travels; `selling_plan` and
  // `_cellexia_design` do not (their gate is unchanged: subscription only).

  it("stamps ONLY seen on a one-time urlencoded items[] add", () => {
    env.setState(oneTimeState());
    const out = params(
      post(`items%5B0%5D%5Bid%5D=${OUR_VARIANT}&items%5B0%5D%5Bquantity%5D=1`),
    );
    expect(out.get("items[0][properties][_cellexia_seen]")).toBe(SEEN);
    expect(out.get("items[0][selling_plan]")).toBeNull();
    expect(out.get("items[0][properties][_cellexia_design]")).toBeNull();
    expect(out.get("items[0][id]")).toBe(OUR_VARIANT);
    expect(out.get("items[0][quantity]")).toBe("1");
  });

  it("stamps ONLY seen on a one-time flat urlencoded add", () => {
    env.setState(oneTimeState());
    const out = params(post(`id=${OUR_VARIANT}&quantity=1`));
    expect(out.get("properties[_cellexia_seen]")).toBe(SEEN);
    expect(out.get("selling_plan")).toBeNull();
    expect(out.get("properties[_cellexia_design]")).toBeNull();
  });

  it("stamps ONLY seen on a one-time JSON items[] add", () => {
    env.setState(oneTimeState());
    const out = JSON.parse(
      String(post(JSON.stringify({ items: [{ id: Number(OUR_VARIANT), quantity: 1 }] }))),
    ) as { items: Array<Record<string, unknown>> };
    expect(out.items[0]).toEqual({
      id: Number(OUR_VARIANT),
      quantity: 1,
      properties: { _cellexia_seen: SEEN },
    });
  });

  it("stamps ONLY seen on a one-time flat JSON add", () => {
    env.setState(oneTimeState());
    const out = JSON.parse(
      String(post(JSON.stringify({ id: OUR_VARIANT, quantity: 1 }))),
    ) as Record<string, unknown>;
    expect(out).toEqual({
      id: OUR_VARIANT,
      quantity: 1,
      properties: { _cellexia_seen: SEEN },
    });
  });

  it("stamps ONLY seen on a one-time FormData add (flat and bracket)", () => {
    env.setState(oneTimeState());
    const flat = new FormData();
    flat.append("id", OUR_VARIANT);
    const flatOut = post(flat) as FormData;
    expect(flatOut).toBeInstanceOf(FormData);
    expect(flatOut.get("properties[_cellexia_seen]")).toBe(SEEN);
    expect(flatOut.get("selling_plan")).toBeNull();
    expect(flatOut.get("properties[_cellexia_design]")).toBeNull();
    expect(flat.get("properties[_cellexia_seen]")).toBeNull(); // caller untouched

    const bracket = new FormData();
    bracket.append("items[0][id]", OUR_VARIANT);
    bracket.append("items[0][quantity]", "1");
    const bracketOut = post(bracket) as FormData;
    expect(bracketOut.get("items[0][properties][_cellexia_seen]")).toBe(SEEN);
    expect(bracketOut.get("items[0][selling_plan]")).toBeNull();
    expect(bracketOut.get("items[0][properties][_cellexia_design]")).toBeNull();
  });

  it("stamps ONLY seen on a one-time URLSearchParams body", () => {
    env.setState(oneTimeState());
    const out = post(new URLSearchParams(`id=${OUR_VARIANT}&quantity=1`)) as URLSearchParams;
    expect(out).toBeInstanceOf(URLSearchParams);
    expect(out.get("properties[_cellexia_seen]")).toBe(SEEN);
    expect(out.get("selling_plan")).toBeNull();
  });

  it("leaves a foreign line byte-identical while one-time is selected too", () => {
    env.setState(oneTimeState());
    const original = `items%5B0%5D%5Bid%5D=${FOREIGN_VARIANT}&items%5B0%5D%5Bquantity%5D=1`;
    expect(post(original)).toBe(original);
    const flat = `id=${FOREIGN_VARIANT}&quantity=1`;
    expect(post(flat)).toBe(flat);
  });

  it("never overwrites an existing non-empty seen value (one-time or subscription)", () => {
    // A seen value that already travelled — the theme copied the widget's
    // hidden input, or an earlier patch pass ran — records the exposure at
    // the moment it was written; it is never rewritten to the current one.
    const original =
      `id=${OUR_VARIANT}&quantity=1&properties%5B_cellexia_seen%5D=tiles%7Co`;
    env.setState(oneTimeState());
    expect(post(original)).toBe(original);

    env.setState(subscriptionState());
    const out = params(post(original));
    expect(out.getAll("properties[_cellexia_seen]")).toEqual(["tiles|o"]);
    expect(out.get("selling_plan")).toBe(PLAN_ID);
    expect(out.get("properties[_cellexia_design]")).toBe("classic");
  });

  it("treats an empty seen value as missing and fills it", () => {
    env.setState(oneTimeState());
    const out = params(post(`id=${OUR_VARIANT}&properties%5B_cellexia_seen%5D=`));
    expect(out.getAll("properties[_cellexia_seen]")).toEqual([SEEN]);
  });

  // ── The preselect flag inside the seen value ───────────────────────────────

  it("encodes the preselect flag: true → s, false → o, absent → u", () => {
    env.setState({ ...oneTimeState(), preselect: false });
    expect(params(post(`id=${OUR_VARIANT}`)).get("properties[_cellexia_seen]")).toBe(
      "classic|o",
    );

    const legacy = oneTimeState();
    delete legacy.preselect; // a buy-box.js that predates the field
    env.setState(legacy);
    expect(params(post(`id=${OUR_VARIANT}`)).get("properties[_cellexia_seen]")).toBe(
      "classic|u",
    );

    env.setState({ ...subscriptionState(), design: "subscription_max" });
    expect(params(post(`id=${OUR_VARIANT}`)).get("properties[_cellexia_seen]")).toBe(
      "subscription_max|s",
    );
  });

  // ── Never act for a selection the visitor cannot see ───────────────────────

  it("touches nothing while the widget is hidden (launch gate / unmounted)", () => {
    // getState() returns null for a widget the visitor cannot see: no plan,
    // no design, and no seen stamp either — an order placed without seeing
    // the widget must stay distinguishable from one that saw it.
    env.setState(null);
    for (const original of [
      `id=${OUR_VARIANT}&quantity=1`,
      `items%5B0%5D%5Bid%5D=${OUR_VARIANT}&items%5B0%5D%5Bquantity%5D=1`,
      JSON.stringify({ items: [{ id: Number(OUR_VARIANT), quantity: 1 }] }),
    ]) {
      expect(post(original)).toBe(original);
    }
    const form = new FormData();
    form.append("id", OUR_VARIANT);
    expect(post(form)).toBe(form);
  });

  it("touches nothing on a request that is not a cart add", () => {
    const original = `items%5B0%5D%5Bid%5D=${OUR_VARIANT}`;
    expect(post(original, "/cart/change.js")).toBe(original);
    env.setState(oneTimeState());
    expect(post(original, "/cart/change.js")).toBe(original);
  });

  it("stamps through the XMLHttpRequest path as well (jQuery.ajax)", () => {
    const XhrCtor = env.window.XMLHttpRequest as new () => {
      open: (method: string, url: string) => void;
      send: (body?: unknown) => void;
    };
    env.setState(oneTimeState());
    const xhr = new XhrCtor();
    xhr.open("POST", "/cart/add.js");
    xhr.send(`id=${OUR_VARIANT}&quantity=1`);
    const out = params(env.sent[env.sent.length - 1].body);
    expect(out.get("properties[_cellexia_seen]")).toBe(SEEN);
    expect(out.get("selling_plan")).toBeNull();
  });
});
