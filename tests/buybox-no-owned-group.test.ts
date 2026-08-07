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
 * THE ADMIN-ONLY "no owned group" DIAGNOSTIC (v1.2.4).
 *
 * On a product whose selling plan groups ALL belong to another subscription
 * app — the client's store runs Joy Subscriptions alongside this one — the
 * buy box renders nothing at all rather than render a competitor's plan
 * through our widget (tests/liquid/render.test.ts pins that half). Correct,
 * and completely silent: the merchant sees a product page with no buy box and
 * no reason given.
 *
 * So the Liquid leaves ONE trace, an empty hidden <template> carrying
 * data-cellexia-no-owned-group, and assets/buy-box.js turns it into a
 * plain-English hint card — but ONLY for a browser session whose preview
 * token the app proxy has actually validated. The card is internal English
 * copy on a live Swiss storefront if that gate ever leaks, so this suite
 * drives the REAL asset files over the REAL server-rendered markup and asserts
 * the gate from both sides: nothing for a shopper, the hint for the admin.
 *
 * Both install shapes are covered, because the marker reaches the page
 * differently in each: standalone for the section app block, inside the
 * (empty, hidden) wrapper for the app embed.
 */

const ASSETS = fileURLToPath(
  new URL("../extensions/cellexia-buy-box/assets/", import.meta.url),
);
const BUY_BOX_JS = join(ASSETS, "buy-box.js");
const EMBED_JS = join(ASSETS, "buy-box-embed.js");

const VALIDATE_PATH = "/apps/cellexia-subs/preview/validate";
const EXPECTED_HINT =
  "Cellexia buy box: this product has subscription plans from another app " +
  "but none from Cellexia. Sync your Cellexia plan to this product in the " +
  "app's Plans page.";

/** Server-rendered markup, straight out of the real Liquid. */
const MARKUP: Record<string, string> = {};

beforeAll(async () => {
  const [sectionNoGroup, embedNoGroup, sectionWidget] = await Promise.all([
    renderWidget({ foreignGroupOnly: true, launchStatus: "live" }),
    renderEmbed({ foreignGroupOnly: true, launchStatus: "live" }),
    // A product we DO own a group on, rendered gated: the control page.
    renderWidget({ launchStatus: "setup" }),
  ]);
  MARKUP.sectionNoGroup = sectionNoGroup;
  MARKUP.embedNoGroup = embedNoGroup;
  MARKUP.sectionWidget = sectionWidget;
});

interface RunOptions {
  /** Which server-rendered markup to put on the page. */
  markup: "sectionNoGroup" | "embedNoGroup" | "sectionWidget";
  /** A ?cx_preview= token in the URL (nothing = an ordinary shopper). */
  token?: string;
  /**
   * What /preview/validate answers for that token. "pending" never answers —
   * the window in which the raw token is already in sessionStorage and the
   * session is still unproven.
   */
  validates?: boolean | "pending";
  /** Load buy-box-embed.js too (the app-embed install shape). */
  withEmbed?: boolean;
}

interface RunResult {
  document: DocumentNode;
  body: ElementNode;
  cards: ElementNode[];
  requests: string[];
  storage: Map<string, string>;
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

  // A theme buy column, so the embed has somewhere plausible to mount.
  parseHtml(
    '<main><div class="product__info"><h1>Cellexia Serum</h1>' +
      '<div class="product-form__buttons"><button>Add to cart</button></div>' +
      "</div></main>",
    body,
  );
  parseHtml(MARKUP[options.markup], body);

