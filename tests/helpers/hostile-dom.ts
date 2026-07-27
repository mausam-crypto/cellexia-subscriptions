/**
 * A tiny, honest DOM for driving the REAL storefront assets
 * (extensions/cellexia-buy-box/assets/buy-box.js and buy-box-embed.js) over a
 * page that was PARSED FROM HTML rather than hand-built node by node.
 *
 * WHY IT EXISTS
 * -------------
 * tests/embed-mount.test.ts and tests/theme-price-sync.test.ts each build a
 * node tree by hand, which is right for what they measure. The hostile-
 * neighbour suite (tests/embed-hostile-neighbour.test.ts) needs something the
 * hand-built trees cannot give: the widget's REAL server-rendered markup,
 * straight out of the Liquid harness, sitting in a page shaped like the
 * client's live PDP. A defect in an attribute the Liquid emits — or one it
 * stops emitting — has to be able to fail that suite, so the markup under
 * test must be the markup the ZIP ships, parsed, not a paraphrase of it.
 *
 * So: an HTML parser, a node tree, a selector engine, events, a
 * MutationObserver and a virtual clock — deliberately small, and only as
 * capable as the two files actually require. Everything here is exercised by
 * the shim self-tests at the top of that suite before a single assertion is
 * made about the subject, so a shim bug can never be mistaken for the files
 * passing.
 *
 * Deliberate limits (they throw rather than silently mismatching):
 *   - selectors: comma lists, DESCENDANT combinators only, and
 *     tag / .class / #id / [attr] / [attr=v] / [attr*=v] / [attr^=v] /
 *     [attr$=v] simple parts. A child/sibling combinator or an unknown
 *     attribute operator raises, so a future selector this shim cannot model
 *     fails loudly here instead of quietly matching nothing.
 *   - attribute-selector values may not contain whitespace (the compound is
 *     split on it).
 *   - timers are a virtual clock drained by flushTimers(): fully
 *     deterministic, no wall-clock sleeps, and a scheduler that will not
 *     settle raises instead of hanging the run.
 */

import { decodeEntitiesOnce } from "../liquid/harness";

// ── Virtual clock ────────────────────────────────────────────────────────────

interface Timer {
  id: number;
  fn: () => void;
  delay: number;
  seq: number;
  cancelled: boolean;
}

let timerQueue: Timer[] = [];
let timerSeq = 0;

export function scheduleTimer(fn: () => void, delay?: number): number {
  timerSeq += 1;
  timerQueue.push({
    id: timerSeq,
    fn,
    delay: Number(delay) || 0,
    seq: timerSeq,
    cancelled: false,
  });
  return timerSeq;
}

export function cancelTimer(id: unknown): void {
  for (const timer of timerQueue) {
    if (timer.id === id) timer.cancelled = true;
  }
}

/**
 * Run every pending timer, in (delay, scheduling order), including the ones
 * scheduled while draining. A real barrier, not a guess about wall-clock
 * timing — and a hard stop if something reschedules itself forever.
 */
export function flushTimers(limit = 500): void {
  let ran = 0;
  for (;;) {
    timerQueue = timerQueue.filter((timer) => !timer.cancelled);
    if (timerQueue.length === 0) return;
    if (ran >= limit) {
      throw new Error(
        `timer queue did not settle after ${limit} callbacks — a scheduler is looping`,
      );
    }
    timerQueue.sort((a, b) => a.delay - b.delay || a.seq - b.seq);
    const next = timerQueue.shift() as Timer;
    ran += 1;
    next.fn();
  }
}

// ── MutationObserver ─────────────────────────────────────────────────────────

interface Registration {
  target: ElementNode;
  callback: () => void;
  observer: MutationObserverShim;
}

let mutationRegistry: Registration[] = [];
const pendingObservers = new Set<MutationObserverShim>();

export class MutationObserverShim {
  private readonly callback: () => void;
  constructor(callback: () => void) {
    this.callback = callback;
  }
  observe(target: ElementNode): void {
    mutationRegistry.push({ target, callback: this.callback, observer: this });
  }
  disconnect(): void {
    mutationRegistry = mutationRegistry.filter(
      (entry) => entry.observer !== this,
    );
  }
}

