import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Portal accessibility pass (v1.28.0, P5.3).
 *
 * Pins:
 *  - contrast math (known reference pairs) and every shell token pair ≥ AA
 *    4.5:1 — including the pre-fix values being BELOW it, so a revert fails;
 *  - :focus-visible outlines, the prefers-reduced-motion block, the skip
 *    link + focusable <main>, one <h1>, labelled nav landmark;
 *  - toast roles: status/aria-live=polite for confirmations, role=alert for
 *    refusals (TOAST_ALERT_KEYS + resolveToast stamps the tone);
 *  - the destructive Remove is an inline Keep / Remove confirm — no
 *    window.confirm anywhere in the shell script, and the route emits the
 *    data-cellexia-confirm-* hooks the script binds to;
 *  - progress bars in the routes carry role=progressbar + aria-value*;
 *  - the auditPortalShell() self-check reports all-green on the shipped shell.
 */

const src = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

import {
  PORTAL_CONTRAST_PAIRS,
  WCAG_AA_TEXT,
  auditPortalContrast,
  auditPortalShell,
  contrastRatio,
} from "~/lib/portal/a11y.server";
import {
  PORTAL_TOKENS,
  TOAST_ALERT_KEYS,
  TOAST_KEYS,
  portalPage,
  resolveToast,
  toastTone,
} from "~/lib/portal/layout.server";

describe("contrast math", () => {
  it("matches WCAG reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 1);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 1);
    expect(contrastRatio("#ffffff", "#ffffff")).toBe(1);
  });

  it("the pre-P5.3 tokens were below AA (the reason for the change)", () => {
    expect(contrastRatio("#8a837a", "#ffffff")).toBeLessThan(WCAG_AA_TEXT);
    expect(contrastRatio("#8a837a", "#f0eeea")).toBeLessThan(WCAG_AA_TEXT);
    expect(contrastRatio("#8a6d3b", "#f6efe2")).toBeLessThan(WCAG_AA_TEXT);
    expect(contrastRatio("#cfd7cd", "#5b7058")).toBeLessThan(WCAG_AA_TEXT);
  });

  it("every shipped token pair reaches AA 4.5:1", () => {
    expect(PORTAL_CONTRAST_PAIRS.length).toBeGreaterThanOrEqual(15);
    const failing = auditPortalContrast().filter((f) => !f.ok);
    expect(failing, failing.map((f) => `${f.check}: ${f.detail}`).join("\n")).toEqual([]);
    // Spot values so a silent token drift is visible in the diff.
    expect(contrastRatio(PORTAL_TOKENS.muted, PORTAL_TOKENS.card)).toBeGreaterThanOrEqual(5);
    expect(contrastRatio(PORTAL_TOKENS.amber, PORTAL_TOKENS.amberSoft)).toBeGreaterThanOrEqual(5);
  });

  it("the stylesheet interpolates the exported tokens (no stale hex literal for muted/amber)", () => {
    const html = portalPage({ locale: "en", title: "t", body: "" });
    expect(html).toContain(`--cxs-muted:${PORTAL_TOKENS.muted}`);
    expect(html).toContain(`--cxs-amber:${PORTAL_TOKENS.amber}`);
    expect(html).not.toContain("#8a837a");
    expect(html).not.toContain("#8a6d3b");
    expect(html).not.toContain("#cfd7cd");
  });
});