  const requests: string[] = [];
  const storage = new Map<string, string>();
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
      if (options.validates === "pending") {
        return new Promise(() => {
          /* still in flight when the assertions run */
        });
      }
      return Promise.resolve({
        ok: true,
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
    body,
    cards: allElements(body).filter((element) =>
      element.classList.contains("cx-buybox-diagnostic"),
    ),
    requests,
    storage,
  };
}

describe("the no-owned-group marker as the server sends it", () => {
  it("is a single empty hidden template, in both install shapes", async () => {
    for (const markup of ["sectionNoGroup", "embedNoGroup"] as const) {
      const page = await run({ markup, withEmbed: markup === "embedNoGroup" });
      const markers = allElements(page.body).filter((element) =>
        element.hasAttribute("data-cellexia-no-owned-group"),
      );
      expect(markers, markup).toHaveLength(1);
      expect(markers[0].tagName, markup).toBe("TEMPLATE");
      expect(markers[0].classList.contains("cx-buybox-nogroup"), markup).toBe(
        true,
      );
      expect(markers[0].hasAttribute("hidden"), markup).toBe(true);
      expect(markers[0].childNodes.length, markup).toBe(0);
      // Not a widget and not a wrapper: no asset may treat it as either.
      expect(markers[0].hasAttribute("data-cellexia-buybox"), markup).toBe(
        false,
      );
      expect(markers[0].hasAttribute("data-cellexia-embed"), markup).toBe(
        false,
      );
    }
  });

  it("brings no widget, no JSON island and no hidden plan input with it", async () => {
    const page = await run({ markup: "sectionNoGroup" });
    expect(page.document.querySelector("[data-cellexia-buybox]")).toBeNull();
    expect(page.document.querySelector("[data-cellexia-data]")).toBeNull();
    expect(
      page.document.querySelector("[data-cellexia-selling-plan]"),
    ).toBeNull();
    expect(page.document.querySelector("[name='selling_plan']")).toBeNull();
  });
});

describe("what a shopper gets", () => {
  it("shows no card and asks the proxy nothing at all", async () => {
    for (const markup of ["sectionNoGroup", "embedNoGroup"] as const) {
      const page = await run({ markup, withEmbed: markup === "embedNoGroup" });
      expect(page.cards, markup).toEqual([]);
      expect(page.requests, markup).toEqual([]);
      expect(page.body.textContent, markup).not.toContain("Cellexia buy box:");
    }
  });

  it("shows no card for a token the proxy rejects, and forgets it", async () => {
    const page = await run({
      markup: "sectionNoGroup",
      token: "leaked-or-expired",
      validates: false,
    });
    expect(page.requests).toHaveLength(1);
    expect(page.requests[0]).toContain(VALIDATE_PATH);
    expect(page.cards).toEqual([]);
    // A rejected token is dropped, so the page stops asking.
    expect([...page.storage.values()]).toEqual([]);
  });

  it("shows no card while the answer is still in flight", async () => {
    /* The raw token is written to sessionStorage by the FIRST lines of
       previewBoot, long before the proxy has judged it — the exact window in
       which keying the card off "a token exists" instead of off the validated
       flag would leak internal English copy onto a live storefront. A leaked
       or invented link puts a token there just as convincingly. */
    const page = await run({
      markup: "sectionNoGroup",
      token: "not-answered-yet",
      validates: "pending",
    });
    expect(page.storage.get("cx_preview_token")).toBe("not-answered-yet");
    expect(page.requests).toHaveLength(1);
    expect(page.cards).toEqual([]);
  });
});

describe("what a validated admin gets", () => {
  it("raises exactly one hint card, in both install shapes", async () => {
    for (const markup of ["sectionNoGroup", "embedNoGroup"] as const) {
      const page = await run({
        markup,
        token: "signed-preview-token",
        validates: true,
        withEmbed: markup === "embedNoGroup",
      });
      expect(page.cards, markup).toHaveLength(1);
      expect(page.cards[0].tagName, markup).toBe("DIV");
      expect(page.cards[0].getAttribute("role"), markup).toBe("status");
      expect(page.cards[0].textContent, markup).toBe(EXPECTED_HINT);
      expect(page.cards[0].parentNode, markup).toBe(page.body);
    }
  });

  it("never doubles up with the app embed's placement diagnostic", async () => {
    /* Both cards are position:fixed in the same corner. The embed's card
       blames the placement, which is the wrong hint here (there is nothing to
       place), so it must stay quiet on a wrapper with no widget in it. */
    const page = await run({
      markup: "embedNoGroup",
      token: "signed-preview-token",
      validates: true,
      withEmbed: true,
    });
    expect(page.cards).toHaveLength(1);
    expect(page.cards[0].textContent).toBe(EXPECTED_HINT);
    expect(page.cards[0].textContent).not.toContain("placement anchor");
  });

  it("stays quiet on a product whose group IS ours", async () => {
    const page = await run({
      markup: "sectionWidget",
      token: "signed-preview-token",
      validates: true,
    });
    // The gated widget is revealed for the admin…
    const widget = page.document.querySelector("[data-cellexia-buybox]");
    expect(widget).not.toBeNull();
    expect((widget as ElementNode).getAttribute("data-cellexia-preview")).toBe(
      "true",
    );
    // …and no marker was rendered, so no hint is raised.
    expect(
      page.document.querySelector("[data-cellexia-no-owned-group]"),
    ).toBeNull();
    expect(page.cards).toEqual([]);
  });
});