/**
 * childList / characterData notification, coalesced per observer exactly like
 * a browser delivers one microtask per batch. Attribute writes deliberately
 * notify nothing: neither shipped file asks for `attributes: true`.
 */
function notifyMutation(node: AnyNode): void {
  for (const entry of mutationRegistry.slice()) {
    if (entry.target !== node && !entry.target.contains(node)) continue;
    if (pendingObservers.has(entry.observer)) continue;
    const { observer, callback } = entry;
    pendingObservers.add(observer);
    scheduleTimer(() => {
      pendingObservers.delete(observer);
      callback();
    }, 0);
  }
}

/** Drop every observer and timer — called when a fresh page is built. */
export function resetDomState(): void {
  timerQueue = [];
  mutationRegistry = [];
  pendingObservers.clear();
}

// ── Events ───────────────────────────────────────────────────────────────────

export interface EventInitLike {
  bubbles?: boolean;
  cancelable?: boolean;
  detail?: unknown;
}

export class EventShim {
  readonly type: string;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly detail: unknown;
  target: unknown = null;
  currentTarget: unknown = null;
  defaultPrevented = false;
  propagationStopped = false;

  constructor(type: string, init?: EventInitLike) {
    this.type = String(type);
    this.bubbles = init ? init.bubbles === true : false;
    this.cancelable = init ? init.cancelable === true : false;
    this.detail = init ? init.detail : undefined;
  }
  preventDefault(): void {
    this.defaultPrevented = true;
  }
  stopPropagation(): void {
    this.propagationStopped = true;
  }
}

export class CustomEventShim extends EventShim {}

// ── Selector engine ──────────────────────────────────────────────────────────

type AttributeOperator = "=" | "*=" | "^=" | "$=" | null;

interface AttributeTest {
  name: string;
  operator: AttributeOperator;
  value: string | null;
}

interface SimpleSelector {
  /** null = universal ("*" or an attribute/class-only part). */
  tag: string | null;
  id: string | null;
  classes: string[];
  attributes: AttributeTest[];
}

const ATTRIBUTE_PART =
  /^\[\s*([\w-]+)\s*(?:(\*=|\^=|\$=|=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*))\s*)?\]/;

function parseSimple(source: string): SimpleSelector {
  const parsed: SimpleSelector = {
    tag: null,
    id: null,
    classes: [],
    attributes: [],
  };
  let rest = source.trim();
  if (rest.startsWith("*")) {
    rest = rest.slice(1);
  } else {
    const tag = /^[a-zA-Z][\w-]*/.exec(rest);
    if (tag) {
      parsed.tag = tag[0].toUpperCase();
      rest = rest.slice(tag[0].length);
    }
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
    match = ATTRIBUTE_PART.exec(rest);
    if (match) {
      const raw = match[3] ?? match[4] ?? match[5];
      parsed.attributes.push({
        name: match[1],
        operator: (match[2] as AttributeOperator) ?? null,
        value: match[2] ? (raw === undefined ? "" : raw) : null,
      });
      rest = rest.slice(match[0].length);
      continue;
    }
    throw new Error(`unsupported selector fragment: "${rest}" in "${source}"`);
  }
  return parsed;
}

function matchesSimple(element: ElementNode, selector: SimpleSelector): boolean {
  if (selector.tag && element.nodeName !== selector.tag) return false;
  if (selector.id && element.getAttribute("id") !== selector.id) return false;
  for (const className of selector.classes) {
    if (!element.classList.contains(className)) return false;
  }
  for (const test of selector.attributes) {
    const actual = element.getAttribute(test.name);
    if (actual === null) return false;
    if (test.operator === null) continue;
    const expected = test.value ?? "";
    if (test.operator === "=") {
      if (actual !== expected) return false;
    } else if (test.operator === "*=") {
      if (actual.indexOf(expected) === -1) return false;
    } else if (test.operator === "^=") {
      if (actual.indexOf(expected) !== 0) return false;
    } else if (test.operator === "$=") {
      if (actual.slice(actual.length - expected.length) !== expected) {
        return false;
      }
    } else {
      throw new Error(`unsupported attribute operator: ${String(test.operator)}`);
    }
  }
  return true;
}

