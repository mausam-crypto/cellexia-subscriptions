import { describe, expect, it } from "vitest";

import {
  FIXTURE,
  JOY_GROUP,
  attributeValue,
  attributeValues,
  parseJsonIsland,
  renderEmbed,
  renderWidget,
  rootTag,
  tagsWithAttribute,
  visibleText,
} from "./harness";
import type { MakeContextOptions, OtherAppGroupFixture } from "./harness";

/**
 * THE CLIENT'S STORE, RENDERED.
 *
 * cellexialabs.com does not run this app alone. It runs **Joy Subscriptions**,
 * which owns its own selling plan group (5% off) and puts it FIRST on the
 * product. Until v1.2.4 the buy box took `product.selling_plan_groups | first`
 * and then looked for a group whose NAME contained "cellexia" — so on that
 * product it resolved to JOY's group. The page advertised Joy's 5%, the
 * frequency selector offered Joy's cadences, and the hidden `selling_plan`
 * mirror (plus the AJAX cart injection that reads it) carried a JOY selling
 * plan id. Every subscription sold through our widget would have created a
 * contract belonging to another app, and editing our own plan in the admin
 * changed nothing on the page — because our plan was never on the page.
 *
 * `tests/liquid/render.test.ts` pins the ownership rules against the canned
 * two-group fixture. THIS file is the multi-app store itself: three
 * subscription apps on one product, ids chosen so that a sloppy comparison
 * (substring, prefix, "contains") picks a competitor, and a competitor group
 * that has copied our own name. Every assertion below is a concrete value —
 * a price, a plan id, a cadence — because "the widget rendered" was true
 * during the outage too.
 *
 * The prices are fixed by the fixture and worth memorising:
 *
 *   one-time                CHF 64.00
 *   OURS, first order       CHF 51.20   (20% off)
 *   OURS, then              CHF 57.60   (10% off)
 *   JOY                     CHF 60.80   ( 5% off)   ← the number the bug showed
 *   RECHARGE                CHF 54.40   (15% off)
 */

/** A third subscription app, so "ours" is never simply "the last one". */
const RECHARGE_GROUP: OtherAppGroupFixture = {
  id: 4412300000003,
  name: "Recharge Refills — 15% off",
  appId: "recharge",
  discount: 0.15,
  plans: [
    {
      id: 7771100002,
      name: "Delivery every 2 months",
      optionValue: "2 months",
    },
  ],
};

const JOY_PLAN_ID = String(FIXTURE.foreignPlanIds.monthly);
const JOY_GROUP_ID = String(FIXTURE.foreignGroupId);
const RECHARGE_PLAN_ID = String(RECHARGE_GROUP.plans![0].id);
const RECHARGE_GROUP_ID = String(RECHARGE_GROUP.id);
const OUR_PLAN_IDS = Object.values(FIXTURE.planIds).map(String);
/** The plan the widget preselects (recommended cadence = 8 weeks). */
const OUR_DEFAULT_PLAN_ID = String(FIXTURE.planIds.weeks8);

/** The client's PDP: Joy first, Recharge second, ours last. */
const THREE_APPS: MakeContextOptions = {
  otherGroups: [JOY_GROUP, RECHARGE_GROUP],
  launchStatus: "live",
};

/**
 * The selling plan id this markup would hand the cart: the hidden mirror the
 * theme's form posts, which `buy-box.js` and `buy-box-embed.js` also read when
 * they inject `selling_plan` into an AJAX `/cart/add`. This one value decides
 * WHICH APP owns the subscription that gets created.
 */
function cartSellingPlanId(html: string): string | null {
  const inputs = tagsWithAttribute(html, "data-cellexia-selling-plan");
  if (inputs.length !== 1) return null;
  return attributeValue(inputs[0], "value");
}

/** Every plan id reachable from the rendered markup (mirror + JSON island). */
function planIdsInMarkup(html: string): string[] {
  const found = new Set<string>();
  if (html.includes("data-cellexia-data")) {
    for (const variant of Object.values(parseJsonIsland(html).variants)) {
      for (const planId of Object.keys(variant.plans)) found.add(planId);
    }
  }
  for (const value of attributeValues(html, "value")) {
    if (/^\d{6,}$/.test(value)) found.add(value);
  }
  return [...found].sort();
}

