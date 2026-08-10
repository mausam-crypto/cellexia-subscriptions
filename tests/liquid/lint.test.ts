import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ASSETS_DIR,
  BLOCKS_DIR,
  EXTENSION_DIR,
  REPO_ROOT,
  SNIPPETS_DIR,
  engine,
  extensionLiquidFiles,
  readAsset,
  shippedLocales,
  translationsFor,
} from "./harness";

/**
 * STATIC GUARDS that make the v1.2.0 defect class impossible to reintroduce.
 *
 * tests/liquid/render.test.ts proves the CURRENT templates render correctly.
 * These rules go further: they forbid the shapes of Liquid that produced the
 * corrupted storefront in the first place, so a future edit cannot reach a
 * broken render even by a route the golden tests do not cover.
 *
 *   1. Never capture a render — forbidden forever. Shopify wraps every
 *      app-snippet render in
 *      "<!-- BEGIN app snippet: x -->…<!-- END app snippet -->"; capturing it
 *      pulls those markers into a STRING, and the next escape filter prints
 *      them on the page. This is the exact production bug.
 *   2. Renders happen ONLY in direct-output markup position (v1.7.0, when the
 *      preset partials were extracted from the core for the platform's
 *      per-file size limit): no render token inside any capture span, and no
 *      render as a bare line inside a liquid block. The snippet set is pinned
 *      — cx-buybox-core.liquid plus the eight cx-preset-*.liquid partials —
 *      and a preset partial renders nothing further: snippets never return
 *      values, all string/value computation stays in the consumer.
 *   3. Never escape the output of `| t`: it is already HTML-escaped, so a
 *      second escape renders "&amp;" as visible characters.
 *   4. No STATIC element id starting with "cx-": the live storefront also
 *      hosts another vendor using "cx-*" ids, so every id we emit must be
 *      suffixed with the block's uid.
 *   5. No `data-cx-*` attribute and no `_cx_design` line property anywhere in
 *      the shipped extension, and no bare `[data-cellexia-*]` document-level
 *      lookup in the storefront JS. That same vendor also renders a
 *      `data-cx-embed` element inside the buy column on cellexialabs.com; our
 *      attributes used to be `data-cx-*` too, so a bare attribute lookup
 *      adopted THEIR element, and the buy box never mounted. The namespace is
 *      `data-cellexia-*` now and every own-markup lookup is qualified with our
 *      own class as well.
 *   6. The same discipline for the CUSTOMER PORTAL's browser script. Rules 4
 *      and 5 scan `extensions/`, but the portal is served through the app
 *      proxy, so its HTML and its <script> are injected into the merchant's
 *      theme — the same document, the same vendor, the same class prefix. It
 *      is the second storefront surface, and it was outside every guard.
 */

const liquidFiles = extensionLiquidFiles();

function repoPath(file: string): string {
  return relative(REPO_ROOT, file);
}

function read(file: string): string {
  return readFileSync(file, "utf8");
}

// ── Comment blanking (shared by every scanner below) ─────────────────────────

/**
 * How each shipped format hides text from the scanners.
 *
 * `null` means "no comment syntax" — nothing is blanked, which is the strict
 * direction: an occurrence that cannot be PROVED to sit in a comment is
 * reported.
 */
interface CommentSyntax {
  /** Line-comment opener, or null when the format has none. */
  line: string | null;
  /** Block-comment delimiters, or null when the format has none. */
  block: readonly [string, string] | null;
  /** Quote characters that open an opaque string literal. */
  quotes: readonly string[];
  /** Backtick template literals (JS only). */
  template: boolean;
  /** Regular-expression literals (JS only). */
  regex: boolean;
}

export function commentSyntaxFor(file: string): CommentSyntax | null {
  /* .ts/.tsx share JS comment, string, template and regex syntax exactly —
     the portal ships its browser script from a .ts module (see the portal
     rules below), so the scanners have to understand that extension too. */
  if (file.endsWith(".js") || file.endsWith(".ts") || file.endsWith(".tsx")) {
    return {
      line: "//",
      block: ["/*", "*/"],
      quotes: ["'", '"'],
      template: true,
      regex: true,
    };
  }
  if (file.endsWith(".css")) {
    /* `//` is NOT a CSS comment — `background: url(//cdn/x)` is a URL. */
    return {
      line: null,
      block: ["/*", "*/"],
      quotes: ["'", '"'],
      template: false,
      regex: false,
    };
  }
  if (file.endsWith(".toml")) {
    return {
      line: "#",
      block: null,
      quotes: ["'", '"'],
      template: false,
      regex: false,
    };
  }
  /* .json — and any format added later — has no comment syntax we trust. */
  return null;
}

/** Index just past the string literal opened at `start` by `quote`. */
function endOfString(source: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) return index + 1;
    /* An unterminated single-line string is a typo, not a comment opener:
       stop at the newline so the rest of the file is still scanned. */
    if (quote !== "`" && char === "\n") return index;
    index += 1;
  }
  return source.length;
}

/**
 * Index just past the regular-expression literal opened at `start`, or
 * `start + 1` when it turns out not to be one. Regex bodies are NOT blanked —
 * they are code — but they have to be stepped over so that a `//` or `/*`
 * inside one cannot be mistaken for a comment opener.
 */
function endOfRegex(source: string, start: number): number {
  let index = start + 1;
  let inCharacterClass = false;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "\n") return start + 1; // not a regex literal after all
    if (char === "[") inCharacterClass = true;
    else if (char === "]") inCharacterClass = false;
    else if (char === "/" && !inCharacterClass) return index + 1;
    index += 1;
  }
  return start + 1;
}

/**
 * The argument text of the call whose `(` sits at `open`, read with balanced
 * parentheses and quote awareness.
 *
 * The regex this replaces stopped at the first `)`, so a perfectly ordinary
 * selector — `'[data-cellexia-x]:not(.y)'` — truncated into something that no
 * longer parsed as a string literal and was skipped by the very rule that had
 * to inspect it. Depth counting removes that whole class of accident.
 */
export function callArgument(source: string, open: number): string | null {
  let depth = 1;
  let index = open + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "'" || char === '"' || char === "`") {
      index = endOfString(source, index, char);
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index).trim();
    }
    index += 1;
  }
  return null;
}

/** A `/` here opens a regex literal, not a division. */
const REGEX_MAY_FOLLOW = new Set(
  "(,=:[!&|?{};+-*%^~<>".split(""),
);

/**
 * Comment text blanked out character for character (newlines preserved, so
 * line numbers stay honest) for every scanner in this file.
 *
 * This is a SCANNER, not a regular expression, and that is the whole point.
 * The regex version blanked from the first `//` to the end of the line, so a
 * `//` inside a string — `'https://cdn.example/x'` — hid every `data-cx-`
 * that followed it on that line; `/*` inside a string hid the rest of the
 * file. It also applied JS comment rules to .json and .toml, where `//` opens
 * nothing at all. These guards are the only thing standing between a
 * namespace regression and the client's storefront, so they may not have a
 * blind spot that an ordinary URL opens.
 *
 * String and regex literals are stepped over but NOT blanked: a `data-cx-`
 * inside a string is a selector, which is exactly what must be reported.
 */
