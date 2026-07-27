import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

/**
 * MOUNT LIFECYCLE contract for extensions/cellexia-buy-box/assets/
 * buy-box-embed.js.
 *
 * The app embed renders ONE widget wrapper at the end of <body> and this file
 * MOVES it into the buy column. That move makes the wrapper a descendant of
 * the host product section — so anything that re-renders that section takes
 * the widget with it. The theme editor does exactly that on every settings
 * change, which is precisely where the merchant is while installing from the
 * ZIP: a widget that vanishes there and only comes back on a full page reload
 * reads as "the app is broken".
 *
 * Mounting is therefore NOT a one-way door. This suite drives the real file
 * through a browser-shaped seam (document.readyState, shopify:section:load,
 * a node tree that actually moves nodes) and asserts the wrapper is put back:
 * a boolean "already mounted" latch fails the re-mount test below.
 *
 * The node model is deliberately tiny — insertBefore/parentNode/isConnected
 * and attribute lookups are all the mount path touches — and its own moving
 * semantics are asserted first, so a shim bug can never be mistaken for the
 * subject passing.
 */

const EMBED_JS = join(
  fileURLToPath(new URL("../extensions/cellexia-buy-box/assets/", import.meta.url)),
  "buy-box-embed.js",
);

// ── A minimal, honest node tree ──────────────────────────────────────────────

/**
 * Selector support is limited to COMPOUND selectors built from `.class` and
 * `[attribute]` parts with no combinator — which is exactly what the mount
 * path uses on the fixture, including the class-qualified own-markup lookups
 * (`.cx-buybox-embed[data-cellexia-embed]`) that keep another vendor's
 * `[data-*]` element from being adopted as our wrapper. Anything else — the
 * descendant combinators in autoAnchor's cellexialabs.com heuristic, for
 * instance — matches nothing, which is what the file's own safeQuery() does
 * with a selector the page cannot satisfy.
 */
function matches(node: FakeNode, selector: string): boolean {
  const parts = selector.match(/\.[a-zA-Z0-9_-]+|\[[a-zA-Z0-9-]+\]/g);
  if (!parts || parts.join("") !== selector.trim()) return false;
  return parts.every((part) =>
    part.charAt(0) === "["
      ? node.hasAttribute(part.slice(1, -1))
      : node.classList.contains(part.slice(1)),
  );
}

/**
 * The subset of DOMTokenList the file uses. `contains` is the ownership
 * assertion buy-box-embed.js makes before it moves, marks or unhides a node,
 * so the shim has to offer it under the browser's own name.
 */
class FakeClassList {
  private readonly names = new Set<string>();
  add(name: string): void {
    this.names.add(name);
  }
  contains(name: string): boolean {
    return this.names.has(name);
  }
}

class FakeNode {
  readonly children: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  readonly classList = new FakeClassList();
  private readonly attributes = new Map<string, string>();

  constructor(
    readonly tagName = "DIV",
    classNames: string[] = [],
  ) {
    for (const name of classNames) this.classList.add(name);
  }

  /** True only while this node is still reachable from the document root. */
  get isConnected(): boolean {
    let node: FakeNode | null = this;
    while (node) {
      if (node.tagName === "#document") return true;
      node = node.parentNode;
    }
    return false;
  }

