import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Concession ladder — "Switch to a smaller size" row (v1.28.0, Stage B
 * follow-up in Stage C).
 *
 * The Stage B ladder had only the quantity-based "Fewer units" row. This row
 * surfaces the engine's DOWNSIZE options (buildDownsizeOptions — the same
 * helper the cancel-flow card uses): the first strictly cheaper VARIANT /
 * PRODUCT option for the biggest recurring line, with the engine's concrete
 * newTotalCents, posting the existing `swap` api action.
 *
 * Pins (source contracts — the loader is not exported):
 *  - the row is gated by portalGrowth.concessionLadder AND
 *    cancelFlow.downsizeSaveEnabled AND active/unlocked/not-preparing;
 *  - it calls buildDownsizeOptions in a contained try/catch and skips
 *    QUANTITY options (already the "fewer" row);
 *  - it renders between the fewer row and the skip row, posts `swap` with
 *    lineId + variantId, and shows total vs current;
 *  - English copy exists and never mentions cancelling.
 */

const src = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

describe("smaller-size ladder row", () => {
  const detail = src("app/routes/proxy.subscription.$id.tsx");

  it("is gated like the cancel-flow DOWNSIZE save and computed through buildDownsizeOptions", () => {
    expect(detail).toContain('import { buildDownsizeOptions } from "~/lib/cancel/engine.server";');
    const block = detail.slice(
      detail.indexOf("let downsizeRow:"),
      detail.indexOf("const skipConsequenceDate ="),
    );
    expect(block).toContain("growth.concessionLadder &&");
    expect(block).toContain("cancelFlowSettings.downsizeSaveEnabled &&");
    expect(block).toContain("isActive &&");
    expect(block).toContain("!lock.locked &&");
    expect(block).toContain("!preparing");
    expect(block).toContain("await buildDownsizeOptions(shop.id, session.shop, contract, target)");
    expect(block).toContain('options.find((o) => o.mode !== "QUANTITY" && !!o.variantId)');
    expect(block).toContain("totalCents: pick.newTotalCents");
    // Contained: a Shopify hiccup drops the row, never the page.
    expect(block).toMatch(/try \{[\s\S]*catch \(err\) \{\s*console\.error\("\[portal\] downsize options failed"/);
  });

  it("renders after the fewer row, posts the swap action with the option's variant, shows total vs current", () => {
    expect(detail).toContain("${delayRow}${slowerRow}${fewerRow}${downsizeRow}${skipRow}");
    const row = detail.slice(
      detail.indexOf("const downsizeRow = ladder.downsize"),
      detail.indexOf("const skipConsequence = ["),
    );
    expect(row).toContain('class="cxs-ladder__downsize"');
    expect(row).toContain('action="${api(ctx, "swap")}"');
    expect(row).toContain('["lineId", ladder.downsize.lineId], ["variantId", ladder.downsize.variantId]');
    expect(row).toContain('"portal.ladder.downsize_title"');
    expect(row).toContain('"portal.ladder.downsize_sub"');
    expect(row).toContain('"portal.ladder.downsize_cta"');
    expect(row).toContain("total: formatMoney(ladder.downsize.totalCents");
    expect(row).toContain("current: formatMoney(ladder.downsize.currentCents");
    // The loader hands the row into scheduleHtml.
    expect(detail).toContain("downsize: downsizeRow,");
  });

  it("English copy exists and never mentions cancelling", () => {
    const en = JSON.parse(src("app/lib/i18n/locales/en.json")) as Record<string, string>;
    for (const k of ["portal.ladder.downsize_title", "portal.ladder.downsize_sub", "portal.ladder.downsize_cta"]) {
      expect(en[k]).toBeTruthy();
      expect(en[k].toLowerCase()).not.toMatch(/cancel/);
    }
    expect(en["portal.ladder.downsize_sub"]).toContain("{total}");
    expect(en["portal.ladder.downsize_sub"]).toContain("{current}");
    expect(en["portal.ladder.downsize_sub"]).toContain("{title}");
  });
});