export function withCommentsBlanked(file: string, source: string): string {
  if (file.endsWith(".liquid")) {
    return source.replace(
      /\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g,
      (match) => match.replace(/[^\n]/g, " "),
    );
  }
  const syntax = commentSyntaxFor(file);
  if (!syntax) return source;

  const chars = source.split("");
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i += 1) {
      if (chars[i] !== "\n") chars[i] = " ";
    }
  };

  let index = 0;
  let previousCode = ""; // last significant code character (regex-literal cue)
  while (index < source.length) {
    const char = source[index];

    if (syntax.block && source.startsWith(syntax.block[0], index)) {
      const from = index + syntax.block[0].length;
      const close = source.indexOf(syntax.block[1], from);
      const end = close === -1 ? source.length : close + syntax.block[1].length;
      blank(index, end);
      index = end;
      continue;
    }
    if (syntax.line && source.startsWith(syntax.line, index)) {
      const newline = source.indexOf("\n", index);
      const end = newline === -1 ? source.length : newline;
      blank(index, end);
      index = end;
      continue;
    }
    if (syntax.quotes.includes(char) || (syntax.template && char === "`")) {
      index = endOfString(source, index, char);
      previousCode = char; // a quote closes a value: a following `/` divides
      continue;
    }
    if (syntax.regex && char === "/" && REGEX_MAY_FOLLOW.has(previousCode || "(")) {
      index = endOfRegex(source, index);
      previousCode = "/";
      continue;
    }
    if (!/\s/.test(char)) previousCode = char;
    index += 1;
  }
  return chars.join("");
}

// ── Document-level query scanning (shared by rule 5c and its own guards) ─────

export interface DocumentQuery {
  file: string;
  line: number;
  receiver: string;
  method: string;
  argument: string;
}

/**
 * Every way a DOCUMENT-WIDE query can be spelled.
 *
 * `document` is not the only root that reaches the whole page:
 * `document.body`, `document.documentElement` and `document.head` all search
 * the same tree, and `document.body.querySelector('[data-cellexia-embed]')` is
 * the pre-fix bug ONE PROPERTY ACCESS away from the shape that took the
 * client's storefront down. An earlier version of this rule matched only a
 * bare `document.` receiver, so every one of those spellings walked straight
 * past it — the guard would have stayed green on the very defect it exists to
 * prevent. `(scope || document)` is safeQuery's default seam, and
 * `event.target` is whatever node the theme handed us, which is not ours
 * either.
 *
 * Lookups rooted at a node we already proved is ours (`root.querySelectorAll`,
 * `wrapper.querySelector`, `form.querySelector`) are deliberately NOT matched:
 * scoping to our own subtree is itself the qualification.
 */
const DOCUMENT_ROOT = String.raw`document(?:\s*\.\s*(?:body|documentElement|head))?`;

const DOCUMENT_QUERY = new RegExp(
  String.raw`(\b${DOCUMENT_ROOT}|\|\|\s*${DOCUMENT_ROOT}\s*\)|\bevent\.target)` +
    String.raw`\s*\.\s*(querySelector|querySelectorAll)\s*\(`,
  "g",
);

/**
 * Document-level `getElementById` / `getElementsBy*` lookups. These CANNOT be
 * qualified by a class the way a selector can — an id lookup takes one string
 * and searches the whole page — so the rule for them is different in kind:
 * they may not name our `cx-*` namespace at all. That namespace is shared with
 * the other vendor on cellexialabs.com (cx-i18n / cx-cart-config /
 * cx-pdp-config / cx-embed-config are THEIR ids), so our own markup must be
 * reached through the OWN_* class+attribute selectors, never by id or class
 * name. `document.getElementById('shopify-section-' + id)` is fine: that id is
 * the platform's, not ours, and it is used to SCOPE a search, not to find us.
 */
const DOCUMENT_LOOKUP = new RegExp(
  String.raw`(\b${DOCUMENT_ROOT})\s*\.\s*` +
    String.raw`(getElementById|getElementsByClassName|getElementsByName|getElementsByTagName)\s*\(`,
  "g",
);

function scanCalls(
  source: string,
  label: string,
  pattern: RegExp,
): DocumentQuery[] {
  const found: DocumentQuery[] = [];
  pattern.lastIndex = 0;
  for (const match of source.matchAll(pattern)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const argument = callArgument(source, open);
    if (argument === null) continue;
    found.push({
      file: label,
      line: source.slice(0, match.index ?? 0).split("\n").length,
      receiver: match[1].includes("event.target")
        ? "event.target"
        : match[1].replace(/^\|\|\s*/, "").replace(/\s*\)$/, "").trim(),
      method: match[2],
      argument,
    });
  }
  return found;
}

/** Document-level querySelector/querySelectorAll calls in `source`. */
export function documentQueriesIn(
  source: string,
  label = "source",
): DocumentQuery[] {
  return scanCalls(source, label, DOCUMENT_QUERY);
}

/** Document-level getElementById/getElementsBy* calls in `source`. */
export function documentLookupsIn(
  source: string,
  label = "source",
): DocumentQuery[] {
  return scanCalls(source, label, DOCUMENT_LOOKUP);
}

// ── Liquid tags, in BOTH forms Shopify accepts ───────────────────────────────

interface LiquidTag {
  /** Tag name: "render", "capture", "assign", … */
  name: string;
  /** Everything after the name, trimmed. */
  body: string;
  /** Offset of the tag's start in the source. */
  index: number;
  /** 1-based line number of the tag. */
  line: number;
  /** True when written as a bare line inside a `{% liquid %}` block. */
  lineForm: boolean;
}

/**
 * Every Liquid tag in a file, in the tag form `{% render 'x' %}` AND the line
 * form inside a `{% liquid %}` block, where the same tag is written bare:
 *
 *     {%- liquid
 *       capture thing
 *       render 'other'
 *     -%}
 *
 * The line form was the hole in the regex-only guards: no `\{%\s*render`
 * pattern can ever see it, so a future edit could have reintroduced exactly
 * the captured-render defect these rules exist to forbid.
 */
export function liquidTags(source: string): LiquidTag[] {
  const found: LiquidTag[] = [];
  const lineOf = (index: number) => source.slice(0, index).split("\n").length;
  const tags = /\{%-?([\s\S]*?)-?%\}/g;
  for (const match of source.matchAll(tags)) {
    const start = match.index ?? 0;
    const inner = match[1];
    const opener = /^\s*([a-z_]\w*)/i.exec(inner);
    if (!opener) continue;
    if (opener[1] !== "liquid") {
      found.push({
        name: opener[1],
        body: inner.slice(opener.index + opener[0].length).trim(),
        index: start,
        line: lineOf(start),
        lineForm: false,
      });
      continue;
    }
    /* A {% liquid %} block: every non-empty, non-comment line is a tag. */
    let cursor = start + match[0].indexOf(inner) + opener[0].length;
    for (const raw of inner.slice(opener.index + opener[0].length).split("\n")) {
      const offset = raw.length - raw.trimStart().length;
      const text = raw.trim();
      if (text !== "" && !text.startsWith("#")) {
        const name = /^([a-z_]\w*)/i.exec(text);
        if (name) {
          const at = cursor + offset;
          found.push({
            name: name[1],
            body: text.slice(name[0].length).trim(),
            index: at,
            line: lineOf(at),
            lineForm: true,
          });
        }
      }
      cursor += raw.length + 1; // + the newline consumed by split
    }
  }
  return found;
}

/**
 * The tags that pull one Liquid file into another.
 *
 * `include` is Liquid's legacy form of `render` and Shopify still parses it.
 * Every rule below is stated ABSOLUTELY — "never capture a render", "no render
 * in snippets/" — so keying them on the word `render` alone would leave the
 * identical defect reachable by the older spelling, which is in fact the WORSE
 * of the two: `include` does not isolate scope, so a snippet reached that way
 * can also read and clobber the caller's variables. The extension uses neither
 * inside a snippet and `render` twice in blocks/; this keeps that true for
 * both spellings.
 */
const SNIPPET_TAGS = ["render", "include"] as const;

function isSnippetTag(name: string): boolean {
  return (SNIPPET_TAGS as readonly string[]).includes(name);
}

