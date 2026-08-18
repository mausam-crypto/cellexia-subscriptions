import { describe, expect, it } from "vitest";

/**
 * Email formatting pipeline (v1.17.0, app/lib/notifications/format.ts).
 *
 * Pinned here:
 *  - SAFETY: every text leaf is HTML-escaped (merchant copy and interpolated
 *    vars are untrusted); hrefs are protocol-allow-listed — javascript:/data:
 *    can never become a clickable link, in inline links or buttons.
 *  - The markdown-lite vocabulary renders: bold, italic, links, autolinked
 *    bare URLs, buttons, headings, lists, quotes, dividers, paragraphs.
 *  - {cta} semantics survive from v1.16.0: replaced by the default button
 *    (or removed without cta_url), appended when absent, inline occurrences
 *    never leak literal "{cta}" into a rendered email.
 *  - The plain-text twin strips markers and writes links as "label: url".
 *  - The default design reproduces the historical shell (wordmark, footer,
 *    colors), so a shop that never opens the Design tab keeps its emails.
 */

import {
  DEFAULT_EMAIL_DESIGN,
  formatEmailBody,
  isSafeHref,
  normalizeEmailDesign,
  renderEmailShell,
} from "~/lib/notifications/format";
import { renderEmail } from "~/lib/notifications/templates.server";

describe("href safety", () => {
  it("allows http, https and mailto only", () => {
    expect(isSafeHref("https://example.com/a")).toBe(true);
    expect(isSafeHref("http://example.com")).toBe(true);
    expect(isSafeHref("mailto:care@cellexia.com")).toBe(true);
    expect(isSafeHref("javascript:alert(1)")).toBe(false);
    expect(isSafeHref("data:text/html,<script>")).toBe(false);
    expect(isSafeHref("//evil.com")).toBe(false);
    expect(isSafeHref("../relative")).toBe(false);
  });

  it("renders an unsafe inline link as visible text, never an anchor", () => {
    const { html } = formatEmailBody("Click [here](javascript:alert(1)) now");
    expect(html).not.toContain("<a ");
    expect(html).toContain("[here](javascript:alert(1))");
  });

  it("renders an unsafe button as visible text, never an anchor", () => {
    const { html } = formatEmailBody("[button:Go](javascript:alert(1))");
    expect(html).not.toContain("<a ");
    expect(html).toContain("[button:Go](javascript:alert(1))");
  });
});

describe("escaping", () => {
  it("escapes HTML in body text", () => {
    const { html } = formatEmailBody('<img src=x onerror="alert(1)"> & <b>hi</b>');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&amp;");
  });

  it("escapes HTML inside bold/italic/link labels and list items", () => {
    const { html } = formatEmailBody(
      "**<u>b</u>** and *<i>i</i>*\n\n- <script>x</script>\n\n[<em>label</em>](https://example.com)",
    );
    expect(html).not.toContain("<u>");
    expect(html).not.toContain("<i>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<em>label</em>");
    expect(html).toContain("<strong>&lt;u&gt;b&lt;/u&gt;</strong>");
  });

  it("escapes quotes in hrefs so attributes cannot be broken out of", () => {
    const { html } = formatEmailBody(
      '[x](https://example.com/a"onmouseover="alert(1))',
    );
    expect(html).not.toContain('"onmouseover="');
  });
});

