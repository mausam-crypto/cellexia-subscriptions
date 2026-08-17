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
  cancelTimer,
  flushTimers,
  parseHtml,
  resetDomState,
  scheduleTimer,
} from "./helpers/hostile-dom";
import { renderEmbed } from "./liquid/harness";

/**
 * THE VISIT BEACON (v1.27.0) — extensions/cellexia-buy-box/assets/
 * buy-box-embed.js, section 4.
 *
 * WHY IT EXISTS
 * -------------
 * Take rate per design has ORDERS as its denominator, so a design that quietly
 * sells fewer orders but converts more of them to subscriptions reads as a
 * winner. The honest comparison is per exposed VISIT: orders per 100 visits,
 * subscriptions per 100 visits, keyed by exactly the same design + preselect
 * stamp as the order facts. This file drives the REAL buy-box.js and
 * buy-box-embed.js over the REAL server-rendered embed markup and measures
 * what the beacon sends, when, and — just as important — when it stays
 * silent and what it may never break.
 *
 * WHAT IS MEASURED (each block says which behaviour it pins)
 *   - view: sent once, only after a widget root has been at least half in the
 *     viewport for a full second (IntersectionObserver stubbed in the
 *     sandbox: callback captured, entries injected, the virtual clock
 *     drained); the fallback without IntersectionObserver (1.5 s after boot).
 *     The DURATIONS are pinned too: the sandbox setTimeout records the delay
 *     of the timer each beacon came out of (1000 ms dwell, 1500 ms fallback);
 *   - engage: once, on the first interaction inside a root, never outside;
 *   - atc: once per (design|preselect|mode) from the cart-request patch, for
 *     the JSON / urlencoded / FormData shapes with m = s (subscription) and
 *     m = o (one-time), whether the patch injected the stamps or found them
 *     already complete (a foreign variant never counts), plus the theme-form
 *     submit path;
 *   - params: exactly e, d, p, v, c, cur, dv, vid, pv, t (+ m on atc); vid
 *     and pv stable across events; vid persisted under localStorage
 *     `cellexia_vid` with the sessionStorage / per-page fallbacks; the path
 *     pinned to /apps/cellexia-subs/w;
 *   - silence: no beacon in an admin preview (?cx_preview=), none in the
 *     theme editor (Shopify.designMode), none while the widget is hidden
 *     (setup mode);
 *   - containment: an Image constructor that throws never stops the cart
 *     request, which still goes out with its stamps.
 *
 * Transport is `new Image().src = url`, so the sandbox stubs `Image` and
 * records every src assignment; the fetch fallback (Image absent) is
 * measured through the recording fetch stub.
 */

const ASSETS_DIR = fileURLToPath(
  new URL("../extensions/cellexia-buy-box/assets/", import.meta.url),
);
const BUY_BOX_JS = join(ASSETS_DIR, "buy-box.js");
const EMBED_JS = join(ASSETS_DIR, "buy-box-embed.js");

const ONE_TIME_MONEY = "CHF 64.00";
const OUR_VARIANT = "4411100011101";
const OTHER_VARIANT = "4411100011102";
const FOREIGN_VARIANT = "9999999999999";
const PLAN_ID = "6881100003";
const VISIT_PATH = "/apps/cellexia-subs/w";
const ORIGIN = "https://cellexialabs.com";

/**
 * A compact PDP in the client's shape: a buy column with a price and the grey
 * quantity + add-to-cart panel the mount heuristic anchors before. No product
 * form by default (add-to-cart is AJAX there); `themeForm` adds a real
 * /cart/add form for the buy-box.js install shape.
 */
function themePage(themeForm: boolean): string {
  const form = themeForm
    ? `<form action="/cart/add" method="post">
         <input type="hidden" name="id" value="${OUR_VARIANT}">
         <button type="submit" name="add">Add to cart</button>
       </form>`
    : "";
  return `
<main class="pdp">
  <div class="pdp__info">
    <h1 class="pdp__title">Cellexia Serum</h1>
    <div class="pdp__price"><span sm-rc-current-price="">${ONE_TIME_MONEY}</span></div>
    <div class="pdp__grey">
      <div class="pdp__actions">
        <button type="button" class="btn btn--primary btn--atc">Add to cart - ${ONE_TIME_MONEY}</button>
      </div>
      ${form}
    </div>
  </div>
</main>
<footer class="site-footer"><a class="footer-link" href="/pages/faq">FAQ</a></footer>
`;
}

let EMBED_LIVE = "";
let EMBED_SETUP = "";
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
  init?: Record<string, unknown>;
}

interface IntersectionEntryLike {
  target: ElementNode;
  intersectionRatio: number;
  isIntersecting: boolean;
}

interface FakeObserver {
  observed: ElementNode[];
  disconnected: boolean;
  options: unknown;
  /** Deliver one entry for `el`, exactly as a browser would. */
  trigger: (el: ElementNode, ratio: number, isIntersecting?: boolean) => void;
}

interface Beacon {
  path: string;
  params: URLSearchParams;
}

interface Page {
  document: DocumentNode;
  body: ElementNode;
  subs: Record<string, unknown>;
  widget: ElementNode | null;
  atcButton: ElementNode;
  footerLink: ElementNode;
  /** Every `Image.src` assignment, in order. */
  images: string[];
  /**
   * Parallel to `images`: the delay (ms) of the setTimeout callback that was
   * running when that beacon went out, or null when it went out synchronously
   * (an engage / atc from an event handler). Pins the DURATIONS the virtual
   * clock cannot: the 1000 ms view dwell and the 1500 ms fallback.
   */
  imageDelays: Array<number | null>;
  /** Every setTimeout delay requested by either asset, in scheduling order. */
  timerDelays: number[];
  /** Every fetch / XHR that went out (cart requests AND the fetch fallback). */
  sent: SentRequest[];
  observers: FakeObserver[];
  /** The one IntersectionObserver the beacon creates, or null. */
  io: FakeObserver | null;
  storage: { local: Map<string, string>; session: Map<string, string> };
  cryptoCalls: number;
  flush: () => void;
  xhrPost: (body: unknown, url?: string) => unknown;
  fetchPost: (body: unknown, url?: string) => unknown;
  sourceChanged: boolean;
  buyBoxSourceChanged: boolean;
}

