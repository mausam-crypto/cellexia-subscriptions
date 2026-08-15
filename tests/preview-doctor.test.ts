import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

/**
 * PREVIEW DOCTOR (v1.6.7) — the blank-preview incident, made self-explaining.
 *
 * The defect this suite pins: the merchant created a plan, opened a
 * storefront preview, and NOTHING showed — no error anywhere. The widget
 * render chain has ~7 independent gates (deployed extension + enabled embed,
 * synced plan, group attached to the product, published allow-list, launch
 * gate, valid token + reachable proxy, JS mount) and every closed gate used
 * to produce the identical symptom: a blank product page. runPreviewDoctor
 * walks that chain against the live store and names the first closed gate.
 *
 * What is pinned here, fixture by fixture:
 *  - every step PASSes on the all-green world and FAILs on its own broken
 *    fixture (unsynced plan, product not in config, missing/empty-planIds
 *    metafield, proxy 404 / foreign body / unreachable, marker-less HTML);
 *  - the storefront fetch THROWING is WARN — inconclusive — never FAIL;
 *  - verdict/firstBlockedStep ordering follows chain order;
 *  - a throwing step is contained: the report always has all 7 steps;
 *  - the preview action (app.preview.tsx, intent "preview-storefront") gates
 *    on a BLOCKED verdict and returns the report instead of a URL, with
 *    openAnyway as the escape hatch;
 *  - the fail-open path is NOT silent: a doctor that itself throws still
 *    opens the preview, but the response carries a "diagnosis was skipped"
 *    toast and the audit event records doctorSkipped: true;
 *  - only a doctor-vetted open ticks "Storefront previewed": the un-vetted
 *    opens (openAnyway over a BLOCKED verdict, the fail-open path, and — since
 *    v1.25.0 — a READY verdict whose storefront_markup step is the
 *    market-hidden WARN, `code: "market_hidden"`) leave the checklist alone
 *    and record checklistPreviewedStorefront: false;
 *  - the market-hidden WARN is judged against the widgetMarkets SETTING: the
 *    merchant's own exclusion names the picker, a hidden page the setting
 *    allows names the drifted metafield + Re-sync, an unreadable setting
 *    stays neutral;
 *  - mutation check on the proxy-identity assertion: flip the probe to a
 *    foreign body, watch the step FAIL, restore it, watch it PASS again.
 *
 * Everything DB/Shopify/network-shaped is mocked (launch-mode.test.ts
 * pattern); ~/lib/ownership/ownership.server stays REAL so the doctor's id
 * handling (numericIdFromGid, parsePlanIdsJson — the v1.6.6 id-space model)
 * is exercised, not stubbed.
 */

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SHOP_DOMAIN = "cellexia.myshopify.com";
const SHOP = {
  id: "shop_1",
  domain: SHOP_DOMAIN,
  primaryDomain: "www.cellexialabs.com",
};

const PRODUCT_GID = "gid://shopify/Product/2001";
const GROUP_GID = "gid://shopify/SellingPlanGroup/111";
const PLAN_GIDS = [
  "gid://shopify/SellingPlan/901",
  "gid://shopify/SellingPlan/902",
];

/** A fully renderable config row, exactly as Prisma returns it. */
const SYNCED_CONFIG = {
  id: "cfg_1",
  name: "Serum Monthly",
  active: true,
  syncStatus: "SYNCED",
  syncError: null,
  shopifyGroupId: GROUP_GID,
  shopifyPlanIds: PLAN_GIDS,
  productIds: [PRODUCT_GID],
};

/** The published allow-list, all factors present (the only renderable shape). */
const ALLOW_LIST_VALUE = JSON.stringify({
  v: 2,
  groupIds: ["111"],
  planIds: ["901", "902"],
  planSets: [["901", "902"]],
  appId: "4477001",
});

const METAFIELD = {
  id: "gid://shopify/Metafield/1",
  namespace: "cellexia",
  key: "plan_groups",
  type: "json",
  value: ALLOW_LIST_VALUE,
};

const PRODUCT = {
  id: PRODUCT_GID,
  title: "Cellexia Serum",
  handle: "cellexia-serum",
  status: "ACTIVE",
  totalInventory: 12,
  featuredImageUrl: null,
};

const PRODUCT_URL = "https://www.cellexialabs.com/products/cellexia-serum";
const PROBE_URL =
  "https://www.cellexialabs.com/apps/cellexia-subs/preview/validate";

const SETUP_LAUNCH = {
  mode: "SETUP",
  wentLiveAt: null,
  confirmedThemeBlock: true,
  confirmedKlaviyo: false,
  previewedStorefront: false,
  previewedPortal: false,
};

/** Live product-page HTML with our (hidden, launch-gated) embed markup. */
const HTML_WITH_MARKER =
  "<html><body><main><div data-cellexia-embed hidden></div></main></body></html>";
/** An ordinary theme page — nothing of ours reached the storefront. */
const HTML_WITHOUT_MARKERS =
  "<html><body><main><form action=\"/cart/add\"><button>Add to cart</button></form></main></body></html>";

/** The chain, in the order the report must present it. */
const CHAIN = [
  "plan_config",
  "product_in_plan",
  "group_on_product",
  "allow_list",
  "proxy",
  "storefront_markup",
  "launch_mode",
] as const;

// ── Mock seams ───────────────────────────────────────────────────────────────

interface LoggedEvent {
  payload: Record<string, unknown>;
  [key: string]: unknown;
}

const mocks = vi.hoisted(() => ({
  configFindMany: vi.fn(async (): Promise<unknown[]> => []),
  requireShop: vi.fn(async (): Promise<unknown> => null),
  getPrimaryShop: vi.fn(async (): Promise<unknown> => null),
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
  authenticateAdmin: vi.fn(async (): Promise<unknown> => ({})),
  logEvent: vi.fn(async (_event: LoggedEvent): Promise<void> => {}),
  getShopMetafield: vi.fn(async (): Promise<unknown> => null),
  getProducts: vi.fn(async (): Promise<unknown[]> => []),
  findProductsMissingFromGroup: vi.fn(async (): Promise<string[]> => []),
  getCurrentAppId: vi.fn(async (): Promise<string> => "4477001"),
  getSellingPlanGroupOwnershipStates: vi.fn(
    async (): Promise<Map<string, { appId: string | null; planIds: string[] }>> =>
      new Map(),
  ),
  getLaunchState: vi.fn(async (): Promise<unknown> => ({})),
  probeProxyIdentity: vi.fn(async (): Promise<unknown> => ({})),
  buildStorefrontPreviewUrl: vi.fn(async (): Promise<string> => ""),
  markChecklist: vi.fn(async (): Promise<void> => {}),
  // Settings rows (the REAL getSetting runs over this): null → registry
  // default, i.e. widgetMarkets { mode: "all" }.
  settingFindUnique: vi.fn(async (): Promise<unknown> => null),
}));