describe("markdown-lite rendering", () => {
  it("renders bold, italic, headings, lists, quotes and dividers", () => {
    const { html } = formatEmailBody(
      "# Big\n## Small\n\n**bold** and *italic*\n\n- one\n- two\n\n> quoted line\n\n---",
    );
    expect(html).toContain("font-size:20px");
    expect(html).toContain("font-size:17px");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<ul");
    expect(html).toContain("<li");
    expect(html).toContain("<blockquote");
    expect(html).toContain("<hr");
  });

  it("renders explicit links and autolinks bare URLs (trailing punctuation excluded)", () => {
    const { html, text } = formatEmailBody(
      "See [your account](https://example.com/account).\nOr go to https://example.com/portal.",
    );
    expect(html).toContain('href="https://example.com/account"');
    expect(html).toContain(">your account</a>");
    expect(html).toContain('href="https://example.com/portal"');
    // The sentence period stays outside the auto-linked URL.
    expect(html).not.toContain('href="https://example.com/portal."');
    expect(text).toContain("your account: https://example.com/account");
    expect(text).toContain("https://example.com/portal");
  });

  it("renders [button:Label](url) as a styled button in html and 'Label: url' in text", () => {
    const { html, text } = formatEmailBody(
      "[button:Manage subscription](https://example.com/account)",
    );
    expect(html).toContain('href="https://example.com/account"');
    expect(html).toContain(">Manage subscription</a>");
    expect(html).toContain(`background:${DEFAULT_EMAIL_DESIGN.buttonColor}`);
    expect(text).toBe("Manage subscription: https://example.com/account");
  });

  it("separates paragraphs on blank lines and keeps single newlines as breaks", () => {
    const { html } = formatEmailBody("line one\nline two\n\nsecond paragraph");
    expect(html).toContain("line one<br>line two");
    expect((html.match(/<p /g) ?? []).length).toBe(2);
  });

  it("keeps parenthesized URLs whole — explicit links, bare URLs and buttons", () => {
    const explicit = formatEmailBody(
      "[Read the policy](https://shop.example.com/pages/terms_(2026))",
    );
    expect(explicit.html).toContain(
      'href="https://shop.example.com/pages/terms_(2026)"',
    );
    expect(explicit.html).toContain(">Read the policy</a>");

    const bare = formatEmailBody(
      "Wiki: https://en.wikipedia.org/wiki/Serum_(blood) — enjoy.",
    );
    expect(bare.html).toContain(
      'href="https://en.wikipedia.org/wiki/Serum_(blood)"',
    );
    // A paren that belongs to the SENTENCE stays outside the link.
    const wrapped = formatEmailBody("(see https://example.com/a)");
    expect(wrapped.html).toContain('href="https://example.com/a"');
    expect(wrapped.html).not.toContain('href="https://example.com/a)"');

    const button = formatEmailBody(
      "[button:Terms](https://shop.example.com/terms_(2026))",
    );
    expect(button.html).toContain(
      'href="https://shop.example.com/terms_(2026)"',
    );
    expect(button.html).toContain(">Terms</a>");
  });

  it("spaced asterisks (math, footnotes) stay literal — never half-italicized", () => {
    const { html, text } = formatEmailBody(
      "Mix 2 * serum with 5 * drops daily. And 2 ** x ** y stays too.",
    );
    expect(html).not.toContain("<em>");
    expect(html).not.toContain("<strong>");
    expect(html).toContain("2 * serum with 5 * drops");
    expect(text).toContain("2 * serum with 5 * drops");
  });

  it("renders a pre-1.17.0 plain body unchanged in meaning (no markers, bare link lines become links)", () => {
    const body =
      "Hello,\n\nYour next order is scheduled for 12 Aug.\n\nSkip this order: https://magic/skip\n\nAnything else:\nhttps://portal";
    const { html, text } = formatEmailBody(body);
    expect(html).toContain("Hello,");
    expect(html).toContain('href="https://magic/skip"');
    expect(html).toContain('href="https://portal"');
    expect(text).toContain("Skip this order: https://magic/skip");
    expect(html).not.toMatch(/\{[a-z0-9_]+\}/i);
  });
});

describe("{cta} semantics", () => {
  const cta = { ctaUrl: "https://example.com/update-card", ctaLabel: "Update card" };

  it("replaces a standalone {cta} line with the default button", () => {
    const { html, text } = formatEmailBody("Fix it here:\n{cta}\nThanks!", cta);
    expect(html).toContain('href="https://example.com/update-card"');
    expect(html).toContain(">Update card</a>");
    expect(text).toContain("Update card: https://example.com/update-card");
    expect(html).not.toContain("{cta}");
  });

  it("renders an INLINE {cta} as the button too — never literal text", () => {
    const { html } = formatEmailBody("Fix it here {cta} right now", cta);
    expect(html).not.toContain("{cta}");
    expect(html).toContain(">Update card</a>");
  });

  it("removes {cta} entirely when no cta_url exists", () => {
    const { html, text } = formatEmailBody("Fix it here:\n{cta}\nThanks!");
    expect(html).not.toContain("{cta}");
    expect(text).not.toContain("{cta}");
  });

  it("appends the button when the body has no {cta} slot", () => {
    const { html, text } = formatEmailBody("Please update your card.", cta);
    expect(html).toContain(">Update card</a>");
    expect(text.endsWith("Update card: https://example.com/update-card")).toBe(true);
  });

  it("ignores an unsafe cta_url", () => {
    const { html } = formatEmailBody("Fix it:\n{cta}", {
      ctaUrl: "javascript:alert(1)",
      ctaLabel: "X",
    });
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("{cta}");
  });
});