interface BuildOptions {
  launchStatus?: "live" | "setup";
  embedMarkup?: string;
  /** window.location.search for this page load. */
  search?: string;
  /** How the sandbox's Image behaves. */
  image?: "record" | "throw" | "absent";
  /** IntersectionObserver present (default), absent, or a constructor that throws. */
  io?: "present" | "absent" | "throws";
  localStorage?: "ok" | "absent" | "throws";
  sessionStorage?: "ok" | "absent";
  /** Share storage between two page loads (a returning visitor). */
  storage?: { local: Map<string, string>; session: Map<string, string> };
  /** window.Shopify; undefined = the global is absent. */
  shopify?: Record<string, unknown>;
  innerWidth?: number;
  coarsePointer?: boolean;
  crypto?: boolean;
  themeForm?: boolean;
  mutateEmbed?: (source: string) => string;
  mutateBuyBox?: (source: string) => string;
}

function storageStub(map: Map<string, string>): Record<string, unknown> {
  return {
    getItem: (key: string) => (map.has(String(key)) ? map.get(String(key)) : null),
    setItem: (key: string, value: string) => {
      map.set(String(key), String(value));
    },
    removeItem: (key: string) => {
      map.delete(String(key));
    },
  };
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

  parseHtml(themePage(options.themeForm === true), body);
  parseHtml(
    options.embedMarkup ??
      (options.launchStatus === "setup" ? EMBED_SETUP : EMBED_LIVE),
    body,
  );

  const atcButton = documentNode.querySelector(".btn--atc") as ElementNode;
  const footerLink = documentNode.querySelector(".footer-link") as ElementNode;

  const sent: SentRequest[] = [];
  const images: string[] = [];
  const imageDelays: Array<number | null> = [];
  const timerDelays: number[] = [];
  // The delay of the timer callback currently running (null outside timers):
  // a beacon sent from inside it is attributed to that delay.
  let runningDelay: number | null = null;
  const observers: FakeObserver[] = [];
  const storage = options.storage ?? {
    local: new Map<string, string>(),
    session: new Map<string, string>(),
  };
  let cryptoCalls = 0;

  class FakeXhr {
    private requestUrl = "";
    private requestMethod = "";
    open(method: string, url: string): void {
      this.requestMethod = String(method);
      this.requestUrl = String(url);
    }
    send(payload?: unknown): void {
      sent.push({ url: this.requestUrl, method: this.requestMethod, body: payload });
    }
    setRequestHeader(): void {}
  }

  class FakeImage {
    private srcValue = "";
    constructor() {
      if (options.image === "throw") {
        throw new Error("Image is not a constructor here");
      }
    }
    get src(): string {
      return this.srcValue;
    }
    set src(value: string) {
      this.srcValue = String(value);
      images.push(this.srcValue);
      imageDelays.push(runningDelay);
    }
  }

  /**
   * The sandbox setTimeout: the virtual clock, plus a record of every delay
   * asked for and, while a callback runs, which delay it was scheduled with.
   * WHY: flushTimers() drains every timer whatever its delay, so without this
   * a dwell of 0 ms would pass every ordering assertion.
   */
  const recordingSetTimeout = (fn: () => void, delay?: number): number => {
    const ms = Number(delay) || 0;
    timerDelays.push(ms);
    return scheduleTimer(() => {
      const previous = runningDelay;
      runningDelay = ms;
      try {
        fn();
      } finally {
        runningDelay = previous;
      }
    }, delay);
  };

  class FakeIntersectionObserver implements FakeObserver {
    observed: ElementNode[] = [];
    disconnected = false;
    options: unknown;
    private readonly callback: (entries: IntersectionEntryLike[], observer: unknown) => void;
    constructor(
      callback: (entries: IntersectionEntryLike[], observer: unknown) => void,
      init?: unknown,
    ) {
      if (options.io === "throws") {
        throw new TypeError("IntersectionObserver unavailable");
      }
      this.callback = callback;
      this.options = init;
      observers.push(this);
    }
    observe(el: ElementNode): void {
      if (this.observed.indexOf(el) === -1) this.observed.push(el);
    }
    unobserve(el: ElementNode): void {
      this.observed = this.observed.filter((entry) => entry !== el);
    }
    disconnect(): void {
      this.disconnected = true;
      this.observed = [];
    }
    trigger(el: ElementNode, ratio: number, isIntersecting = ratio > 0): void {
      this.callback([{ target: el, intersectionRatio: ratio, isIntersecting }], this);
    }
  }

  const noop = (): void => {};
  const windowStub: Record<string, unknown> = {
    location: {
      origin: ORIGIN,
      href: `${ORIGIN}/products/cellexia-serum${options.search ?? ""}`,
      search: options.search ?? "",
    },
    history: {},
    document: documentNode,
    setTimeout: recordingSetTimeout,
    clearTimeout: cancelTimer,
    MutationObserver: MutationObserverShim,
    XMLHttpRequest: FakeXhr,
    fetch: (url: string, init?: Record<string, unknown>) => {
      sent.push({
        url: String(url),
        method: String((init && init.method) || "GET"),
        body: init ? init.body : undefined,
        init,
      });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    },
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: () => true,
    URLSearchParams,
    FormData,
    URL,
    Event: EventShim,
    CustomEvent: CustomEventShim,
    innerWidth: options.innerWidth ?? 1280,
    matchMedia: (query: string) => ({
      matches: query === "(pointer: coarse)" ? options.coarsePointer === true : false,
    }),
  };
  if (options.image !== "absent") windowStub.Image = FakeImage;
  if (options.io !== "absent") windowStub.IntersectionObserver = FakeIntersectionObserver;
  if (options.localStorage === "throws") {
    Object.defineProperty(windowStub, "localStorage", {
      get() {
        throw new Error("SecurityError: access denied");
      },
    });
  } else if (options.localStorage !== "absent") {
    windowStub.localStorage = storageStub(storage.local);
  }
  if (options.sessionStorage !== "absent") {
    windowStub.sessionStorage = storageStub(storage.session);
  }
  if (options.shopify !== undefined) windowStub.Shopify = options.shopify;
  if (options.crypto) {
    windowStub.crypto = {
      getRandomValues: (array: Uint8Array) => {
        cryptoCalls += 1;
        for (let i = 0; i < array.length; i += 1) array[i] = (i * 37 + 11) % 256;
        return array;
      },
    };
  }
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

  vm.runInContext(buyBoxSource, sandbox, { filename: "buy-box.js" });
  vm.runInContext(embedSource, sandbox, { filename: "buy-box-embed.js" });
  flushTimers();

  const xhrPost = (payload: unknown, url = "/cart/add.js"): unknown => {
    const request = new (windowStub.XMLHttpRequest as new () => {
      open: (method: string, url: string) => void;
      send: (body?: unknown) => void;
    })();
    request.open("POST", url);
    request.send(payload);
    return sent[sent.length - 1].body;
  };
  const fetchPost = (payload: unknown, url = "/cart/add.js"): unknown => {
    (windowStub.fetch as (u: string, i: Record<string, unknown>) => unknown)(url, {
      method: "POST",
      body: payload,
    });
    return sent[sent.length - 1].body;
  };

  return {
    document: documentNode,
    body,
    subs: windowStub.CellexiaSubs as Record<string, unknown>,
    widget: documentNode.querySelector(".cx-buybox"),
    atcButton,
    footerLink,
    images,
    imageDelays,
    timerDelays,
    sent,
    observers,
    io: observers[0] ?? null,
    storage,
    get cryptoCalls() {
      return cryptoCalls;
    },
    flush: () => flushTimers(),
    xhrPost,
    fetchPost,
    sourceChanged: embedSource !== embedOriginal,
    buyBoxSourceChanged: buyBoxSource !== buyBoxOriginal,
  };
}