/** Descendant combinators only — anything else raises (see the header). */
function matchesCompound(element: ElementNode, compound: string): boolean {
  const trimmed = compound.trim();
  if (/[>+~]/.test(trimmed)) {
    throw new Error(`unsupported combinator in selector: "${trimmed}"`);
  }
  const parts = trimmed.split(/\s+/).map(parseSimple);
  const last = parts.pop() as SimpleSelector;
  if (!matchesSimple(element, last)) return false;
  let current = element.parentNode;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    let found = false;
    while (current) {
      const candidate = current;
      current = current.parentNode;
      if (matchesSimple(candidate, parts[i])) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

function matchesList(element: ElementNode, selectorList: string): boolean {
  for (const compound of selectorList.split(",")) {
    if (compound.trim() === "") continue;
    if (matchesCompound(element, compound)) return true;
  }
  return false;
}

// ── Nodes ────────────────────────────────────────────────────────────────────

export type AnyNode = ElementNode | TextNode | CommentNode;

export class TextNode {
  readonly nodeType = 3;
  readonly nodeName = "#text";
  parentNode: ElementNode | null = null;
  private value: string;

  constructor(value: string) {
    this.value = value;
  }
  get nodeValue(): string {
    return this.value;
  }
  set nodeValue(next: string) {
    this.value = next === null || next === undefined ? "" : String(next);
    notifyMutation(this);
  }
  get textContent(): string {
    return this.value;
  }
  get isConnected(): boolean {
    return this.parentNode ? this.parentNode.isConnected : false;
  }
  remove(): void {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
}

export class CommentNode {
  readonly nodeType = 8;
  readonly nodeName = "#comment";
  parentNode: ElementNode | null = null;
  constructor(readonly data: string) {}
  get isConnected(): boolean {
    return this.parentNode ? this.parentNode.isConnected : false;
  }
  remove(): void {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
}

class ClassListShim {
  constructor(private readonly owner: ElementNode) {}
  private names(): string[] {
    return (this.owner.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
  }
  contains(name: string): boolean {
    return this.names().indexOf(name) !== -1;
  }
  add(name: string): void {
    const list = this.names();
    if (list.indexOf(name) === -1) {
      list.push(name);
      this.owner.setAttribute("class", list.join(" "));
    }
  }
  remove(name: string): void {
    const list = this.names().filter((entry) => entry !== name);
    this.owner.setAttribute("class", list.join(" "));
  }
  toggle(name: string, force?: boolean): boolean {
    const on = force === undefined ? !this.contains(name) : force === true;
    if (on) this.add(name);
    else this.remove(name);
    return on;
  }
}

const VOID_ELEMENTS = new Set([
  "AREA",
  "BASE",
  "BR",
  "COL",
  "EMBED",
  "HR",
  "IMG",
  "INPUT",
  "LINK",
  "META",
  "PARAM",
  "SOURCE",
  "TRACK",
  "WBR",
]);

const RAW_TEXT_ELEMENTS = new Set(["SCRIPT", "STYLE"]);

interface ListenerEntry {
  fn: (event: unknown) => void;
  capture: boolean;
}

export class ElementNode {
  readonly nodeType = 1;
  readonly nodeName: string;
  /** Insertion-ordered, so a serialization round-trip is byte-stable. */
  readonly attributes = new Map<string, string>();
  readonly childNodes: AnyNode[] = [];
  parentNode: ElementNode | null = null;
  readonly classList: ClassListShim;
  checked = false;
  selected = false;
  disabled = false;
  private valueProp: string | null = null;
  private readonly listeners = new Map<string, ListenerEntry[]>();

  constructor(nodeName: string) {
    this.nodeName = nodeName.toUpperCase();
    this.classList = new ClassListShim(this);
  }

  get tagName(): string {
    return this.nodeName;
  }
  get className(): string {
    return this.getAttribute("class") ?? "";
  }
  get id(): string {
    return this.getAttribute("id") ?? "";
  }
  get type(): string {
    return this.getAttribute("type") ?? "";
  }
  set type(next: string) {
    this.setAttribute("type", String(next));
  }
  get name(): string {
    return this.getAttribute("name") ?? "";
  }
  set name(next: string) {
    this.setAttribute("name", String(next));
  }

  get value(): string {
    if (this.nodeName === "SELECT") {
      const options = this.querySelectorAll("option");
      for (const option of options) {
        if (option.selected) return option.getAttribute("value") ?? "";
      }
      return options.length ? (options[0].getAttribute("value") ?? "") : "";
    }
    if (this.valueProp !== null) return this.valueProp;
    return this.getAttribute("value") ?? "";
  }
  set value(next: string) {
    const wanted = next === null || next === undefined ? "" : String(next);
    if (this.nodeName === "SELECT") {
      for (const option of this.querySelectorAll("option")) {
        option.selected = (option.getAttribute("value") ?? "") === wanted;
      }
      return;
    }
    this.valueProp = wanted;
  }

  // ── attributes ─────────────────────────────────────────────────────────────

  getAttribute(name: string): string | null {
    const key = String(name).toLowerCase();
    return this.attributes.has(key) ? (this.attributes.get(key) as string) : null;
  }
  setAttribute(name: string, value: unknown): void {
    this.attributes.set(
      String(name).toLowerCase(),
      value === null || value === undefined ? "" : String(value),
    );
  }
  removeAttribute(name: string): void {
    this.attributes.delete(String(name).toLowerCase());
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(String(name).toLowerCase());
  }

  // ── tree ───────────────────────────────────────────────────────────────────

  get isConnected(): boolean {
    let node: ElementNode | null = this;
    while (node) {
      if (node.nodeName === "#DOCUMENT") return true;
      node = node.parentNode;
    }
    return false;
  }

  get children(): ElementNode[] {
    return this.childNodes.filter(
      (child): child is ElementNode => child.nodeType === 1,
    );
  }
  get firstChild(): AnyNode | null {
    return this.childNodes[0] ?? null;
  }
  get nextSibling(): AnyNode | null {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get parentElement(): ElementNode | null {
    const parent = this.parentNode;
    return parent && parent.nodeName !== "#DOCUMENT" ? parent : null;
  }

  appendChild<T extends AnyNode>(child: T): T {
    child.remove();
    child.parentNode = this;
    this.childNodes.push(child);
    notifyMutation(this);
    return child;
  }

  insertBefore<T extends AnyNode>(child: T, ref: AnyNode | null): T {
    child.remove();
    child.parentNode = this;
    const at = ref ? this.childNodes.indexOf(ref) : -1;
    if (at === -1) this.childNodes.push(child);
    else this.childNodes.splice(at, 0, child);
    notifyMutation(this);
    return child;
  }

  removeChild<T extends AnyNode>(child: T): T {
    const at = this.childNodes.indexOf(child);
    if (at !== -1) this.childNodes.splice(at, 1);
    child.parentNode = null;
    notifyMutation(this);
    return child;
  }

  remove(): void {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  contains(node: AnyNode | null): boolean {
    let current: AnyNode | null = node;
    while (current) {
      if (current === (this as unknown as AnyNode)) return true;
      current = current.parentNode;
    }
    return false;
  }

  // ── text ───────────────────────────────────────────────────────────────────

  get textContent(): string {
    let out = "";
    for (const child of this.childNodes) {
      if (child.nodeType === 3) out += (child as TextNode).nodeValue;
      else if (child.nodeType === 1) out += (child as ElementNode).textContent;
    }
    return out;
  }
  set textContent(next: string) {
    for (const child of [...this.childNodes]) this.removeChild(child);
    const value = next === null || next === undefined ? "" : String(next);
    if (value !== "") this.appendChild(new TextNode(value));
  }

  // ── queries ────────────────────────────────────────────────────────────────

  matches(selectorList: string): boolean {
    return matchesList(this, selectorList);
  }

  closest(selectorList: string): ElementNode | null {
    let current: ElementNode | null = this;
    while (current) {
      if (current.nodeName !== "#DOCUMENT" && matchesList(current, selectorList)) {
        return current;
      }
      current = current.parentNode;
    }
    return null;
  }

  querySelectorAll(selectorList: string): ElementNode[] {
    const found: ElementNode[] = [];
    const walk = (node: ElementNode): void => {
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue;
        const element = child as ElementNode;
        if (matchesList(element, selectorList)) found.push(element);
        walk(element);
      }
    };
    walk(this);
    return found;
  }

  querySelector(selectorList: string): ElementNode | null {
    return this.querySelectorAll(selectorList)[0] ?? null;
  }

  // ── events ─────────────────────────────────────────────────────────────────

  addEventListener(
    type: string,
    fn: (event: unknown) => void,
    options?: unknown,
  ): void {
    const capture =
      options === true ||
      (options !== null &&
        typeof options === "object" &&
        (options as { capture?: boolean }).capture === true);
    const list = this.listeners.get(type) ?? [];
    list.push({ fn, capture });
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: (event: unknown) => void): void {
    const list = this.listeners.get(type);
    if (!list) return;
    this.listeners.set(
      type,
      list.filter((entry) => entry.fn !== fn),
    );
  }

  /** capture = true / false selects a phase; null fires both (the target). */
  fireListeners(event: EventShim, capture: boolean | null): void {
    const list = this.listeners.get(event.type);
    if (!list) return;
    for (const entry of list.slice()) {
      if (event.propagationStopped) return;
      if (capture !== null && entry.capture !== capture) continue;
      event.currentTarget = this;
      entry.fn.call(this, event);
    }
  }

  dispatchEvent(event: EventShim): boolean {
    event.target = this;
    const path: ElementNode[] = [];
    let node: ElementNode | null = this;
    while (node) {
      path.push(node);
      node = node.parentNode;
    }
    for (let i = path.length - 1; i >= 1; i -= 1) {
      if (event.propagationStopped) break;
      path[i].fireListeners(event, true);
    }
    if (!event.propagationStopped) path[0].fireListeners(event, null);
    if (event.bubbles) {
      for (let i = 1; i < path.length; i += 1) {
        if (event.propagationStopped) break;
        path[i].fireListeners(event, false);
      }
    }
    return !event.defaultPrevented;
  }

  focus(): void {
    const root = this.ownerDocument();
    if (root) root.activeElement = this;
  }

  private ownerDocument(): DocumentNode | null {
    let node: ElementNode | null = this;
    while (node) {
      if (node.nodeName === "#DOCUMENT") return node as DocumentNode;
      node = node.parentNode;
    }
    return null;
  }
}

export class DocumentNode extends ElementNode {
  readyState = "complete";
  activeElement: ElementNode | null = null;
  body!: ElementNode;
  documentElement!: ElementNode;

  constructor() {
    super("#document");
  }

  createElement(tagName: string): ElementNode {
    return new ElementNode(String(tagName));
  }
  createTextNode(value: string): TextNode {
    return new TextNode(String(value));
  }
  getElementById(id: string): ElementNode | null {
    const wanted = String(id);
    for (const element of this.querySelectorAll("*")) {
      if (element.getAttribute("id") === wanted) return element;
    }
    return null;
  }
}

// ── HTML parsing ─────────────────────────────────────────────────────────────

const ATTRIBUTE_PATTERN =
  /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/**
 * Parse `html` into `into`. Handles the shapes the extension and the theme
 * fixture actually contain: void elements, self-closing SVG children, raw-text
 * script/style bodies (the JSON island), boolean attributes, HTML comments
 * (Shopify's BEGIN/END app-snippet markers live inside our own wrapper) and
 * entity-encoded attribute values.
 */
export function parseHtml(html: string, into: ElementNode): void {
  const stack: ElementNode[] = [into];
  const top = (): ElementNode => stack[stack.length - 1];
  const pushText = (chunk: string): void => {
    if (chunk === "") return;
    top().appendChild(new TextNode(decodeEntitiesOnce(chunk)));
  };

  let index = 0;
  while (index < html.length) {
    const lt = html.indexOf("<", index);
    if (lt === -1) {
      pushText(html.slice(index));
      break;
    }
    if (lt > index) pushText(html.slice(index, lt));

    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      const stop = end === -1 ? html.length : end;
      top().appendChild(new CommentNode(html.slice(lt + 4, stop)));
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", lt)) {
      const end = html.indexOf(">", lt);
      index = end === -1 ? html.length : end + 1;
      continue;
    }
    if (html.startsWith("</", lt)) {
      const end = html.indexOf(">", lt);
      const name = html
        .slice(lt + 2, end === -1 ? html.length : end)
        .trim()
        .toUpperCase();
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if (stack[depth].nodeName === name) {
          stack.length = depth;
          break;
        }
      }
      index = end === -1 ? html.length : end + 1;
      continue;
    }

    // Open tag: scan to the closing '>' without being fooled by quoted values.
    let cursor = lt + 1;
    let quote = "";
    while (cursor < html.length) {
      const ch = html[cursor];
      if (quote) {
        if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        break;
      }
      cursor += 1;
    }
    const raw = html.slice(lt + 1, cursor);
    index = cursor + 1;

    const nameMatch = /^[a-zA-Z][\w:-]*/.exec(raw);
    if (!nameMatch) continue;
    const selfClosing = raw.replace(/\s+$/, "").endsWith("/");
    const element = new ElementNode(nameMatch[0]);

    ATTRIBUTE_PATTERN.lastIndex = nameMatch[0].length;
    let attribute = ATTRIBUTE_PATTERN.exec(raw);
    while (attribute !== null) {
      const name = attribute[1];
      if (name !== "/") {
        const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? "";
        element.setAttribute(name, decodeEntitiesOnce(value));
      }
      attribute = ATTRIBUTE_PATTERN.exec(raw);
    }
    // The DOM properties a browser seeds from the parsed attributes.
    if (element.hasAttribute("checked")) element.checked = true;
    if (element.hasAttribute("selected")) element.selected = true;
    if (element.hasAttribute("disabled")) element.disabled = true;

    top().appendChild(element);

    if (selfClosing || VOID_ELEMENTS.has(element.nodeName)) continue;

    if (RAW_TEXT_ELEMENTS.has(element.nodeName)) {
      const closeTag = "</" + element.nodeName.toLowerCase();
      const close = html.toLowerCase().indexOf(closeTag, index);
      const stop = close === -1 ? html.length : close;
      const body = html.slice(index, stop);
      // Raw text is NOT entity-decoded, exactly like a browser.
      if (body !== "") element.appendChild(new TextNode(body));
      if (close === -1) {
        index = html.length;
      } else {
        const gt = html.indexOf(">", close);
        index = gt === -1 ? html.length : gt + 1;
      }
      continue;
    }

    stack.push(element);
  }
}

// ── Serialization (for "untouched" assertions) ───────────────────────────────

/** The node and its subtree as a string. Stable: attributes keep source order. */
export function serialize(node: AnyNode): string {
  if (node.nodeType === 3) return (node as TextNode).nodeValue;
  if (node.nodeType === 8) return `<!--${(node as CommentNode).data}-->`;
  const element = node as ElementNode;
  const tag = element.nodeName.toLowerCase();
  let out = `<${tag}`;
  for (const [name, value] of element.attributes) out += ` ${name}="${value}"`;
  out += ">";
  if (VOID_ELEMENTS.has(element.nodeName)) return out;
  for (const child of element.childNodes) out += serialize(child);
  return `${out}</${tag}>`;
}

/** Just the children, i.e. the browser's innerHTML. */
export function serializeChildren(element: ElementNode): string {
  return element.childNodes.map(serialize).join("");
}

/** Every element in the subtree, document order, the root excluded. */
export function allElements(root: ElementNode): ElementNode[] {
  return root.querySelectorAll("*");
}