/** This app's own numeric App id, as the mocked Admin API reports it. */
const OUR_APP_ID = "4477001";

vi.mock("~/db.server", () => ({
  default: {
    sellingPlanConfig: { findMany: mocks.configFindMany },
    setting: { findUnique: mocks.settingFindUnique },
  },
}));

vi.mock("~/shopify.server", () => ({
  adminClientForShop: mocks.adminClientForShop,
  authenticate: { admin: mocks.authenticateAdmin },
}));

vi.mock("~/lib/shop/install.server", () => ({
  requireShop: mocks.requireShop,
  getPrimaryShop: mocks.getPrimaryShop,
}));

vi.mock("~/lib/events/log.server", () => ({
  logEvent: mocks.logEvent,
}));

vi.mock("~/lib/graphql/metafields.server", () => ({
  getShopMetafield: mocks.getShopMetafield,
}));

vi.mock("~/lib/graphql/products.server", () => ({
  getProducts: mocks.getProducts,
}));

vi.mock("~/lib/graphql/sellingPlans.server", () => ({
  findProductsMissingFromGroup: mocks.findProductsMissingFromGroup,
  getCurrentAppId: mocks.getCurrentAppId,
  getSellingPlanGroupOwnershipStates: mocks.getSellingPlanGroupOwnershipStates,
}));

vi.mock("~/lib/launch/launch.server", () => ({
  getLaunchState: mocks.getLaunchState,
  probeProxyIdentity: mocks.probeProxyIdentity,
  buildStorefrontPreviewUrl: mocks.buildStorefrontPreviewUrl,
  markChecklist: mocks.markChecklist,
  getOverdueContracts: vi.fn(async () => []),
  goLive: vi.fn(),
  launchFlagDiverged: vi.fn(() => false),
  readLaunchMetafield: vi.fn(async () => null),
  revertToSetup: vi.fn(),
  syncLaunchMetafield: vi.fn(),
}));

// app.preview.tsx module-load surface that the action tests never exercise —
// inert stubs so importing the route never boots Shopify, Prisma or Klaviyo.
vi.mock("~/lib/portal/demo.server", () => ({ createDemoContract: vi.fn() }));
vi.mock("~/lib/magiclinks/builder.server", () => ({ buildMagicUrl: vi.fn() }));
vi.mock("~/lib/klaviyo/client.server", () => ({
  isKlaviyoConfigured: () => false,
}));
vi.mock("~/lib/graphql/index.server", () => ({
  getProducts: vi.fn(async () => []),
  getSubscribableProducts: vi.fn(async () => []),
  listMarkets: vi.fn(async () => []),
}));
vi.mock("~/lib/ownership/foreign-groups.server", () => ({
  scanForeignSellingPlanGroups: vi.fn(),
  toForeignGroupScanJson: vi.fn(),
}));

// Spy-mode mock: every export keeps its REAL implementation (the doctor
// tests above exercise the genuine runPreviewDoctor), but the action tests
// can make it throw once to pin the fail-open path — the route and this
// file share the same module instance.
vi.mock("~/lib/launch/doctor.server", { spy: true });

// UI packages the route imports at module scope: stubbed so the node test
// environment never loads Polaris/App Bridge/Remix-React. Only the action is
// under test; the component tree is never rendered.
vi.mock("@shopify/polaris", () => {
  const stub = (): null => null;
  return {
    Badge: stub,
    Banner: stub,
    BlockStack: stub,
    Box: stub,
    Button: stub,
    Card: stub,
    Checkbox: stub,
    ChoiceList: stub,
    Divider: stub,
    InlineGrid: stub,
    InlineStack: stub,
    Modal: Object.assign((): null => null, { Section: stub }),
    Page: stub,
    Select: stub,
    Tag: stub,
    Text: stub,
    TextField: stub,
  };
});
vi.mock("@shopify/app-bridge-react", () => ({
  useAppBridge: () => ({ toast: { show: (): void => {} } }),
}));
vi.mock("@remix-run/react", () => ({
  useActionData: () => undefined,
  useFetcher: () => ({}),
  useLoaderData: () => ({}),
  useNavigation: () => ({ state: "idle" }),
  useSubmit: () => (): void => {},
}));

import {
  runPreviewDoctor,
  type DoctorReport,
  type DoctorStep,
} from "~/lib/launch/doctor.server";
import { action as previewAction } from "~/routes/app.preview";

// ── Harness ──────────────────────────────────────────────────────────────────

/** A minimal Response-shaped object for the storefront HTML probe. */
function htmlResponse(
  html: string,
  { status = 200, url = PRODUCT_URL }: { status?: number; url?: string } = {},
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    text: async () => html,
  };
}

const fetchMock = vi.fn();

function step(report: DoctorReport, key: string): DoctorStep {
  const found = report.steps.find((s) => s.key === key);
  if (!found) throw new Error(`step ${key} missing from report`);
  return found;
}

/** All preview_doctor_run audit payloads logged so far. */
function doctorRunEvents(): Array<Record<string, unknown>> {
  return mocks.logEvent.mock.calls
    .map(([event]) => event.payload)
    .filter((payload) => payload.action === "preview_doctor_run");
}