// ── Reading what went out ────────────────────────────────────────────────────

function parseBeacon(src: string): Beacon {
  const url = new URL(src, ORIGIN);
  return { path: url.pathname, params: url.searchParams };
}

function beacons(page: Page): Beacon[] {
  return page.images.map(parseBeacon);
}

function ofEvent(page: Page, event: string): Beacon[] {
  return beacons(page).filter((beacon) => beacon.params.get("e") === event);
}

/** Beacons that went out through the fetch fallback (Image absent). */
function fetchBeacons(page: Page): SentRequest[] {
  return page.sent.filter((request) => request.url.startsWith(VISIT_PATH));
}

/**
 * The setTimeout delays (ms) of the timers that sent each `view` beacon
 * (null = sent synchronously, which a view never may be).
 */
function viewDelays(page: Page): Array<number | null> {
  return page.images
    .map((src, index) => ({ event: parseBeacon(src).params.get("e"), delay: page.imageDelays[index] }))
    .filter((entry) => entry.event === "view")
    .map((entry) => entry.delay);
}

// ── Driving the page ─────────────────────────────────────────────────────────

function radioFor(page: Page, mode: "subscription" | "one_time"): ElementNode {
  const widget = page.widget as ElementNode;
  return widget.querySelector(`input[data-cellexia-option="${mode}"]`) as ElementNode;
}

/** A shopper's click on a purchase option: flips the group, fires change. */
function selectMode(page: Page, mode: "subscription" | "one_time"): void {
  const wanted = radioFor(page, mode);
  const other = radioFor(page, mode === "subscription" ? "one_time" : "subscription");
  other.checked = false;
  wanted.checked = true;
  wanted.dispatchEvent(new EventShim("change", { bubbles: true }));
  page.flush();
}

/** The root at least half visible: what a shopper reading the widget looks like. */
function showWidget(page: Page, ratio = 0.75): void {
  (page.io as FakeObserver).trigger(page.widget as ElementNode, ratio, true);
}

function currentState(page: Page): Record<string, unknown> | null {
  return (page.subs.getState as () => Record<string, unknown> | null)();
}

// ── Sandbox self-checks (a stub bug must not read as the file passing) ───────

describe("visit sandbox", () => {
  it("mounts and shows the real widget, records images and creates one observer", () => {
    const page = buildPage();
    expect(page.widget).not.toBeNull();
    expect(currentState(page)).toMatchObject({
      mode: "subscription",
      design: "classic",
      preselect: true,
      variantId: OUR_VARIANT,
      sellingPlanId: PLAN_ID,
    });
    // The beacon created exactly one IntersectionObserver, watching the root
    // with the 50% threshold the dwell rule needs.
    expect(page.observers).toHaveLength(1);
    expect(page.io?.observed).toContain(page.widget);
    expect(page.io?.options).toEqual({ threshold: [0.5] });
    // Nothing has been sent yet: no visibility, no interaction, no add.
    expect(page.images).toEqual([]);
    expect(fetchBeacons(page)).toEqual([]);
  });

  it("the Image stub records src assignments (a view is the simplest beacon)", () => {
    const page = buildPage();
    showWidget(page);
    page.flush();
    expect(page.images).toHaveLength(1);
    expect(page.images[0]).toContain(`${VISIT_PATH}?`);
  });
});

// ── view ─────────────────────────────────────────────────────────────────────