describe("shell markup + CSS", () => {
  const html = portalPage({
    locale: "en",
    title: "Your subscription",
    body: '<div class="cxs-card">x</div>',
    toast: { text: "Saved" },
  });

  it("focus-visible outlines cover buttons, links, inputs, selects, textareas and summaries", () => {
    expect(html).toMatch(
      /\.cxs-portal a:focus-visible,\.cxs-portal button:focus-visible,\.cxs-portal input:focus-visible,\.cxs-portal select:focus-visible,\.cxs-portal textarea:focus-visible,\.cxs-portal summary:focus-visible[^{]*\{outline:2px solid var\(--cxs-accent\);outline-offset:2px\}/,
    );
  });

  it("prefers-reduced-motion disables transitions and animations", () => {
    expect(html).toMatch(
      /@media \(prefers-reduced-motion:reduce\)\{\s*\.cxs-portal \*,\.cxs-portal \*::before,\.cxs-portal \*::after\{transition:none !important;animation:none !important/,
    );
  });

  it("skip link is the first focusable element and targets the focusable main", () => {
    const skipAt = html.indexOf('<a class="cxs-skip" href="#cxs-main">Skip to content</a>');
    expect(skipAt).toBeGreaterThan(0);
    // Before the nav and the header.
    expect(skipAt).toBeLessThan(html.indexOf('<nav class="cxs-nav"'));
    expect(html).toContain('<main id="cxs-main" tabindex="-1">');
    // Visually hidden until focused, then pinned on screen.
    expect(html).toMatch(/\.cxs-skip\{position:absolute;left:-9999px/);
    expect(html).toMatch(/\.cxs-skip:focus,\.cxs-skip:focus-visible\{position:fixed;left:16px;top:16px/);
  });

  it("renders exactly one h1 and a labelled nav landmark", () => {
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(html).toContain('<nav class="cxs-nav" aria-label="Portal navigation">');
  });

  it("primary buttons and nav links reserve ≥ 44px", () => {
    expect(html).toMatch(/\.cxs-btn\{[^}]*min-height:44px/);
    expect(html).toMatch(/\.cxs-btn--small\{[^}]*min-height:44px/);
    expect(html).toMatch(/\.cxs-stepper button\{[^}]*min-width:44px;min-height:44px/);
    expect(html).toMatch(/\.cxs-nav a\{[^}]*min-height:56px/);
  });

  it("no window.confirm — inline confirm hooks instead", () => {
    expect(html).not.toContain("window.confirm(");
    expect(html).toContain('[data-cellexia-confirm-arm]');
    expect(html).toContain('[data-cellexia-confirm-panel]');
    expect(html).toContain('[data-cellexia-confirm-keep]');
    // Panel styling exists and stays hidden until armed.
    expect(html).toMatch(/\.cxs-confirm\{display:flex/);
    expect(html).toMatch(/\.cxs-confirm\[hidden\]\{display:none\}/);
  });
});

describe("toast live regions", () => {
  it("confirmations are polite status regions; refusals are alerts", () => {
    const ok = portalPage({ locale: "en", title: "t", body: "", toast: { text: "Saved" } });
    expect(ok).toContain('<div class="cxs-toast" data-cellexia-toast role="status" aria-live="polite">Saved</div>');
    const bad = portalPage({
      locale: "en",
      title: "t",
      body: "",
      toast: { text: "Nope", tone: "alert" },
    });
    expect(bad).toContain('<div class="cxs-toast" data-cellexia-toast role="alert">Nope</div>');
  });

  it("every alert key is a real toast key and resolveToast stamps the tone", () => {
    for (const key of TOAST_ALERT_KEYS) expect(TOAST_KEYS.has(key)).toBe(true);
    expect(toastTone("error")).toBe("alert");
    expect(toastTone("locked")).toBe("alert");
    expect(toastTone("preparing")).toBe("alert");
    expect(toastTone("skipped")).toBe("status");
    expect(toastTone("support_sent")).toBe("status");
    const err = resolveToast(new Request("https://x.test/apps/cellexia-subs/?toast=error"), "en");
    expect(err?.toast.tone).toBe("alert");
    const fine = resolveToast(new Request("https://x.test/apps/cellexia-subs/?toast=paused"), "en");
    expect(fine?.toast.tone).toBe("status");
  });
});

describe("route markup contracts", () => {
  const detail = src("app/routes/proxy.subscription.$id.tsx");
  const index = src("app/routes/proxy._index.tsx");

  it("Remove is an inline Keep / Remove confirm in the items card", () => {
    expect(detail).toContain("data-cellexia-confirm-arm");
    expect(detail).toContain("data-cellexia-confirm-panel");
    expect(detail).toContain("data-cellexia-confirm-keep");
    expect(detail).toContain('"portal.items.remove_keep"');
    expect(detail).toContain('"portal.items.remove_go"');
    expect(detail).not.toContain('data-cellexia-confirm="');
    expect(detail).not.toContain("window.confirm(");
  });

  it("progress bars carry role=progressbar with aria-value* and a label", () => {
    // Milestone + rewards-unlock bars of the rewards strip (shared module
    // since v1.29.0 — the home page and the single-mode detail render it).
    const rewards = src("app/lib/portal/rewards-card.server.ts");
    expect(index).toContain('from "~/lib/portal/rewards-card.server"');
    const bars = rewards.match(/role="progressbar"[^>]*/g) ?? [];
    expect(bars).toHaveLength(2);
    for (const bar of bars) {
      expect(bar).toMatch(/aria-label="/);
      expect(bar).toMatch(/aria-valuemin="0"/);
      expect(bar).toMatch(/aria-valuemax="\$\{/);
      expect(bar).toMatch(/aria-valuenow="\$\{/);
    }
    // Welcome-period bar on the detail page.
    expect(detail).toMatch(
      /class="cxs-progress cxs-progress--welcome" role="progressbar" aria-label="\$\{escapeHtml\(t\(locale, "portal\.a11y\.progress_welcome"\)\)\}" aria-valuemin="0" aria-valuemax="\$\{lock\.lockDays\}" aria-valuenow="\$\{dayOfWindow\}" aria-valuetext="/,
    );
  });

  it("cancel-flow error banner is role=alert", () => {
    expect(src("app/lib/cancel/pages.server.ts")).toContain('class="cxs-error" role="alert"');
  });
});

describe("self-check", () => {
  it("auditPortalShell is all-green on the shipped shell", () => {
    const audit = auditPortalShell();
    const failed = audit.findings.filter((f) => !f.ok);
    expect(failed, failed.map((f) => `${f.check}: ${f.detail}`).join("\n")).toEqual([]);
    expect(audit.ok).toBe(true);
    expect(audit.findings.length).toBeGreaterThan(PORTAL_CONTRAST_PAIRS.length + 5);
  });
});