beforeEach(() => {
  vi.clearAllMocks();
  // The all-green world: every gate on the chain is open. Each test breaks
  // exactly the gate it is about.
  mocks.requireShop.mockResolvedValue(SHOP);
  mocks.getPrimaryShop.mockResolvedValue(SHOP);
  mocks.adminClientForShop.mockResolvedValue({});
  mocks.authenticateAdmin.mockResolvedValue({ session: { shop: SHOP_DOMAIN } });
  mocks.configFindMany.mockResolvedValue([{ ...SYNCED_CONFIG }]);
  mocks.getShopMetafield.mockResolvedValue({ ...METAFIELD });
  mocks.getProducts.mockResolvedValue([{ ...PRODUCT }]);
  mocks.findProductsMissingFromGroup.mockResolvedValue([]);
  mocks.getCurrentAppId.mockResolvedValue(OUR_APP_ID);
  // The group on Shopify carries our stamp and exactly the recorded plans
  // (the post-v1.6.9 steady state).
  mocks.getSellingPlanGroupOwnershipStates.mockResolvedValue(
    new Map([[GROUP_GID, { appId: OUR_APP_ID, planIds: PLAN_GIDS }]]),
  );
  mocks.getLaunchState.mockResolvedValue({ ...SETUP_LAUNCH });
  mocks.probeProxyIdentity.mockResolvedValue({
    status: "OK",
    url: PROBE_URL,
    detail: null,
  });
  mocks.buildStorefrontPreviewUrl.mockResolvedValue(
    `${PRODUCT_URL}?cx_preview=signed-token`,
  );
  mocks.settingFindUnique.mockResolvedValue(null);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(htmlResponse(HTML_WITH_MARKER));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── The all-green chain ──────────────────────────────────────────────────────

describe("the all-green chain", () => {
  it("reports READY with all 7 steps PASS, in chain order", async () => {
    const report = await runPreviewDoctor(SHOP_DOMAIN, PRODUCT_GID);

    expect(report.verdict).toBe("READY");
    expect(report.firstBlockedStep).toBeUndefined();
    expect(report.steps.map((s) => s.key)).toEqual([...CHAIN]);
    for (const s of report.steps) {
      expect(s.status, `step ${s.key}`).toBe("PASS");
      expect(s.detail).not.toBe("");
    }
    // The end-to-end probe actually fetched the LIVE product page.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(PRODUCT_URL);
    // launch_mode is informational: SETUP is a PASS, phrased as hidden.
    expect(step(report, "launch_mode").detail).toContain("SETUP");
  });

  it("logs exactly one preview_doctor_run audit event with the verdict", async () => {
    await runPreviewDoctor(SHOP_DOMAIN, PRODUCT_GID);
    const runs = doctorRunEvents();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual({
      action: "preview_doctor_run",
      verdict: "READY",
      firstBlockedStep: null,
      productId: PRODUCT_GID,
    });
  });

  it("without a product, the product-scoped steps SKIP and SKIP never blocks", async () => {
    const report = await runPreviewDoctor(SHOP_DOMAIN);
    expect(step(report, "product_in_plan").status).toBe("SKIP");
    expect(step(report, "group_on_product").status).toBe("SKIP");
    expect(step(report, "storefront_markup").status).toBe("SKIP");
    expect(step(report, "plan_config").status).toBe("PASS");
    expect(step(report, "allow_list").status).toBe("PASS");
    expect(report.verdict).toBe("READY");
  });
});

// ── Step a: plan_config ──────────────────────────────────────────────────────

describe("plan_config — the plan itself", () => {
  it("FAILs on an unsynced plan, naming the sync status and error", async () => {
    mocks.configFindMany.mockResolvedValue([
      {
        ...SYNCED_CONFIG,
        syncStatus: "ATTACH_FAILED",
        syncError: "2 products missing from group",
        shopifyGroupId: null,
        shopifyPlanIds: [],
      },
    ]);
    const report = await runPreviewDoctor(SHOP_DOMAIN, PRODUCT_GID);
    const s = step(report, "plan_config");
    expect(s.status).toBe("FAIL");
    expect(s.detail).toContain("ATTACH_FAILED");
    expect(s.detail).toContain("2 products missing from group");
    expect(s.remediation).toContain("Sync to Shopify");
    expect(report.verdict).toBe("BLOCKED");
    expect(report.firstBlockedStep).toBe("plan_config");
  });

  it("FAILs when no plan exists at all", async () => {
    mocks.configFindMany.mockResolvedValue([]);
    const report = await runPreviewDoctor(SHOP_DOMAIN, PRODUCT_GID);
    const s = step(report, "plan_config");
    expect(s.status).toBe("FAIL");
    expect(s.detail).toContain("No subscription plan exists yet");
  });

  it("FAILs a half-synced plan (group recorded, zero plan ids)", async () => {
    mocks.configFindMany.mockResolvedValue([
      { ...SYNCED_CONFIG, shopifyPlanIds: [] },
    ]);
    const report = await runPreviewDoctor(SHOP_DOMAIN, PRODUCT_GID);
    const s = step(report, "plan_config");
    expect(s.status).toBe("FAIL");
    expect(s.detail).toContain("no selling plan ids were recorded");
  });
});

// ── Step b: product_in_plan ──────────────────────────────────────────────────

describe("product_in_plan — the diagnosed product is in the config", () => {
  it("FAILs when the product id is not in any plan's product list", async () => {
    const report = await runPreviewDoctor(
      SHOP_DOMAIN,
      "gid://shopify/Product/9999",
    );
    const s = step(report, "product_in_plan");
    expect(s.status).toBe("FAIL");
    expect(s.detail).toContain("not in any plan's product list");
    expect(s.remediation).toContain("add it, then re-sync");
    // plan_config PASSed, so the first blocked step is THIS one.
    expect(step(report, "plan_config").status).toBe("PASS");
    expect(report.firstBlockedStep).toBe("product_in_plan");
  });
});

// ── Step c: group_on_product ─────────────────────────────────────────────────

describe("group_on_product — Shopify's attachment answer", () => {
  it("FAILs when Shopify does not list our group on the product", async () => {
    mocks.findProductsMissingFromGroup.mockResolvedValue([PRODUCT_GID]);
    const report = await runPreviewDoctor(SHOP_DOMAIN, PRODUCT_GID);
    const s = step(report, "group_on_product");
    expect(s.status).toBe("FAIL");
    expect(s.detail).toContain("111"); // the numeric group id, named
    expect(s.remediation).toContain("Sync to Shopify");
    expect(report.firstBlockedStep).toBe("group_on_product");
    // The check asked Shopify about OUR group and THIS product (Admin GIDs
    // on both sides — one id space).
    expect(mocks.findProductsMissingFromGroup).toHaveBeenCalledWith(
      expect.anything(),
      GROUP_GID,
      [PRODUCT_GID],
    );
  });

  it("SKIPs (not vacuous PASS) when no group exists to check", async () => {
    mocks.configFindMany.mockResolvedValue([
      { ...SYNCED_CONFIG, syncStatus: "PENDING", shopifyGroupId: null },
    ]);
    const report = await runPreviewDoctor(SHOP_DOMAIN, PRODUCT_GID);
    expect(step(report, "group_on_product").status).toBe("SKIP");
    // Blocked further up the chain, where the actual problem is.
    expect(report.firstBlockedStep).toBe("plan_config");
  });
});

// ── Step d: allow_list (the v1.6.6 id-space model) ───────────────────────────

describe("allow_list — plan ids are the storefront's ownership factor", () => {
  it("FAILs when the metafield does not exist", async () => {
    mocks.getShopMetafield.mockResolvedValue(null);
    const report = await runPreviewDoctor(SHOP_DOMAIN, PRODUCT_GID);
    const s = step(report, "allow_list");
    expect(s.status).toBe("FAIL");
    expect(s.detail).toContain("never published");
    expect(report.firstBlockedStep).toBe("allow_list");
  });

  it("FAILs when the metafield holds junk instead of a JSON object", async () => {
    mocks.getShopMetafield.mockResolvedValue({
      ...METAFIELD,
      value: "not json at all",
    });
    const report = await runPreviewDoctor(SHOP_DOMAIN, PRODUCT_GID);
    expect(step(report, "allow_list").status).toBe("FAIL");
  });

  it("FAILs an allow-list with our group ids but an EMPTY planIds list", async () => {
    // The v1.6.6 lesson: storefront Liquid matches ownership on PLAN ids
    // (group ids live in a different id space there), and it requires BOTH
    // lists non-empty. Group ids alone render NOTHING — this must FAIL.
    mocks.getShopMetafield.mockResolvedValue({
      ...METAFIELD,
      value: JSON.stringify({ v: 1, groupIds: ["111"], planIds: [] }),
    });
    const report = await runPreviewDoctor(SHOP_DOMAIN, PRODUCT_GID);
    const s = step(report, "allow_list");
    expect(s.status).toBe("FAIL");
    expect(s.detail).toContain("planIds list is empty");
    expect(report.firstBlockedStep).toBe("allow_list");
  });

  it("FAILs when the published plan ids are all another app's", async () => {
    mocks.getShopMetafield.mockResolvedValue({
      ...METAFIELD,
      value: JSON.stringify({
        v: 1,
        groupIds: ["111"],
        planIds: ["777777", "888888"],
      }),
    });
    const report = await runPreviewDoctor(SHOP_DOMAIN, PRODUCT_GID);
    const s = step(report, "allow_list");
    expect(s.status).toBe("FAIL");
    expect(s.detail).toContain("none of our selling plan ids");
  });

  it("FAILs when our group id is missing from the published list", async () => {
    mocks.getShopMetafield.mockResolvedValue({
      ...METAFIELD,
      value: JSON.stringify({
        v: 1,
        groupIds: ["424242"],
        planIds: ["901", "902"],
        appId: OUR_APP_ID,
      }),
    });
    const report = await runPreviewDoctor(SHOP_DOMAIN, PRODUCT_GID);
    const s = step(report, "allow_list");
    expect(s.status).toBe("FAIL");
    expect(s.detail).toContain("111");
  });

  it("FAILs a metafield published before v1.6.9 — plan ids fine, appId missing", async () => {
    /* THE FALSE PASS THIS RELEASE CLOSES. The storefront requires the appId
       factor and renders nothing from a pre-upgrade metafield; a doctor
       checking only the plan ids would report a green chain over a dark
       storefront. */
    mocks.getShopMetafield.mockResolvedValue({
      ...METAFIELD,
      value: JSON.stringify({ v: 1, groupIds: ["111"], planIds: ["901", "902"] }),
    });
    const report = await runPreviewDoctor(SHOP_DOMAIN, PRODUCT_GID);
    const s = step(report, "allow_list");
    expect(s.status).toBe("FAIL");
    expect(s.detail).toContain("appId field is missing");
    expect(report.firstBlockedStep).toBe("allow_list");
  });

  it("FAILs a published appId that is not this app's installed id", async () => {
    mocks.getShopMetafield.mockResolvedValue({
      ...METAFIELD,
      value: JSON.stringify({
        v: 1,
        groupIds: ["111"],
        planIds: ["901", "902"],
        appId: "999999",
      }),
    });
    const report = await runPreviewDoctor(SHOP_DOMAIN, PRODUCT_GID);
    const s = step(report, "allow_list");
    expect(s.status).toBe("FAIL");
    expect(s.detail).toContain("999999");
    expect(s.detail).toContain(OUR_APP_ID);
  });

  it("FAILs when the GROUP on Shopify is not stamped with our app id", async () => {
    /* The other half of the upgrade window: metafield perfect, but the group
       predates the stamp (app_id nil in Liquid) — the storefront renders
       nothing from it, so the doctor must say so instead of passing. */
    mocks.getSellingPlanGroupOwnershipStates.mockResolvedValue(
      new Map([[GROUP_GID, { appId: null, planIds: PLAN_GIDS }]]),
    );
    const report = await runPreviewDoctor(SHOP_DOMAIN, PRODUCT_GID);
    const s = step(report, "allow_list");
    expect(s.status).toBe("FAIL");
    expect(s.detail).toContain("does not carry our app id");
    expect(s.remediation).toContain("Sync to Shopify");
  });

  it("FAILs when the group cannot be read back at all (not provably stamped)", async () => {
    mocks.getSellingPlanGroupOwnershipStates.mockResolvedValue(new Map());
    const report = await runPreviewDoctor(SHOP_DOMAIN, PRODUCT_GID);
    expect(step(report, "allow_list").status).toBe("FAIL");
  });

  it("FAILs a whitespace-padded appId instead of trimming it into a false PASS", async () => {
    /* The storefront compares EXACTLY (`| append: ''` never trims): appId
       " 4477001" is a dark widget on every product. A doctor that trims
       before comparing would call it a match — the green-dashboard/
       dark-storefront trap this step exists to prevent. */
    mocks.getShopMetafield.mockResolvedValue({
      ...METAFIELD,
      value: JSON.stringify({
        v: 2,
        groupIds: ["111"],
        planIds: ["901", "902"],
        planSets: [["901", "902"]],
        appId: ` ${OUR_APP_ID}`,
      }),
    });
    const report = await runPreviewDoctor(SHOP_DOMAIN, PRODUCT_GID);
    const s = step(report, "allow_list");
    expect(s.status).toBe("FAIL");
    expect(s.detail).toContain("whitespace");
    expect(report.firstBlockedStep).toBe("allow_list");
  });

  it("FAILs when no published set exactly covers the group's LIVE plans", async () => {
    // The storefront's exact-set factor: the group grew a plan (or the
    // metafield went stale) — any-member would still pass, exact equality
    // renders nothing, and the doctor must say so.
    mocks.getSellingPlanGroupOwnershipStates.mockResolvedValue(
      new Map([
        [
          GROUP_GID,
          {
            appId: OUR_APP_ID,
            planIds: [...PLAN_GIDS, "gid://shopify/SellingPlan/903"],
          },
        ],
      ]),
    );
    const report = await runPreviewDoctor(SHOP_DOMAIN, PRODUCT_GID);
    const s = step(report, "allow_list");
    expect(s.status).toBe("FAIL");
    expect(s.detail).toContain("matches no published planSets entry");
    expect(s.remediation).toContain("Sync to Shopify");
  });

  it("FAILs a metafield with appId but no planSets (partial upgrade state)", async () => {
    mocks.getShopMetafield.mockResolvedValue({
      ...METAFIELD,
      value: JSON.stringify({
        v: 1,
        groupIds: ["111"],
        planIds: ["901", "902"],
        appId: OUR_APP_ID,
      }),
    });
    const report = await runPreviewDoctor(SHOP_DOMAIN, PRODUCT_GID);
    const s = step(report, "allow_list");
    expect(s.status).toBe("FAIL");
    expect(s.detail).toContain("planSets");
  });

  it("PASSes only when appId, group stamp AND exact set coverage all hold — and says so", async () => {
    const report = await runPreviewDoctor(SHOP_DOMAIN, PRODUCT_GID);
    const s = step(report, "allow_list");
    expect(s.status).toBe("PASS");
    expect(s.detail).toContain(`appId matches this app (${OUR_APP_ID})`);
    expect(s.detail).toContain("stamped");
    expect(s.detail).toContain("exactly covered");
  });
});

// ── Step e: proxy ────────────────────────────────────────────────────────────

describe("proxy — the identity probe", () => {
  it("FAILs a 404 as 'no proxy registered' (the undeployed-app incident)", async () => {
    mocks.probeProxyIdentity.mockResolvedValue({
      status: "MISMATCH",
      url: PROBE_URL,
      detail: "HTTP 404",
    });
    const report = await runPreviewDoctor(SHOP_DOMAIN, PRODUCT_GID);
    const s = step(report, "proxy");
    expect(s.status).toBe("FAIL");
    expect(s.detail).toContain("HTTP 404");
    expect(s.detail).toContain("no app proxy registered");
    expect(s.remediation).toContain("npm run deploy");
    expect(report.firstBlockedStep).toBe("proxy");
  });

  it("FAILs an UNREACHABLE probe — the doctor is stricter than the checklist", async () => {
    // The launch checklist treats a network hiccup as a warning; the doctor
    // must not: this exact probe is what the visitor-side reveal runs, so
    // "unreachable now" blocks the preview now.
    mocks.probeProxyIdentity.mockResolvedValue({
      status: "UNREACHABLE",
      url: PROBE_URL,
      detail: "no answer within 5s",
    });
    const report = await runPreviewDoctor(SHOP_DOMAIN, PRODUCT_GID);
    const s = step(report, "proxy");
    expect(s.status).toBe("FAIL");
    expect(s.detail).toContain("could not be reached");
  });

  it("mutation check: a foreign body flips the step to FAIL — and back", async () => {
    // Prove the assertion really discriminates on response identity: mutate
    // the probe to a foreign body, watch FAIL; restore it, watch PASS.
    mocks.probeProxyIdentity.mockResolvedValue({
      status: "MISMATCH",
      url: PROBE_URL,
      detail: "unexpected response body",
    });
    let report = await runPreviewDoctor(SHOP_DOMAIN, PRODUCT_GID);
    let s = step(report, "proxy");
    expect(s.status).toBe("FAIL");
    expect(s.detail).toContain("something else owns the path");
    expect(report.verdict).toBe("BLOCKED");
    expect(report.firstBlockedStep).toBe("proxy");

    mocks.probeProxyIdentity.mockResolvedValue({
      status: "OK",
      url: PROBE_URL,
      detail: null,
    });
    report = await runPreviewDoctor(SHOP_DOMAIN, PRODUCT_GID);
    s = step(report, "proxy");
    expect(s.status).toBe("PASS");
    expect(s.detail).toContain("ok: true");
    expect(report.verdict).toBe("READY");
  });
});

// ── Step f: storefront_markup ────────────────────────────────────────────────

describe("storefront_markup — the end-to-end HTML probe", () => {
  it("PASSes on any of our markers, naming the one it found", async () => {
    fetchMock.mockResolvedValue(
      htmlResponse("<html><body><div class=\"cx-buybox\" hidden></div></body></html>"),
    );
    const report = await runPreviewDoctor(SHOP_DOMAIN, PRODUCT_GID);
    const s = step(report, "storefront_markup");
    expect(s.status).toBe("PASS");
    expect(s.detail).toContain("cx-buybox");
  });

  it("FAILs a page none of our markup reached (embed off / not deployed)", async () => {
    fetchMock.mockResolvedValue(htmlResponse(HTML_WITHOUT_MARKERS));
    const report = await runPreviewDoctor(SHOP_DOMAIN, PRODUCT_GID);
    const s = step(report, "storefront_markup");
    expect(s.status).toBe("FAIL");
    expect(s.detail).toContain("none of our markers");
    expect(s.remediation).toContain("App embeds");
    expect(s.remediation).toContain("npm run deploy");
    expect(report.firstBlockedStep).toBe("storefront_markup");
  });

  it("a THROWING fetch is WARN, not FAIL — and WARN never blocks", async () => {
    // The app host failing to reach the storefront proves nothing about the
    // theme. Inconclusive must not read as broken.
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const report = await runPreviewDoctor(SHOP_DOMAIN, PRODUCT_GID);
    const s = step(report, "storefront_markup");
    expect(s.status).toBe("WARN");
    expect(s.detail).toContain("inconclusive");
    expect(report.verdict).toBe("READY");
    expect(report.firstBlockedStep).toBeUndefined();
  });

  it("a password-page redirect is WARN (probe blind), not FAIL", async () => {
    fetchMock.mockResolvedValue(
      htmlResponse("<html>password</html>", {
        url: "https://www.cellexialabs.com/password",
      }),
    );
    const report = await runPreviewDoctor(SHOP_DOMAIN, PRODUCT_GID);
    expect(step(report, "storefront_markup").status).toBe("WARN");
    expect(report.verdict).toBe("READY");
  });

  it("FAILs a DRAFT product — its storefront page does not exist", async () => {
    mocks.getProducts.mockResolvedValue([{ ...PRODUCT, status: "DRAFT" }]);
    const report = await runPreviewDoctor(SHOP_DOMAIN, PRODUCT_GID);
    const s = step(report, "storefront_markup");
    expect(s.status).toBe("FAIL");
    expect(s.detail).toContain("DRAFT");
    expect(fetchMock).not.toHaveBeenCalled(); // no page to probe
  });

  // ── v1.25.0 market visibility ─────────────────────────────────────────────

  /**
   * The excluded-market page: cx-buybox-core renders ONLY the inert
   * market-hidden template — which still sits inside Shopify's app-snippet
   * comment wrapper, i.e. carries one of STOREFRONT_MARKERS. Without the
   * marker-first branch this would PASS as "markup found" over a page that
   * will never show the widget.
   */
  const HTML_MARKET_HIDDEN =
    '<html><body><!-- BEGIN app snippet: cx-buybox-core --><template class="cx-buybox-nogroup" data-cellexia-market-hidden hidden style="display:none!important" data-cellexia-diag-market="fr"></template><!-- END app snippet --></body></html>';

  /** The merchant's own choice: "Only these markets" without "fr". */
  const SETTING_ONLY_CH = { value: { mode: "selected", handles: ["ch"] } };

  it("WARNs (never FAILs, never blocks) a page hidden by the market setting, naming the market — when the SETTING really excludes it", async () => {
    mocks.settingFindUnique.mockResolvedValue(SETTING_ONLY_CH);
    fetchMock.mockResolvedValue(htmlResponse(HTML_MARKET_HIDDEN));
    const report = await runPreviewDoctor(SHOP_DOMAIN, PRODUCT_GID);
    const s = step(report, "storefront_markup");
    expect(s.status).toBe("WARN");
    expect(s.code).toBe("market_hidden");
    expect(s.detail).toContain("market setting");
    expect(s.detail).toContain("“fr”");
    expect(s.detail).toContain("www.cellexialabs.com");
    expect(s.detail).toContain("launch gate cannot be judged");
    expect(s.detail).toContain("Where the buy box shows");
    // The wording came from READING the setting, not from the marker alone.
    expect(mocks.settingFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopId_key: { shopId: SHOP.id, key: "widgetMarkets" } },
      }),
    );
    // WARN never blocks preview-storefront.
    expect(report.verdict).toBe("READY");
    expect(report.firstBlockedStep).toBeUndefined();
  });

  it("the market-hidden WARN names a blank handle honestly (storefront without a market)", async () => {
    mocks.settingFindUnique.mockResolvedValue(SETTING_ONLY_CH);
    fetchMock.mockResolvedValue(
      htmlResponse(HTML_MARKET_HIDDEN.replace('data-cellexia-diag-market="fr"', 'data-cellexia-diag-market=""')),
    );
    const report = await runPreviewDoctor(SHOP_DOMAIN, PRODUCT_GID);
    const s = step(report, "storefront_markup");
    expect(s.status).toBe("WARN");
    expect(s.code).toBe("market_hidden");
    expect(s.detail).toContain("no market handle");
    expect(s.detail).not.toContain("“”");
  });

  it("DRIFT: a market-hidden page while the setting ALLOWS that market is not blamed on the setting — it names the drifted metafield and Re-sync", async () => {
    // Setting = the default "all markets" (no row), yet the theme hides
    // "fr": the metafield the theme reads is not what the app published (a
    // hand edit, a racing save, a write that landed after a rollback). The
    // old wording told the merchant to "add" a market that is already
    // allowed — the wrong control.
    fetchMock.mockResolvedValue(htmlResponse(HTML_MARKET_HIDDEN));
    let report = await runPreviewDoctor(SHOP_DOMAIN, PRODUCT_GID);
    let s = step(report, "storefront_markup");
    expect(s.status).toBe("WARN");
    expect(s.code).toBe("market_hidden");
    expect(s.detail).toContain("“fr”");
    expect(s.detail).toContain("your setting allows it");
    expect(s.detail).toContain("all markets");
    expect(s.detail).toContain("drifted");
    expect(s.detail).not.toContain("add this market");
    expect(s.remediation).toContain("Where the buy box shows");
    expect(s.remediation).toContain("Re-sync");
    expect(report.verdict).toBe("READY");

    // Same with a selected list that DOES include the hidden market.
    mocks.settingFindUnique.mockResolvedValue({
      value: { mode: "selected", handles: ["fr", "ch"] },
    });
    report = await runPreviewDoctor(SHOP_DOMAIN, PRODUCT_GID);
    s = step(report, "storefront_markup");
    expect(s.status).toBe("WARN");
    expect(s.detail).toContain("only fr, ch");
    expect(s.detail).toContain("drifted");
  });

  it("an unreadable setting keeps the WARN neutral — it asserts nothing about the merchant's choice", async () => {
    mocks.settingFindUnique.mockRejectedValue(new Error("settings table locked"));
    fetchMock.mockResolvedValue(htmlResponse(HTML_MARKET_HIDDEN));
    const report = await runPreviewDoctor(SHOP_DOMAIN, PRODUCT_GID);
    const s = step(report, "storefront_markup");
    expect(s.status).toBe("WARN");
    expect(s.code).toBe("market_hidden");
    expect(s.detail).toContain("“fr”");
    expect(s.detail).toContain("could not be read");
    expect(s.detail).not.toContain("by your market setting");
    expect(s.detail).not.toContain("drifted");
    // Contained: the doctor did not crash and the verdict is unchanged.
    expect(report.steps).toHaveLength(CHAIN.length);
    expect(report.verdict).toBe("READY");
  });

  it("the market marker is checked BEFORE the generic markers — a page with both markup and no marker still PASSes", async () => {
    // Ordinary live page (no market marker): the untouched PASS path.
    fetchMock.mockResolvedValue(htmlResponse(HTML_WITH_MARKER));
    const report = await runPreviewDoctor(SHOP_DOMAIN, PRODUCT_GID);
    expect(step(report, "storefront_markup").status).toBe("PASS");
    expect(step(report, "storefront_markup").code).toBeUndefined();
  });
});

