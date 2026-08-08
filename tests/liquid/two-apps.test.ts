import { describe, expect, it } from "vitest";

import {
  FIXTURE,
  JOY_GROUP,
  attributeValue,
  attributeValues,
  decodeEntitiesOnce,
  parseJsonIsland,
  renderEmbed,
  renderWidget,
  rootTag,
  storefrontGroupId,
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
 * THE SECOND OUTAGE THIS FILE NOW PINS (the id-space trap): storefront Liquid
 * exposes selling plan GROUP ids in a DIFFERENT id space than the Admin API —
 * `selling_plan_group.id` is an opaque storefront identifier, while the
 * allow-list metafield necessarily carries the numeric ADMIN ids the app
 * knows. A group-id comparison therefore matches NOTHING on a real
 * storefront, and an ownership rule that required it rendered nothing on a
 * product whose plan sync had SUCCEEDED (the merchant saw the "plans from
 * another app" admin card next to a correctly-synced plan). Selling PLAN ids
 * are numeric and identical in both APIs — they are what the cart's
 * `selling_plan` param carries — so PLAN-id intersection is the ownership
 * factor, and the harness models both id spaces so the group-id assumption
 * can never quietly return.
 *
 * THE HARDENING THIS FILE PINS SINCE v1.6.9 (two factors, exact sets): after
 * the id-space fix, a single field — one planIds entry — decided ownership
 * by itself; anything that could write a plan id into the metafield was
 * sufficient alone. Ownership now requires BOTH: (a) the group's
 * `selling_plan_group.app_id` equal to the allow-list's `appId` (this app's
 * own numeric App id, which the app stamps onto its own groups on sync —
 * Shopify leaves `app_id` nil otherwise; the harness models both the stamped
 * steady state and the unstamped legacy group; NOT secret — any app can copy
 * it onto its own groups, so it never decides alone); and (b) the group's
 * live plan set EXACTLY equal to one `planSets` entry — same members, same
 * count. Exact equality is what makes single-entry corruption harmless:
 * appending or altering one entry darkens the widget (fails closed) instead
 * of unlocking a competitor's single-plan group, and the legacy any-member
 * `planIds` field is storefront-inert. The never-firing legacy group-id OR
 * is REMOVED outright rather than left as attack surface.
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
/** Our own app id — the allow-list's second factor since v1.6.9. */
const OUR_APP_ID = FIXTURE.appId;
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
    storefrontGroupId(FIXTURE.foreignGroupId), // Joy's id as Liquid sees it
    RECHARGE_PLAN_ID,
    RECHARGE_GROUP_ID,
    storefrontGroupId(RECHARGE_GROUP.id),
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

  it("THE LIVE-STORE BUG, REGRESSION-PROOFED: the published numeric group ids match NO Liquid group — plan ids decide", async () => {
    /* Exactly what the app publishes after a successful sync: numeric ADMIN
       group ids in `groupIds`. Liquid's `selling_plan_group.id` lives in a
       different id space (opaque storefront identifiers — the harness now
       models that), so the group-id field can never pick a group. Ownership
       that REQUIRED a group-id match therefore rendered nothing on the
       merchant's correctly-synced product; ownership resting on the PLAN ids
       — numeric and identical in both APIs — renders ours. Revert the Liquid
       to group-id(-first) matching and this test fails. */
    const html = await renderWidget({
      ...THREE_APPS,
      planGroups: {
        v: 1,
        groupIds: [String(FIXTURE.groupId)], // admin-numeric: matches nothing in Liquid
        planIds: OUR_PLAN_IDS,
        planSets: [OUR_PLAN_IDS],
        appId: OUR_APP_ID,
      },
    });
    const root = rootTag(html);
    expect(root).not.toBeNull();
    expect(cartSellingPlanId(html)).toBe(OUR_DEFAULT_PLAN_ID);
    expect(attributeValue(root!, "data-cellexia-money-sub")).toBe("CHF 51.20");
    expectNoForeignTrace(html);
  });

  it("renders OURS even when groupIds matches nothing anywhere (pure plan-id path)", async () => {
    // Not even the admin id of a group on this product: a stale or foreign
    // groupIds field is simply inert while planIds names our plans.
    const html = await renderWidget({
      ...THREE_APPS,
      planGroups: {
        v: 1,
        groupIds: ["424242424242"],
        planIds: OUR_PLAN_IDS,
        planSets: [OUR_PLAN_IDS],
        appId: OUR_APP_ID,
      },
    });
    expect(cartSellingPlanId(html)).toBe(OUR_DEFAULT_PLAN_ID);
    expect(parseJsonIsland(html).initialPlan).toBe(OUR_DEFAULT_PLAN_ID);
    expectNoForeignTrace(html);
  });

  it("the legacy group-id OR is GONE — the strongest input it ever matched unlocks NOTHING", async () => {
    /* Until v1.6.9 the old comparison survived, demoted: a group whose
       Liquid-visible id was named EXACTLY in groupIds still rendered even
       when planIds named none of its plans. It could never fire in
       production (the app publishes admin-numeric ids, which cannot collide
       with the opaque storefront form), so it was pure attack surface for
       zero benefit — one hand-written metafield entry away from a render
       with no plan-id evidence at all. The branch is now REMOVED: the exact
       opaque id, with a correct appId beside it, renders nothing. */
    const html = await renderWidget({
      ...THREE_APPS,
      planGroups: {
        v: 1,
        groupIds: [storefrontGroupId(FIXTURE.groupId)],
        planIds: ["424242424242"], // names no plan anywhere
        appId: OUR_APP_ID,
      },
    });
    expect(rootTag(html)).toBeNull();
    expect(cartSellingPlanId(html)).toBeNull();
    expect(visibleText(html)).toBe("");
    expectNoForeignTrace(html);
  });

  it("VACUITY GUARD: this fixture CAN render a competitor's group", async () => {
    /* Every assertion above is a negative — "Joy is not on the page" — and a
       fixture whose foreign groups Liquid simply cannot render would satisfy
       all of them while pinning nothing. Forge the FULL allow-list — Joy's
       plan id AND Joy's app id — and the client's reported symptom comes
       straight back: Joy's plan id in the cart mirror, Joy's 5% on the page.
       The allow-list is the only thing standing between that render and a
       shopper.

       Since v1.6.9 reaching this render means forging BOTH load-bearing
       fields together (the groupIds entry is inert either way — it is Joy's
       ADMIN id, which matches no Liquid group id). The metafield is written
       by this app alone: buildPlanGroupsValue() only ever emits plan ids
       read off our own SellingPlanConfig rows, and the publish path writes
       only this app's own appId. A planIds-only forgery — the pre-v1.6.9
       single point of failure — no longer renders (pinned below in "the
       appId second factor"); this test is the honest statement of what a
       COMPLETE forgery still buys. */
    const html = await renderWidget({
      ...THREE_APPS,
      planGroups: {
        v: 1,
        groupIds: [JOY_GROUP_ID],
        planIds: [JOY_PLAN_ID],
        planSets: [[JOY_PLAN_ID]],
        appId: JOY_GROUP.appId,
      },
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
        planSets: [[RECHARGE_PLAN_ID]],
        appId: RECHARGE_GROUP.appId,
      },
    });
    expect(cartSellingPlanId(recharge)).toBe(RECHARGE_PLAN_ID);
    expect(attributeValue(rootTag(recharge)!, "data-cellexia-money-sub")).toBe(
      "CHF 54.40",
    );
  });

  it("REGRESSION: an allow-list with no plan ids unlocks nothing at all", async () => {
    /* THE HOLE THIS PINS. `planIds` used to be a veto rather than a
       requirement: when it was absent or empty, a group-id match stood alone.
       That collapsed ownership onto one field in precisely the state this
       app emits itself — publishOwnGroupsMetafield() writes
       {"groupIds":[…],"planIds":[]} whenever refreshOwnPlanIdsFromShopify()
       cannot read the group back. planIds is now the ownership factor AND a
       hard gate: without plan ids nothing renders, not even through the
       legacy group-id OR, and not even for our own group. Briefly absent
       beats briefly wrong. */
    for (const [label, planGroups] of [
      [
        "planIds empty",
        { v: 1, groupIds: [JOY_GROUP_ID], planIds: [], appId: OUR_APP_ID },
      ],
      ["planIds absent", { v: 1, groupIds: [JOY_GROUP_ID], appId: OUR_APP_ID }],
      [
        "planIds null",
        { v: 1, groupIds: [JOY_GROUP_ID], planIds: null, appId: OUR_APP_ID },
      ],
      [
        // Even the one groupIds form the removed legacy OR used to match —
        // the exact opaque storefront id — unlocks nothing without plan ids.
        "planIds empty, groupIds the exact opaque Liquid id",
        {
          v: 1,
          groupIds: [storefrontGroupId(FIXTURE.foreignGroupId)],
          planIds: [],
          appId: OUR_APP_ID,
        },
      ],
      [
        "planIds empty, groupIds OUR admin id",
        {
          v: 1,
          groupIds: [String(FIXTURE.groupId)],
          planIds: [],
          appId: OUR_APP_ID,
        },
      ],
    ] as Array<[string, unknown]>) {
      const html = await renderWidget({ ...THREE_APPS, planGroups });
      expect(rootTag(html), label).toBeNull();
      expect(cartSellingPlanId(html), label).toBeNull();
      expect(planIdsInMarkup(html), label).toEqual([]);
      expect(visibleText(html), label).toBe("");
      expectNoForeignTrace(html);
    }
  });

  it("a groupIds entry naming a competitor is inert — planIds still picks OURS", async () => {
    // The fourth old "one forged field" case, under the real id spaces: a
    // forged or corrupt groupIds naming Joy's ADMIN id matches no Liquid
    // group (different id space), and planIds names only plans WE created —
    // so the widget renders OURS, never Joy's, and never nothing.
    const html = await renderWidget({
      ...THREE_APPS,
      planGroups: {
        v: 1,
        groupIds: [JOY_GROUP_ID],
        planIds: OUR_PLAN_IDS,
        planSets: [OUR_PLAN_IDS],
        appId: OUR_APP_ID,
      },
    });
    expect(cartSellingPlanId(html)).toBe(OUR_DEFAULT_PLAN_ID);
    expect(parseJsonIsland(html).initialPlan).toBe(OUR_DEFAULT_PLAN_ID);
    expectNoForeignTrace(html);
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
        appId: OUR_APP_ID,
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
      /<template class="cx-buybox-nogroup" data-cellexia-no-owned-group hidden style="display:none!important"(?: data-cellexia-diag-[a-z-]+="[^"]*")*><\/template>/;
    expect(foreignOnly).toMatch(marker);
    expect(foreignOnly.replace(marker, "")).toBe(noPlans);
    // The marker is the admin-only diagnostic: empty, hidden, inert. The hint
    // text itself never reaches the storefront markup.
    expect(foreignOnly).not.toContain("Sync your Cellexia plan");
    expect(visibleText(foreignOnly)).toBe("");
  });
});