/** Nothing of another app's may survive anywhere in the served bytes. */
function expectNoForeignTrace(html: string): void {
  for (const id of [
    JOY_PLAN_ID,
    JOY_GROUP_ID,
    RECHARGE_PLAN_ID,
    RECHARGE_GROUP_ID,
  ]) {
    expect(html, `foreign id ${id} reached the page`).not.toContain(id);
  }
  // Their money, too: Joy's 5% and Recharge's 15% off CHF 64.00.
  expect(html).not.toContain("60.80");
  expect(html).not.toContain("54.40");
  // And their cadences, which would betray a foreign frequency selector.
  const text = visibleText(html);
  expect(text).not.toContain("1 month");
  expect(text).not.toContain("2 months");
}

// ── a. Three apps on one product: OURS renders, theirs never does ────────────

describe("a product carrying three subscription apps' groups", () => {
  it("renders OUR group — our discount, our cadences, our plan id", async () => {
    const html = await renderWidget(THREE_APPS);

    // 1. The widget renders at all.
    const root = rootTag(html);
    expect(root).not.toBeNull();

    // 2. The price the page promises is OURS: 20% off, not Joy's 5%.
    expect(attributeValue(root!, "data-cellexia-money-onetime")).toBe("CHF 64.00");
    expect(attributeValue(root!, "data-cellexia-money-sub")).toBe("CHF 51.20");
    const island = parseJsonIsland(html);
    const small = island.variants[String(FIXTURE.variantIds.small)];
    expect(small.oneTime).toBe("CHF 64.00");
    expect(small.plans[OUR_DEFAULT_PLAN_ID].first).toBe("CHF 51.20");
    expect(small.plans[OUR_DEFAULT_PLAN_ID].then).toBe(
      "then CHF 57.60 every 8 weeks",
    );
    expect(small.plans[OUR_DEFAULT_PLAN_ID].save).toBe("Save 20%");

    // 3. The id that would reach the cart is one of OURS.
    expect(cartSellingPlanId(html)).toBe(OUR_DEFAULT_PLAN_ID);
    expect(OUR_PLAN_IDS).toContain(cartSellingPlanId(html));
    expect(island.initialPlan).toBe(OUR_DEFAULT_PLAN_ID);

    // 4. Every plan the shopper can switch to is ours as well — the selector
    //    is built from OUR group, not from the union of everything on the
    //    product.
    expect(planIdsInMarkup(html)).toEqual([...OUR_PLAN_IDS].sort());
    expect(Object.keys(small.plans).sort()).toEqual([...OUR_PLAN_IDS].sort());
    expect(visibleText(html)).toContain("8 weeks");

    // 5. Nothing of Joy's or Recharge's is anywhere in the bytes.
    expectNoForeignTrace(html);
  });

  it("VACUITY GUARD: this fixture CAN render a competitor's group", async () => {
    /* Every assertion above is a negative — "Joy is not on the page" — and a
       fixture whose foreign groups Liquid simply cannot render would satisfy
       all of them while pinning nothing. Allow-list JOY's group id AND Joy's
       plan id instead of ours and the client's reported symptom comes straight
       back: Joy's plan id in the cart mirror, Joy's 5% on the page. The
       allow-list is the only thing standing between that render and a shopper.

       Both fields have to be forged for this to render at all — naming only
       the group is refused, and so is an allow-list with no plan ids — which
       is exactly the bar the two mandatory factors are there to set. */
    const html = await renderWidget({
      ...THREE_APPS,
      planGroups: { v: 1, groupIds: [JOY_GROUP_ID], planIds: [JOY_PLAN_ID] },
    });
    expect(cartSellingPlanId(html)).toBe(JOY_PLAN_ID);
    expect(parseJsonIsland(html).initialPlan).toBe(JOY_PLAN_ID);
    expect(attributeValue(rootTag(html)!, "data-cellexia-money-sub")).toBe(
      "CHF 60.80",
    );
    expect(visibleText(html)).toContain("Save 5%");

    // …and the same for the third app, so "renders a foreign group" is not a
    // property of Joy's fixture in particular.
    const recharge = await renderWidget({
      ...THREE_APPS,
      planGroups: {
        v: 1,
        groupIds: [RECHARGE_GROUP_ID],
        planIds: [RECHARGE_PLAN_ID],
      },
    });
    expect(cartSellingPlanId(recharge)).toBe(RECHARGE_PLAN_ID);
    expect(attributeValue(rootTag(recharge)!, "data-cellexia-money-sub")).toBe(
      "CHF 54.40",
    );
  });

  it("REGRESSION: one forged field is not enough — no plan ids, no render", async () => {
    /* THE HOLE THIS PINS. `planIds` used to be a veto rather than a
       requirement: when it was absent or empty, a group-id match stood alone.
       That collapsed the two factors back into one in precisely the state this
       app emits itself — publishOwnGroupsMetafield() writes
       {"groupIds":[…],"planIds":[]} whenever refreshOwnPlanIdsFromShopify()
       cannot read the group back — so ONE corrupt or forged field put a
       competitor's group on the page in full: Joy's 5% in the price, Joy's
       selling plan id in the cart mirror and the JSON island, Joy's contract
       at the end of it.

       The guard is now symmetric with the group-id one: both fields must name
       the group before anything renders. Each case below is the vacuity guard
       above with exactly one field weakened, so a regression that restores the
       fallback fails here and nowhere else. */
    for (const [label, planGroups] of [
      ["planIds empty", { v: 1, groupIds: [JOY_GROUP_ID], planIds: [] }],
      ["planIds absent", { v: 1, groupIds: [JOY_GROUP_ID] }],
      ["planIds null", { v: 1, groupIds: [JOY_GROUP_ID], planIds: null }],
      [
        "planIds names OUR plans, groupIds names Joy's group",
        { v: 1, groupIds: [JOY_GROUP_ID], planIds: OUR_PLAN_IDS },
      ],
    ] as Array<[string, unknown]>) {
      const html = await renderWidget({ ...THREE_APPS, planGroups });
      expect(rootTag(html), label).toBeNull();
      expect(cartSellingPlanId(html), label).toBeNull();
      expect(planIdsInMarkup(html), label).toEqual([]);
      expect(visibleText(html), label).toBe("");
      expectNoForeignTrace(html);
    }

    // The same weakening applied to OUR OWN group id: an allow-list with no
    // plan ids unlocks nothing at all, ours included. Briefly absent beats
    // briefly wrong.
    const ours = await renderWidget({
      ...THREE_APPS,
      planGroups: { v: 1, groupIds: [String(FIXTURE.groupId)], planIds: [] },
    });
    expect(rootTag(ours)).toBeNull();
    expect(visibleText(ours)).toBe("");
    expectNoForeignTrace(ours);
  });

  it("does not care where our group sits in the list", async () => {
    // Ours first, the other two after: same render, byte for byte.
    const oursFirst = await renderWidget({
      ...THREE_APPS,
      otherGroupsPosition: "after",
    });
    const oursLast = await renderWidget(THREE_APPS);
    expect(oursFirst).toBe(oursLast);
    expect(cartSellingPlanId(oursFirst)).toBe(OUR_DEFAULT_PLAN_ID);
    expectNoForeignTrace(oursFirst);
  });

  it("renders ours through the app embed too (the client's install shape)", async () => {
    const html = await renderEmbed(THREE_APPS);
    expect(cartSellingPlanId(html)).toBe(OUR_DEFAULT_PLAN_ID);
    expect(parseJsonIsland(html).initialPlan).toBe(OUR_DEFAULT_PLAN_ID);
    expectNoForeignTrace(html);
  });
});

