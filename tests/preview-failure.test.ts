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
} from "./helpers/hostile-dom";
import { renderEmbed, renderWidget } from "./liquid/harness";

/**
 * PREVIEW-VALIDATION FAILURE SURFACING (v1.6.7).
 *
 * The defect this pins the fix for, reported live: the merchant created a
 * plan, opened a storefront preview, and got a blank page — because
 * /apps/cellexia-subs/preview/validate 404'd (the app configuration was
 * never deployed). Every failure in the ?cx_preview= chain used to look
 * identical: the widget stayed hidden IN SILENCE, exactly as it does for a
 * customer. Fail-closed rendering of the widget is correct and unchanged;
 * the silence was the bug.
 *
 * The contract: when — and only when — the URL of THIS page load carries the
 * cx_preview parameter (admin context; customers never have it) AND the
 * validation round-trip completes with a failure, buy-box.js raises the
 * existing admin-diagnostic card style with the specific reason:
 *
 *   - transport failure (non-2xx HTTP status, network error/timeout) →
 *     "the preview could not be validated (<detail>) … run the Preview
 *     Doctor" — naming the transport detail but routing to the admin-gated
 *     doctor for cause and fix;
 *   - { ok: false } (expired or invalid token) → "generate a fresh preview
 *     link from Preview & launch".
 *
 * The gate is the URL parameter, NOT sessionStorage: the stored token
 * follows the tab across the admin's PDP → cart navigation, and a card
 * keyed off storage could fire on pages nobody previewed — including for a
 * customer in a browser session where a preview link was once opened. The
 * widget itself is revealed only by a validated session, exactly as before.
 *
 * DISCLOSURE RULE (also pinned here): the failure card's gate is the URL
 * parameter ALONE — validation failed, so no admin is proven — which makes
 * it an unauthenticated surface anyone can elicit with ?cx_preview=x. Its
 * copy must therefore never name internal paths (the validate endpoint) or
 * operator commands (npm run …); that detail lives in the admin-gated
 * Preview Doctor the card points to.
 *
 * Like tests/buybox-no-owned-group.test.ts, this drives the REAL asset
 * files over REAL server-rendered markup, in both install shapes.
 */

const ASSETS = fileURLToPath(
  new URL("../extensions/cellexia-buy-box/assets/", import.meta.url),
);
const BUY_BOX_JS = join(ASSETS, "buy-box.js");
const EMBED_JS = join(ASSETS, "buy-box-embed.js");

const VALIDATE_PATH = "/apps/cellexia-subs/preview/validate";

/** The exact copy the card must carry — remediation lines included. */
const TOKEN_CARD =
  "Cellexia buy box: this preview link is expired or invalid, so the " +
  "widget stays hidden. Generate a fresh preview link from Preview & launch.";
const proxyCard = (detail: string): string =>
  `Cellexia buy box: the preview could not be validated (${detail}), so ` +
  "the widget stays hidden. Open Preview & launch in the Cellexia admin " +
  "and run the Preview Doctor for the exact cause and fix.";

/** Server-rendered markup, straight out of the real Liquid: gated widgets. */
const MARKUP: Record<string, string> = {};

beforeAll(async () => {
  const [sectionGated, embedGated] = await Promise.all([
    renderWidget({ launchStatus: "setup" }),
    renderEmbed({ launchStatus: "setup" }),
  ]);
  MARKUP.sectionGated = sectionGated;
  MARKUP.embedGated = embedGated;
});

interface RunOptions {
  markup: "sectionGated" | "embedGated";
  /** A ?cx_preview= token in the URL (nothing = an ordinary shopper). */
  token?: string;
  /** A token pre-seeded in sessionStorage only — the PDP → cart hop. */
  storedToken?: string;
  /** What /preview/validate answers with HTTP 200: { ok: <this> }. */
  validates?: boolean;
  /** Answer with this non-2xx HTTP status instead (proxy missing/broken). */
  httpStatus?: number;
  /** Reject the fetch outright (network error / timeout). */
  networkError?: boolean;
  /** Load buy-box-embed.js too (the app-embed install shape). */
  withEmbed?: boolean;
  /** Leave the theme buy column out, so the embed finds no mount anchor. */
  noAnchor?: boolean;
}

interface RunResult {
  document: DocumentNode;
  cards: ElementNode[];
  requests: string[];
  storage: Map<string, string>;
  widget: ElementNode | null;
  wrapper: ElementNode | null;
}