describe("view: at least half visible for a full second, once per page load", () => {
  it("sends one view after the dwell timer, and never a second one", () => {
    const page = buildPage();
    const timersBefore = page.timerDelays.length;
    showWidget(page);
    // Not yet: the dwell second has not elapsed.
    expect(ofEvent(page, "view")).toHaveLength(0);
    // Visibility armed exactly one timer, and it asks for the full second:
    // the virtual clock drains every delay, so the DURATION is pinned here.
    expect(page.timerDelays.slice(timersBefore)).toEqual([1000]);
    page.flush();
    expect(ofEvent(page, "view")).toHaveLength(1);
    // The view came out of that 1000 ms timer, not from any shorter one
    // and not synchronously from the intersection callback.
    expect(viewDelays(page)).toEqual([1000]);
    // Scrolling away and back does not count the visitor twice.
    showWidget(page, 0);
    showWidget(page, 0.9);
    page.flush();
    expect(ofEvent(page, "view")).toHaveLength(1);
    // The observer has done its job for this page load.
    expect(page.io?.disconnected).toBe(true);
  });

  it("does not count a root that is less than half visible", () => {
    const page = buildPage();
    showWidget(page, 0.4);
    page.flush();
    expect(ofEvent(page, "view")).toHaveLength(0);
    // …nor one the observer reports as not intersecting at all.
    (page.io as FakeObserver).trigger(page.widget as ElementNode, 0, false);
    page.flush();
    expect(ofEvent(page, "view")).toHaveLength(0);
  });

  it("cancels the dwell when the root leaves the viewport before the second is up", () => {
    const page = buildPage();
    showWidget(page, 0.8);
    showWidget(page, 0.1); // scrolled past before 1000 ms
    page.flush();
    expect(ofEvent(page, "view")).toHaveLength(0);
    // A real read later still counts, once.
    showWidget(page, 0.8);
    page.flush();
    expect(ofEvent(page, "view")).toHaveLength(1);
  });

  it("falls back to 'visible 1.5 s after boot' when IntersectionObserver is missing", () => {
    // buildPage() drains the virtual clock, so the 1500 ms fallback has run.
    const page = buildPage({ io: "absent" });
    expect(page.observers).toEqual([]);
    expect(ofEvent(page, "view")).toHaveLength(1);
    // The 1.5 s is a real delay: the view came out of a 1500 ms timer (the
    // embed's mount grace pass is 1500 ms too, so timerDelays alone would
    // not pin this; the delay of the SENDING timer does).
    expect(viewDelays(page)).toEqual([1500]);
    // A widget the visitor cannot see is not a view, fallback or not.
    const hidden = buildPage({ io: "absent", launchStatus: "setup" });
    expect(currentState(hidden)).toBeNull();
    expect(ofEvent(hidden, "view")).toHaveLength(0);
  });

  it("treats an IntersectionObserver constructor that throws like a missing one", () => {
    const page = buildPage({ io: "throws" });
    expect(page.observers).toEqual([]);
    expect(ofEvent(page, "view")).toHaveLength(1);
    expect(viewDelays(page)).toEqual([1500]);
  });

  it("MUTATION CHECK: a shortened dwell or fallback is caught by the delay pins above", () => {
    // Exactly the regression the review found the old suite blind to: both
    // literals set to 0 passed every ordering assertion. The pins now read
    // the delay of the timer that sent the view, so a 0 ms (or 100 ms) dwell
    // reads as a view from a sub-second timer and `toEqual([1000])` fails.
    for (const shortened of [0, 100]) {
      const dwell = buildPage({
        mutateEmbed: (source) =>
          source.replace("viewTimerFor(watch), 1000)", `viewTimerFor(watch), ${shortened})`),
      });
      expect(dwell.sourceChanged).toBe(true);
      showWidget(dwell);
      dwell.flush();
      expect(viewDelays(dwell), String(shortened)).toEqual([shortened]);
    }

    // The fallback literal specifically (the mount grace pass is 1500 ms too,
    // so the replacement is anchored on the sendVisit('view') call).
    const fallback = buildPage({
      io: "absent",
      mutateEmbed: (source) =>
        source.replace(/(sendVisit\('view', null\);\s*\}, )1500\)/, "$10)"),
    });
    expect(fallback.sourceChanged).toBe(true);
    expect(viewDelays(fallback)).toEqual([0]);
  });

  it("MUTATION CHECK: without the once-per-load latch a second visibility sends a second view", () => {
    const LATCH = "visitsSent[once] = true;";
    const page = buildPage({
      mutateEmbed: (source) => source.replace(LATCH, "void 0;"),
    });
    expect(page.sourceChanged).toBe(true);
    showWidget(page);
    page.flush();
    showWidget(page, 0);
    showWidget(page);
    page.flush();
    // The green test above depends on the latch, not on the fixture.
    expect(ofEvent(page, "view").length).toBeGreaterThan(1);
  });
});

// ── engage ───────────────────────────────────────────────────────────────────

describe("engage: the first interaction inside a root, once", () => {
  it("sends one engage for a click inside the widget and no more for later ones", () => {
    const page = buildPage();
    const radio = radioFor(page, "one_time");
    radio.dispatchEvent(new EventShim("click", { bubbles: true }));
    expect(ofEvent(page, "engage")).toHaveLength(1);
    radio.dispatchEvent(new EventShim("pointerdown", { bubbles: true }));
    radio.dispatchEvent(new EventShim("keydown", { bubbles: true }));
    radio.dispatchEvent(new EventShim("change", { bubbles: true }));
    page.flush();
    expect(ofEvent(page, "engage")).toHaveLength(1);
  });

  it("ignores interactions outside the widget (the theme's own buttons, the footer)", () => {
    const page = buildPage();
    page.atcButton.dispatchEvent(new EventShim("click", { bubbles: true }));
    page.footerLink.dispatchEvent(new EventShim("pointerdown", { bubbles: true }));
    page.flush();
    expect(ofEvent(page, "engage")).toHaveLength(0);
  });

  it("counts pointerdown / keydown / change as engagement too", () => {
    for (const type of ["pointerdown", "keydown", "change"]) {
      const page = buildPage();
      radioFor(page, "subscription").dispatchEvent(new EventShim(type, { bubbles: true }));
      page.flush();
      expect(ofEvent(page, "engage"), type).toHaveLength(1);
    }
  });
});

// ── atc ──────────────────────────────────────────────────────────────────────