// ── Verdict and ordering ─────────────────────────────────────────────────────

describe("verdict and firstBlockedStep ordering", () => {
  it("with several closed gates, firstBlockedStep is the earliest in chain order", async () => {
    mocks.configFindMany.mockResolvedValue([
      { ...SYNCED_CONFIG, syncStatus: "PENDING" },
    ]);
    mocks.getShopMetafield.mockResolvedValue(null);
    mocks.probeProxyIdentity.mockResolvedValue({
      status: "MISMATCH",
      url: PROBE_URL,
      detail: "HTTP 404",
    });
    fetchMock.mockResolvedValue(htmlResponse(HTML_WITHOUT_MARKERS));

    const report = await runPreviewDoctor(SHOP_DOMAIN, PRODUCT_GID);
    expect(report.verdict).toBe("BLOCKED");
    expect(report.firstBlockedStep).toBe("plan_config");
    // Later gates keep their own honest answers — the report is a full walk,
    // not a short-circuit at the first failure.
    expect(step(report, "allow_list").status).toBe("FAIL");
    expect(step(report, "proxy").status).toBe("FAIL");
    expect(step(report, "storefront_markup").status).toBe("FAIL");
    expect(report.steps.map((s) => s.key)).toEqual([...CHAIN]);
    // And the audit event carries the blocked verdict.
    expect(doctorRunEvents()[0]).toMatchObject({
      verdict: "BLOCKED",
      firstBlockedStep: "plan_config",
    });
  });
});