// ── 1. Never capture a render ────────────────────────────────────────────────

describe("no captured renders (the v1.2.0 storefront bug)", () => {
  it("has .liquid files to check", () => {
    expect(liquidFiles.length).toBeGreaterThan(0);
  });

  /**
   * The [start, end) offsets covered by each `capture … endcapture`, counting
   * BOTH tag form and `{% liquid %}` line form. Nesting is tracked so an inner
   * capture cannot close an outer one.
   */
  function captureRanges(source: string): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    const open: number[] = [];
    for (const tag of liquidTags(source)) {
      if (tag.name === "capture") open.push(tag.index);
      else if (tag.name === "endcapture") {
        const start = open.pop();
        if (start !== undefined) ranges.push([start, tag.index]);
      }
    }
    return ranges;
  }

  it.each(liquidFiles.map(repoPath))(
    "%s never captures the output of a render",
    (relativeFile) => {
      const source = read(join(REPO_ROOT, relativeFile));
      const ranges = captureRanges(source);
      const offenders = liquidTags(source)
        .filter(
          (tag) =>
            isSnippetTag(tag.name) &&
            ranges.some(([from, to]) => tag.index > from && tag.index < to),
        )
        .map((tag) => `line ${tag.line}: ${tag.name}`);
      expect(
        offenders,
        `${relativeFile} captures a render at ${offenders.join(", ")}. ` +
          "Shopify wraps app-snippet output in BEGIN/END comments; captured " +
          "and escaped they become visible page text.",
      ).toEqual([]);
    },
  );

  it.each(liquidFiles.map(repoPath))(
    "%s never assigns or echoes a render",
    (relativeFile) => {
      const source = read(join(REPO_ROOT, relativeFile));
      const offenders = liquidTags(source)
        .filter(
          (tag) =>
            (tag.name === "assign" || tag.name === "echo") &&
            SNIPPET_TAGS.some((keyword) =>
              new RegExp(`\\b${keyword}\\b`).test(tag.body),
            ),
        )
        .map((tag) => `line ${tag.line}: ${tag.name} ${tag.body.slice(0, 60)}`);
      expect(offenders, offenders.join("\n")).toEqual([]);
    },
  );

  it("sees the capture blocks and the renders it is checking", () => {
    /* Vacuity guard: if liquidTags ever stops parsing this extension the
       three rules above would pass by finding nothing at all. The counts
       reflect the v1.11.0 shape: the core keeps its five markup captures
       (frequency control, benefit list, reassurance, the two price-block
       variants) and dispatches the eight preset partials; the partials add
       their own pure-markup captures; each block file renders the core. */
    const snippet = read(join(SNIPPETS_DIR, "cx-buybox-core.liquid"));
    expect(captureRanges(snippet).length, "capture blocks found").toBeGreaterThan(
      3,
    );
    const partialCaptures = readdirSync(SNIPPETS_DIR)
      .filter((name) => name.startsWith("cx-preset-") && name.endsWith(".liquid"))
      .flatMap((name) => captureRanges(read(join(SNIPPETS_DIR, name))));
    expect(partialCaptures.length, "capture blocks found in the partials")
      .toBeGreaterThan(3);
    const coreRenders = liquidTags(snippet).filter(
      (tag) => tag.name === "render",
    );
    expect(coreRenders.length, "preset renders found in the core").toBe(8);
    const blockRenders = readdirSync(BLOCKS_DIR)
      .filter((name) => name.endsWith(".liquid"))
      .flatMap((name) =>
        liquidTags(read(join(BLOCKS_DIR, name))).filter(
          (tag) => tag.name === "render",
        ),
      );
    expect(blockRenders.length, "renders found in the block files").toBe(2);
  });

  it("treats the legacy include tag as a render", () => {
    /* Executable statement of why SNIPPET_TAGS has two entries: both
       spellings pull a file in, both get Shopify's BEGIN/END app-snippet
       markers, and a rule that only knew the word "render" would wave the
       older — and less safe, because it shares the caller's scope — spelling
       straight through. Both forms of the tag syntax, since a `{% liquid %}`
       line is invisible to any `{%\s*include` regex. */
    const source = [
      "{% capture a %}{% include 'other' %}{% endcapture %}",
      "{%- liquid",
      "  capture b",
      "  include 'other'",
      "  endcapture",
      "-%}",
    ].join("\n");
    const captured = liquidTags(source).filter(
      (tag) =>
        isSnippetTag(tag.name) &&
        captureRanges(source).some(
          ([from, to]) => tag.index > from && tag.index < to,
        ),
    );
    expect(captured.map((tag) => tag.line)).toEqual([1, 4]);
    expect(captured.every((tag) => tag.name === "include")).toBe(true);
    /* And the modern spelling is still seen, so widening lost nothing. */
    expect(
      liquidTags("{% capture a %}{% render 'x' %}{% endcapture %}").filter(
        (tag) => isSnippetTag(tag.name),
      ),
    ).toHaveLength(1);
  });

  it("parses the line form of a tag inside a liquid block", () => {
    /* The hole this scanner closes, stated as an executable example: neither
       of these is reachable by a `{%\s*render` regex. */
    const source = [
      "{%- liquid",
      "  # render 'commented-out'",
      "  capture thing",
      "  render 'other'",
      "  endcapture",
      "-%}",
    ].join("\n");
    const names = liquidTags(source).map((tag) => tag.name);
    expect(names).toEqual(["capture", "render", "endcapture"]);
    expect(captureRanges(source)).toHaveLength(1);
    const render = liquidTags(source).find((tag) => tag.name === "render");
    expect(render?.line).toBe(4);
    expect(render?.lineForm).toBe(true);
    const [from, to] = captureRanges(source)[0];
    expect(render!.index > from && render!.index < to).toBe(true);
  });
});

// ── 2. Renders only in direct-output markup position; the snippet set is
//       pinned ────────────────────────────────────────────────────────────────

/** The eight design presets, one partial each, dispatched by the core. */
const PRESET_NAMES = [
  "classic",
  "inline",
  "planner",
  "subscription_max",
  "subscription_ultra_max",
  "tiles",
  "toggle",
  "value_stack",
] as const;