describe("atc: the cart-request patch targeted our variant", () => {
  const jsonBody = (): string =>
    JSON.stringify({ items: [{ id: Number(OUR_VARIANT), quantity: 1 }] });
  const encodedBody = (): string =>
    `items%5B0%5D%5Bid%5D=${OUR_VARIANT}&items%5B0%5D%5Bquantity%5D=1`;
  const formBody = (): FormData => {
    const form = new FormData();
    form.append("id", OUR_VARIANT);
    form.append("quantity", "1");
    return form;
  };

  it("m = s for a subscription add, in every body shape (JSON via fetch, urlencoded via XHR, FormData via fetch)", () => {
    const json = buildPage();
    const jsonOut = JSON.parse(String(json.fetchPost(jsonBody()))) as {
      items: Array<Record<string, unknown>>;
    };
    expect(jsonOut.items[0].selling_plan).toBe(Number(PLAN_ID));
    expect(ofEvent(json, "atc")).toHaveLength(1);
    expect(ofEvent(json, "atc")[0].params.get("m")).toBe("s");

    const encoded = buildPage();
    const encodedOut = new URLSearchParams(String(encoded.xhrPost(encodedBody())));
    expect(encodedOut.get("items[0][selling_plan]")).toBe(PLAN_ID);
    expect(ofEvent(encoded, "atc")).toHaveLength(1);
    expect(ofEvent(encoded, "atc")[0].params.get("m")).toBe("s");

    const form = buildPage();
    const formOut = form.fetchPost(formBody()) as FormData;
    expect(formOut.get("selling_plan")).toBe(PLAN_ID);
    expect(ofEvent(form, "atc")).toHaveLength(1);
    expect(ofEvent(form, "atc")[0].params.get("m")).toBe("s");
  });

  it("m = o for a one-time add, in every body shape", () => {
    for (const [label, post] of [
      ["json", (page: Page) => page.fetchPost(jsonBody())],
      ["urlencoded", (page: Page) => page.xhrPost(encodedBody())],
      ["formdata", (page: Page) => page.fetchPost(formBody())],
    ] as const) {
      const page = buildPage();
      selectMode(page, "one_time");
      expect(currentState(page)).toMatchObject({ mode: "one_time", sellingPlanId: null });
      post(page);
      const atc = ofEvent(page, "atc");
      expect(atc, label).toHaveLength(1);
      expect(atc[0].params.get("m"), label).toBe("o");
      // The seen stamp still travelled (the patch is what decided this was ours).
      const last = page.sent[page.sent.length - 1];
      const bodyText =
        last.body instanceof FormData
          ? new URLSearchParams(
              [...last.body.entries()].map(([k, v]) => [k, String(v)]),
            ).toString()
          : String(last.body);
      expect(bodyText, label).toContain("_cellexia_seen");
    }
  });

  it("sends atc once per mode: a second identical add is not counted again", () => {
    const page = buildPage();
    page.xhrPost(encodedBody());
    page.xhrPost(encodedBody());
    page.fetchPost(jsonBody());
    expect(ofEvent(page, "atc")).toHaveLength(1);
  });

  it("a one-time add followed by a subscription add records both flags, each once", () => {
    // WHY per mode rather than per page: the server sets addedToCart from
    // any atc and addedSubscription only from m = s; a shopper who adds
    // one-time, reconsiders and adds the subscription must not lose the
    // second flag to a first-event-wins latch.
    const page = buildPage();
    selectMode(page, "one_time");
    page.xhrPost(encodedBody());
    selectMode(page, "subscription");
    page.xhrPost(encodedBody());
    page.xhrPost(encodedBody());
    const modes = ofEvent(page, "atc").map((beacon) => beacon.params.get("m"));
    expect(modes).toEqual(["o", "s"]);
  });

  it("stays silent for another vendor's add and for a request that is not a cart add", () => {
    const page = buildPage();
    const foreign = `items%5B0%5D%5Bid%5D=${FOREIGN_VARIANT}&items%5B0%5D%5Bquantity%5D=1`;
    expect(page.xhrPost(foreign)).toBe(foreign);
    expect(page.xhrPost(encodedBody(), "/cart/change.js")).toBe(encodedBody());
    expect(ofEvent(page, "atc")).toHaveLength(0);
  });

  it("uses the same request-shape decision as the stamp: a body already carrying OUR plan is an atc too", () => {
    const page = buildPage();
    const original = `${encodedBody()}&items%5B0%5D%5Bselling_plan%5D=${PLAN_ID}`;
    const out = new URLSearchParams(String(page.xhrPost(original)));
    expect(out.get("items[0][properties][_cellexia_seen]")).toBe("classic|s");
    expect(ofEvent(page, "atc")).toHaveLength(1);
    expect(ofEvent(page, "atc")[0].params.get("m")).toBe("s");
  });

  describe("a body that already carries every stamp (nothing to inject) is still an add of our variant", () => {
    // WHY (v1.27.0 review #2): on a theme-form install buy-box.js writes
    // selling_plan and both properties into the product form; a theme whose
    // add-to-cart serialises that form and calls fetch / XHR itself (no
    // submit event) sends a body with nothing missing. The patch leaves it
    // byte-identical, and before the fix that "nothing changed" branch was
    // the only place atc fired, so those adds were never counted although
    // their orders were.
    const completeFlat = (): string =>
      `id=${OUR_VARIANT}&quantity=1&selling_plan=${PLAN_ID}` +
      `&properties%5B_cellexia_design%5D=classic&properties%5B_cellexia_seen%5D=classic%7Cs`;
    const completeForm = (): FormData => {
      const form = new FormData();
      form.append("id", OUR_VARIANT);
      form.append("quantity", "1");
      form.append("selling_plan", PLAN_ID);
      form.append("properties[_cellexia_design]", "classic");
      form.append("properties[_cellexia_seen]", "classic|s");
      return form;
    };
    const completeJson = (): string =>
      JSON.stringify({
        items: [
          {
            id: Number(OUR_VARIANT),
            quantity: 1,
            selling_plan: Number(PLAN_ID),
            properties: { _cellexia_design: "classic", _cellexia_seen: "classic|s" },
          },
        ],
      });

    it("subscription: urlencoded via XHR, FormData and JSON via fetch, each untouched and atc m = s once", () => {
      const encoded = buildPage();
      const original = completeFlat();
      expect(encoded.xhrPost(original)).toBe(original); // byte-identical pass-through
      expect(ofEvent(encoded, "atc").map((b) => b.params.get("m"))).toEqual(["s"]);
      encoded.xhrPost(original);
      expect(ofEvent(encoded, "atc")).toHaveLength(1); // still once per mode

      const form = buildPage();
      const formIn = completeForm();
      expect(form.fetchPost(formIn)).toBe(formIn); // the caller's object, untouched
      expect(ofEvent(form, "atc").map((b) => b.params.get("m"))).toEqual(["s"]);

      const json = buildPage();
      const jsonIn = completeJson();
      expect(json.fetchPost(jsonIn)).toBe(jsonIn);
      expect(ofEvent(json, "atc").map((b) => b.params.get("m"))).toEqual(["s"]);
    });

    it("one-time: a body with the seen stamp only (nothing missing) is atc m = o", () => {
      const page = buildPage();
      selectMode(page, "one_time");
      const original = `id=${OUR_VARIANT}&quantity=1&properties%5B_cellexia_seen%5D=classic%7Cs`;
      expect(page.xhrPost(original)).toBe(original);
      expect(ofEvent(page, "atc").map((b) => b.params.get("m"))).toEqual(["o"]);
      // items[i][id] bracket shape through fetch, same answer, still once.
      page.fetchPost(
        `items%5B0%5D%5Bid%5D=${OUR_VARIANT}&items%5B0%5D%5Bproperties%5D%5B_cellexia_seen%5D=classic%7Cs`,
      );
      expect(ofEvent(page, "atc")).toHaveLength(1);
    });

    it("a foreign variant carrying the same stamps is neither touched nor counted", () => {
      const page = buildPage();
      const foreignFlat = completeFlat().replace(OUR_VARIANT, FOREIGN_VARIANT);
      expect(page.xhrPost(foreignFlat)).toBe(foreignFlat);
      const foreignJson = completeJson().replace(OUR_VARIANT, FOREIGN_VARIANT);
      expect(page.fetchPost(foreignJson)).toBe(foreignJson);
      const foreignForm = completeForm();
      foreignForm.set("id", FOREIGN_VARIANT);
      expect(page.fetchPost(foreignForm)).toBe(foreignForm);
      const foreignBracket =
        `items%5B0%5D%5Bid%5D=${FOREIGN_VARIANT}&items%5B0%5D%5Bselling_plan%5D=${PLAN_ID}`;
      expect(page.xhrPost(foreignBracket)).toBe(foreignBracket);
      expect(ofEvent(page, "atc")).toHaveLength(0);
      // Nor a body with no id at all, nor a shape the patch never reads.
      expect(page.xhrPost("quantity=1")).toBe("quantity=1");
      page.fetchPost(new Blob(["id=1"]));
      expect(ofEvent(page, "atc")).toHaveLength(0);
    });

    it("MUTATION CHECK: without bodyTargetsOurs the ours-complete add is silent again", () => {
      const page = buildPage({
        mutateEmbed: (source) =>
          source
            .replace("nextBody !== null || bodyTargetsOurs(init.body, state)", "nextBody !== null")
            .replace("nextBody !== null || bodyTargetsOurs(body, state)", "nextBody !== null"),
      });
      expect(page.sourceChanged).toBe(true);
      page.xhrPost(completeFlat());
      page.fetchPost(completeJson());
      expect(ofEvent(page, "atc")).toHaveLength(0);
    });
  });
});

