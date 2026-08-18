import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { fromZonedTime } from "date-fns-tz";

/**
 * Pause exit ramp magic verbs (v1.28.0, P2.6):
 *
 *  - RESUME (already a verb, never minted before) and the NEW EXTEND_PAUSE
 *    ride in the resume_reminder link bundle as resume_url /
 *    extend_pause_url (buildActionLinkBundle pauseControls); the token
 *    carries the week choices from settings.portal.pauseExtendChoicesWeeks;
 *  - EXTEND_PAUSE is a landing page: describeMagicAction returns one
 *    `choice` per allowed week count, labelled with the exact new resume day;
 *    executeMagicAction(payload, { choice }) validates the tapped choice
 *    against the token's own list (tampering falls back to the smallest) and
 *    calls extendPause(resumeAt + weeks) as MAGIC_LINK/customer;
 *  - honest refusals: not paused → magic.extend_pause.not_paused; beyond the
 *    maximum hold → magic.extend_pause.too_far with the latest allowed day;
 *  - classification: EXTEND_PAUSE is MUTATING (setup-gated, throttled) and
 *    LOCK-blocked like PAUSE; RESUME stays a recovery (never lock-blocked);
 *  - the resume_reminder catalog entry + preview sample vars + English body
 *    carry the two links; the pause confirmation quotes the exact resume date
 *    through the contract snapshot's resume_line.
 *
 * Scaffold: tests/magic-retry-payment.test.ts.
 */

const TZ = "Europe/Zurich";
const DAY = (ymd: string) => fromZonedTime(`${ymd}T00:00:00`, TZ);

const mocks = vi.hoisted(() => {
  const shop = {
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    primaryDomain: "cellexialabs.com",
    ianaTimezone: "Europe/Zurich",
  };
  const contract = {
    id: "ctr_1",
    shopId: "shop_1",
    shopifyContractId: "gid://shopify/SubscriptionContract/1",
    customerId: "gid://shopify/Customer/1",
    email: "sub@example.com",
    locale: "en",
    status: "PAUSED",
    ownership: "OURS",
    nextBillingDate: null,
    pausedAt: new Date("2026-08-01T10:00:00Z"),
    resumeAt: null as Date | null,
    paymentMethodId: "gid://shopify/CustomerPaymentMethod/1",
    lines: [],
    shop,
  };
  const setupMode = { value: false };
  return {
    shop,
    contract,
    setupMode,
    isSetupMode: vi.fn(async (): Promise<boolean> => setupMode.value),
    contractFindUnique: vi.fn(async (): Promise<unknown> => contract),
    contractFindFirst: vi.fn(async (): Promise<unknown> => null),
    subscriberEventCount: vi.fn(async (): Promise<number> => 1),
    logEvent: vi.fn(async (_event: unknown): Promise<void> => {}),
    portalSetting: {
      mutationsPerHour: 30,
      friendlyLockMessaging: false,
      pauseExtendChoicesWeeks: [2, 4],
    } as Record<string, unknown>,
    getSetting: vi.fn(async (_shopId: string, key: string): Promise<unknown> => {
      if (key === "portal") return mocks.portalSetting;
      return {};
    }),
    resolveLockState: vi.fn(
      async (): Promise<unknown> => ({ locked: false, until: null, lockDays: 0 }),
    ),
    extendPause: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ resumeAt: null })),
    resumeContract: vi.fn(async (): Promise<unknown> => ({ nextBillingDate: null })),
    pauseContract: vi.fn(async (): Promise<unknown> => ({ resumeAt: null })),
    createMagicToken: vi.fn(
      async (input: { action: string }): Promise<string> => `tok_${input.action}`,
    ),
    getPrimaryShop: vi.fn(async (): Promise<unknown> => shop),
  };
});

vi.mock("~/db.server", () => ({
  default: {
    subscriptionContract: {
      findUnique: mocks.contractFindUnique,
      findFirst: mocks.contractFindFirst,
    },
    subscriberEvent: { count: mocks.subscriberEventCount },
    shop: { findUnique: vi.fn(async (): Promise<unknown> => mocks.shop) },
  },
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: mocks.getSetting,
}));
vi.mock("~/lib/launch/launch.server", () => ({
  isSetupMode: mocks.isSetupMode,
}));
vi.mock("~/lib/contracts/lock.server", () => ({
  resolveLockState: mocks.resolveLockState,
}));
vi.mock("~/lib/crypto/tokens.server", () => ({
  createMagicToken: mocks.createMagicToken,
  sha256: (data: string) => createHash("sha256").update(data).digest("hex"),
}));
vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: mocks.getPrimaryShop,
}));
vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/graphql/index.server", () => ({
  getPaymentMethodUpdateUrl: vi.fn(),
}));
vi.mock("~/lib/contracts/service.server", () => {
  class PauseUntilError extends Error {
    constructor(
      readonly code: string,
      readonly maxResumeAt?: Date,
    ) {
      super(code);
    }
  }
  return {
    PauseUntilError,
    addOneTimeAddon: vi.fn(),
    applyDiscountGrant: vi.fn(),
    delayNextCycle: vi.fn(),
    delaySchedule: vi.fn(),
    extendPause: mocks.extendPause,
    pauseContract: mocks.pauseContract,
    resumeContract: mocks.resumeContract,
    skipNextCycle: vi.fn(),
    swapLineVariant: vi.fn(),
    unskipNextCycle: vi.fn(),
  };
});

