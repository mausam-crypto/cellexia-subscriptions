/**
 * [offers ↔ theme-ext] — settings-shape contract test.
 *
 * The admin "Settings (JSON)" editor (app.widgets.tsx) is pre-filled with
 * DEFAULT_WIDGET_SETTINGS and promises that overrides are "merged over the
 * brand-default copy" and rendered on the storefront. The storefront consumer
 * is the widget-config callback in
 * extensions/treatment-widgets/assets/cellexia-widgets.js, so every top-level
 * key of the TREATMENT_CHOICE default shape must be consumed there — this
 * test keeps the two sides from drifting apart again.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WIDGET_SETTINGS,
  mergeSettings,
} from "~/services/offers/widgets.server";

const assetPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../extensions/treatment-widgets/assets/cellexia-widgets.js",
);

describe("TREATMENT_CHOICE settings contract (admin defaults ↔ storefront JS)", () => {
  const src = readFileSync(assetPath, "utf8");

  it("consumes every top-level key of the canonical settings shape", () => {
    const keys = Object.keys(DEFAULT_WIDGET_SETTINGS.TREATMENT_CHOICE);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(
        new RegExp(`s\\.${key}\\b`).test(src),
        `cellexia-widgets.js must consume settings.${key}`,
      ).toBe(true);
    }
  });

  it("fills the documented {percent} and {weeks} placeholders client-side", () => {
    expect(src).toContain("{percent}");
    expect(src).toContain("{weeks}");
  });

  it("still honours the legacy heading/savingsCopy keys", () => {
    expect(src).toContain("s.heading");
    expect(src).toContain("s.savingsCopy");
  });

  it("resolved no-config settings carry NO committed key — Liquid enablement must survive the config fetch", () => {
    // Regression: a default committed:{enabled:false,...} shipped on every
    // widget-config response; the storefront's `cm.enabled === false` hide
    // switched every Liquid-enabled committed card off ~0.5s after first
    // paint and the default terms copy stomped the merchant's Liquid terms.
    // resolveWidget merges the (possibly empty) config over these defaults,
    // so the no-config resolved TREATMENT_CHOICE settings equal the defaults
    // — they must never introduce a committed block on their own.
    expect(Object.keys(DEFAULT_WIDGET_SETTINGS.TREATMENT_CHOICE)).not.toContain(
      "committed",
    );
    expect(
      mergeSettings(DEFAULT_WIDGET_SETTINGS.TREATMENT_CHOICE, {}),
    ).not.toHaveProperty("committed");
    // The storefront still consumes an EXPLICIT committed override (hide on
    // enabled:false, planIds pool replacement, terms fill)…
    expect(src).toMatch(/s\.committed/);
    expect(src).toMatch(/cm\.enabled === false/);
    // …and an explicit admin config flows through the generic merge untouched.
    const overridden = mergeSettings(DEFAULT_WIDGET_SETTINGS.TREATMENT_CHOICE, {
      committed: { enabled: true, position: 1 },
    }) as { committed?: { enabled?: boolean; position?: number } };
    expect(overridden.committed?.enabled).toBe(true);
    expect(overridden.committed?.position).toBe(1);
  });
});
