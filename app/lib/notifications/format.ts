/**
 * Email formatting + design system (v1.17.0).
 *
 * ISOMORPHIC — no server imports. The admin Emails pages import this
 * client-side (design defaults, formatting help), and templates.server.ts
 * renders every outgoing email through it, so there is exactly ONE
 * text→HTML pipeline for previews, direct SMTP and the Klaviyo
 * content_html event property.
 *
 * ## The formatting language (markdown-lite)
 *
 * Merchant copy (and the built-in i18n copy) is plain text with a small,
 * conservative formatting vocabulary — chosen so that every pre-1.17.0
 * body, which was rendered as escape-then-<br>, still renders at least as
 * well without edits:
 *
 *   **bold**            → <strong>
 *   *italic*            → <em>       (word-bounded; never fires inside URLs)
 *   [label](https://…)  → link       (http/https/mailto only — anything else
 *                                      stays visible plain text)
 *   bare https://…      → auto-linked (pre-1.17.0 bodies list one-tap links
 *                                      as bare {skip_url} lines; those now
 *                                      become real links instead of text)
 *   [button:Label](url) → a brand-colored button on its own line
 *   [image:Alt](url)    → a centered product image on its own line (v1.24.0;
 *                         unsafe/unresolved URLs stay visible plain text)
 *   {cta}               → the template's default action button (built from
 *                         vars.cta_url / cta_label — same contract as v1.16)
 *   # Heading / ## Sub  → headings (line-start)
 *   - item              → bulleted list (line-start)
 *   > quote             → quoted block (line-start)
 *   ---                 → divider (alone on a line)
 *
 * Blank lines separate paragraphs. Single newlines inside a paragraph stay
 * line breaks. Unknown {placeholders} are left visible upstream
 * (interpolateVars) and render as plain text here — a typo should be seen.
 *
 * ## Safety
 *
 * Every text leaf is HTML-escaped at emission (escape-before-structure, the
 * same guarantee the v1.16.0 renderer gave by escaping the whole body
 * first). Link/button hrefs must match an allow-listed protocol
 * (http/https/mailto); everything else — javascript:, data:, relative
 * paths — is rendered as visible text, never as a clickable href.
 */

// ── Design (brand kit) ───────────────────────────────────────────────────────

export interface EmailDesign {
  /** "wordmark" renders `wordmark` as spaced text; "logo" renders logoUrl. */
  headerStyle: "wordmark" | "logo" | "none";
  wordmark: string;
  logoUrl: string;
  /** Rendered logo width in px (height stays auto). */
  logoWidth: number;
  fontFamily: "serif" | "sans";
  backgroundColor: string;
  cardBackground: string;
  cardBorderColor: string;
  textColor: string;
  mutedColor: string;
  /** Links inside the body copy. */
  linkColor: string;
  buttonColor: string;
  buttonTextColor: string;
  /** Footer line 1 — e.g. the brand promise. Empty = omitted. */
  footerText: string;
  /** Footer line 2 — e.g. the "why am I receiving this". Empty = omitted. */
  footerNote: string;
}

/**
 * The v1.16.0 shell, written out as explicit knobs — a shop that never
 * touches the Design tab renders emails identical to every release before
 * the brand kit existed.
 */
export const DEFAULT_EMAIL_DESIGN: EmailDesign = {
  headerStyle: "wordmark",
  wordmark: "C E L L E X I A",
  logoUrl: "",
  logoWidth: 140,
  fontFamily: "serif",
  backgroundColor: "#faf8f5",
  cardBackground: "#ffffff",
  cardBorderColor: "#ece7df",
  textColor: "#1a1a1a",
  mutedColor: "#8a837a",
  linkColor: "#1a1a1a",
  buttonColor: "#1a1a1a",
  buttonTextColor: "#faf8f5",
  footerText: "Cellexia — skincare that keeps its promises.",
  footerNote: "You are receiving this email about your Cellexia subscription.",
};

const FONT_STACKS: Record<EmailDesign["fontFamily"], string> = {
  serif: "Georgia,'Times New Roman',serif",
  sans: "-apple-system,'Segoe UI',Helvetica,Arial,sans-serif",
};