import {
  allowedExtendWeeks,
  describeMagicAction,
  executeMagicAction,
} from "~/lib/magiclinks/handlers.server";
import { PauseUntilError } from "~/lib/contracts/service.server";
import {
  buildActionLinkBundle,
  resolvePauseExtendChoices,
} from "~/lib/magiclinks/builder.server";
import { t } from "~/lib/i18n/i18n.server";
import { formatShopDate } from "~/lib/dates.server";
import { EMAIL_CATALOG } from "~/lib/notifications/catalog.server";
import { previewSampleVars } from "~/lib/notifications/preview.server";
import { contractSnapshotProperties } from "~/lib/klaviyo/events-map.server";

function payload(
  action: string,
  params: Record<string, unknown> = {},
): Parameters<typeof executeMagicAction>[0] {
  return {
    v: 1,
    action,
    contractId: "ctr_1",
    customerId: "gid://shopify/Customer/1",
    email: "sub@example.com",
    params,
    exp: Math.floor(Date.now() / 1000) + 300,
    nonce: "nonce",
  } as Parameters<typeof executeMagicAction>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SHOPIFY_APP_URL = "https://app.example";
  mocks.setupMode.value = false;
  mocks.contract.status = "PAUSED";
  mocks.contract.resumeAt = DAY("2026-09-10");
  mocks.portalSetting = {
    mutationsPerHour: 30,
    friendlyLockMessaging: false,
    pauseExtendChoicesWeeks: [2, 4],
  };
  mocks.contractFindUnique.mockResolvedValue(mocks.contract);
  mocks.subscriberEventCount.mockResolvedValue(1);
  mocks.resolveLockState.mockResolvedValue({ locked: false, until: null, lockDays: 0 });
  mocks.extendPause.mockImplementation(
    async (_shop: unknown, _id: unknown, date: unknown) => ({ resumeAt: date }),
  );
});

describe("resume_reminder link bundle mints RESUME + EXTEND_PAUSE", () => {
  it("buildActionLinkBundle({ pauseControls }) adds resume_url / extend_pause_url; the EXTEND_PAUSE token carries the settings' week choices", async () => {
    const bundle = await buildActionLinkBundle({
      contractId: "ctr_1",
      customerId: "gid://shopify/Customer/1",
      email: "sub@example.com",
      createdVia: "KLAVIYO_FLOW",
      pauseControls: true,
      shopId: "shop_1",
    });
    expect(bundle.resume_url).toBe("https://app.example/magic/tok_RESUME");
    expect(bundle.extend_pause_url).toBe("https://app.example/magic/tok_EXTEND_PAUSE");
    // The classic bundle is untouched.
    expect(bundle.skip_url).toBeDefined();
    expect(bundle.pause_url).toBeDefined();
    const extendMint = mocks.createMagicToken.mock.calls
      .map((c) => c[0] as { action: string; params?: Record<string, unknown> })
      .find((i) => i.action === "EXTEND_PAUSE");
    expect(extendMint?.params).toEqual({ weeksChoices: [2, 4] });
    const resumeMint = mocks.createMagicToken.mock.calls
      .map((c) => c[0] as { action: string; contractId?: string })
      .find((i) => i.action === "RESUME");
    expect(resumeMint?.contractId).toBe("ctr_1");
  });

  it("without pauseControls (every other template) nothing pause-related is minted", async () => {
    const bundle = await buildActionLinkBundle({
      contractId: "ctr_1",
      createdVia: "KLAVIYO_FLOW",
    });
    expect(bundle.resume_url).toBeUndefined();
    expect(bundle.extend_pause_url).toBeUndefined();
    const actions = mocks.createMagicToken.mock.calls.map(
      (c) => (c[0] as { action: string }).action,
    );
    expect(actions).not.toContain("RESUME");
    expect(actions).not.toContain("EXTEND_PAUSE");
  });

  it("choices come from settings.portal.pauseExtendChoicesWeeks (sanitised, sorted, deduped); a broken read falls back to [2, 4]", async () => {
    mocks.portalSetting = { pauseExtendChoicesWeeks: [6, 1, 6, 99, "x"] };
    expect(await resolvePauseExtendChoices("shop_1")).toEqual([1, 6]);
    mocks.getSetting.mockRejectedValueOnce(new Error("db down"));
    expect(await resolvePauseExtendChoices("shop_1")).toEqual([2, 4]);
    expect(await resolvePauseExtendChoices(undefined)).toEqual([2, 4]);
  });

  it("the resume_reminder catalog entry, the preview sample links and the English body all carry the two links", () => {
    expect(EMAIL_CATALOG.resume_reminder.links).toEqual(
      expect.arrayContaining(["resume_url", "extend_pause_url"]),
    );
    expect(EMAIL_CATALOG.upcoming_order.links).not.toContain("extend_pause_url");
    const sample = previewSampleVars("resume_reminder");
    expect(sample.resume_url).toBeDefined();
    expect(sample.extend_pause_url).toBeDefined();
    const body = t("en", "email.resume_reminder.body");
    expect(body).toContain("{resume_url}");
    expect(body).toContain("{extend_pause_url}");
    expect(body).toContain("{resume_date}");
  });
});