// ── The marker's diagnostic data attributes ──────────────────────────────────

describe("the no-owned-group marker's diagnostic attributes", () => {
  /**
   * The empty marker was correct and mute: the admin card could say THAT
   * nothing matched but never WHY. These data-cellexia-diag-* attributes make
   * the reason readable in a browser inspector (and available to the JS card):
   * which groups the product actually carries (app id + truncated name),
   * whether an allow-list was published at all, and how many plan ids it
   * holds. They live on a <template> that renders nothing, carries [hidden]
   * and an inline display:none — nothing here is shopper-perceivable.
   */
  const markerTag = (html: string): string => {
    const markers = tagsWithAttribute(html, "data-cellexia-no-owned-group");
    expect(markers).toHaveLength(1);
    return markers[0];
  };

  it("says WHY nothing matched: every group, the allow-list state, the plan-id count", async () => {
    const html = await renderWidget({
      omitOwnGroup: true,
      otherGroups: [JOY_GROUP, RECHARGE_GROUP],
      launchStatus: "live",
    });
    const marker = markerTag(html);
    expect(attributeValue(marker, "data-cellexia-diag-group-count")).toBe("2");
    expect(
      decodeEntitiesOnce(
        attributeValue(marker, "data-cellexia-diag-groups") ?? "",
      ),
    ).toBe(
      "joy-subscriptions:Joy Subscriptions — Save 5% ~ " +
        "recharge:Recharge Refills — 15% off",
    );
    // The allow-list WAS published (it names our plans; this product simply
    // does not carry our group): "present", with its 3 plan ids counted and
    // the appId it expects — next to the group app ids above, an unstamped
    // or mismatched group is readable straight off the inspector.
    expect(attributeValue(marker, "data-cellexia-diag-allowlist")).toBe(
      "present",
    );
    expect(attributeValue(marker, "data-cellexia-diag-plan-count")).toBe("3");
    expect(attributeValue(marker, "data-cellexia-diag-set-count")).toBe("1");
    expect(attributeValue(marker, "data-cellexia-diag-allow-app-id")).toBe(
      OUR_APP_ID,
    );
    // Still invisible and inert.
    expect(visibleText(html)).toBe("");
    expectNoForeignTrace(html);
  });

  it("reports a pre-appId allow-list (published before v1.6.9) as expecting 'none'", async () => {
    // The upgrade-window diagnostic: plans are named but the appId field is
    // missing, so the widget renders nothing — and says why.
    const html = await renderWidget({
      otherGroups: [JOY_GROUP],
      planGroups: {
        v: 1,
        groupIds: [String(FIXTURE.groupId)],
        planIds: OUR_PLAN_IDS,
      },
      launchStatus: "live",
    });
    const marker = markerTag(html);
    expect(attributeValue(marker, "data-cellexia-diag-allowlist")).toBe(
      "present",
    );
    expect(attributeValue(marker, "data-cellexia-diag-allow-app-id")).toBe(
      "none",
    );
    // plan-count 3 with set-count 0: the pre-v1.6.9 signature, readable
    // straight off the inspector.
    expect(attributeValue(marker, "data-cellexia-diag-plan-count")).toBe("3");
    expect(attributeValue(marker, "data-cellexia-diag-set-count")).toBe("0");
  });

  it("reports an absent allow-list (plans never synced) with a zero plan count", async () => {
    const html = await renderWidget({
      planGroups: null,
      otherGroups: [JOY_GROUP],
      launchStatus: "live",
    });
    const marker = markerTag(html);
    expect(attributeValue(marker, "data-cellexia-diag-allowlist")).toBe(
      "absent",
    );
    expect(attributeValue(marker, "data-cellexia-diag-plan-count")).toBe("0");
    expect(attributeValue(marker, "data-cellexia-diag-allow-app-id")).toBe(
      "none",
    );
    // Joy's group AND our (unprovable) own group are both listed — the card
    // can say "a Cellexia-named group is here but no allow-list proves it".
    expect(attributeValue(marker, "data-cellexia-diag-group-count")).toBe("2");
    expect(
      decodeEntitiesOnce(
        attributeValue(marker, "data-cellexia-diag-groups") ?? "",
      ),
    ).toContain(`${OUR_APP_ID}:Cellexia Ritual`);
  });

  it("truncates a long merchant group name to 40 characters", async () => {
    const html = await renderWidget({
      omitOwnGroup: true,
      otherGroups: [{ ...JOY_GROUP, name: "A".repeat(60) }],
      launchStatus: "live",
    });
    expect(
      decodeEntitiesOnce(
        attributeValue(markerTag(html), "data-cellexia-diag-groups") ?? "",
      ),
    ).toBe(`joy-subscriptions:${"A".repeat(40)}`);
  });

  it("escapes merchant text into the attribute exactly once", async () => {
    const html = await renderWidget({
      omitOwnGroup: true,
      otherGroups: [{ ...JOY_GROUP, name: 'Joy "Save & Smile" <b>' }],
      launchStatus: "live",
    });
    const raw =
      attributeValue(markerTag(html), "data-cellexia-diag-groups") ?? "";
    expect(raw).toContain("&quot;");
    expect(raw).not.toContain("&amp;amp;");
    expect(raw).not.toContain("<b>");
    expect(decodeEntitiesOnce(raw)).toBe(
      'joy-subscriptions:Joy "Save & Smile" <b>',
    );
    expect(visibleText(html)).toBe("");
  });

  it("carries no diagnostic attributes when a widget renders (nothing to explain)", async () => {
    const html = await renderWidget(THREE_APPS);
    expect(rootTag(html)).not.toBeNull();
    expect(html).not.toContain("data-cellexia-diag-");
    expect(html).not.toContain("data-cellexia-no-owned-group");
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
      planGroups: {
        v: 2,
        groupIds: [String(FIXTURE.groupId)],
        planIds: OUR_PLAN_IDS,
        planSets: [OUR_PLAN_IDS],
        appId: OUR_APP_ID,
      },
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

// ── e. Plan-id comparison is exact string equality ───────────────────────────

describe("allow-list plan ids are compared by exact equality", () => {
  /**
   * Plan ids are decimal strings, and Liquid's `contains` works on strings.
   * A comparison written against a JOINED list silently matches a PREFIX or a
   * SUBSTRING — and on a multi-app product the competitor's group is the one
   * that comes first, so the sloppy comparison does not merely allow the
   * wrong group, it PREFERS it. Now that plan ids decide ownership, the
   * partial-match hazard lives HERE; the ids below are chosen so both
   * directions of the containment are exercised.
   */
  it("a foreign plan id that is a SUBSTRING of ours never matches (Joy first)", async () => {
    // Joy's plan id is a 9-digit prefix of our weeks4 plan id 6881100001.
    // `planIds joined` contains it, so a contains-comparison would render
    // JOY — who sits first on the product. Exact equality skips Joy and
    // renders ours.
    const html = await renderWidget({
      otherGroups: [
        {
          ...JOY_GROUP,
          plans: [
            { id: 688110000, name: "Delivery every 1 month", optionValue: "1 month" },
          ],
        },
      ],
      planGroups: {
        v: 2,
        groupIds: [String(FIXTURE.groupId)],
        planIds: OUR_PLAN_IDS,
        planSets: [OUR_PLAN_IDS],
        appId: OUR_APP_ID,
      },
      launchStatus: "live",
    });
    expect(cartSellingPlanId(html)).toBe(OUR_DEFAULT_PLAN_ID);
    expect(attributeValue(rootTag(html)!, "data-cellexia-money-sub")).toBe(
      "CHF 51.20",
    );
    // Every plan reachable from the markup is exactly ours — the 9-digit
    // foreign id would be caught here if it leaked anywhere.
    expect(planIdsInMarkup(html)).toEqual([...OUR_PLAN_IDS].sort());
  });

  it("a foreign plan id that CONTAINS ours never matches either", async () => {
    // The other direction: Joy's plan id has our weeks4 id as a prefix.
    const html = await renderWidget({
      otherGroups: [
        {
          ...JOY_GROUP,
          plans: [
            { id: 68811000019, name: "Delivery every 1 month", optionValue: "1 month" },
          ],
        },
      ],
      planGroups: {
        v: 2,
        groupIds: [String(FIXTURE.groupId)],
        planIds: OUR_PLAN_IDS,
        planSets: [OUR_PLAN_IDS],
        appId: OUR_APP_ID,
      },
      launchStatus: "live",
    });
    expect(cartSellingPlanId(html)).toBe(OUR_DEFAULT_PLAN_ID);
    expect(planIdsInMarkup(html)).toEqual([...OUR_PLAN_IDS].sort());
    expect(html).not.toContain("68811000019");
  });

  it("matches the exact plan set, and near misses of one member not at all", async () => {
    /* One mutated MEMBER of an otherwise-correct set — the closest a
       corrupted publish can get — must fail the whole set (exact string
       equality per entry, exact count for the set). And a joined list is
       not a set. */
    const ours = OUR_DEFAULT_PLAN_ID;
    const others = OUR_PLAN_IDS.filter((id) => id !== ours);
    for (const entry of [
      ours.slice(0, -1), // a prefix of ours
      ours.slice(1), // a suffix of ours
      `${ours}0`, // an id ours is a prefix of
      ` ${ours}`, // whitespace is not equality
      OUR_PLAN_IDS.join(","), // a joined list is not a set member
    ]) {
      const html = await renderWidget({
        otherGroups: [JOY_GROUP],
        planGroups: {
          v: 2,
          groupIds: [String(FIXTURE.groupId)],
          planIds: [...others, entry],
          planSets: [[...others, entry]],
          appId: OUR_APP_ID,
        },
        launchStatus: "live",
      });
      expect(rootTag(html), `entry ${JSON.stringify(entry)}`).toBeNull();
      expect(html, `entry ${JSON.stringify(entry)}`).not.toContain(JOY_PLAN_ID);
    }

    // The exact set still renders: the loop above is not vacuous. Member
    // ORDER is irrelevant — it is a set, not a sequence.
    const exact = await renderWidget({
      otherGroups: [JOY_GROUP],
      planGroups: {
        v: 2,
        groupIds: [String(FIXTURE.groupId)],
        planIds: OUR_PLAN_IDS,
        planSets: [[...OUR_PLAN_IDS].reverse()],
        appId: OUR_APP_ID,
      },
      launchStatus: "live",
    });
    expect(cartSellingPlanId(exact)).toBe(OUR_DEFAULT_PLAN_ID);
  });

  it("a PARTIAL set — fewer entries than the group's plans — unlocks nothing", async () => {
    /* THE v1.6.9 SEMANTIC CHANGE, pinned on purpose: under the old
       any-member rule ONE allow-listed plan id proved a whole group, which
       is exactly what let a single corrupted entry render a competitor's
       single-plan group. Now the set must carry the SAME COUNT as the
       group's live plans: a one-entry set cannot unlock our three-plan
       group, however correct that entry is. */
    const html = await renderWidget({
      otherGroups: [JOY_GROUP],
      planGroups: {
        v: 2,
        groupIds: [String(FIXTURE.groupId)],
        planIds: [OUR_DEFAULT_PLAN_ID],
        planSets: [[OUR_DEFAULT_PLAN_ID]],
        appId: OUR_APP_ID,
      },
      launchStatus: "live",
    });
    expect(rootTag(html)).toBeNull();
    expect(html).not.toContain(JOY_PLAN_ID);

    // A SUPERSET fails the same way: count equality is two-sided.
    const superset = await renderWidget({
      otherGroups: [JOY_GROUP],
      planGroups: {
        v: 2,
        groupIds: [String(FIXTURE.groupId)],
        planIds: [...OUR_PLAN_IDS, "424242424242"],
        planSets: [[...OUR_PLAN_IDS, "424242424242"]],
        appId: OUR_APP_ID,
      },
      launchStatus: "live",
    });
    expect(rootTag(superset)).toBeNull();
    expect(superset).not.toContain(JOY_PLAN_ID);
  });

  it("accepts set members in either JSON form (string or number)", async () => {
    for (const set of [
      [...OUR_PLAN_IDS],
      [...OUR_PLAN_IDS].map(Number),
    ] as const) {
      const html = await renderWidget({
        otherGroups: [JOY_GROUP],
        planGroups: {
          v: 2,
          groupIds: [String(FIXTURE.groupId)],
          planIds: set,
          planSets: [set],
          appId: OUR_APP_ID,
        },
        launchStatus: "live",
      });
      expect(cartSellingPlanId(html), typeof set[0]).toBe(
        OUR_DEFAULT_PLAN_ID,
      );
    }
  });

  it("a stale groupIds entry naming a competitor cannot flip ownership", async () => {
    // A stale allow-list (our group's admin id plus one that was never ours)
    // must not become "first match on the product wins" — Joy is first on
    // the product, but neither admin-numeric entry matches any Liquid group,
    // and the plan ids name only ours.
    const html = await renderWidget({
      otherGroups: [JOY_GROUP],
      planGroups: {
        v: 1,
        groupIds: [JOY_GROUP_ID, String(FIXTURE.groupId)],
        planIds: OUR_PLAN_IDS,
        planSets: [OUR_PLAN_IDS],
        appId: OUR_APP_ID,
      },
      launchStatus: "live",
    });
    expect(cartSellingPlanId(html)).toBe(OUR_DEFAULT_PLAN_ID);
    expect(html).not.toContain(JOY_PLAN_ID);
  });
});

// ── f. The appId second factor (v1.6.9) ──────────────────────────────────────

describe("the appId second factor", () => {
  /**
   * WHY A SECOND FACTOR. After the id-space fix, ONE field decided ownership
   * by itself: any planIds entry — a bug, a bad migration, a forged request —
   * was sufficient alone to render whichever group carried that plan.
   * Ownership now also requires the group's `selling_plan_group.app_id` to
   * equal the allow-list's `appId`. The factor's value is not secrecy (any
   * app can stamp any string onto its OWN groups) but INDEPENDENCE: it lives
   * on the group, written through the Admin API with our token, while
   * planIds lives in a shop metafield. Corrupting one no longer unlocks
   * anything; both halves must agree with the same group, at once.
   *
   * Shopify does NOT auto-fill `app_id` — it is nil until the owning app
   * stamps it (SellingPlanGroupInput.appId on sync). Both degraded upgrade
   * states are pinned here to fail CLOSED: a pre-v1.6.9 metafield (no appId
   * field) and a pre-v1.6.9 group (no stamp).
   */
  it("the correct plan set with the WRONG appId renders nothing", async () => {
    const html = await renderWidget({
      ...THREE_APPS,
      planGroups: {
        v: 2,
        groupIds: [String(FIXTURE.groupId)],
        planIds: OUR_PLAN_IDS,
        planSets: [OUR_PLAN_IDS],
        appId: "999999999999",
      },
    });
    expect(rootTag(html)).toBeNull();
    expect(cartSellingPlanId(html)).toBeNull();
    expect(visibleText(html)).toBe("");
    expectNoForeignTrace(html);
  });

  it("the right appId with the WRONG plan sets renders nothing", async () => {
    const html = await renderWidget({
      ...THREE_APPS,
      planGroups: {
        v: 2,
        groupIds: [String(FIXTURE.groupId)],
        planIds: ["424242424242"],
        planSets: [["424242424242"]],
        appId: OUR_APP_ID,
      },
    });
    expect(rootTag(html)).toBeNull();
    expect(cartSellingPlanId(html)).toBeNull();
    expect(visibleText(html)).toBe("");
    expectNoForeignTrace(html);
  });

  it("a metafield published BEFORE the fix (no appId field) renders nothing until republished", async () => {
    // The intended fail-closed upgrade behaviour: "briefly absent beats
    // briefly wrong". The next plan sync republishes with the new field.
    const html = await renderWidget({
      ...THREE_APPS,
      planGroups: {
        v: 1,
        groupIds: [String(FIXTURE.groupId)],
        planIds: OUR_PLAN_IDS,
      },
    });
    expect(rootTag(html)).toBeNull();
    expect(cartSellingPlanId(html)).toBeNull();
    expect(visibleText(html)).toBe("");
    expectNoForeignTrace(html);
  });

  it("an UNSTAMPED group (synced before the fix) renders nothing, however correct the metafield", async () => {
    /* The other half of the upgrade window: the metafield already carries
       the new appId, but OUR group on Shopify was created before the app
       stamped app_id onto its groups — Liquid reads nil. The widget must
       stay dark until a sync (or the publish-path heal) stamps the group;
       rendering on the metafield alone would collapse ownership back onto
       one field. */
    const html = await renderWidget({
      ...THREE_APPS,
      ownGroupAppId: null,
    });
    expect(rootTag(html)).toBeNull();
    expect(cartSellingPlanId(html)).toBeNull();
    expect(visibleText(html)).toBe("");
    expectNoForeignTrace(html);

    // Vacuity guard: the SAME context renders once the group is stamped.
    const stamped = await renderWidget(THREE_APPS);
    expect(cartSellingPlanId(stamped)).toBe(OUR_DEFAULT_PLAN_ID);
  });

  it("THE HARDENING ITSELF: single-entry corruption never renders a foreign group — even one that copied our appId", async () => {
    /* The scenario the exact-set rule exists for. Joy's owner can stamp OUR
       public app id onto Joy's own group (nothing stops it — appId is not a
       secret), which neutralises the app-id factor for Joy entirely. Under
       an any-member plan rule, ONE corrupted planIds entry would then have
       rendered Joy's single-plan group through our buy box: the pre-v1.6.9
       single point of failure, resurrected. Under exact sets, both
       single-entry corruptions fail CLOSED instead. */
    const joyCopy: OtherAppGroupFixture = { ...JOY_GROUP, appId: OUR_APP_ID };

    // (a) A Joy plan id appended to the legacy planIds union: storefront-
    // inert since v1.6.9 — OUR group still renders, Joy never does.
    const legacyCorrupted = await renderWidget({
      otherGroups: [joyCopy],
      planGroups: {
        v: 2,
        groupIds: [String(FIXTURE.groupId)],
        planIds: [...OUR_PLAN_IDS, JOY_PLAN_ID],
        planSets: [OUR_PLAN_IDS],
        appId: OUR_APP_ID,
      },
      launchStatus: "live",
    });
    expect(cartSellingPlanId(legacyCorrupted)).toBe(OUR_DEFAULT_PLAN_ID);
    expect(legacyCorrupted).not.toContain(JOY_PLAN_ID);

    // (b) A Joy plan id appended to OUR set: the set no longer equals any
    // group's live plans — NOTHING renders, ours included. Briefly absent
    // beats briefly wrong.
    const setCorrupted = await renderWidget({
      otherGroups: [joyCopy],
      planGroups: {
        v: 2,
        groupIds: [String(FIXTURE.groupId)],
        planIds: OUR_PLAN_IDS,
        planSets: [[...OUR_PLAN_IDS, JOY_PLAN_ID]],
        appId: OUR_APP_ID,
      },
      launchStatus: "live",
    });
    expect(rootTag(setCorrupted)).toBeNull();
    expect(setCorrupted).not.toContain(JOY_PLAN_ID);
    expect(visibleText(setCorrupted)).toBe("");
  });

  it("a foreign group that copies OUR appId still cannot render without a full forged set", async () => {
    // Any app can stamp any string onto its own groups, including ours. The
    // copy buys nothing by itself: its plan set matches no published set,
    // and OUR group still matches first on both factors.
    const joyCopy: OtherAppGroupFixture = { ...JOY_GROUP, appId: OUR_APP_ID };
    const html = await renderWidget({
      otherGroups: [joyCopy],
      launchStatus: "live",
    });
    expect(cartSellingPlanId(html)).toBe(OUR_DEFAULT_PLAN_ID);
    expect(html).not.toContain(JOY_PLAN_ID);

    // …and with ours absent from the product, the copycat renders nothing.
    const alone = await renderWidget({
      omitOwnGroup: true,
      otherGroups: [joyCopy],
      launchStatus: "live",
    });
    expect(rootTag(alone)).toBeNull();
    expect(alone).not.toContain(JOY_PLAN_ID);
    expect(visibleText(alone)).toBe("");

    /* THE HONEST RESIDUAL, pinned: a wholesale forgery — an authored,
       well-formed set exactly matching the copycat's live plans, inside the
       one metafield only this app should write — still renders it. No
       storefront-side rule can distinguish that from ownership, because
       every input except app_id comes from the same metafield; what v1.6.9
       guarantees is that it takes the FULL coherent forgery, never one
       corrupted entry. */
    const fullForgery = await renderWidget({
      omitOwnGroup: true,
      otherGroups: [joyCopy],
      planGroups: {
        v: 2,
        groupIds: [JOY_GROUP_ID],
        planIds: [JOY_PLAN_ID],
        planSets: [[JOY_PLAN_ID]],
        appId: OUR_APP_ID,
      },
      launchStatus: "live",
    });
    expect(parseJsonIsland(fullForgery).initialPlan).toBe(JOY_PLAN_ID);
  });

  it("appId compares exactly, in either JSON form", async () => {
    // A JSON number is normalised like the ids (append '') and matches…
    const numeric = await renderWidget({
      ...THREE_APPS,
      planGroups: {
        v: 2,
        groupIds: [String(FIXTURE.groupId)],
        planIds: OUR_PLAN_IDS,
        planSets: [OUR_PLAN_IDS],
        appId: Number(OUR_APP_ID),
      },
    });
    expect(cartSellingPlanId(numeric)).toBe(OUR_DEFAULT_PLAN_ID);

    // …while near misses of every shape match nothing.
    for (const appId of [
      OUR_APP_ID.slice(0, -1),
      `${OUR_APP_ID}0`,
      ` ${OUR_APP_ID}`,
    ]) {
      const html = await renderWidget({
        ...THREE_APPS,
        planGroups: {
          v: 2,
          groupIds: [String(FIXTURE.groupId)],
          planIds: OUR_PLAN_IDS,
          planSets: [OUR_PLAN_IDS],
          appId,
        },
      });
      expect(rootTag(html), `appId ${JSON.stringify(appId)}`).toBeNull();
      expectNoForeignTrace(html);
    }
  });

  it("MUTATION KILLER: an EMPTY appId can never open the gate — nil-vs-nil is not a match", async () => {
    /* The `!= blank` half of the gate guard is security-load-bearing and
       this test exists to make it un-deletable: with the guard removed, a
       metafield lacking appId ('' after append) would equal every UNSTAMPED
       group's nil app_id ('' after append), and ownership would collapse
       back onto the plan sets alone. Both nil-nil directions are pinned
       with everything else valid, so ONLY the blank guard separates render
       from dark. */
    for (const planGroups of [
      // pre-v1.6.9 metafield: no appId field at all
      {
        v: 2,
        groupIds: [String(FIXTURE.groupId)],
        planIds: OUR_PLAN_IDS,
        planSets: [OUR_PLAN_IDS],
      },
      // appId present but empty / whitespace-only (blank in Liquid)
      {
        v: 2,
        groupIds: [String(FIXTURE.groupId)],
        planIds: OUR_PLAN_IDS,
        planSets: [OUR_PLAN_IDS],
        appId: "",
      },
      {
        v: 2,
        groupIds: [String(FIXTURE.groupId)],
        planIds: OUR_PLAN_IDS,
        planSets: [OUR_PLAN_IDS],
        appId: "   ",
      },
    ]) {
      // Our own group unstamped: nil app_id on the group side too.
      const own = await renderWidget({
        ...THREE_APPS,
        ownGroupAppId: null,
        planGroups,
      });
      expect(rootTag(own), JSON.stringify(planGroups)).toBeNull();
      expect(visibleText(own)).toBe("");

      // A foreign NIL-app_id group (most real apps never stamp) whose plan
      // set is forged into the metafield: the strongest thing the missing
      // guard would unlock.
      const foreign = await renderWidget({
        omitOwnGroup: true,
        otherGroups: [{ ...JOY_GROUP, appId: null }],
        planGroups: { ...planGroups, planSets: [[JOY_PLAN_ID]] },
        launchStatus: "live",
      });
      expect(rootTag(foreign), JSON.stringify(planGroups)).toBeNull();
      expect(foreign).not.toContain(JOY_PLAN_ID);
      expect(visibleText(foreign)).toBe("");
    }
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