// ── Containment: a throwing step never crashes the report ────────────────────

describe("containment — a throwing step never crashes the report", () => {
  it("a rejecting DB read turns dependent steps into contained FAILs", async () => {
    mocks.configFindMany.mockRejectedValue(new Error("db down"));
    const report = await runPreviewDoctor(SHOP_DOMAIN, PRODUCT_GID);

    expect(report.steps.map((s) => s.key)).toEqual([...CHAIN]);
    for (const key of ["plan_config", "product_in_plan", "group_on_product", "allow_list"]) {
      const s = step(report, key);
      expect(s.status, `step ${key}`).toBe("FAIL");
      expect(s.detail).toContain("This check could not run: db down");
    }
    // Independent steps still answer for themselves.
    expect(step(report, "proxy").status).toBe("PASS");
    expect(step(report, "storefront_markup").status).toBe("PASS");
    expect(step(report, "launch_mode").status).toBe("PASS");
    expect(report.verdict).toBe("BLOCKED");
    expect(report.firstBlockedStep).toBe("plan_config");
  });

  it("a throwing launch_mode step is contained, with no remediation invented", async () => {
    mocks.getLaunchState.mockRejectedValue(new Error("settings unreadable"));
    const report = await runPreviewDoctor(SHOP_DOMAIN, PRODUCT_GID);
    const s = step(report, "launch_mode");
    expect(s.status).toBe("FAIL");
    expect(s.detail).toContain("This check could not run: settings unreadable");
    expect(s.remediation).toBeUndefined();
    expect(report.steps).toHaveLength(CHAIN.length);
  });

  it("even a missing shop — every step failing — still yields a full report", async () => {
    mocks.requireShop.mockRejectedValue(new Error(`Shop not found: ${SHOP_DOMAIN}`));
    const report = await runPreviewDoctor(SHOP_DOMAIN, PRODUCT_GID);
    expect(report.steps).toHaveLength(CHAIN.length);
    expect(report.verdict).toBe("BLOCKED");
    expect(report.firstBlockedStep).toBe("plan_config");
    // The audit write needs the shop too; its failure is swallowed, not thrown.
    expect(doctorRunEvents()).toHaveLength(0);
  });
});