describe("EXTEND_PAUSE — describe (landing page choices)", () => {
  it("returns one choice per allowed week count, labelled with the exact new resume day; the description quotes the current resume day", async () => {
    const desc = await describeMagicAction(payload("EXTEND_PAUSE", { weeksChoices: [2, 4] }));
    expect(desc.title).toBe(t("en", "magic.confirm.title.EXTEND_PAUSE"));
    const resumeDate = formatShopDate(DAY("2026-09-10"), TZ, "en");
    expect(desc.description).toBe(
      t("en", "magic.confirm.desc.EXTEND_PAUSE", { resume_date: resumeDate }),
    );
    expect(desc.choices).toEqual([
      {
        value: "2",
        label: t("en", "magic.extend_pause.choice", {
          weeks: 2,
          date: formatShopDate(DAY("2026-09-24"), TZ, "en"),
        }),
      },
      {
        value: "4",
        label: t("en", "magic.extend_pause.choice", {
          weeks: 4,
          date: formatShopDate(DAY("2026-10-08"), TZ, "en"),
        }),
      },
    ]);
    expect(desc.lockedResult).toBeUndefined();
  });

  it("a token without choices falls back to [2, 4]; a tampered list is sanitised", () => {
    expect(allowedExtendWeeks({})).toEqual([2, 4]);
    expect(allowedExtendWeeks({ weeksChoices: [4, 2, 2, 0, 27, 3.5] })).toEqual([2, 4]);
    expect(allowedExtendWeeks({ weeksChoices: [8] })).toEqual([8]);
  });

  it("other verbs keep the single confirm button (no choices)", async () => {
    const desc = await describeMagicAction(payload("RESUME"));
    expect(desc.choices).toBeUndefined();
    expect(desc.confirmLabel).toBe(t("en", "magic.confirm.button"));
  });
});