/** Defensive normalization for stored design values (schema drift, tests). */
export function normalizeEmailDesign(raw: unknown): EmailDesign {
  const d = (raw ?? {}) as Partial<Record<keyof EmailDesign, unknown>>;
  const str = (v: unknown, fallback: string): string =>
    typeof v === "string" ? v : fallback;
  const color = (v: unknown, fallback: string): string =>
    typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v : fallback;
  const D = DEFAULT_EMAIL_DESIGN;
  return {
    headerStyle:
      d.headerStyle === "logo" || d.headerStyle === "none"
        ? d.headerStyle
        : "wordmark",
    wordmark: str(d.wordmark, D.wordmark),
    logoUrl: str(d.logoUrl, D.logoUrl),
    logoWidth:
      typeof d.logoWidth === "number" &&
      Number.isFinite(d.logoWidth) &&
      d.logoWidth >= 40 &&
      d.logoWidth <= 400
        ? Math.round(d.logoWidth)
        : D.logoWidth,
    fontFamily: d.fontFamily === "sans" ? "sans" : "serif",
    backgroundColor: color(d.backgroundColor, D.backgroundColor),
    cardBackground: color(d.cardBackground, D.cardBackground),
    cardBorderColor: color(d.cardBorderColor, D.cardBorderColor),
    textColor: color(d.textColor, D.textColor),
    mutedColor: color(d.mutedColor, D.mutedColor),
    linkColor: color(d.linkColor, D.linkColor),
    buttonColor: color(d.buttonColor, D.buttonColor),
    buttonTextColor: color(d.buttonTextColor, D.buttonTextColor),
    footerText: str(d.footerText, D.footerText),
    footerNote: str(d.footerNote, D.footerNote),
  };
}

// ── Escaping + href safety ───────────────────────────────────────────────────

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** http/https/mailto only. Anything else is NOT a link. */
export function isSafeHref(url: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(url.trim());
}

// ── Inline parsing ───────────────────────────────────────────────────────────

type InlineNode =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "link"; label: string; href: string };

/**
 * Tokenizes one line of RAW (unescaped) text. Order matters: explicit
 * [label](url) first (so its URL is never re-autolinked), then bare URLs,
 * then bold, then italic — each only inside remaining plain-text spans.
 */
/**
 * Trims a bare-URL match GFM-style: trailing punctuation stays outside the
 * link, and trailing ')' characters are kept only while parens inside the
 * URL stay balanced — so `https://…/Foo_(bar)` links whole while
 * `(see https://example.com)` excludes the closing paren.
 */
function trimBareUrl(match: string): string {
  let url = match;
  for (;;) {
    const last = url[url.length - 1];
    if (last && ".,!?;:'\"".includes(last)) {
      url = url.slice(0, -1);
      continue;
    }
    if (last === ")") {
      const opens = (url.match(/\(/g) ?? []).length;
      const closes = (url.match(/\)/g) ?? []).length;
      if (closes > opens) {
        url = url.slice(0, -1);
        continue;
      }
    }
    return url;
  }
}

/** Link/button destination: allows one level of balanced parens (CommonMark). */
const LINK_DEST = String.raw`((?:\([^()\s]*\)|[^()\s])+)`;
const INLINE_LINK = new RegExp(
  String.raw`\[([^\]\n]+)\]\(` + LINK_DEST + String.raw`\)`,
  "g",
);

function parseInline(raw: string): InlineNode[] {
  // Pass 1: explicit links.
  let nodes: InlineNode[] = splitBy(
    [{ kind: "text", text: raw }],
    INLINE_LINK,
    (m) =>
      isSafeHref(m[2])
        ? { kind: "link", label: m[1], href: m[2] }
        : // Unsafe protocol: keep the source text visible, unlinked.
          { kind: "text", text: m[0] },
  );
  // Pass 2: bare URLs, paren-aware trimmed (see trimBareUrl).
  nodes = splitBy(nodes, /https?:\/\/[^\s<>]+/g, (m) => {
    const url = trimBareUrl(m[0]);
    const rest = m[0].slice(url.length);
    return [
      { kind: "link", label: url, href: url } as InlineNode,
      ...(rest ? [{ kind: "text", text: rest } as InlineNode] : []),
    ];
  });
  // Pass 3: bold — content edges must be non-space and non-asterisk so
  // spaced asterisk pairs ("2 ** x ** y") stay literal.
  nodes = splitBy(nodes, /\*\*([^*\s](?:[^*\n]*[^*\s])?)\*\*/g, (m) => ({
    kind: "bold",
    text: m[1],
  }));
  // Pass 4: italic — non-word/non-* boundaries outside AND non-space,
  // non-asterisk content edges inside, so asterisks used as math
  // ("2 * serum", "2 ** x ** y") never italicize half a sentence.
  nodes = splitBy(
    nodes,
    /(^|[^*\w])\*([^*\s](?:[^*\n]*[^*\s])?)\*(?![\w*])/g,
    (m) => [
      ...(m[1] ? [{ kind: "text", text: m[1] } as InlineNode] : []),
      { kind: "italic", text: m[2] } as InlineNode,
    ],
  );
  return nodes;
}

