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
        appId: "cellexia",
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
        appId: "cellexia",
      },
    });
    expect(cartSellingPlanId(html)).toBe(OUR_DEFAULT_PLAN_ID);
    expect(parseJsonIsland(html).initialPlan).toBe(OUR_DEFAULT_PLAN_ID);
    expectNoForeignTrace(html);
  });

  it("the legacy group-id OR is gone — a matching Liquid id alone renders nothing", async () => {
    /* The old comparison is deleted, not demoted: a group whose Liquid-visible
       id is named EXACTLY in groupIds no longer renders on its own. Ownership
       now requires a real plan id AND a matching appId together — a group-id
       match (even the exact opaque storefront id, hand-written into the
       metafield) proves neither, so it must not be enough by itself. */
    const html = await renderWidget({
      ...THREE_APPS,
      planGroups: {
        v: 1,
        groupIds: [storefrontGroupId(FIXTURE.groupId)],
        planIds: ["424242424242"], // names no plan anywhere
        appId: "cellexia",
      },
    });
    expect(rootTag(html)).toBeNull();
    expect(cartSellingPlanId(html)).toBeNull();
    expectNoForeignTrace(html);
  });

  it("VACUITY GUARD: this fixture CAN render a competitor's group", async () => {
    /* Every assertion above is a negative — "Joy is not on the page" — and a
       fixture whose foreign groups Liquid simply cannot render would satisfy
       all of them while pinning nothing. Allow-list JOY's group id AND Joy's
       plan id instead of ours and the client's reported symptom comes straight
       back: Joy's plan id in the cart mirror, Joy's 5% on the page. The
       allow-list is the only thing standing between that render and a shopper.

       planIds and appId are the fields that decide (the groupIds entry here
       is inert — it is Joy's ADMIN id, which matches no Liquid group id).
       The metafield is written by this app alone, and
       buildPlanGroupsValue()/publishOwnGroupsMetafield() only ever emit our
       own plan ids and our own app id, so reaching this render means forging
       BOTH load-bearing fields together — the honest statement of the
       residual. */
    const html = await renderWidget({
      ...THREE_APPS,
      planGroups: {
        v: 1,
        groupIds: [JOY_GROUP_ID],
        planIds: [JOY_PLAN_ID],
        appId: "joy-subscriptions",
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
        appId: "recharge",
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
      ["planIds empty", { v: 1, groupIds: [JOY_GROUP_ID], planIds: [] }],
      ["planIds absent", { v: 1, groupIds: [JOY_GROUP_ID] }],
      ["planIds null", { v: 1, groupIds: [JOY_GROUP_ID], planIds: null }],
      [
        // Even the one groupIds form the legacy OR could match — the exact
        // opaque storefront id — unlocks nothing without plan ids.
        "planIds empty, groupIds the exact opaque Liquid id",
        {
          v: 1,
          groupIds: [storefrontGroupId(FIXTURE.foreignGroupId)],
          planIds: [],
        },
      ],
      [
        "planIds empty, groupIds OUR admin id",
        { v: 1, groupIds: [String(FIXTURE.groupId)], planIds: [] },
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
        appId: "cellexia",
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
    // does not carry our group): "present", with its 3 plan ids counted.
    expect(attributeValue(marker, "data-cellexia-diag-allowlist")).toBe(
      "present",
    );
    expect(attributeValue(marker, "data-cellexia-diag-plan-count")).toBe("3");
    // Still invisible and inert.
    expect(visibleText(html)).toBe("");
    expectNoForeignTrace(html);
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
    // Joy's group AND our (unprovable) own group are both listed — the card
    // can say "a Cellexia-named group is here but no allow-list proves it".
    expect(attributeValue(marker, "data-cellexia-diag-group-count")).toBe("2");
    expect(
      decodeEntitiesOnce(
        attributeValue(marker, "data-cellexia-diag-groups") ?? "",
      ),
    ).toContain("cellexia:Cellexia Ritual");
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
        v: 1,
        groupIds: [String(FIXTURE.groupId)],
        planIds: OUR_PLAN_IDS,
        appId: "cellexia",
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
        v: 1,
        groupIds: [String(FIXTURE.groupId)],
        planIds: OUR_PLAN_IDS,
        appId: "cellexia",
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
        v: 1,
        groupIds: [String(FIXTURE.groupId)],
        planIds: OUR_PLAN_IDS,
        appId: "cellexia",
      },
      launchStatus: "live",
    });
    expect(cartSellingPlanId(html)).toBe(OUR_DEFAULT_PLAN_ID);
    expect(planIdsInMarkup(html)).toEqual([...OUR_PLAN_IDS].sort());
    expect(html).not.toContain("68811000019");
  });

  it("matches a real-length plan id exactly, and near misses not at all", async () => {
    const ours = OUR_DEFAULT_PLAN_ID;
    for (const entry of [
      ours.slice(0, -1), // a prefix of ours
      ours.slice(1), // a suffix of ours
      `${ours}0`, // an id ours is a prefix of
      ` ${ours}`, // whitespace is not equality
      OUR_PLAN_IDS.join(","), // a joined list is not a list
    ]) {
      const html = await renderWidget({
        otherGroups: [JOY_GROUP],
        planGroups: {
          v: 1,
          groupIds: [String(FIXTURE.groupId)],
          planIds: [entry],
          appId: "cellexia",
        },
        launchStatus: "live",
      });
      expect(rootTag(html), `entry ${JSON.stringify(entry)}`).toBeNull();
      expect(html, `entry ${JSON.stringify(entry)}`).not.toContain(JOY_PLAN_ID);
    }

    // The exact entry still renders: the loop above is not vacuous. ONE plan
    // id is enough to prove the group.
    const exact = await renderWidget({
      otherGroups: [JOY_GROUP],
      planGroups: {
        v: 1,
        groupIds: [String(FIXTURE.groupId)],
        planIds: [ours],
        appId: "cellexia",
      },
      launchStatus: "live",
    });
    expect(cartSellingPlanId(exact)).toBe(OUR_DEFAULT_PLAN_ID);
  });

  it("accepts plan ids in either JSON form (string or number)", async () => {
    for (const planIds of [
      [...OUR_PLAN_IDS],
      [...OUR_PLAN_IDS].map(Number),
    ] as const) {
      const html = await renderWidget({
        otherGroups: [JOY_GROUP],
        planGroups: {
          v: 1,
          groupIds: [String(FIXTURE.groupId)],
          planIds,
          appId: "cellexia",
        },
        launchStatus: "live",
      });
      expect(cartSellingPlanId(html), typeof planIds[0]).toBe(
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
        appId: "cellexia",
      },
      launchStatus: "live",
    });
    expect(cartSellingPlanId(html)).toBe(OUR_DEFAULT_PLAN_ID);
    expect(html).not.toContain(JOY_PLAN_ID);
  });

  it("groupIds is not consulted at all — the legacy field is decoration only", async () => {
    // Junk groupIds, a real plan id and the real appId: still renders. The
    // field is published for backward compatibility with the old metafield
    // shape but is not read by the ownership decision any more.
    const html = await renderWidget({
      otherGroups: [JOY_GROUP],
      planGroups: {
        v: 1,
        groupIds: ["not-even-numeric"],
        planIds: OUR_PLAN_IDS,
        appId: "cellexia",
      },
      launchStatus: "live",
    });
    expect(cartSellingPlanId(html)).toBe(OUR_DEFAULT_PLAN_ID);
    expect(html).not.toContain(JOY_PLAN_ID);
  });

  it("a correct plan id with the WRONG appId still renders nothing", async () => {
    // The two-factor guarantee this whole model exists for: a corrupted or
    // foreign appId must not be rescued by an otherwise-correct planIds list.
    const html = await renderWidget({
      otherGroups: [JOY_GROUP],
      planGroups: {
        v: 1,
        groupIds: [String(FIXTURE.groupId)],
        planIds: OUR_PLAN_IDS,
        appId: "another-subscription-app",
      },
      launchStatus: "live",
    });
    expect(rootTag(html)).toBeNull();
    expect(visibleText(html)).toBe("");
    expect(html).not.toContain(JOY_PLAN_ID);
  });

  it("the right appId with the WRONG plan ids still renders nothing", async () => {
    // The other half of the guarantee: appId alone cannot unlock a group
    // either. Both factors are mandatory, always.
    const html = await renderWidget({
      otherGroups: [JOY_GROUP],
      planGroups: {
        v: 1,
        groupIds: [String(FIXTURE.groupId)],
        planIds: [JOY_PLAN_ID],
        appId: "cellexia",
      },
      launchStatus: "live",
    });
    expect(rootTag(html)).toBeNull();
    expect(visibleText(html)).toBe("");
    expect(html).not.toContain(JOY_PLAN_ID);
  });

  it("an allow-list published before the appId fix fails closed until republished", async () => {
    // A metafield written by a pre-fix app version has planIds but no appId
    // at all. Must render nothing rather than fall back to the old (broken)
    // group-id check — the whole point of the fix is that path is gone.
    const html = await renderWidget({
      otherGroups: [JOY_GROUP],
      planGroups: {
        v: 1,
        groupIds: [String(FIXTURE.groupId)],
        planIds: OUR_PLAN_IDS,
        // appId omitted on purpose.
      },
      launchStatus: "live",
    });
    expect(rootTag(html)).toBeNull();
    expect(visibleText(html)).toBe("");
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