// ── b. Only another app's groups: render NOTHING ─────────────────────────────

describe("a product with no group of ours", () => {
  it("renders nothing at all when the allow-list names none of its groups", async () => {
    const html = await renderWidget({
      omitOwnGroup: true,
      otherGroups: [JOY_GROUP, RECHARGE_GROUP],
      launchStatus: "live",
    });

    // No widget, no JSON island, no hidden mirror — nothing a cart could read.
    expect(rootTag(html)).toBeNull();
    expect(html).not.toContain("data-cellexia-buybox");
    expect(html).not.toContain("data-cellexia-data");
    expect(html).not.toContain("data-cellexia-selling-plan");
    expect(cartSellingPlanId(html)).toBeNull();
    expect(html).not.toContain("<style");
    expect(planIdsInMarkup(html)).toEqual([]);
    expect(visibleText(html)).toBe("");
    expectNoForeignTrace(html);
  });

  it("renders nothing when our plan was synced to a DIFFERENT product", async () => {
    // The allow-list exists and is correct; this product simply is not in our
    // group. "The list is present but misses here" must fail closed exactly
    // like "the list is present and empty".
    const html = await renderWidget({
      omitOwnGroup: true,
      otherGroups: [JOY_GROUP],
      planGroups: {
        v: 1,
        groupIds: ["9999999999999"],
        planIds: OUR_PLAN_IDS,
      },
      launchStatus: "live",
    });
    expect(rootTag(html)).toBeNull();
    expect(visibleText(html)).toBe("");
    expect(html).not.toContain(JOY_PLAN_ID);
  });

  it("is byte-identical to a product with no subscription plans, bar the marker", async () => {
    const foreignOnly = await renderWidget({
      omitOwnGroup: true,
      otherGroups: [JOY_GROUP],
      launchStatus: "live",
    });
    const noPlans = await renderWidget({ noSellingPlans: true, launchStatus: "live" });

    const marker =
      '<template class="cx-buybox-nogroup" data-cellexia-no-owned-group hidden style="display:none!important"></template>';
    expect(foreignOnly.replace(marker, "")).toBe(noPlans);
    // The marker is the admin-only diagnostic: empty, hidden, inert. The hint
    // text itself never reaches the storefront markup.
    expect(foreignOnly).not.toContain("Sync your Cellexia plan");
    expect(visibleText(foreignOnly)).toBe("");
  });
});