/** Applies a regex to every plain-text node, mapping matches to new nodes. */
function splitBy(
  nodes: InlineNode[],
  re: RegExp,
  toNode: (m: RegExpMatchArray) => InlineNode | InlineNode[],
): InlineNode[] {
  const out: InlineNode[] = [];
  for (const node of nodes) {
    if (node.kind !== "text") {
      out.push(node);
      continue;
    }
    let last = 0;
    for (const m of node.text.matchAll(re)) {
      const idx = m.index ?? 0;
      if (idx > last) out.push({ kind: "text", text: node.text.slice(last, idx) });
      const mapped = toNode(m);
      out.push(...(Array.isArray(mapped) ? mapped : [mapped]));
      last = idx + m[0].length;
    }
    if (last < node.text.length) {
      out.push({ kind: "text", text: node.text.slice(last) });
    }
  }
  return out;
}

function inlineHtml(nodes: InlineNode[], design: EmailDesign): string {
  return nodes
    .map((n) => {
      switch (n.kind) {
        case "text":
          return escapeHtml(n.text);
        case "bold":
          return `<strong>${escapeHtml(n.text)}</strong>`;
        case "italic":
          return `<em>${escapeHtml(n.text)}</em>`;
        case "link":
          return `<a href="${escapeHtml(n.href)}" style="color:${design.linkColor};text-decoration:underline;">${escapeHtml(n.label)}</a>`;
      }
    })
    .join("");
}

function inlineText(nodes: InlineNode[]): string {
  return nodes
    .map((n) => {
      switch (n.kind) {
        case "text":
          return n.text;
        case "bold":
        case "italic":
          return n.text;
        case "link":
          return n.label === n.href ? n.href : `${n.label}: ${n.href}`;
      }
    })
    .join("");
}

// ── Block parsing ────────────────────────────────────────────────────────────

type Block =
  | { kind: "paragraph"; lines: string[] }
  | { kind: "heading"; level: 2 | 3; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "divider" }
  | { kind: "button"; label: string; href: string }
  | { kind: "image"; alt: string; href: string }
  | { kind: "cta" };

const BUTTON_LINE = new RegExp(
  String.raw`^\[button:\s*([^\]]+)\]\(` + LINK_DEST + String.raw`\)$`,
);

// [image:Alt text](https://url) on its own line → a centered product image
// (v1.24.0, for gift emails). Same safety posture as buttons: an unsafe or
// unresolved URL renders the source text, never a broken <img>.
const IMAGE_LINE = new RegExp(
  String.raw`^\[image:\s*([^\]]*)\]\(` + LINK_DEST + String.raw`\)$`,
);