describe("snippet surface", () => {
  it("ships exactly the core snippet plus the eight preset partials", () => {
    /* Pinned, not counted: a stray snippet is a review event, because every
       new render target is a new set of app-snippet comment markers and a
       new opportunity to stringify one. */
    const snippets = readdirSync(SNIPPETS_DIR)
      .filter((name) => name.endsWith(".liquid"))
      .sort();
    expect(snippets).toEqual([
      "cx-buybox-core.liquid",
      ...PRESET_NAMES.map((preset) => `cx-preset-${preset}.liquid`),
    ]);
  });

  it("every render in every .liquid sits in direct-output markup position", () => {
    /* The refined form of "no renders in snippets": a render is allowed —
       the core dispatches the preset partials with one — but ONLY where its
       app-snippet comment markers land between elements as ordinary HTML
       comments. That means never inside a {% capture %} span (rule 1 above
       forbids that shape everywhere; restated here so this rule stands on
       its own) and never as a bare line inside a {% liquid %} block, which
       is not markup position. */
    for (const file of liquidFiles) {
      const source = read(file);
      const ranges: Array<[number, number]> = [];
      const open: number[] = [];
      for (const tag of liquidTags(source)) {
        if (tag.name === "capture") open.push(tag.index);
        else if (tag.name === "endcapture") {
          const start = open.pop();
          if (start !== undefined) ranges.push([start, tag.index]);
        }
      }
      const offenders = liquidTags(source)
        .filter((tag) => isSnippetTag(tag.name))
        .filter(
          (tag) =>
            tag.lineForm ||
            ranges.some(([from, to]) => tag.index > from && tag.index < to),
        )
        .map((tag) => `line ${tag.line}: ${tag.name} ${tag.body.slice(0, 40)}`);
      expect(
        offenders,
        `${repoPath(file)} has a render outside direct-output markup ` +
          `position:\n${offenders.join("\n")}`,
      ).toEqual([]);
    }
  });

  it("the core renders exactly the eight preset partials, once each", () => {
    /* The dispatch is pinned both ways: every branch of the {% case %}
       reaches a preset partial, and no render targets anything else — a
       renamed partial, a helper snippet or a second render of the same
       preset all fail here. */
    const renders = liquidTags(read(join(SNIPPETS_DIR, "cx-buybox-core.liquid")))
      .filter((tag) => isSnippetTag(tag.name));
    expect(renders.every((tag) => tag.name === "render")).toBe(true);
    const targets = renders
      .map((tag) => /^'([^']+)'/.exec(tag.body)?.[1] ?? tag.body.slice(0, 40))
      .sort();
    expect(targets).toEqual(
      PRESET_NAMES.map((preset) => `cx-preset-${preset}`),
    );
  });

  it("a preset partial renders nothing further and computes nothing", () => {
    /* Snippets never return values: all string/value computation stays in
       the consumer (the core), so a partial contains no render, no include
       and no capture-of-render — only markup and the captures of pure
       markup its ordering knobs need. */
    for (const preset of PRESET_NAMES) {
      const name = `cx-preset-${preset}.liquid`;
      const renders = liquidTags(read(join(SNIPPETS_DIR, name)))
        .filter((tag) => isSnippetTag(tag.name))
        .map((tag) => `line ${tag.line}: ${tag.name} ${tag.body.slice(0, 40)}`);
      expect(
        renders,
        `${name}: a preset partial only prints what the core passed it — ` +
          `see the Liquid rules in extensions/cellexia-buy-box/README.md`,
      ).toEqual([]);
    }
  });

  it("each block renders the core snippet exactly once, in markup position", () => {
    for (const name of readdirSync(BLOCKS_DIR).filter((f) =>
      f.endsWith(".liquid"),
    )) {
      const renders = liquidTags(read(join(BLOCKS_DIR, name))).filter((tag) =>
        isSnippetTag(tag.name),
      );
      expect(renders.map((tag) => tag.line), `${name} render count`).toHaveLength(
        1,
      );
      /* `render`, never the legacy `include`: include does not isolate scope,
         so the snippet could read and overwrite the block's own variables. */
      expect(renders[0].name, `${name} uses the modern render tag`).toBe(
        "render",
      );
      expect(renders[0].body, `${name} renders the core snippet`).toMatch(
        /^'cx-buybox-core'/,
      );
      /* Markup position, literally: a render written as a line inside a
         `{% liquid %}` block is not between elements, and Shopify's BEGIN/END
         app-snippet markers would land somewhere they can be captured. */
      expect(
        renders[0].lineForm,
        `${name} renders from inside a {% liquid %} block, not markup position`,
      ).toBe(false);
    }
  });
});

// ── 3. Never escape the output of the t filter ───────────────────────────────

/**
 * Every Liquid expression that produces a value: `{{ … }}` outputs, `assign`
 * statements (tag form and `{% liquid %}` line form) and `echo` lines.
 */
function valueExpressions(source: string): Array<{ line: number; text: string }> {
  const expressions: Array<{ line: number; text: string }> = [];
  const lineOf = (index: number) => source.slice(0, index).split("\n").length;

  const outputs = /\{\{-?([\s\S]*?)-?\}\}/g;
  let match = outputs.exec(source);
  while (match !== null) {
    expressions.push({ line: lineOf(match.index), text: match[1] });
    match = outputs.exec(source);
  }

  // {% assign … %} / {% echo … %} and their {% liquid %} line equivalents,
  // read through the tag scanner so neither form — nor a body containing a
  // literal "%" — can slip past.
  for (const tag of liquidTags(source)) {
    if (tag.name === "assign" || tag.name === "echo") {
      expressions.push({ line: tag.line, text: tag.body });
    }
  }
  return expressions;
}

describe("escaping discipline", () => {
  it.each(liquidFiles.map(repoPath))(
    "%s never pipes t-filter output through escape",
    (relativeFile) => {
      const source = read(join(REPO_ROOT, relativeFile));
      const offenders = valueExpressions(source)
        .filter(({ text }) => {
          const translated = /\|\s*t\b/.exec(text);
          if (!translated) return false;
          return /\|\s*escape\b/.test(text.slice(translated.index));
        })
        .map(({ line, text }) => `line ${line}: ${text.trim().slice(0, 80)}`);

      expect(
        offenders,
        `${relativeFile} escapes already-escaped translation output ` +
          `("Subscribe & Save" → "Subscribe &amp;amp; Save"):\n${offenders.join("\n")}`,
      ).toEqual([]);
    },
  );

  it.each(liquidFiles.map(repoPath))(
    "%s never escapes the same value twice",
    (relativeFile) => {
      const source = read(join(REPO_ROOT, relativeFile));
      const offenders = valueExpressions(source)
        .filter(({ text }) => (text.match(/\|\s*escape\b/g) ?? []).length > 1)
        .map(({ line, text }) => `line ${line}: ${text.trim().slice(0, 80)}`);
      expect(offenders, offenders.join("\n")).toEqual([]);
    },
  );
});

// ── 4. Element ids cannot collide with the other vendor's cx-* ids ───────────

describe("id namespace", () => {
  /** Every `id="…"` attribute in the extension's markup, with its file/line. */
  function idAttributes(): Array<{ file: string; line: number; value: string }> {
    const found: Array<{ file: string; line: number; value: string }> = [];
    for (const file of liquidFiles) {
      const source = read(file);
      const pattern = /\sid="([^"]*)"/g;
      let match = pattern.exec(source);
      while (match !== null) {
        found.push({
          file: repoPath(file),
          line: source.slice(0, match.index).split("\n").length,
          value: match[1],
        });
        match = pattern.exec(source);
      }
    }
    return found;
  }

  it("emits cx-* ids only when they are suffixed with the block uid", () => {
    const cxIds = idAttributes().filter(({ value }) => value.startsWith("cx-"));
    // The widget legitimately uses cx-<name>-{{ uid }} ids for aria wiring and
    // the scoped custom-CSS selector; block.id makes every one of them unique
    // per block instance, so they cannot collide with the other vendor's
    // static cx-* ids on cellexialabs.com.
    expect(cxIds.length).toBeGreaterThan(0);
    const staticIds = cxIds.filter(
      ({ value }) => !/\{\{-?\s*uid\s*(\||-?\}\})/.test(value),
    );
    expect(
      staticIds.map((id) => `${id.file}:${id.line} id="${id.value}"`),
      "static cx-* ids can collide with the other vendor's ids on the live store",
    ).toEqual([]);
  });

  it("references those ids only through the same uid-suffixed form", () => {
    // aria-controls / aria-labelledby / for="…" must track the id scheme.
    for (const file of liquidFiles) {
      const source = read(file);
      const pattern = /\s(?:for|aria-controls|aria-labelledby)="(cx-[^"]*)"/g;
      let match = pattern.exec(source);
      while (match !== null) {
        expect(
          match[1],
          `${repoPath(file)} references a non-uid cx-* id`,
        ).toMatch(/\{\{-?\s*uid\s*(\||-?\}\})/);
        match = pattern.exec(source);
      }
    }
  });
});

// ── 5. The attribute namespace cannot drift back into the collision ──────────