describe("EXTEND_PAUSE — execute", () => {
  it("calls extendPause(resumeAt + tapped weeks) as MAGIC_LINK/customer and renders the done copy with the new day", async () => {
    const result = await executeMagicAction(
      payload("EXTEND_PAUSE", { weeksChoices: [2, 4] }),
      { choice: "4" },
    );
    expect(mocks.extendPause).toHaveBeenCalledWith(
      "cellexia.myshopify.com",
      "ctr_1",
      DAY("2026-10-08"),
      { source: "MAGIC_LINK", actor: "customer" },
    );
    expect(result.headline).toBe(t("en", "magic.extend_pause.done", { weeks: 4 }));
    expect(result.sub).toBe(
      t("en", "magic.extend_pause.sub", {
        date: formatShopDate(DAY("2026-10-08"), TZ, "en"),
      }),
    );
    const types = mocks.logEvent.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).toContain("magic.link_used");
  });

  it("a tampered / missing choice falls back to the SMALLEST allowed choice — never further than the email offered", async () => {
    await executeMagicAction(payload("EXTEND_PAUSE", { weeksChoices: [2, 4] }), {
      choice: "52",
    });
    expect(mocks.extendPause).toHaveBeenLastCalledWith(
      "cellexia.myshopify.com",
      "ctr_1",
      DAY("2026-09-24"),
      expect.anything(),
    );
    await executeMagicAction(payload("EXTEND_PAUSE", { weeksChoices: [2, 4] }), {});
    expect(mocks.extendPause).toHaveBeenLastCalledWith(
      "cellexia.myshopify.com",
      "ctr_1",
      DAY("2026-09-24"),
      expect.anything(),
    );
  });

  it("not paused (or no resume day) → honest not_paused copy, no service call", async () => {
    mocks.contract.status = "ACTIVE";
    const result = await executeMagicAction(payload("EXTEND_PAUSE"), { choice: "2" });
    expect(mocks.extendPause).not.toHaveBeenCalled();
    expect(result.headline).toBe(t("en", "magic.extend_pause.not_paused"));
    expect(result.sub).toBe(t("en", "magic.extend_pause.not_paused_sub"));
  });

  it("beyond the maximum hold → too_far copy with the latest allowed day (from the service's typed refusal)", async () => {
    const maxDay = DAY("2026-10-30");
    mocks.extendPause.mockRejectedValueOnce(
      new PauseUntilError("RESUME_DATE_TOO_FAR", maxDay),
    );
    const result = await executeMagicAction(payload("EXTEND_PAUSE"), { choice: "4" });
    expect(result.headline).toBe(t("en", "magic.extend_pause.too_far"));
    expect(result.sub).toBe(
      t("en", "magic.extend_pause.too_far_sub", {
        date: formatShopDate(maxDay, TZ, "en"),
      }),
    );
  });

  it("is MUTATING (setup-gated + throttled) and LOCK-blocked like PAUSE; RESUME is a recovery and never lock-blocked", async () => {
    mocks.setupMode.value = true;
    const gated = await executeMagicAction(payload("EXTEND_PAUSE"), { choice: "2" });
    expect(gated.headline).toBe(t("en", "portal.setup.title"));
    expect(mocks.extendPause).not.toHaveBeenCalled();
    mocks.setupMode.value = false;

    mocks.subscriberEventCount.mockResolvedValueOnce(10_000);
    const throttled = await executeMagicAction(payload("EXTEND_PAUSE"), { choice: "2" });
    expect(throttled.headline).toBe(t("en", "magic.error.rate_limited"));
    expect(mocks.extendPause).not.toHaveBeenCalled();

    mocks.resolveLockState.mockResolvedValue({
      locked: true,
      until: new Date("2026-12-01T00:00:00Z"),
      lockDays: 30,
    });
    const locked = await executeMagicAction(payload("EXTEND_PAUSE"), { choice: "2" });
    expect(locked.headline).toBe(t("en", "magic.locked"));
    expect(mocks.extendPause).not.toHaveBeenCalled();
    // Describe renders the same refusal instead of the choice form.
    const desc = await describeMagicAction(payload("EXTEND_PAUSE"));
    expect(desc.lockedResult?.headline).toBe(t("en", "magic.locked"));

    // RESUME: recovery — executes even while locked.
    mocks.resumeContract.mockResolvedValueOnce({ nextBillingDate: DAY("2026-08-20") });
    const resumed = await executeMagicAction(payload("RESUME"));
    expect(mocks.resumeContract).toHaveBeenCalledWith("cellexia.myshopify.com", "ctr_1", {
      source: "MAGIC_LINK",
      actor: "customer",
    });
    expect(resumed.headline).toBe(t("en", "magic.resume.done"));
  });
});

describe("pause confirmation quotes the exact resume date", () => {
  it("contractSnapshotProperties carries resume_date / resume_date_iso / resume_line for a PAUSED contract with a scheduled resume, and an EMPTY resume_line otherwise (never a bare placeholder)", async () => {
    const paused = { ...mocks.contract, lines: [], resumeAt: DAY("2026-09-10") };
    const props = await contractSnapshotProperties(paused as never, TZ);
    const date = formatShopDate(DAY("2026-09-10"), TZ, "en");
    expect(props.resume_date).toBe(date);
    expect(props.resume_date_iso).toBe(DAY("2026-09-10").toISOString());
    expect(props.resume_line).toBe(
      t("en", "email.pause_confirmed.resume_line", { resume_date: date }),
    );

    const external = { ...mocks.contract, lines: [], resumeAt: null };
    const props2 = await contractSnapshotProperties(external as never, TZ);
    expect(props2.resume_line).toBe("");
    expect(props2.resume_date).toBeUndefined();

    // The English pause confirmation body renders the line — and no reason.
    const body = t("en", "email.pause_confirmed.body");
    expect(body).toContain("{resume_line}");
    expect(body.toLowerCase()).not.toContain("reason");
    expect(t("en", "email.pause_confirmed.resume_line")).toContain("{resume_date}");
  });
});