// ── c/d. Before the first plan sync: no allow-list metafield ─────────────────

describe("before the first plan sync (no allow-list published yet)", () => {
  it("renders NOTHING when several groups are on the product and none is named like ours", async () => {
    // Ambiguous. Guessing is what created the bug, so the widget stays dark
    // until the merchant syncs the plan and the allow-list appears.
    const html = await renderWidget({
      planGroups: null,
      groupName: "Ritual Club",
      otherGroups: [JOY_GROUP, RECHARGE_GROUP],
      launchStatus: "live",
    });
    expect(rootTag(html)).toBeNull();
    expect(visibleText(html)).toBe("");
    expect(planIdsInMarkup(html)).toEqual([]);
  });

  it("renders NOTHING for a lone group, whoever owns it and whatever it is called", async () => {
    // One group on the product is not evidence that the group is ours — not
    // even when it is literally named after us. Rendering it would mean
    // selling a plan we cannot prove is ours, and the id allow-list is the
    // only proof there is.
    for (const options of [
      { groupName: "Cellexia Subscribe & Save" }, // ours, named like us
      { groupName: "Ritual Club" }, // ours, named like nothing
      { omitOwnGroup: true, otherGroups: [JOY_GROUP] }, // Joy's alone
      {
        // Joy's alone, wearing our name — the case that used to sell Joy's
        // plan through our widget.
        omitOwnGroup: true,
        otherGroups: [{ ...JOY_GROUP, name: "Cellexia Subscribe & Save" }],
      },
    ] as MakeContextOptions[]) {
      const html = await renderWidget({
        ...options,
        planGroups: null,
        launchStatus: "live",
      });
      expect(rootTag(html), JSON.stringify(options)).toBeNull();
      expect(visibleText(html), JSON.stringify(options)).toBe("");
      expect(planIdsInMarkup(html), JSON.stringify(options)).toEqual([]);
    }
  });

  it("VACUITY GUARD: the same lone group renders once its id is allow-listed", async () => {
    const html = await renderWidget({
      groupName: "Cellexia Subscribe & Save",
      planGroups: { v: 1, groupIds: [String(FIXTURE.groupId)], planIds: OUR_PLAN_IDS },
      launchStatus: "live",
    });
    expect(rootTag(html)).not.toBeNull();
    expect(cartSellingPlanId(html)).toBe(OUR_DEFAULT_PLAN_ID);
    expect(
      parseJsonIsland(html).variants[String(FIXTURE.variantIds.small)].plans[
        OUR_DEFAULT_PLAN_ID
      ].first,
    ).toBe("CHF 51.20");
    // The ampersand survives exactly once — the group name is merchant text.
    expect(visibleText(html)).not.toContain("&amp;");
  });

  it("a competitor group named like ours renders NOTHING without an allow-list", async () => {
    /* This used to be a DOCUMENTED LIMITATION, and it was the last way a
       competitor's plan could still reach a shopper through our widget.

       With no allow-list there is nothing to compare ids against, so the
       fallback matched the group NAME — and a competitor's group carries a
       merchant-chosen name too. On a store called Cellexia Labs it is entirely
       plausible that the Joy group is called "Cellexia Subscribe & Save", and
       in that state the widget rendered JOY's plan: Joy's discount on the
       page, a Joy selling plan id in the cart, a Joy contract at the end of
       it.

       The fallback is now refused outright as soon as the product carries more
       than one selling plan group — the presence of a second group IS the
       evidence that names cannot be trusted here. Ids, and only ids, decide on
       such a product. */
    const html = await renderWidget({
      planGroups: null,
      groupName: "Ritual Club",
      otherGroups: [{ ...JOY_GROUP, name: "Cellexia Subscribe & Save" }],
      launchStatus: "live",
    });
    expect(rootTag(html)).toBeNull();
    expect(cartSellingPlanId(html)).toBeNull();
    expect(visibleText(html)).toBe("");
    expect(html).not.toContain(JOY_PLAN_ID);
    expect(planIdsInMarkup(html)).toEqual([]);
  });

  it("…and the same is true when the competitor is the only group named like ours", async () => {
    // Ours is not on this product at all; Joy's carries our token. The old
    // fallback would have sold Joy's plan through our widget.
    const html = await renderWidget({
      planGroups: null,
      omitOwnGroup: true,
      otherGroups: [
        { ...JOY_GROUP, name: "Cellexia Subscribe & Save" },
        RECHARGE_GROUP,
      ],
      launchStatus: "live",
    });
    expect(rootTag(html)).toBeNull();
    expect(visibleText(html)).toBe("");
    expect(html).not.toContain(JOY_PLAN_ID);
  });

  it("…and the published allow-list makes names irrelevant, in both directions", async () => {
    // The state every synced shop is in — and the answer to the limitation
    // above. A competitor group named exactly like ours is still not ours…
    const html = await renderWidget({
      groupName: "Ritual Club", // ours carries no token at all
      otherGroups: [{ ...JOY_GROUP, name: "Cellexia Subscribe & Save" }],
      launchStatus: "live",
    });
    expect(cartSellingPlanId(html)).toBe(OUR_DEFAULT_PLAN_ID);
    expect(html).not.toContain(JOY_PLAN_ID);

    // …and ours is still ours however it is named.
    expect(
      cartSellingPlanId(
        await renderWidget({ groupName: "Ritual Club", launchStatus: "live" }),
      ),
    ).toBe(OUR_DEFAULT_PLAN_ID);
  });

  it("treats an allow-list that is present but empty like a missing one: nothing", async () => {
    const html = await renderWidget({
      planGroups: { v: 1, groupIds: [], planIds: [] },
      launchStatus: "live",
    });
    expect(rootTag(html)).toBeNull();
    expect(cartSellingPlanId(html)).toBeNull();
    expect(visibleText(html)).toBe("");
  });
});