describe("atc: the theme-form submit path (buy-box.js install shape)", () => {
  function submit(page: Page, form: ElementNode): void {
    form.dispatchEvent(new EventShim("submit", { bubbles: true, cancelable: true }));
    page.flush();
  }

  it("counts a submit of a /cart/add form that carries our enabled seen input", () => {
    const page = buildPage({ themeForm: true });
    const form = page.document.querySelector('form[action*="/cart/add"]') as ElementNode;
    // Non-vacuous: buy-box.js bound the form and wrote its seen input.
    const seen = form.querySelector('input[name="properties[_cellexia_seen]"]') as ElementNode;
    expect(seen).not.toBeNull();
    expect(seen.disabled).toBe(false);
    expect(seen.value).toBe("classic|s");

    submit(page, form);
    const atc = ofEvent(page, "atc");
    expect(atc).toHaveLength(1);
    expect(atc[0].params.get("m")).toBe("s");

    // The mode decides m: one-time selected → o (a second, distinct flag).
    selectMode(page, "one_time");
    submit(page, form);
    expect(ofEvent(page, "atc").map((b) => b.params.get("m"))).toEqual(["s", "o"]);
    // …and never twice for the same mode.
    submit(page, form);
    expect(ofEvent(page, "atc")).toHaveLength(2);
  });

  it("ignores a form without our seen input, a disabled input, and a non-cart form", () => {
    const page = buildPage({ themeForm: true });
    const form = page.document.querySelector('form[action*="/cart/add"]') as ElementNode;
    const seen = form.querySelector('input[name="properties[_cellexia_seen]"]') as ElementNode;

    seen.disabled = true; // releaseForm()'s state while the widget is hidden
    submit(page, form);
    expect(ofEvent(page, "atc")).toHaveLength(0);
    seen.disabled = false;

    form.setAttribute("action", "/cart/change");
    submit(page, form);
    expect(ofEvent(page, "atc")).toHaveLength(0);
    form.setAttribute("action", "/cart/add");

    seen.remove();
    submit(page, form);
    expect(ofEvent(page, "atc")).toHaveLength(0);
  });
});

// ── params ───────────────────────────────────────────────────────────────────