async function run(options: RunOptions): Promise<RunResult> {
  resetDomState();

  const documentNode = new DocumentNode();
  const html = new ElementNode("html");
  documentNode.appendChild(html);
  const body = new ElementNode("body");
  html.appendChild(body);
  documentNode.body = body;
  documentNode.documentElement = html;

  // A theme buy column, so the embed has somewhere plausible to mount —
  // unless the scenario is exactly "no anchor anywhere on this page".
  parseHtml(
    options.noAnchor
      ? "<main><h1>Cellexia Serum</h1></main>"
      : '<main><div class="product__info"><h1>Cellexia Serum</h1>' +
          '<div class="product-form__buttons"><button>Add to cart</button>' +
          "</div></div></main>",
    body,
  );
  parseHtml(MARKUP[options.markup], body);

  const requests: string[] = [];
  const storage = new Map<string, string>();
  if (options.storedToken) {
    storage.set("cx_preview_token", options.storedToken);
  }
  const noop = (): void => {};

  const windowStub: Record<string, unknown> = {
    location: {
      origin: "https://cellexialabs.com",
      href: "https://cellexialabs.com/products/cellexia-serum",
      search: options.token ? `?cx_preview=${options.token}` : "",
    },
    history: {},
    document: documentNode,
    setTimeout: scheduleTimer,
    clearTimeout: cancelTimer,
    MutationObserver: MutationObserverShim,
    fetch: (url: string) => {
      requests.push(String(url));
      if (options.networkError) {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      if (options.httpStatus) {
        return Promise.resolve({
          ok: false,
          status: options.httpStatus,
          json: () => Promise.resolve({}),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: options.validates === true }),
      });
    },
    sessionStorage: {
      getItem: (key: string) => storage.get(String(key)) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(String(key), String(value));
      },
      removeItem: (key: string) => {
        storage.delete(String(key));
      },
    },
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
  if (options.withEmbed) {
    vm.runInContext(readFileSync(EMBED_JS, "utf8"), sandbox, {
      filename: "buy-box-embed.js",
    });
  }
  flushTimers();
  // The proxy answer arrives over microtasks; a macrotask tick drains them.
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushTimers();

  return {
    document: documentNode,
    cards: allElements(body).filter((element) =>
      element.classList.contains("cx-buybox-diagnostic"),
    ),
    requests,
    storage,
    widget: documentNode.querySelector(
      ".cx-buybox[data-cellexia-buybox]",
    ) as ElementNode | null,
    wrapper: documentNode.querySelector(
      ".cx-buybox-embed[data-cellexia-embed]",
    ) as ElementNode | null,
  };
}

describe("a rejected token ({ ok: false }) from the URL", () => {
  it("raises the expired-link card and keeps the widget hidden", async () => {
    const page = await run({
      markup: "sectionGated",
      token: "expired-preview-token",
      validates: false,
    });
    expect(page.requests).toHaveLength(1);
    expect(page.requests[0]).toContain(VALIDATE_PATH);
    expect(page.cards).toHaveLength(1);
    expect(page.cards[0].tagName).toBe("DIV");
    expect(page.cards[0].getAttribute("role")).toBe("status");
    expect(page.cards[0].textContent).toBe(TOKEN_CARD);
    // Fail-closed rendering is UNCHANGED: gated, hidden, never revealed.
    expect(page.widget).not.toBeNull();
    expect((page.widget as ElementNode).hasAttribute("hidden")).toBe(true);
    expect(
      (page.widget as ElementNode).getAttribute("data-cellexia-preview"),
    ).toBeNull();
    // The dead token is dropped, so the page stops asking.
    expect([...page.storage.values()]).toEqual([]);
  });
});