function parseBlocks(raw: string): Block[] {
  const lines = raw.replaceAll("\r\n", "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let quote: string[] = [];

  const flush = (): void => {
    if (paragraph.length) blocks.push({ kind: "paragraph", lines: paragraph });
    if (list.length) blocks.push({ kind: "list", items: list });
    if (quote.length) blocks.push({ kind: "quote", lines: quote });
    paragraph = [];
    list = [];
    quote = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") {
      flush();
      continue;
    }
    if (trimmed === "---") {
      flush();
      blocks.push({ kind: "divider" });
      continue;
    }
    if (trimmed === "{cta}") {
      flush();
      blocks.push({ kind: "cta" });
      continue;
    }
    const button = trimmed.match(BUTTON_LINE);
    if (button) {
      flush();
      if (isSafeHref(button[2])) {
        blocks.push({ kind: "button", label: button[1].trim(), href: button[2] });
      } else {
        // Unresolved placeholder or unsafe URL — show the source, unlinked.
        blocks.push({ kind: "paragraph", lines: [trimmed] });
      }
      continue;
    }
    const image = trimmed.match(IMAGE_LINE);
    if (image) {
      flush();
      if (isSafeHref(image[2])) {
        blocks.push({ kind: "image", alt: image[1].trim(), href: image[2] });
      } else {
        blocks.push({ kind: "paragraph", lines: [trimmed] });
      }
      continue;
    }
    const heading = trimmed.match(/^(##?)\s+(.*)$/);
    if (heading) {
      flush();
      blocks.push({
        kind: "heading",
        level: heading[1] === "#" ? 2 : 3,
        text: heading[2],
      });
      continue;
    }
    if (trimmed.startsWith("- ")) {
      if (paragraph.length || quote.length) flush();
      list.push(trimmed.slice(2));
      continue;
    }
    if (trimmed.startsWith("> ")) {
      if (paragraph.length || list.length) flush();
      quote.push(trimmed.slice(2));
      continue;
    }
    if (list.length || quote.length) flush();
    paragraph.push(line);
  }
  flush();
  return blocks;
}

// ── Rendering ────────────────────────────────────────────────────────────────

export interface FormatBodyOptions {
  design?: EmailDesign;
  /** Default action button — replaces {cta}, or is appended when absent. */
  ctaUrl?: string;
  ctaLabel?: string;
}

export interface FormattedBody {
  html: string;
  text: string;
}

function buttonHtml(label: string, href: string, design: EmailDesign): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0 8px;"><tr><td style="border-radius:6px;background:${design.buttonColor};"><a href="${escapeHtml(href)}" style="display:inline-block;padding:13px 28px;font-family:${FONT_STACKS[design.fontFamily]};font-size:15px;color:${design.buttonTextColor};text-decoration:none;letter-spacing:0.02em;">${escapeHtml(label)}</a></td></tr></table>`;
}

/**
 * Renders a body's copy (placeholders already interpolated) into the HTML
 * fragment that goes inside the shell card, plus its plain-text twin.
 */
export function formatEmailBody(
  raw: string,
  opts: FormatBodyOptions = {},
): FormattedBody {
  const design = opts.design ?? DEFAULT_EMAIL_DESIGN;
  const ctaUrl = opts.ctaUrl && isSafeHref(opts.ctaUrl) ? opts.ctaUrl : undefined;
  const ctaLabel = opts.ctaLabel || "Manage subscription";

  // {cta} always renders as its own block, wherever it was written — an
  // inline occurrence would otherwise survive as literal text (the v1.16.0
  // renderer swapped it anywhere in the body, and the fallback tests pin
  // that no {placeholder} ever reaches a rendered email).
  const normalized = raw.replace(/[ \t]*\{cta\}[ \t]*/g, "\n{cta}\n");

  const blocks = parseBlocks(normalized);
  const htmlParts: string[] = [];
  const textParts: string[] = [];
  let ctaRendered = false;

  for (const block of blocks) {
    switch (block.kind) {
      case "paragraph": {
        const html = block.lines
          .map((l) => inlineHtml(parseInline(l), design))
          .join("<br>");
        htmlParts.push(`<p style="margin:0 0 16px;">${html}</p>`);
        textParts.push(block.lines.map((l) => inlineText(parseInline(l))).join("\n"));
        break;
      }
      case "heading": {
        const size = block.level === 2 ? 20 : 17;
        htmlParts.push(
          `<p style="margin:0 0 12px;font-size:${size}px;line-height:1.35;font-weight:bold;">${inlineHtml(parseInline(block.text), design)}</p>`,
        );
        textParts.push(inlineText(parseInline(block.text)));
        break;
      }
      case "list": {
        const items = block.items
          .map(
            (item) =>
              `<li style="margin:0 0 6px;">${inlineHtml(parseInline(item), design)}</li>`,
          )
          .join("");
        htmlParts.push(
          `<ul style="margin:0 0 16px;padding:0 0 0 22px;">${items}</ul>`,
        );
        textParts.push(
          block.items.map((item) => `• ${inlineText(parseInline(item))}`).join("\n"),
        );
        break;
      }
      case "quote": {
        const html = block.lines
          .map((l) => inlineHtml(parseInline(l), design))
          .join("<br>");
        htmlParts.push(
          `<blockquote style="margin:0 0 16px;padding:2px 0 2px 14px;border-left:3px solid ${design.cardBorderColor};color:${design.mutedColor};">${html}</blockquote>`,
        );
        textParts.push(block.lines.map((l) => inlineText(parseInline(l))).join("\n"));
        break;
      }
      case "divider":
        htmlParts.push(
          `<hr style="border:none;border-top:1px solid ${design.cardBorderColor};margin:20px 0;">`,
        );
        textParts.push("————");
        break;
      case "button":
        htmlParts.push(buttonHtml(block.label, block.href, design));
        textParts.push(`${block.label}: ${block.href}`);
        break;
      case "image":
        htmlParts.push(
          `<p style="margin:0 0 16px;text-align:center;"><img src="${escapeHtml(block.href)}" alt="${escapeHtml(block.alt)}" style="max-width:100%;max-height:280px;border-radius:8px;" /></p>`,
        );
        // The text twin carries the alt only — a raw CDN URL is noise in a
        // plain-text email; an image with no alt simply disappears there.
        if (block.alt) textParts.push(block.alt);
        break;
      case "cta":
        if (ctaUrl) {
          htmlParts.push(buttonHtml(ctaLabel, ctaUrl, design));
          textParts.push(`${ctaLabel}: ${ctaUrl}`);
          ctaRendered = true;
        }
        // No cta_url: the slot disappears (v1.16.0 text-twin behavior).
        break;
    }
  }

  // A template with a default action but no {cta} slot appends its button —
  // the pre-1.17.0 contract (card_expiring, threeds_action rely on it).
  if (ctaUrl && !ctaRendered && !raw.includes("{cta}")) {
    htmlParts.push(buttonHtml(ctaLabel, ctaUrl, design));
    textParts.push(`${ctaLabel}: ${ctaUrl}`);
  }

  return {
    html: htmlParts.join("\n"),
    text: textParts.join("\n\n").trim(),
  };
}

// ── Shell ────────────────────────────────────────────────────────────────────

/** Wraps a formatted body fragment in the branded outer table shell. */
export function renderEmailShell(bodyHtml: string, raw?: EmailDesign): string {
  const design = raw ?? DEFAULT_EMAIL_DESIGN;
  const font = FONT_STACKS[design.fontFamily];

  let header = "";
  if (design.headerStyle === "logo" && design.logoUrl && isSafeHref(design.logoUrl)) {
    header = `<tr>
            <td align="center" style="padding:8px 0 28px;"><img src="${escapeHtml(design.logoUrl)}" width="${design.logoWidth}" alt="${escapeHtml(design.wordmark)}" style="display:block;max-width:100%;height:auto;border:0;"></td>
          </tr>`;
  } else if (design.headerStyle !== "none" && design.wordmark) {
    header = `<tr>
            <td align="center" style="padding:8px 0 28px;font-family:${font};font-size:22px;letter-spacing:0.35em;color:${design.textColor};">${escapeHtml(design.wordmark)}</td>
          </tr>`;
  }

  const footerLines = [design.footerText, design.footerNote]
    .filter((l) => l.trim() !== "")
    .map((l) => escapeHtml(l))
    .join("<br>");
  const footer = footerLines
    ? `<tr>
            <td align="center" style="padding:24px 8px 0;font-family:${font};font-size:12px;line-height:1.6;color:${design.mutedColor};">${footerLines}</td>
          </tr>`
    : "";

  return `<div style="margin:0;padding:0;background:${design.backgroundColor};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${design.backgroundColor};">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;">
          ${header}
          <tr>
            <td style="background:${design.cardBackground};border:1px solid ${design.cardBorderColor};border-radius:8px;padding:36px 40px;font-family:${font};font-size:16px;line-height:1.65;color:${design.textColor};">${bodyHtml}</td>
          </tr>
          ${footer}
        </table>
      </td>
    </tr>
  </table>
</div>`;
}