// ── e. Id comparison is exact string equality ────────────────────────────────

describe("allow-list ids are compared by exact equality", () => {
  /**
   * Group ids are decimal strings, and Liquid's `contains` works on strings.
   * A comparison written as `cx_allow_ids contains cx_g_id`, or against a
   * joined list, silently matches a PREFIX or a SUBSTRING — and on a two-app
   * product the competitor's group is the one that comes first, so the sloppy
   * comparison does not merely allow the wrong group, it PREFERS it.
   *
   * These ids are deliberately tiny so both directions of the containment are
   * exercised: "12" is a substring of "123", and "123" contains "12".
   */
  it("an allow-listed '12' does not match a competitor's group 123", async () => {
    const html = await renderWidget({
      ownGroupId: 12,
      otherGroups: [{ ...JOY_GROUP, id: 123 }], // FIRST on the product
      planGroups: { v: 1, groupIds: ["12"], planIds: OUR_PLAN_IDS },
      launchStatus: "live",
    });
    expect(cartSellingPlanId(html)).toBe(OUR_DEFAULT_PLAN_ID);
    expect(attributeValue(rootTag(html)!, "data-cellexia-money-sub")).toBe(
      "CHF 51.20",
    );
    expect(html).not.toContain(JOY_PLAN_ID);
  });

  it("an allow-listed '123' does not match a competitor's group 12", async () => {
    const html = await renderWidget({
      ownGroupId: 123,
      otherGroups: [{ ...JOY_GROUP, id: 12 }],
      planGroups: { v: 1, groupIds: ["123"], planIds: OUR_PLAN_IDS },
      launchStatus: "live",
    });
    expect(cartSellingPlanId(html)).toBe(OUR_DEFAULT_PLAN_ID);
    expect(html).not.toContain(JOY_PLAN_ID);
  });

  it("renders nothing when the allow-list entry merely resembles both ids", async () => {
    const html = await renderWidget({
      ownGroupId: 12,
      otherGroups: [{ ...JOY_GROUP, id: 123 }],
      planGroups: { v: 1, groupIds: ["1"], planIds: OUR_PLAN_IDS }, // a prefix of both
      launchStatus: "live",
    });
    expect(rootTag(html)).toBeNull();
    expect(visibleText(html)).toBe("");
    expect(html).not.toContain(JOY_PLAN_ID);
  });

  it("matches a real-length id exactly, and near misses not at all", async () => {
    const ours = String(FIXTURE.groupId);
    for (const entry of [
      ours.slice(0, -1), // a prefix of ours
      ours.slice(1), // a suffix of ours
      `${ours}0`, // an id ours is a prefix of
      ` ${ours}`, // whitespace is not equality
      `${ours},${JOY_GROUP_ID}`, // a joined list is not a list
    ]) {
      const html = await renderWidget({
        otherGroups: [JOY_GROUP],
        planGroups: { v: 1, groupIds: [entry], planIds: OUR_PLAN_IDS },
        launchStatus: "live",
      });
      expect(rootTag(html), `entry ${JSON.stringify(entry)}`).toBeNull();
      expect(html, `entry ${JSON.stringify(entry)}`).not.toContain(JOY_PLAN_ID);
    }

    // The exact entry still renders: the loop above is not vacuous.
    const exact = await renderWidget({
      otherGroups: [JOY_GROUP],
      planGroups: { v: 1, groupIds: [ours], planIds: OUR_PLAN_IDS },
      launchStatus: "live",
    });
    expect(cartSellingPlanId(exact)).toBe(OUR_DEFAULT_PLAN_ID);
  });

  it("accepts the id in either JSON form (string or number)", async () => {
    for (const entry of [String(FIXTURE.groupId), FIXTURE.groupId]) {
      const html = await renderWidget({
        otherGroups: [JOY_GROUP],
        planGroups: { v: 1, groupIds: [entry], planIds: OUR_PLAN_IDS },
        launchStatus: "live",
      });
      expect(cartSellingPlanId(html), typeof entry).toBe(OUR_DEFAULT_PLAN_ID);
    }
  });

  it("picks OUR group even when a competitor is allow-listed alongside it", async () => {
    // A stale allow-list (our group id plus one that was never ours) must not
    // become "first match on the product wins" — Joy is first on the product.
    const html = await renderWidget({
      otherGroups: [JOY_GROUP],
      planGroups: {
        v: 1,
        groupIds: [String(FIXTURE.groupId)],
        planIds: OUR_PLAN_IDS,
      },
      launchStatus: "live",
    });
    expect(cartSellingPlanId(html)).toBe(OUR_DEFAULT_PLAN_ID);
  });
});

// ── The launch gate is unchanged by any of this ──────────────────────────────

describe("ownership and the launch gate are independent", () => {
  it("stays gated in SETUP on a multi-app product", async () => {
    const html = await renderWidget({ ...THREE_APPS, launchStatus: "setup" });
    expect(rootTag(html)).toContain('data-cellexia-gated="true"');
    expect(rootTag(html)).toContain("hidden");
    expect(cartSellingPlanId(html)).toBe(OUR_DEFAULT_PLAN_ID);
    expectNoForeignTrace(html);
  });

  it("has nothing to gate when no group is ours", async () => {
    const html = await renderWidget({
      omitOwnGroup: true,
      otherGroups: [JOY_GROUP],
      launchStatus: "setup",
    });
    expect(html).not.toContain("data-cellexia-gated");
    expect(visibleText(html)).toBe("");
  });
});