describe("a proxy that is not there (the undeployed-app blank page)", () => {
  it("raises the deploy card naming the HTTP status", async () => {
    const page = await run({
      markup: "sectionGated",
      token: "any-token",
      httpStatus: 404,
    });
    expect(page.cards).toHaveLength(1);
    expect(page.cards[0].getAttribute("role")).toBe("status");
    expect(page.cards[0].textContent).toBe(proxyCard("HTTP 404"));
    expect((page.widget as ElementNode).hasAttribute("hidden")).toBe(true);
    // A server hiccup keeps the token: reloading after deploy just works.
    expect(page.storage.get("cx_preview_token")).toBe("any-token");
  });

  it("names a 5xx as itself — a deployed but broken proxy reads differently", async () => {
    const page = await run({
      markup: "sectionGated",
      token: "any-token",
      httpStatus: 502,
    });
    expect(page.cards).toHaveLength(1);
    expect(page.cards[0].textContent).toBe(proxyCard("HTTP 502"));
  });

  it("raises the deploy card on a network error too", async () => {
    const page = await run({
      markup: "sectionGated",
      token: "any-token",
      networkError: true,
    });
    expect(page.cards).toHaveLength(1);
    expect(page.cards[0].textContent).toBe(
      proxyCard("a network error or timeout"),
    );
    expect((page.widget as ElementNode).hasAttribute("hidden")).toBe(true);
    expect(page.storage.get("cx_preview_token")).toBe("any-token");
  });

  it("discloses no internal paths or operator commands (unauthenticated surface)", async () => {
    /* The card's gate is the URL parameter alone — validation failed, so no
       admin is proven — meaning anyone can elicit it with ?cx_preview=x.
       Whatever the copy says, it must never leak configuration detail: no
       proxy/endpoint paths, no shell commands. The fix detail lives in the
       admin-gated Preview Doctor the card points to. */
    for (const failure of [{ httpStatus: 404 }, { networkError: true }]) {
      const page = await run({
        markup: "sectionGated",
        token: "any-token",
        ...failure,
      });
      const text = page.cards.map((card) => card.textContent).join(" ");
      expect(text).not.toContain(VALIDATE_PATH);
      expect(text).not.toMatch(/\/apps\//);
      expect(text).not.toMatch(/npm|deploy/i);
    }
  });
});

describe("the customer gate: no cx_preview in THIS page's URL, no card", () => {
  it("stays silent when the failing token came from sessionStorage alone", async () => {
    /* The PDP → cart hop: the stored token follows the tab, the URL does
       not. If validation fails on such a page — token expired mid-session,
       say — the admin gets silence there (the page they previewed is where
       the card lives), and a customer in a session that once saw a preview
       link can never be shown vendor English. */
    const page = await run({
      markup: "sectionGated",
      storedToken: "expired-mid-session",
      validates: false,
    });
    expect(page.requests).toHaveLength(1); // validation still ran…
    expect(page.cards).toEqual([]); // …but no card without the URL param
    expect([...page.storage.values()]).toEqual([]); // dead token still dropped
  });

  it("stays silent on a proxy failure when the token is storage-only", async () => {
    const page = await run({
      markup: "sectionGated",
      storedToken: "stored-token",
      httpStatus: 404,
    });
    expect(page.cards).toEqual([]);
  });

  it("an ordinary shopper: no token, no request, no card", async () => {
    const page = await run({ markup: "sectionGated" });
    expect(page.requests).toEqual([]);
    expect(page.cards).toEqual([]);
  });
});

describe("a validated session shows the widget, never a failure card", () => {
  it("reveals the gated widget and raises nothing", async () => {
    const page = await run({
      markup: "sectionGated",
      token: "signed-preview-token",
      validates: true,
    });
    expect(page.cards).toEqual([]);
    expect((page.widget as ElementNode).hasAttribute("hidden")).toBe(false);
    expect(
      (page.widget as ElementNode).getAttribute("data-cellexia-preview"),
    ).toBe("true");
  });
});

describe("the app-embed install shape", () => {
  it("raises exactly one card on a proxy 404 — the placement card stays quiet", async () => {
    /* buy-box-embed.js's own "no placement anchor" diagnostic is gated on
       the VALIDATED session, which a failed validation by definition never
       establishes — so the two cards (same fixed corner) can never stack. */
    const page = await run({
      markup: "embedGated",
      token: "any-token",
      httpStatus: 404,
      withEmbed: true,
    });
    expect(page.cards).toHaveLength(1);
    expect(page.cards[0].textContent).toBe(proxyCard("HTTP 404"));
    // The mounted-but-gated wrapper stays hidden: nothing shifts on the PDP.
    expect((page.wrapper as ElementNode).hasAttribute("hidden")).toBe(true);
    expect((page.widget as ElementNode).hasAttribute("hidden")).toBe(true);
  });

  it("raises the expired-link card for a rejected token", async () => {
    const page = await run({
      markup: "embedGated",
      token: "expired-preview-token",
      validates: false,
      withEmbed: true,
    });
    expect(page.cards).toHaveLength(1);
    expect(page.cards[0].textContent).toBe(TOKEN_CARD);
    expect((page.wrapper as ElementNode).hasAttribute("hidden")).toBe(true);
  });
});

describe("the placement-anchor card obeys the same URL gate", () => {
  /* v1.6.7: every admin diagnostic requires ?cx_preview= in the URL of the
     page it appears on. The embed's "no placement anchor" card additionally
     requires the VALIDATED session (it names shop-internal configuration).
     The validated token persists in sessionStorage across same-tab
     navigation — by design, for the widget reveal — so without the URL half
     this card could surface on pages the admin never previewed. */
  const PLACEMENT_CARD =
    "Cellexia buy box: no placement anchor found — set a custom CSS " +
    "selector in the Buy box designer → Placement.";

  it("appears for a validated admin on the preview-linked page", async () => {
    const page = await run({
      markup: "embedGated",
      token: "signed-preview-token",
      validates: true,
      withEmbed: true,
      noAnchor: true,
    });
    expect(page.cards).toHaveLength(1);
    expect(page.cards[0].textContent).toBe(PLACEMENT_CARD);
  });

  it("stays silent on a VALIDATED storage-only hop (no ?cx_preview= here)", async () => {
    const page = await run({
      markup: "embedGated",
      storedToken: "validated-on-a-previous-page",
      validates: true,
      withEmbed: true,
      noAnchor: true,
    });
    // The proxy said yes — only the URL half of the double gate held it.
    expect(page.requests).toHaveLength(1);
    expect(page.cards).toEqual([]);
  });
});