describe("params: exactly the wire format the proxy route parses", () => {
  const SHOPIFY = { country: "ch", currency: { active: "chf" } };

  it("sends e, d, p, v, c, cur, dv, vid, pv, t on the pinned path (and m only on atc)", () => {
    const page = buildPage({ shopify: SHOPIFY });
    const before = Date.now();
    showWidget(page);
    page.flush();
    const [view] = ofEvent(page, "view");
    expect(view.path).toBe(VISIT_PATH);
    expect([...view.params.keys()].sort()).toEqual(
      ["c", "cur", "d", "dv", "e", "p", "pv", "t", "v", "vid"].sort(),
    );
    expect(view.params.get("d")).toBe("classic");
    expect(view.params.get("p")).toBe("s");
    expect(view.params.get("v")).toBe(OUR_VARIANT);
    expect(view.params.get("c")).toBe("CH"); // uppercased ISO-2
    expect(view.params.get("cur")).toBe("CHF");
    expect(view.params.get("dv")).toBe("d"); // innerWidth 1280, fine pointer
    expect(view.params.get("vid")).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(view.params.get("pv")).toMatch(/^[A-Za-z0-9_-]{8}$/);
    const t = Number(view.params.get("t"));
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(Date.now());

    page.xhrPost(`id=${OUR_VARIANT}&quantity=1`);
    const [atc] = ofEvent(page, "atc");
    expect([...atc.params.keys()].sort()).toEqual(
      ["c", "cur", "d", "dv", "e", "m", "p", "pv", "t", "v", "vid"].sort(),
    );
    expect(atc.params.get("m")).toBe("s");
  });

  it("keeps vid and pv identical across view, engage and atc within one page load", () => {
    const page = buildPage();
    showWidget(page);
    page.flush();
    radioFor(page, "subscription").dispatchEvent(new EventShim("click", { bubbles: true }));
    page.xhrPost(`id=${OUR_VARIANT}&quantity=1`);
    const all = beacons(page);
    expect(all.map((b) => b.params.get("e"))).toEqual(["view", "engage", "atc"]);
    const vids = new Set(all.map((b) => b.params.get("vid")));
    const pvs = new Set(all.map((b) => b.params.get("pv")));
    expect(vids.size).toBe(1);
    expect(pvs.size).toBe(1);
  });

  it("follows the variant the shopper switched to", () => {
    const page = buildPage();
    (page.subs.setVariant as (id: string) => void)(OTHER_VARIANT);
    page.flush();
    showWidget(page);
    page.flush();
    expect(ofEvent(page, "view")[0].params.get("v")).toBe(OTHER_VARIANT);
  });

  it("encodes the preselect variable: o for a one-time-preselected render, u when the field is missing", () => {
    const oneTime = buildPage({ embedMarkup: EMBED_LIVE_ONE_TIME });
    expect(currentState(oneTime)).toMatchObject({ preselect: false, mode: "one_time" });
    showWidget(oneTime);
    oneTime.flush();
    expect(ofEvent(oneTime, "view")[0].params.get("p")).toBe("o");
    // The stamp is a render decision, not the mode: switching to the
    // subscription keeps p = o.
    selectMode(oneTime, "subscription");
    oneTime.xhrPost(`id=${OUR_VARIANT}&quantity=1`);
    expect(ofEvent(oneTime, "atc")[0].params.get("p")).toBe("o");
    expect(ofEvent(oneTime, "atc")[0].params.get("m")).toBe("s");

    const legacy = buildPage({
      mutateBuyBox: (source) =>
        source.replace(/\n\s*preselect: data\.preselect === true,\n/, "\n"),
    });
    expect(legacy.buyBoxSourceChanged).toBe(true);
    showWidget(legacy);
    legacy.flush();
    expect(ofEvent(legacy, "view")[0].params.get("p")).toBe("u");
  });

  it("sends empty c and cur when window.Shopify is absent, and validates their shape", () => {
    const absent = buildPage();
    showWidget(absent);
    absent.flush();
    expect(ofEvent(absent, "view")[0].params.get("c")).toBe("");
    expect(ofEvent(absent, "view")[0].params.get("cur")).toBe("");

    const odd = buildPage({ shopify: { country: "Switzerland", currency: { active: "francs" } } });
    showWidget(odd);
    odd.flush();
    expect(ofEvent(odd, "view")[0].params.get("c")).toBe("");
    expect(ofEvent(odd, "view")[0].params.get("cur")).toBe("");
  });

  it("classifies the device: m under 768, t under 1024, t for a coarse pointer on a wide viewport, d otherwise", () => {
    const cases: Array<[number, boolean, string]> = [
      [500, false, "m"],
      [390, true, "m"],
      [800, false, "t"],
      [1280, true, "t"],
      [1280, false, "d"],
    ];
    for (const [width, coarse, expected] of cases) {
      const page = buildPage({ innerWidth: width, coarsePointer: coarse });
      showWidget(page);
      page.flush();
      expect(ofEvent(page, "view")[0].params.get("dv"), `${width}/${coarse}`).toBe(expected);
    }
  });

  it("uses crypto.getRandomValues for the ids when the browser has it", () => {
    const page = buildPage({ crypto: true });
    showWidget(page);
    page.flush();
    // pv at boot, vid at the first beacon: two calls.
    expect(page.cryptoCalls).toBe(2);
    expect(ofEvent(page, "view")[0].params.get("vid")).toMatch(/^[A-Za-z0-9]{16}$/);
  });
});

// ── vid persistence ──────────────────────────────────────────────────────────

describe("vid: localStorage cellexia_vid, then sessionStorage, then per page", () => {
  it("persists the visitor id in localStorage and reuses it on the next page load", () => {
    const first = buildPage();
    showWidget(first);
    first.flush();
    const vid = ofEvent(first, "view")[0].params.get("vid") as string;
    expect(first.storage.local.get("cellexia_vid")).toBe(vid);
    expect(first.storage.session.has("cellexia_vid")).toBe(false);

    const second = buildPage({ storage: first.storage });
    showWidget(second);
    second.flush();
    expect(ofEvent(second, "view")[0].params.get("vid")).toBe(vid);
    // A new page load is a new page view.
    expect(ofEvent(second, "view")[0].params.get("pv")).not.toBe(
      ofEvent(first, "view")[0].params.get("pv"),
    );
  });

  it("falls back to sessionStorage when localStorage is absent or throws on access", () => {
    for (const localStorage of ["absent", "throws"] as const) {
      const page = buildPage({ localStorage });
      showWidget(page);
      page.flush();
      const vid = ofEvent(page, "view")[0].params.get("vid") as string;
      expect(vid, localStorage).toMatch(/^[A-Za-z0-9_-]{16}$/);
      expect(page.storage.session.get("cellexia_vid"), localStorage).toBe(vid);
      expect(page.storage.local.has("cellexia_vid"), localStorage).toBe(false);
    }
  });

  it("still sends a well-formed per-page id when no storage works at all", () => {
    const page = buildPage({ localStorage: "throws", sessionStorage: "absent" });
    showWidget(page);
    page.flush();
    page.xhrPost(`id=${OUR_VARIANT}&quantity=1`);
    const vids = new Set(beacons(page).map((b) => b.params.get("vid")));
    expect(vids.size).toBe(1);
    expect([...vids][0]).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });

  it("replaces a tampered stored value instead of sending it", () => {
    const storage = { local: new Map([["cellexia_vid", "<script>x</script>"]]), session: new Map() };
    const page = buildPage({ storage });
    showWidget(page);
    page.flush();
    const vid = ofEvent(page, "view")[0].params.get("vid") as string;
    expect(vid).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(storage.local.get("cellexia_vid")).toBe(vid);
  });
});

