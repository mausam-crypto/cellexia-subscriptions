import { describe, expect, it } from "vitest";

import {
  FIXTURE,
  JOY_GROUP,
  renderEmbed,
  renderWidget,
  stripHtmlComments,
  visibleText,
} from "./harness";
import type { MakeContextOptions } from "./harness";

/**
 * THE WORST PRODUCT ON THE CLIENT'S STORE: one that carries the OTHER app's
 * selling plan group and none of ours.
 *
 * `two-apps.test.ts` covers the product where both apps have a group and ours
 * must win. This is the other half of the same rule — "our group or nothing" —
 * on the product where we have nothing to render. The buy box must emit no
 * subscription UI at all rather than fall back to the only group on the page,
 * which is a competitor's.
 *
 * Asserted on the SERVED BYTES, not on the parsed DOM: the requirement is that
 * a competitor's discount, cadence, group id and plan id never leave the
 * server, so anything hidden in an attribute, a JSON island or a data-* hook
 * counts as a leak just as much as visible text does.
 */

const JOY_GROUP_ID = String(FIXTURE.foreignGroupId);
const JOY_PLAN_ID = String(FIXTURE.foreignPlanIds.monthly);

/**
 * Joy's group on the product, ours nowhere — with the allow-list published and
 * naming our group, which this product does not carry.
 *
 * Typed as MakeContextOptions on purpose. These options reach the renderer
 * through a spread, and a spread does not get TypeScript's excess-property
 * check: a misspelt key would be silently dropped, the fixture would quietly
 * keep OUR group on the product, and every "renders nothing" assertion below
 * would be testing the wrong page.
 */
const FOREIGN_ONLY: MakeContextOptions = {
  foreignGroupOnly: true,
  otherGroups: [JOY_GROUP],
  launchStatus: "live",
};

const renderers = [
  ["section app block", renderWidget],
  ["app embed", renderEmbed],
] as const;

describe("a product carrying ONLY another app's group", () => {
  it.each(renderers)("renders no subscription UI at all (%s)", async (_label, render) => {
    const html = await render(FOREIGN_ONLY);

    // Nothing of Joy's, in any form the bytes could carry it.
    expect(html).not.toContain(JOY_GROUP_ID);
    expect(html).not.toContain(JOY_PLAN_ID);
    expect(html).not.toContain("60.80"); // Joy's 5% off CHF 64.00

    // None of our own widget chrome either — there is no group to render.
    expect(html).not.toContain("data-cellexia-buybox");
    expect(html).not.toContain("data-cellexia-data"); // the JSON island
    expect(html).not.toContain("data-cellexia-selling-plan"); // the cart mirror
    expect(html).not.toContain('name="selling_plan"');
    expect(html).not.toContain("data-cellexia-freq");
  });

  it.each(renderers)("puts nothing on the page a shopper can see (%s)", async (_label, render) => {
    const html = await render(FOREIGN_ONLY);
    expect(visibleText(html)).toBe("");
  });

  it.each(renderers)(
    "leaks nothing through the widget's own markup either (%s)",
    async (_label, render) => {
      const html = await render(FOREIGN_ONLY);
      // Everything the snippet itself emitted, comments (Shopify's app-snippet
      // markers) removed. The embed's page chrome — stylesheet link and the
      // two script tags it ships on every page — is not group-derived, so the
      // check is that nothing here is a rendered GROUP.
      const body = stripHtmlComments(html);
      expect(body).not.toMatch(/<(fieldset|select|option|label)\b/i);
      expect(body).not.toMatch(/\bcx-buybox__(card|price|chip|freq)\b/);
    },
  );

  /**
   * VACUITY GUARD. Every assertion above is a negative, and negatives pass
   * just as happily against a renderer that has been broken outright, a
   * fixture that stopped producing a group, or a harness that returns "".
   * Allow-list Joy's group id — the one thing that could ever make the widget
   * treat it as ours — and the SAME fixture must render Joy's group in full.
   * That is also the concrete demonstration of why the allow-list is the only
   * input trusted to choose a group.
   */
  it("VACUITY GUARD: this exact fixture DOES render that group once it is allow-listed", async () => {
    const html = await renderWidget({
      ...FOREIGN_ONLY,
      planGroups: { v: 1, groupIds: [JOY_GROUP_ID], planIds: [JOY_PLAN_ID] },
    });

    expect(html).toContain("data-cellexia-buybox");
    expect(html).toContain(JOY_PLAN_ID);
    expect(visibleText(html).length).toBeGreaterThan(0);
  });
});