// ── The preview action gates on BLOCKED ──────────────────────────────────────

function previewRequest(fields: Record<string, string>): Request {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return new Request("https://app.cellexia.example/app/preview", {
    method: "POST",
    body,
  });
}

async function runPreviewIntent(
  extra: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await previewAction({
    request: previewRequest({
      intent: "preview-storefront",
      productHandle: PRODUCT.handle,
      productId: PRODUCT_GID,
      ...extra,
    }),
    params: {},
    context: {},
  });
  const body = (await response.json()) as unknown as Record<string, unknown>;
  return { status: response.status, body };
}

describe("preview-storefront action — gated on the doctor's verdict", () => {
  it("BLOCKED: returns the report instead of a URL and ticks nothing", async () => {
    mocks.configFindMany.mockResolvedValue([
      { ...SYNCED_CONFIG, syncStatus: "PENDING" },
    ]);
    const { body } = await runPreviewIntent();

    expect(body.ok).toBe(false);
    expect(body.url).toBeUndefined();
    const report = body.report as DoctorReport;
    expect(report.verdict).toBe("BLOCKED");
    expect(report.firstBlockedStep).toBe("plan_config");
    expect(String(body.toast)).toContain("Preview blocked");
    // No preview link was built, no checklist item ticked, no
    // storefront_preview_created event — the preview never "happened".
    expect(mocks.buildStorefrontPreviewUrl).not.toHaveBeenCalled();
    expect(mocks.markChecklist).not.toHaveBeenCalled();
    expect(
      mocks.logEvent.mock.calls.some(
        ([event]) => event.payload.action === "storefront_preview_created",
      ),
    ).toBe(false);
  });

  it("openAnyway: skips the doctor and opens the preview regardless", async () => {
    mocks.configFindMany.mockResolvedValue([
      { ...SYNCED_CONFIG, syncStatus: "PENDING" },
    ]);
    const { body } = await runPreviewIntent({ openAnyway: "true" });

    expect(body.ok).toBe(true);
    expect(String(body.url)).toContain("cx_preview=");
    expect(mocks.buildStorefrontPreviewUrl).toHaveBeenCalledTimes(1);
    // The doctor did not run at all on the escape hatch.
    expect(doctorRunEvents()).toHaveLength(0);
    expect(mocks.getShopMetafield).not.toHaveBeenCalled();
    // The escape hatch opens a preview the doctor just called BLOCKED — the
    // likely-blank page must NOT tick "Storefront previewed"; the audit
    // event records the un-vetted open, and the toast says the item stayed
    // unticked.
    expect(mocks.markChecklist).not.toHaveBeenCalled();
    const created = mocks.logEvent.mock.calls
      .map(([event]) => event.payload)
      .find((payload) => payload.action === "storefront_preview_created");
    expect(created).toMatchObject({
      openAnyway: true,
      checklistPreviewedStorefront: false,
    });
    expect(String(body.toast)).toContain("Storefront previewed");
  });

  it("READY: the doctor runs, passes, and the preview opens", async () => {
    const { body } = await runPreviewIntent();

    expect(body.ok).toBe(true);
    expect(String(body.url)).toContain("cx_preview=");
    expect(body.report).toBeUndefined();
    // A clean pre-flight carries no toast — the skipped-diagnosis note
    // below must be reserved for the fail-open path — and no market note.
    expect(body.toast).toBeUndefined();
    expect(body.marketHidden).toBeUndefined();
    // The gate genuinely ran (one doctor audit event, verdict READY)…
    expect(doctorRunEvents()).toEqual([
      expect.objectContaining({ verdict: "READY" }),
    ]);
    // …and the preview was recorded as previewed.
    expect(mocks.markChecklist).toHaveBeenCalledWith(
      SHOP.id,
      "previewedStorefront",
      true,
      `admin@${SHOP_DOMAIN}`,
    );
  });

  it("fail-open is not silent: a throwing doctor opens the preview WITH a skipped-diagnosis note", async () => {
    /* runPreviewDoctor is designed never to throw (every step is
       contained), so a throw here is an unknown bug — the preview must
       still open (fail open, a broken doctor never blocks), but the
       merchant must be told the pre-flight check was skipped: an "opened"
       answer with no note would read as "diagnosed and fine". */
    vi.mocked(runPreviewDoctor).mockRejectedValueOnce(
      new Error("doctor exploded"),
    );
    const { body } = await runPreviewIntent();

    expect(body.ok).toBe(true);
    expect(String(body.url)).toContain("cx_preview=");
    expect(body.report).toBeUndefined();
    // The toast names the skipped diagnosis and the next step.
    expect(String(body.toast)).toContain("diagnosis could not run");
    expect(String(body.toast)).toContain("Run diagnosis");
    // The audit event records that this preview opened un-vetted.
    const created = mocks.logEvent.mock.calls
      .map(([event]) => event.payload)
      .find((payload) => payload.action === "storefront_preview_created");
    expect(created).toMatchObject({
      doctorSkipped: true,
      checklistPreviewedStorefront: false,
    });
    // The checklist does NOT tick: nothing vetted this open, and it may be
    // the exact blank page "Storefront previewed" exists to catch. A later
    // preview whose diagnosis actually runs and passes ticks it.
    expect(mocks.markChecklist).not.toHaveBeenCalled();
  });

  it("market-hidden (doctor READY + storefront_markup WARN market_hidden): opens the tab, explains it, does NOT tick “Storefront previewed”", async () => {
    // The primary market is excluded by the merchant's setting: the doctor
    // stays READY (WARN never blocks) but the preview tab — primary domain =
    // primary market — will show no widget, and the storefront raises no
    // diagnostic there (no gated root, no no-group marker). The old flow
    // discarded the WARN, opened a blank tab and ticked the checklist.
    mocks.settingFindUnique.mockResolvedValue({
      value: { mode: "selected", handles: ["ch"] },
    });
    fetchMock.mockResolvedValue(
      htmlResponse(
        '<html><body><!-- BEGIN app snippet: cx-buybox-core --><template class="cx-buybox-nogroup" data-cellexia-market-hidden hidden style="display:none!important" data-cellexia-diag-market="fr"></template><!-- END app snippet --></body></html>',
      ),
    );
    const { body } = await runPreviewIntent();

    // WARN never blocks: the preview still opens…
    expect(body.ok).toBe(true);
    expect(String(body.url)).toContain("cx_preview=");
    expect(doctorRunEvents()).toEqual([expect.objectContaining({ verdict: "READY" })]);
    // …but the merchant is told WHY the page will show no buy box, and the
    // checklist is left alone; the audit event records the un-vetted open.
    expect(String(body.toast)).toContain("shows no buy box");
    expect(String(body.toast)).toContain("market setting");
    expect(String(body.toast)).toContain("“fr”");
    expect(String(body.toast)).toContain("“Storefront previewed” was not ticked");
    // …persistently too (the card renders this as a banner; a toast fades).
    expect(String(body.marketHidden)).toContain("“fr”");
    expect(body.report).toBeUndefined();
    expect(mocks.markChecklist).not.toHaveBeenCalled();
    const created = mocks.logEvent.mock.calls
      .map(([event]) => event.payload)
      .find((payload) => payload.action === "storefront_preview_created");
    expect(created).toMatchObject({
      marketHidden: true,
      checklistPreviewedStorefront: false,
    });
    expect(created).not.toHaveProperty("openAnyway");
    expect(created).not.toHaveProperty("doctorSkipped");
  });
});