// ── silence ──────────────────────────────────────────────────────────────────

describe("silence: previews and hidden widgets are never measured", () => {
  it("sends nothing in an admin preview (?cx_preview= in the URL), while the cart stamp still works", () => {
    const page = buildPage({ search: "?cx_preview=tok-123&variant=1" });
    expect(currentState(page)).not.toBeNull();
    // No observer was even created: the admin's own reading is not a visit,
    // so there is no visibility to report; interactions and adds stay silent.
    expect(page.observers).toEqual([]);
    page.flush();
    radioFor(page, "subscription").dispatchEvent(new EventShim("click", { bubbles: true }));
    const out = new URLSearchParams(String(page.xhrPost(`id=${OUR_VARIANT}&quantity=1`)));
    expect(out.get("selling_plan")).toBe(PLAN_ID);
    expect(page.images).toEqual([]);
    expect(fetchBeacons(page)).toEqual([]);
    // The fallback view path is off too (no IO here would otherwise fire it).
    const noIo = buildPage({ search: "?cx_preview=tok-123", io: "absent" });
    expect(currentState(noIo)).not.toBeNull();
    expect(noIo.images).toEqual([]);
  });

  it("sends nothing in the theme editor (Shopify.designMode === true), while the cart stamp still works", () => {
    // WHY (v1.27.0 review #1): the customiser's preview frame carries no
    // cx_preview= in its URL, so without this gate every editing session
    // adds zero-order visits to exactly the design being edited. Shopify's
    // documented editor-only global is the signal.
    const page = buildPage({ shopify: { designMode: true, country: "CH" } });
    expect(currentState(page)).not.toBeNull();
    // No observer, so no view can ever arm; interactions and adds stay silent.
    expect(page.observers).toEqual([]);
    page.flush();
    radioFor(page, "subscription").dispatchEvent(new EventShim("click", { bubbles: true }));
    const out = new URLSearchParams(String(page.xhrPost(`id=${OUR_VARIANT}&quantity=1`)));
    expect(out.get("selling_plan")).toBe(PLAN_ID);
    expect(out.get("properties[_cellexia_seen]")).toBe("classic|s");
    expect(page.images).toEqual([]);
    expect(fetchBeacons(page)).toEqual([]);
    // The no-IntersectionObserver fallback is off too.
    const noIo = buildPage({ shopify: { designMode: true }, io: "absent" });
    expect(currentState(noIo)).not.toBeNull();
    expect(noIo.images).toEqual([]);
    // Only the documented boolean counts: a truthy string or a false flag is
    // a live storefront, so the merchant's real shoppers are still measured.
    for (const shopify of [{ designMode: false }, { designMode: "true" }, {}]) {
      const live = buildPage({ shopify });
      expect(live.observers, JSON.stringify(shopify)).toHaveLength(1);
      showWidget(live);
      live.flush();
      expect(ofEvent(live, "view"), JSON.stringify(shopify)).toHaveLength(1);
    }
  });

  it("sends nothing while the widget is hidden (setup mode: getState() is null)", () => {
    const page = buildPage({ launchStatus: "setup" });
    expect(currentState(page)).toBeNull();
    if (page.io) showWidget(page);
    page.flush();
    (page.widget as ElementNode).dispatchEvent(new EventShim("click", { bubbles: true }));
    const original = `id=${OUR_VARIANT}&quantity=1`;
    expect(page.xhrPost(original)).toBe(original);
    expect(page.images).toEqual([]);
    expect(fetchBeacons(page)).toEqual([]);
  });
});

// ── containment ──────────────────────────────────────────────────────────────

describe("containment: the beacon never breaks add-to-cart", () => {
  it("an Image constructor that throws leaves the cart request untouched and stamped", () => {
    const page = buildPage({ image: "throw" });
    showWidget(page);
    expect(() => page.flush()).not.toThrow();
    const out = new URLSearchParams(String(page.xhrPost(`id=${OUR_VARIANT}&quantity=1`)));
    // The request went out, patched exactly as without the beacon.
    expect(page.sent[page.sent.length - 1].url).toBe("/cart/add.js");
    expect(out.get("selling_plan")).toBe(PLAN_ID);
    expect(out.get("properties[_cellexia_design]")).toBe("classic");
    expect(out.get("properties[_cellexia_seen]")).toBe("classic|s");
    expect(page.images).toEqual([]);
    // Same through fetch.
    const json = JSON.parse(
      String(page.fetchPost(JSON.stringify({ items: [{ id: Number(OUR_VARIANT), quantity: 1 }] }))),
    ) as { items: Array<Record<string, unknown>> };
    expect(json.items[0].selling_plan).toBe(Number(PLAN_ID));
  });

  it("uses fetch(GET, keepalive, no-cors, credentials omit) only when Image is missing, and never awaits it", () => {
    const page = buildPage({ image: "absent" });
    showWidget(page);
    page.flush();
    const [beacon] = fetchBeacons(page);
    expect(beacon).toBeDefined();
    expect(beacon.method).toBe("GET");
    expect(beacon.init).toMatchObject({
      method: "GET",
      keepalive: true,
      credentials: "omit",
      mode: "no-cors",
    });
    expect(parseBeacon(beacon.url).params.get("e")).toBe("view");
    // The cart request is still the last thing sent after an add.
    page.xhrPost(`id=${OUR_VARIANT}&quantity=1`);
    expect(page.sent[page.sent.length - 1].url).toBe("/cart/add.js");
    expect(fetchBeacons(page).map((r) => parseBeacon(r.url).params.get("e"))).toEqual([
      "view",
      "atc",
    ]);
  });

  it("pins the beacon path literal in the shipped source (spelled once, app-proxy subpath)", () => {
    const source = readFileSync(EMBED_JS, "utf8");
    // One constant, one spelling; the app-proxy subpath itself is pinned
    // against shopify.app.toml by tests/proxy-subpath.test.ts.
    expect(source.match(/VISIT_PATH = '[^']*'/g)).toEqual([`VISIT_PATH = '${VISIT_PATH}'`]);
    expect(source).not.toContain("/apps/cellexia/");
  });
});