describe("design (brand kit)", () => {
  it("normalizes garbage to the defaults", () => {
    const d = normalizeEmailDesign({
      headerStyle: "banner",
      buttonColor: "red",
      logoWidth: 9999,
      fontFamily: 42,
    });
    expect(d).toEqual(DEFAULT_EMAIL_DESIGN);
  });

  it("keeps valid custom values", () => {
    const d = normalizeEmailDesign({
      headerStyle: "logo",
      logoUrl: "https://cdn.example.com/logo.png",
      logoWidth: 200,
      buttonColor: "#123456",
      fontFamily: "sans",
    });
    expect(d.headerStyle).toBe("logo");
    expect(d.buttonColor).toBe("#123456");
    expect(d.logoWidth).toBe(200);
    expect(d.fontFamily).toBe("sans");
  });

  it("default shell reproduces the historical look (wordmark, footer, colors)", () => {
    const html = renderEmailShell("<p>body</p>");
    expect(html).toContain("C E L L E X I A");
    expect(html).toContain("Cellexia — skincare that keeps its promises.");
    expect(html).toContain(
      "You are receiving this email about your Cellexia subscription.",
    );
    expect(html).toContain("background:#faf8f5");
    expect(html).toContain("border:1px solid #ece7df");
    expect(html).toContain("Georgia,'Times New Roman',serif");
    expect(html).toContain("max-width:560px");
  });

  it("headerStyle none drops the header; empty footer drops the footer row", () => {
    const html = renderEmailShell("<p>x</p>", {
      ...DEFAULT_EMAIL_DESIGN,
      headerStyle: "none",
      footerText: "",
      footerNote: "",
    });
    expect(html).not.toContain("C E L L E X I A");
    expect(html).not.toContain("skincare that keeps its promises");
  });

  it("logo header renders an https image and escapes the URL", () => {
    const html = renderEmailShell("<p>x</p>", {
      ...DEFAULT_EMAIL_DESIGN,
      headerStyle: "logo",
      logoUrl: 'https://cdn.example.com/logo.png?a=1&b="2',
      logoWidth: 180,
    });
    expect(html).toContain("<img src=");
    expect(html).toContain('width="180"');
    expect(html).not.toContain('b="2');
  });

  it("brand colors flow into body links and buttons", () => {
    const design = {
      ...DEFAULT_EMAIL_DESIGN,
      linkColor: "#0000ee",
      buttonColor: "#ff0000",
      buttonTextColor: "#00ff00",
    };
    const { html } = formatEmailBody(
      "[go](https://example.com)\n\n[button:Do it](https://example.com)",
      { design },
    );
    expect(html).toContain("color:#0000ee");
    expect(html).toContain("background:#ff0000");
    expect(html).toContain("color:#00ff00");
  });
});

describe("renderEmail integration (design parameter)", () => {
  it("renders the built-in copy through the new pipeline with the default shell", () => {
    const rendered = renderEmail("upcoming_order", "en", {
      next_date: "12 Aug",
      items_summary: "1× Serum",
      total_estimate: "CHF 64.00",
      // v1.28.0: the reminder always supplies its card vars (P1.5) and the
      // edit cut-off line (P2.1).
      payment_line: "Payment method: Visa ····4242",
      card_expiry_warning: "",
      edit_cutoff_line: "You can make changes until 12 Aug, 00:00.",
      skip_url: "https://magic/skip",
      delay_3w_url: "https://magic/delay3w",
      portal_url: "https://portal",
    });
    expect(rendered.html).toContain("C E L L E X I A");
    expect(rendered.html).toContain('href="https://magic/skip"');
    expect(rendered.html).not.toMatch(/\{[a-z0-9_]+\}/i);
    expect(rendered.text).toContain("https://magic/skip");
  });

  it("applies a custom design to a rendered template", () => {
    const rendered = renderEmail(
      "upcoming_order",
      "en",
      { next_date: "12 Aug", portal_url: "https://portal" },
      null,
      { ...DEFAULT_EMAIL_DESIGN, wordmark: "A C M E", buttonColor: "#222299" },
    );
    expect(rendered.html).toContain("A C M E");
    expect(rendered.html).not.toContain("C E L L E X I A");
  });

  it("merchant override bodies cannot inject HTML", () => {
    const rendered = renderEmail(
      "upcoming_order",
      "en",
      { portal_url: "https://portal" },
      { subject: "S", body: '<script>steal()</script> [x](javascript:alert(1))' },
    );
    expect(rendered.html).not.toContain("<script>");
    // The unsafe URL may appear as visible text, but never as a clickable href.
    expect(rendered.html).not.toContain('href="javascript:');
  });
});
