import { describe, expect, it, vi } from "vitest";

/**
 * Email preview + sample data (v1.17.0, preview.server.ts).
 *
 * Pinned here:
 *  - EVERY template renders from previewSampleVars with no unresolved
 *    {placeholder} left in subject, html or text — the sample set must keep
 *    covering every variable the built-in copy references, or the preview
 *    (and the test send) would show raw placeholders.
 *  - Every sample link points at example.com — a test email can be clicked
 *    without touching a real subscription, and no magic token is ever
 *    minted for a preview.
 *  - Draft subject/body flow through renderTemplatePreview, so the editor
 *    preview shows the unsaved draft.
 */

vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async () => ({})),
}));

import {
  previewSampleVars,
  renderTemplatePreview,
} from "~/lib/notifications/preview.server";
import { TEMPLATES, type TemplateKey } from "~/lib/notifications/templates.server";

const PLACEHOLDER = /\{[a-z0-9_]+\}/i;

describe("sample coverage", () => {
  for (const template of Object.keys(TEMPLATES) as TemplateKey[]) {
    it(`${template}: built-in copy renders with no unresolved placeholder`, async () => {
      const preview = await renderTemplatePreview({ template, locale: "en" });
      expect(preview.subject).not.toMatch(PLACEHOLDER);
      expect(preview.html).not.toMatch(PLACEHOLDER);
      expect(preview.text).not.toMatch(PLACEHOLDER);
      expect(preview.subject.length).toBeGreaterThan(0);
      expect(preview.html).toContain("<table");
    });
  }
});

describe("sample links", () => {
  it("every sample URL points at example.com", () => {
    const vars = previewSampleVars("upcoming_order");
    for (const [key, value] of Object.entries(vars)) {
      if (typeof value === "string" && value.startsWith("http")) {
        expect(value, key).toMatch(/^https:\/\/example\.com\//);
      }
    }
  });
});

describe("draft rendering", () => {
  it("renders the unsaved draft copy with vars substituted", async () => {
    const preview = await renderTemplatePreview({
      template: "upcoming_order",
      locale: "en",
      subject: "Ships {next_date}!",
      body: "**Heads-up** — skip here: {skip_url}",
    });
    expect(preview.subject).toBe("Ships 12 September 2026!");
    expect(preview.html).toContain("<strong>Heads-up</strong>");
    expect(preview.html).toContain('href="https://example.com/skip-next-order"');
  });

  it("empty draft falls back to the built-in copy", async () => {
    const builtIn = await renderTemplatePreview({ template: "upcoming_order" });
    const viaEmpty = await renderTemplatePreview({
      template: "upcoming_order",
      subject: "",
      body: "",
    });
    expect(viaEmpty.subject).toBe(builtIn.subject);
    expect(viaEmpty.html).toBe(builtIn.html);
  });
});