  getAttribute(name: string): string | null {
    return this.attributes.has(name) ? (this.attributes.get(name) as string) : null;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  appendChild(child: FakeNode): FakeNode {
    child.detach();
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  /** Moves `child` (removing it from wherever it is) in front of `ref`. */
  insertBefore(child: FakeNode, ref: FakeNode | null): FakeNode {
    child.detach();
    child.parentNode = this;
    const at = ref ? this.children.indexOf(ref) : -1;
    if (at === -1) this.children.push(child);
    else this.children.splice(at, 0, child);
    return child;
  }

  removeChild(child: FakeNode): FakeNode {
    const at = this.children.indexOf(child);
    if (at !== -1) this.children.splice(at, 1);
    child.parentNode = null;
    return child;
  }

  detach(): void {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  get nextSibling(): FakeNode | null {
    if (!this.parentNode) return null;
    return this.parentNode.children[this.parentNode.children.indexOf(this) + 1] ?? null;
  }

  get firstChild(): FakeNode | null {
    return this.children[0] ?? null;
  }

  closest(selector: string): FakeNode | null {
    let node: FakeNode | null = this;
    while (node) {
      if (matches(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  querySelectorAll(selector: string): FakeNode[] {
    const found: FakeNode[] = [];
    for (const child of this.children) {
      if (matches(child, selector)) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }

  querySelector(selector: string): FakeNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

// ── Fixture: a Dawn-shaped PDP with the app embed at body end ────────────────

interface MountEnv {
  document: FakeNode & { body: FakeNode };
  wrapper: FakeNode;
  /** Replace the product section's contents, as the theme editor does. */
  rerenderSection: () => FakeNode;
  fire: (type: string) => void;
  flushTimers: () => void;
  subs: Record<string, unknown>;
  /** True when `mutate` actually rewrote the source (see the vacuity guard). */
  sourceChanged: boolean;
  /** The other cx-namespace vendor's element, when the fixture rendered one. */
  foreign: FakeNode | null;
}

function loadEmbed(
  mutate?: (source: string) => string,
  options: { foreignWidget?: boolean } = {},
): MountEnv {
  const documentRoot = new FakeNode("#document");
  const body = new FakeNode("BODY");
  documentRoot.appendChild(body);

  const section = new FakeNode("DIV", ["shopify-section"]);
  body.appendChild(section);

  /**
   * The other "cx"-namespace vendor's widget, as it appears on the client's
   * live PDP: inside the buy column (so EARLIER in the DOM than our body-end
   * wrapper), class "cx cx--self-contained". Its attribute is given OUR
   * current name here on purpose — the point of the assertion is that the
   * class qualification and the ownership check, not the attribute name
   * alone, are what keep us off another vendor's DOM.
   */
  let foreign: FakeNode | null = null;
  if (options.foreignWidget) {
    foreign = new FakeNode("DIV", ["cx", "cx--self-contained"]);
    foreign.setAttribute("data-cellexia-embed", "");
    const foreignInner = new FakeNode("DIV", ["cx__inner"]);
    foreignInner.setAttribute("data-cellexia-buybox", "");
    foreign.appendChild(foreignInner);
    section.appendChild(foreign);
  }

  function buildBuyColumn(): FakeNode {
    const buttons = new FakeNode("DIV", ["product-form__buttons"]);
    section.appendChild(buttons);
    return buttons;
  }
  let anchor = buildBuyColumn();

  // The server-rendered app embed: hidden wrapper at the very end of <body>,
  // holding the (live, ungated) widget.
  const wrapper = new FakeNode("DIV", ["cx-buybox-embed"]);
  wrapper.setAttribute("data-cellexia-embed", "");
  wrapper.setAttribute("hidden", "");
  wrapper.setAttribute("data-cellexia-anchor", "");
  wrapper.setAttribute("data-cellexia-anchor-pos", "before");
  const widget = new FakeNode("DIV", ["cx-buybox"]);
  widget.setAttribute("data-cellexia-buybox", "");
  wrapper.appendChild(widget);
  body.appendChild(wrapper);

  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const timers: Array<() => void> = [];
  const noop = (): void => {};

  const documentStub = Object.assign(documentRoot, {
    readyState: "complete",
    body,
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      const forType = listeners.get(type) ?? [];
      forType.push(fn);
      listeners.set(type, forType);
    },
    removeEventListener: noop,
    createElement: (tagName: string) => new FakeNode(tagName.toUpperCase()),
  });

  const windowStub: Record<string, unknown> = {
    location: { origin: "https://example.myshopify.com", search: "" },
    addEventListener: noop,
    removeEventListener: noop,
    setTimeout: (fn: () => void) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: noop,
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    fetch: () => Promise.resolve({ ok: true }),
    URLSearchParams,
    FormData,
    URL,
    // MutationObserver deliberately absent: the file must survive without it,
    // and shopify:section:load is the net this suite measures.
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
  const original = readFileSync(EMBED_JS, "utf8");
  const source = mutate ? mutate(original) : original;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "buy-box-embed.js" });

  return {
    sourceChanged: source !== original,
    document: documentStub as MountEnv["document"],
    wrapper,
    foreign,
    rerenderSection: () => {
      // Shopify replaces the section's innerHTML: every node inside it —
      // including the wrapper this file moved in — is detached at once.
      for (const child of [...section.children]) section.removeChild(child);
      anchor = buildBuyColumn();
      return anchor;
    },
    fire: (type: string) => {
      for (const fn of listeners.get(type) ?? []) fn({ target: documentStub });
    },
    flushTimers: () => {
      while (timers.length) (timers.shift() as () => void)();
    },
    subs: windowStub.CellexiaSubs as Record<string, unknown>,
  };
}

/** The wrapper's position relative to its siblings, for placement asserts. */
function indexIn(parent: FakeNode, node: FakeNode): number {
  return parent.children.indexOf(node);
}

// ── The shim's own semantics, asserted before anything relies on them ────────

describe("mount-test node model", () => {
  it("moves a node between parents and tracks isConnected", () => {
    const root = new FakeNode("#document");
    const a = new FakeNode();
    const b = new FakeNode();
    const moved = new FakeNode();
    root.appendChild(a);
    root.appendChild(b);
    a.appendChild(moved);

    expect(moved.isConnected).toBe(true);
    expect(a.children).toContain(moved);

    b.insertBefore(moved, null);
    expect(a.children).not.toContain(moved);
    expect(b.children).toContain(moved);
    expect(moved.parentNode).toBe(b);

    root.removeChild(b);
    expect(moved.isConnected).toBe(false);
  });
});

// ── The contract ─────────────────────────────────────────────────────────────

describe("buy-box-embed mounting", () => {
  it("moves the wrapper into the buy column and unhides it", () => {
    const env = loadEmbed();
    const anchor = env.document.querySelector(
      ".product-form__buttons",
    ) as FakeNode;

    expect(env.wrapper.parentNode).toBe(anchor.parentNode);
    expect(indexIn(anchor.parentNode as FakeNode, env.wrapper)).toBe(
      indexIn(anchor.parentNode as FakeNode, anchor) - 1,
    );
    expect(env.wrapper.getAttribute("data-cellexia-mounted")).toBe("true");
    // The widget inside is live (not launch-gated), so the wrapper shows.
    expect(env.wrapper.hasAttribute("hidden")).toBe(false);
    expect(env.subs.embedMounted).toBe(true);
  });

  it("re-mounts after the theme editor re-renders the host section", () => {
    const env = loadEmbed();
    expect(env.wrapper.isConnected).toBe(true);

    // The merchant changes a product-section setting in the theme editor.
    const newAnchor = env.rerenderSection();
    expect(env.wrapper.isConnected).toBe(false); // taken down with the section

    env.fire("shopify:section:load");
    env.flushTimers();

    expect(env.wrapper.isConnected).toBe(true);
    expect(env.wrapper.parentNode).toBe(newAnchor.parentNode);
    expect(indexIn(newAnchor.parentNode as FakeNode, env.wrapper)).toBe(
      indexIn(newAnchor.parentNode as FakeNode, newAnchor) - 1,
    );
    expect(env.subs.embedMounted).toBe(true);
  });

  it("survives repeated re-renders (the latch would only ever mount once)", () => {
    const env = loadEmbed();
    for (let pass = 0; pass < 3; pass += 1) {
      const anchor = env.rerenderSection();
      env.fire("shopify:section:load");
      env.flushTimers();
      expect(env.wrapper.isConnected).toBe(true);
      expect(env.wrapper.parentNode).toBe(anchor.parentNode);
    }
  });

  /**
   * Vacuity guard. Re-introduce the defect this fix removed — make the mount
   * state LATCH at true instead of being re-read from the document — and
   * prove the re-mount assertions above actually depend on it. Without this,
   * a future refactor could make the suite green no matter what the file does.
   */
  it("would fail if the mount state latched instead of being re-checked", () => {
    const latched = loadEmbed((source) =>
      source.replace(
        "var mounted = inDocument(mountedWrapper);",
        "var mounted = subs.embedMounted || inDocument(mountedWrapper);",
      ),
    );
    expect(latched.sourceChanged).toBe(true);
    expect(latched.wrapper.isConnected).toBe(true);

    latched.rerenderSection();
    latched.fire("shopify:section:load");
    latched.flushTimers();

    // The latched build believes it is still mounted, so the widget is gone
    // from the page until a full reload — the reported defect, reproduced.
    expect(latched.wrapper.isConnected).toBe(false);
  });

  /**
   * THE CELLEXIALABS.COM NAMESPACE COLLISION, reproduced.
   *
   * The client's PDP already hosts an unrelated vendor that owns the "cx"
   * namespace: a <div class="cx cx--self-contained" data-cx-embed> inside the
   * buy column, i.e. EARLIER in the DOM than our body-end wrapper. Our
   * wrapper attribute was `data-cx-embed` too, so the bare attribute lookup
   * returned THEIR element: we stamped our mount marker on it and adopted it,
   * the mount check then answered "already mounted" forever, and our own
   * wrapper never left the end of <body> — an invisible buy box, which is the
   * defect the client reported.
   *
   * The fixture gives the foreign element our CURRENT attribute name on
   * purpose. Renaming the namespace alone would make this pass vacuously; the
   * behaviour under test is that the class qualification and the ownership
   * assertion keep us off DOM we do not own even when an attribute collides.
   */
  it("ignores another vendor's element and mounts our own wrapper", () => {
    const env = loadEmbed(undefined, { foreignWidget: true });
    const foreign = env.foreign as FakeNode;
    const anchor = env.document.querySelector(
      ".product-form__buttons",
    ) as FakeNode;

    // Ours mounted, in the buy column, immediately before the anchor.
    expect(env.wrapper).not.toBe(foreign);
    expect(env.wrapper.parentNode).toBe(anchor.parentNode);
    expect(indexIn(anchor.parentNode as FakeNode, env.wrapper)).toBe(
      indexIn(anchor.parentNode as FakeNode, anchor) - 1,
    );
    expect(env.wrapper.getAttribute("data-cellexia-mounted")).toBe("true");
    expect(env.wrapper.hasAttribute("hidden")).toBe(false);
    expect(env.subs.embedMounted).toBe(true);

    // Theirs: never marked, and still exactly where the page put it (first
    // child of the section, ahead of the buy column we inserted into).
    expect(foreign.getAttribute("data-cellexia-mounted")).toBeNull();
    expect(indexIn(foreign.parentNode as FakeNode, foreign)).toBe(0);
  });

  /**
   * Vacuity guard for the test above: put the pre-fix bare attribute lookup
   * back and the foreign element IS adopted, exactly as it was live.
   */
  it("would adopt the foreign element with the pre-fix bare lookup", () => {
    const broken = loadEmbed(
      (source) =>
        source.replace(
          "var inPage = document.querySelector(OWN_WRAPPER);",
          "var inPage = document.querySelector('[data-cellexia-embed]');",
        ),
      { foreignWidget: true },
    );
    expect(broken.sourceChanged).toBe(true);
    // Our wrapper is still stranded at the end of <body>: the reported defect.
    expect(broken.wrapper.parentNode).toBe(broken.document.body);
    expect(broken.wrapper.hasAttribute("hidden")).toBe(true);
    // The ownership assertion is the independent third layer: even with the
    // bare lookup back, the foreign element is never marked or moved.
    expect(
      (broken.foreign as FakeNode).getAttribute("data-cellexia-mounted"),
    ).toBeNull();
  });

  it("reports embedMounted honestly while the widget is off the page", () => {
    const env = loadEmbed();
    env.rerenderSection();
    // Any read of the mount state must re-check the document, never a flag:
    // firing the section event is what forces that read here.
    env.fire("shopify:section:unload");
    expect(env.wrapper.isConnected).toBe(false);
    expect(env.subs.embedMounted).toBe(false);
    env.flushTimers();
    expect(env.wrapper.isConnected).toBe(true);
  });
});