describe("attribute namespace", () => {
  /** Every file the ZIP ships to a theme: Liquid, JS and CSS. */
  function shippedFiles(): string[] {
    return [
      ...liquidFiles,
      ...readdirSync(ASSETS_DIR)
        .filter((name) => /\.(?:js|css)$/.test(name))
        .map((name) => join(ASSETS_DIR, name)),
    ];
  }

  /**
   * Every browser script the extension ships, read from disk.
   *
   * The document-level query rules below used to iterate a hard-coded
   * ["buy-box.js", "buy-box-embed.js"]. That made the guard silently
   * incomplete: a third asset (a portal script, a lazy-loaded add-on) would
   * be namespace-scanned by the rules above — which walk the filesystem —
   * yet skipped by every "is this query qualified?" rule here, which is the
   * half that actually prevents the cellexialabs.com element adoption. The
   * list is derived instead, so a new script is covered the moment it lands.
   */
  function browserScripts(): string[] {
    return readdirSync(ASSETS_DIR)
      .filter((name) => name.endsWith(".js"))
      .sort();
  }

  it("ships Liquid, JS and CSS to check", () => {
    expect(shippedFiles().length).toBeGreaterThan(4);
  });

  it("checks every browser script the extension ships", () => {
    /* Non-vacuity: the derived list must actually find the scripts we know
       are there, so a broken readdir cannot turn every rule below into a
       no-op loop over an empty array. */
    const scripts = browserScripts();
    expect(scripts).toContain("buy-box.js");
    expect(scripts).toContain("buy-box-embed.js");
    expect(
      readdirSync(ASSETS_DIR).filter((name) => name.endsWith(".js")).length,
      "a shipped .js asset is missing from the document-query rules",
    ).toBe(scripts.length);
  });

  /* Comments are blanked by withCommentsBlanked (module scope above): the
     headers of buy-box.js / buy-box-embed.js document the collision in prose
     and necessarily name the other vendor's `data-cx-embed`; prose is not
     markup and not a selector, so it is exempt — nothing else is, and the
     blanker is a scanner precisely so that "in a comment" cannot be faked by
     a `//` inside a string. */

  it("emits no data-cx-* attribute anywhere (the live namespace collision)", () => {
    const offenders: string[] = [];
    for (const file of shippedFiles()) {
      const source = withCommentsBlanked(file, read(file));
      source.split("\n").forEach((line, index) => {
        if (line.includes("data-cx-")) {
          offenders.push(`${repoPath(file)}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      "data-cx-* collides with another vendor on cellexialabs.com — use " +
        `data-cellexia-*:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("writes the design line property under its cellexia name only", () => {
    for (const file of shippedFiles()) {
      expect(
        withCommentsBlanked(file, read(file)),
        `${repoPath(file)} writes the pre-rename property`,
      ).not.toContain("_cx_design");
    }
  });

  it("never looks our own markup up by a bare attribute selector", () => {
    /* A document-level lookup keyed only on an attribute is exactly what let
       another vendor's element be adopted as our wrapper. Every own-markup
       selector must carry our class too. */
    const bare =
      /(?:document|event\.target)\.querySelector(?:All)?\(\s*(['"])\s*\[data-cellexia-[^'"]*\1/g;
    for (const name of browserScripts()) {
      const source = readAsset(name);
      const offenders = [...source.matchAll(bare)].map((m) => m[0]);
      expect(
        offenders,
        `${name} queries the document by attribute alone: ${offenders.join(", ")}`,
      ).toEqual([]);
    }
  });

  it("qualifies the hoisted own-markup selectors with our class", () => {
    for (const name of browserScripts()) {
      const source = readAsset(name);
      const constants = [
        ...source.matchAll(/\bOWN_[A-Z_]+\s*=\s*(['"])([^'"]*)\1/g),
      ].map((m) => m[2]);
      /* A script that never queries the document for our markup needs no
         OWN_* constant — but one that DOES must hoist it, so the selector a
         human reviews is the selector every lookup uses. Keyed on a
         document-level query rather than on the filename, so this stays true
         for a script added later. */
      if (documentQueriesIn(source, name).length > 0) {
        expect(
          constants.length,
          `${name} makes a document-level query but hoists no OWN_* selector`,
        ).toBeGreaterThan(0);
      }
      for (const selector of constants) {
        expect(selector, `${name}: ${selector}`).toMatch(
          /^\.cx-[\w-]+\[data-cellexia-[\w-]+\]$/,
        );
      }
    }
  });

  // ── 5b. The rule covers the WHOLE extension, not just the files we
  //        remembered to list ─────────────────────────────────────────────────

  /** Every file the extension directory contains, at any depth. */
  function everyExtensionFile(directory: string = EXTENSION_DIR): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) found.push(...everyExtensionFile(full));
      else found.push(full);
    }
    return found.sort();
  }

  /**
   * README.md is the one exemption, and it is deliberate: it documents the
   * collision for whoever maintains this next, and quotes the OTHER vendor's
   * `<div class="cx cx--self-contained" data-cx-embed>` verbatim so the
   * history is legible. Documentation is not markup, and a README at the
   * extension root reaches no storefront: Shopify serves assets/, blocks/,
   * snippets/ and locales/, and nothing else. EVERYTHING under those — plus
   * the extension TOML — is scanned, with comments blanked where the format
   * has them.
   *
   * The test below pins that reasoning instead of trusting it, so the
   * exemption cannot quietly grow to cover a file that IS served.
   */
  const NAMESPACE_SCAN_EXEMPT = new Set(["README.md"]);

  /** Directories whose contents Shopify serves to a storefront. */
  const SERVED_DIRECTORIES = ["assets", "blocks", "snippets", "locales"];

  function extensionRelative(file: string): string {
    return file.slice(EXTENSION_DIR.length + 1);
  }

  function isScanned(file: string): boolean {
    return !NAMESPACE_SCAN_EXEMPT.has(extensionRelative(file));
  }

  it("scans every file the extension ships (no format can slip past)", () => {
    const all = everyExtensionFile();
    const scanned = all.filter(isScanned);
    expect(all.length).toBeGreaterThan(25);
    expect(all.length - scanned.length, "exactly one exemption: README.md").toBe(
      1,
    );
    // The formats present must all be ones withCommentsBlanked understands or
    // that have no comment syntax at all; a new one has to be considered here.
    const extensions = new Set(
      scanned.map((file) => file.slice(file.lastIndexOf("."))),
    );
    expect([...extensions].sort()).toEqual([
      ".css",
      ".js",
      ".json",
      ".liquid",
      ".toml",
    ]);
  });

  it("exempts nothing that reaches a storefront", () => {
    /* The exemption is prose-only, and "prose" has to mean a file Shopify
       never serves — not merely a file someone decided to skip. */
    const exempt = [...NAMESPACE_SCAN_EXEMPT];
    expect(exempt, "the only exemption is the maintainer README").toEqual([
      "README.md",
    ]);
    for (const relative of exempt) {
      expect(
        relative.includes("/"),
        `${relative} is not at the extension root`,
      ).toBe(false);
      expect(
        SERVED_DIRECTORIES.some((dir) => relative.startsWith(`${dir}/`)),
        `${relative} sits in a directory Shopify serves`,
      ).toBe(false);
    }
    /* Every file under a served directory really is scanned. */
    const skippedButServed = everyExtensionFile()
      .filter((file) => !isScanned(file))
      .map(extensionRelative)
      .filter((relative) =>
        SERVED_DIRECTORIES.some((dir) => relative.startsWith(`${dir}/`)),
      );
    expect(skippedButServed, skippedButServed.join(", ")).toEqual([]);
  });

  it("emits no data-cx-* attribute in any file it serves (README prose aside)", () => {
    const offenders: string[] = [];
    for (const file of everyExtensionFile().filter(isScanned)) {
      withCommentsBlanked(file, read(file))
        .split("\n")
        .forEach((line, index) => {
          if (line.includes("data-cx-")) {
            offenders.push(`${repoPath(file)}:${index + 1}: ${line.trim()}`);
          }
        });
    }
    expect(
      offenders,
      "data-cx-* collides with the other cx-namespace vendor on " +
        `cellexialabs.com — use data-cellexia-*:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("names the design line property _cellexia_design in every file it serves", () => {
    for (const file of everyExtensionFile().filter(isScanned)) {
      expect(
        withCommentsBlanked(file, read(file)),
        `${repoPath(file)} writes the pre-rename property`,
      ).not.toContain("_cx_design");
    }
  });

  // ── 5c. Every DOCUMENT-LEVEL query is qualified ──────────────────────────

  /** See documentQueriesIn at module scope for what counts as document-level. */
  function documentQueries(name: string): DocumentQuery[] {
    return documentQueriesIn(readAsset(name), name);
  }

  /** See documentLookupsIn at module scope. */
  function documentLookups(name: string): DocumentQuery[] {
    return documentLookupsIn(readAsset(name), name);
  }

  /** A selector is qualified when EVERY compound naming one of our attributes
      also names one of our classes. */
  function unqualifiedCompounds(selector: string): string[] {
    return selector
      .split(",")
      .map((compound) => compound.trim())
      .filter(
        (compound) =>
          compound.includes("data-cellexia-") && !/\.cx-[\w-]/.test(compound),
      );
  }

  it("finds the document-level queries it claims to check", () => {
    const all = browserScripts().flatMap((name) => documentQueries(name));
    expect(all.length, "no document-level query found — the regex has rotted")
      .toBeGreaterThan(4);
  });

  it("qualifies every document-level data-cellexia-* query with our class", () => {
    const offenders: string[] = [];
    for (const name of browserScripts()) {
      for (const query of documentQueries(name)) {
        const literal = /^(['"])([\s\S]*)\1$/.exec(query.argument);
        if (!literal) continue; // identifiers are handled by the test below
        for (const compound of unqualifiedCompounds(literal[2])) {
          offenders.push(
            `${name}:${query.line} ${query.receiver}.${query.method}("${compound}")`,
          );
        }
      }
    }
    expect(
      offenders,
      "a document-level lookup keyed on our attribute ALONE is what adopted " +
        "another vendor's element on cellexialabs.com. Qualify it with our " +
        `own class (.cx-buybox…) or root it at a node already proved ours:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("passes only reviewed selector variables to a document-level query", () => {
    /* An identifier hides its selector from the rule above, so the set of
       identifiers reaching a document-level query is pinned. OWN_* constants
       are separately required to be class+attribute qualified; `selector` is
       safeQuery's parameter, whose own call sites are checked below. Anything
       new here has to be looked at by a human. */
    const allowed = new Set([
      "OWN_WIDGET",
      "OWN_WRAPPER",
      "OWN_GATED",
      // v1.2.4 group ownership: the empty <template> the Liquid leaves behind
      // when every selling plan group on the product belongs to another
      // subscription app. Reviewed: class + attribute qualified like the rest
      // (.cx-buybox-nogroup[data-cellexia-no-owned-group]), and it is only
      // ever read — never marked, moved or unhidden.
      "OWN_NO_GROUP",
      // v1.11.0 subscription_ultra_max: the relocated one-time line — OUR
      // markup legitimately living outside the widget root once mounted.
      // Reviewed: class + attribute qualified
      // (.cx-buybox-satellite[data-cellexia-satellite]); the document-level
      // query serves the predecessor-stray cleanup at init, and every
      // mutation behind it asserts isOwnSatellite() first.
      "OWN_SATELLITE",
      "selector",
    ]);
    const seen = new Set<string>();
    const offenders: string[] = [];
    for (const name of browserScripts()) {
      for (const query of documentQueries(name)) {
        if (/^(['"])[\s\S]*\1$/.test(query.argument)) continue;
        seen.add(query.argument);
        if (!allowed.has(query.argument)) {
          offenders.push(
            `${name}:${query.line} ${query.receiver}.${query.method}(${query.argument})`,
          );
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
    expect(seen.size, "the OWN_* constants must still reach a document query")
      .toBeGreaterThan(0);
  });

  it("never hands safeQuery a literal selector of our own markup", () => {
    /* safeQuery defaults to the document, so a literal passed to it is a
       document-level lookup wearing a helper's name — invisible to the
       `document.querySelector` rules above. Our own markup must be found
       through the OWN_* constants, never here. Checked in every script, not
       just the one that happens to define the helper today. */
    const offenders: string[] = [];
    for (const name of browserScripts()) {
      const source = readAsset(name);
      for (const match of source.matchAll(/\bsafeQuery\(\s*(['"])([^'"]*)\1/g)) {
        if (match[2].includes("data-cellexia-")) {
          offenders.push(`${name}: safeQuery("${match[2]}")`);
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("never reaches our own markup by id or by class name", () => {
    /* getElementById / getElementsBy* take a bare name and search the whole
       page: there is no class to qualify them with, so our markup may not be
       reached that way at all. The `cx-*` id namespace is SHARED with the
       other vendor on the live store (cx-i18n, cx-cart-config, cx-pdp-config,
       cx-embed-config are theirs), which is exactly why the Liquid may only
       emit uid-suffixed ids — and why the JS must go through the OWN_*
       class+attribute selectors instead of guessing an id back. */
    const offenders: string[] = [];
    for (const name of browserScripts()) {
      for (const lookup of documentLookups(name)) {
        if (/cx-|cellexia/i.test(lookup.argument)) {
          offenders.push(
            `${name}:${lookup.line} ${lookup.receiver}.${lookup.method}(${lookup.argument})`,
          );
        }
      }
    }
    expect(
      offenders,
      "an id/class-name lookup cannot be class-qualified and shares the cx-* " +
        `namespace with the other vendor — use the OWN_* selectors:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("pins the document-level id lookups a human has reviewed", () => {
    /* The rule above only forbids OUR namespace. Everything else that searches
       the whole page by id or tag name still deserves a human's eyes, so the
       exact set is pinned: a new one fails here until it is looked at. */
    const seen = browserScripts()
      .flatMap((name) => documentLookups(name))
      .map((lookup) => `${lookup.method}(${lookup.argument})`);
    expect(seen.sort()).toEqual([
      // Scopes the product-form search to the block's own Shopify section —
      // the platform's id, used to NARROW a search, never to find our markup.
      "getElementById('shopify-section-' + sectionId)",
    ]);
  });

  it("qualifies every upward walk to our markup with our class too", () => {
    /* closest() and matches() leave the subtree we own — closest() walks all
       the way to <html> — so an attribute-only selector there can land on the
       other vendor's element exactly as a document query can. Identifiers
       (OWN_WRAPPER, OWN_WIDGET) are separately proved class-qualified. */
    const offenders: string[] = [];
    for (const name of browserScripts()) {
      const source = withCommentsBlanked(name, readAsset(name));
      for (const match of source.matchAll(
        /\.\s*(closest|matches)\s*\(\s*(['"])([^'"]*)\2/g,
      )) {
        const line = source.slice(0, match.index ?? 0).split("\n").length;
        for (const compound of unqualifiedCompounds(match[3])) {
          offenders.push(`${name}:${line} .${match[1]}("${compound}")`);
        }
      }
    }
    expect(
      offenders,
      "an upward walk keyed on our attribute alone can adopt another " +
        `vendor's element:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

// ── 5e. The SECOND surface that ships JS into the merchant's theme ──────────

/**
 * The customer portal is served through the app proxy, so `portalPage()` HTML
 * is injected INTO THE MERCHANT'S THEME. The theme's own markup and every
 * storefront app on the shop share that document — including the "cx" vendor
 * whose collision forced the rename that rules 4 and 5 exist to enforce.
 *
 * Those rules stop at `extensions/`, and the portal is the other place this
 * app puts a <script> on a storefront page. It was querying
 * `.cx-toast` and `.cx-portal form` — class-only, unqualified by any
 * attribute — and the second of those WRITES: it disables submit buttons, so a
 * foreign `.cx-portal` on the page would have had its forms broken by us. Same
 * document, same vendor, same class prefix, same failure mode as v1.2.2; only
 * the directory was different, which is why nothing caught it.
 */
describe("portal script namespace", () => {
  const PORTAL_LAYOUT = join(REPO_ROOT, "app", "lib", "portal", "layout.server.ts");
  const PORTAL_LABEL = "app/lib/portal/layout.server.ts";
  const portalSource = read(PORTAL_LAYOUT);

  /** Every template that renders portal markup the selectors must match. */
  const portalMarkup = [
    portalSource,
    ...readdirSync(join(REPO_ROOT, "app", "routes"))
      .filter((name) => name.startsWith("proxy.") && name.endsWith(".tsx"))
      .map((name) => read(join(REPO_ROOT, "app", "routes", name))),
  ].join("\n");

  const queries = () => documentQueriesIn(portalSource, PORTAL_LABEL);

  it("has a browser script to check", () => {
    expect(
      queries().length,
      "no document-level query found in the portal script — if that script " +
        "moved, this rule has to move with it rather than silently pass",
    ).toBeGreaterThan(0);
  });

  it("qualifies every document-level query by our class AND our attribute", () => {
    const offenders: string[] = [];
    for (const query of queries()) {
      const literal = /^(['"])([\s\S]*)\1$/.exec(query.argument);
      if (!literal) {
        offenders.push(`${PORTAL_LABEL}:${query.line} non-literal ${query.argument}`);
        continue;
      }
      for (const compound of literal[2].split(",").map((part) => part.trim())) {
        if (!/\.cx-[\w-]/.test(compound) || !compound.includes("data-cellexia-")) {
          offenders.push(
            `${PORTAL_LABEL}:${query.line} ${query.receiver}.${query.method}("${compound}")`,
          );
        }
      }
    }
    expect(
      offenders,
      "the portal renders inside the merchant's theme: a document-level " +
        "lookup must prove the element is OURS — by our class AND our " +
        `attribute — before reading it, let alone writing to it:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("makes ONE document-level query, then works from that root", () => {
    /* Everything the script touches lives inside the portal root, so a single
       qualified lookup suffices; each additional one is another opportunity to
       adopt a foreign node. Rooted lookups (root.querySelectorAll) are free. */
    expect(
      queries().map((query) => `${query.line}: ${query.argument}`),
    ).toHaveLength(1);
  });

  it("never reaches portal markup by id or by class name", () => {
    /* Same reasoning as the extension rule: getElementById/getElementsBy* take
       a bare name and search the whole page, so there is no class to qualify
       them with and our markup may not be reached that way at all. */
    const offenders = documentLookupsIn(portalSource, PORTAL_LABEL).map(
      (query) => `${PORTAL_LABEL}:${query.line} ${query.receiver}.${query.method}(${query.argument})`,
    );
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("emits every data-cellexia-* hook its selectors depend on", () => {
    /* Selector and markup live in DIFFERENT files — the confirm forms are
       rendered by app/routes/proxy.*.tsx — so renaming one side silently turns
       the behaviour off: the handler binds to nothing and no error is raised.
       The pairing is asserted, not assumed. */
    const used = new Set(
      [...portalSource.matchAll(/\[(data-cellexia-[\w-]+)\]/g)].map((m) => m[1]),
    );
    expect(
      used.size,
      "no data-cellexia-* selector found in the portal script",
    ).toBeGreaterThan(0);
    const missing = [...used].filter(
      (attribute) => !new RegExp(`${attribute}[\\s=>"']`).test(portalMarkup),
    );
    expect(
      missing,
      `the portal script selects on ${missing.join(", ")}, but no portal ` +
        "template emits it — those handlers would bind to nothing",
    ).toEqual([]);
  });

  it("carries no old-namespace attribute or design property", () => {
    const live = withCommentsBlanked(PORTAL_LABEL, portalSource);
    expect(live).not.toContain("data-cx-");
    expect(live).not.toContain("_cx_design");
  });
});

// ── 5d. The guards' own blind spots ─────────────────────────────────────────

describe("the namespace scanners themselves", () => {
  /** What is left once blanking has run: code, with comments gone. */
  const surviving = (file: string, source: string) =>
    withCommentsBlanked(file, source)
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n");

  it("blanks real comments", () => {
    expect(surviving("x.js", "a; // data-cx-embed\nb;")).toBe("a;\nb;");
    expect(surviving("x.js", "/* data-cx-a */ b;")).toBe("                b;");
    expect(surviving("x.css", "/* data-cx-a */ .b {}")).toBe(
      "                .b {}",
    );
    expect(surviving("x.toml", "# data-cx-a\nname = 1")).toBe("\nname = 1");
    expect(
      surviving("x.liquid", "{%- comment -%} data-cx-a {%- endcomment -%}x"),
    ).toBe(" ".repeat(44) + "x");
  });

  it("does not treat a URL, a regex or a hash inside a string as a comment", () => {
    /* THE regression this scanner exists for: the regex blanker erased from
       the first `//` to end of line, so a CDN URL hid every data-cx-* that
       followed it — in the one guard standing between a namespace regression
       and the client's storefront. */
    expect(
      withCommentsBlanked("x.js", "var u = 'https://cdn/x'; q('[data-cx-embed]');"),
    ).toContain("data-cx-embed");
    expect(
      withCommentsBlanked("x.js", "var s = '/* not a comment */ data-cx-a';"),
    ).toContain("data-cx-a");
    expect(
      withCommentsBlanked("x.js", "var r = /a\\/\\/b/; q('[data-cx-embed]');"),
    ).toContain("data-cx-embed");
    /* `//` opens nothing in CSS, TOML or JSON. */
    expect(
      withCommentsBlanked("x.css", "a { background: url(//cdn/x) } /* */ [data-cx-a] {}"),
    ).toContain("data-cx-a");
    expect(
      withCommentsBlanked("x.toml", 'url = "//cdn/x" # c\nname = "data-cx-a"'),
    ).toContain("data-cx-a");
    expect(
      withCommentsBlanked("x.json", '{"a": "//cdn/x", "b": "data-cx-embed"}'),
    ).toContain("data-cx-embed");
    expect(withCommentsBlanked("x.toml", 'a = "# data-cx-b"')).toContain(
      "data-cx-b",
    );
  });

  it("keeps line numbers honest while blanking", () => {
    const blanked = withCommentsBlanked("x.js", "a;\n/* one\ntwo */\nb;");
    expect(blanked.split("\n")).toHaveLength(4);
    expect(blanked.split("\n")[3]).toBe("b;");
  });

  it("sees a document-wide query through body, documentElement and head", () => {
    /* THE blind spot this scanner was widened for. An earlier version matched
       only a bare `document.` receiver, so every line below — including
       `document.body.querySelector('[data-cellexia-embed]')`, the pre-fix bug
       one property access away — was invisible to the rule that exists to
       forbid it. If this ever fails, the guard has gone vacuous and an
       unqualified document-wide lookup can ship again. */
    for (const root of ["document", "document.body", "document.documentElement", "document.head"]) {
      const source = `var x = ${root}.querySelector('[data-cellexia-embed]');`;
      const found = documentQueriesIn(source);
      expect(found, `${root} receiver not seen`).toHaveLength(1);
      expect(found[0].argument).toBe("'[data-cellexia-embed]'");
      expect(found[0].receiver).toBe(root);
    }
    /* safeQuery's default seam, in every receiver spelling. */
    expect(
      documentQueriesIn("return (scope || document.body).querySelector(selector);"),
    ).toHaveLength(1);
    expect(
      documentQueriesIn("Array.prototype.slice.call(event.target.querySelectorAll(OWN_WIDGET));"),
    ).toHaveLength(1);
  });

  it("leaves lookups rooted at a node we own alone", () => {
    /* The counterpart: scoping to our own subtree IS the qualification, so
       these must NOT be reported or the rule becomes unusable noise. */
    expect(documentQueriesIn("root.querySelector('[data-cellexia-freq]');")).toEqual([]);
    expect(documentQueriesIn("wrapper.querySelector(OWN_WIDGET);")).toEqual([]);
    expect(documentQueriesIn("form.querySelectorAll('[name=\"id\"]');")).toEqual([]);
    /* A node merely NAMED document-something is not the document. */
    expect(documentQueriesIn("documentFragment.querySelector('.x');")).toEqual([]);
  });

  it("sees id and class-name lookups made against the document", () => {
    for (const root of ["document", "document.body", "document.documentElement"]) {
      expect(
        documentLookupsIn(`${root}.getElementById('cx-buybox-1');`),
        `${root} id lookup not seen`,
      ).toHaveLength(1);
    }
    expect(
      documentLookupsIn("document.getElementsByClassName('cx-buybox');"),
    ).toHaveLength(1);
    expect(
      documentLookupsIn("document.getElementsByTagName('form');")[0].method,
    ).toBe("getElementsByTagName");
    expect(documentLookupsIn("document.getElementsByName('id');")).toHaveLength(1);
    /* Rooted at our own node: not a document-level lookup. */
    expect(documentLookupsIn("root.getElementsByTagName('input');")).toEqual([]);
  });

  it("reads a call argument past an inner parenthesis", () => {
    /* The document-query rule skipped any selector containing `)` because the
       old pattern stopped there — `:not(…)` is ordinary CSS, so the one shape
       most likely to hide an unqualified lookup was the one shape the rule
       could not see. */
    const source = "document.querySelectorAll('[data-cellexia-x]:not(.y)');";
    expect(callArgument(source, source.indexOf("("))).toBe(
      "'[data-cellexia-x]:not(.y)'",
    );
    expect(callArgument("f(')(' , a)", 1)).toBe("')(' , a");
    expect(callArgument("f(unclosed", 1)).toBeNull();
  });
});

// ── 6. The harness cannot silently drift from the templates ──────────────────

describe("harness fidelity", () => {
  it("implements every filter the extension Liquid uses", () => {
    const known = new Set(Object.keys(engine().filters));
    const used = new Set<string>();
    for (const file of liquidFiles) {
      for (const match of read(file).matchAll(/\|\s*([a-z_0-9]+)/g)) {
        used.add(match[1]);
      }
    }
    const missing = [...used].filter((filter) => !known.has(filter)).sort();
    expect(
      missing,
      `tests/liquid/harness.ts does not implement: ${missing.join(", ")}. ` +
        "Renders would silently pass the value through instead of formatting it.",
    ).toEqual([]);
  });

  it("implements every tag the extension Liquid uses", () => {
    const known = new Set(Object.keys(engine().tags));
    const used = new Set<string>();
    for (const file of liquidFiles) {
      for (const match of read(file).matchAll(/\{%-?\s*(\w+)/g)) {
        used.add(match[1]);
      }
    }
    const ignorable = new Set([
      "end",
      "else",
      "elsif",
      "when",
      "break",
      "continue",
    ]);
    const missing = [...used].filter(
      (tag) =>
        !known.has(tag) &&
        !tag.startsWith("end") &&
        !ignorable.has(tag),
    );
    expect(missing, `unknown Liquid tags: ${missing.join(", ")}`).toEqual([]);
  });
});

// ── 7. Locale coverage for every `| t` key ───────────────────────────────────

describe("extension locales", () => {
  const translationKeys = (() => {
    const keys = new Set<string>();
    for (const file of liquidFiles) {
      for (const match of read(file).matchAll(/'([\w.]+)'\s*\|\s*t\b/g)) {
        keys.add(match[1]);
      }
    }
    return [...keys].sort();
  })();

  it("finds the translation keys the templates use", () => {
    expect(translationKeys.length).toBeGreaterThan(10);
  });

  it("resolves every key in the default locale", () => {
    const defaults = translationsFor("en");
    const missing = translationKeys.filter((key) => !(key in defaults));
    expect(
      missing,
      `keys missing from locales/en.default.json (they would render ` +
        `"translation missing: en.<key>" on the storefront): ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("resolves every key in every shipped locale", () => {
    const locales = shippedLocales();
    expect(locales.length).toBeGreaterThan(5);
    const offenders: string[] = [];
    for (const code of locales) {
      const table = translationsFor(code);
      for (const key of translationKeys) {
        const value = table[key];
        if (typeof value !== "string" || value.trim() === "") {
          offenders.push(`${code}: ${key}`);
        }
      }
    }
    expect(offenders, offenders.join(", ")).toEqual([]);
  });

  it("pins strict per-file key parity with en.default.json (no fallback masking)", () => {
    // translationsFor() merges each locale OVER en.default.json, mirroring
    // Shopify's per-key English fallback. That means the two tests above would
    // still pass if a locale file silently DROPPED a key (it would fall back
    // to English on the storefront). This test reads every shipped file raw
    // and requires the exact same key set as the default locale, both ways,
    // so a dropped or stray key fails loudly instead of degrading to English.
    const localeFiles = readdirSync(join(EXTENSION_DIR, "locales"))
      .filter((name) => name.endsWith(".json"))
      .sort();
    expect(localeFiles.length, "expected all 22 locale files").toBe(22);

    const defaultKeys = Object.keys(
      JSON.parse(
        readFileSync(join(EXTENSION_DIR, "locales", "en.default.json"), "utf8"),
      ) as Record<string, string>,
    ).sort();

    const offenders: string[] = [];
    for (const file of localeFiles) {
      if (file === "en.default.json") continue;
      const table = JSON.parse(
        readFileSync(join(EXTENSION_DIR, "locales", file), "utf8"),
      ) as Record<string, string>;
      const keys = new Set(Object.keys(table));
      for (const key of defaultKeys) {
        if (!keys.has(key)) offenders.push(`${file}: missing "${key}"`);
        else if (typeof table[key] !== "string" || table[key].trim() === "")
          offenders.push(`${file}: empty "${key}"`);
      }
      for (const key of keys) {
        if (!defaultKeys.includes(key))
          offenders.push(`${file}: stray key "${key}" not in en.default.json`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("keeps every {{ placeholder }} of the default locale in every locale", () => {
    const defaults = translationsFor("en");
    const placeholders = (value: string) =>
      [...value.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]).sort();

    const offenders: string[] = [];
    for (const code of shippedLocales()) {
      const table = translationsFor(code);
      for (const key of translationKeys) {
        const expected = placeholders(defaults[key] ?? "");
        const actual = placeholders(table[key] ?? "");
        if (expected.join(",") !== actual.join(",")) {
          offenders.push(
            `${code}: ${key} has [${actual.join(", ")}], expected [${expected.join(", ")}]`,
          );
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
