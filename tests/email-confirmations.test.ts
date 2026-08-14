import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Confirmation bridge (v1.17.0, confirmations.server.ts + log.server.ts).
 *
 * Pinned here:
 *  - The bridge fires ONLY for templates the merchant explicitly flipped to
 *    sender "app" — "auto"/"klaviyo"/no-row means the Klaviyo flow keeps
 *    owning the moment and NOTHING new sends on upgrade.
 *  - Event → template mapping covers exactly the state-change confirmations.
 *  - PROVENANCE: only person-initiated moments send. SYSTEM/SCHEDULER
 *    events (consolidation, stockout evaluation, auto-resume, dunning),
 *    non-CUSTOMER skip initiators, MERGED cancels and DUNNING/SYSTEM
 *    cancels never claim "as requested". A cancel's provenance-less
 *    webhook twin consults the contract mirror — the SAME fallback the
 *    Klaviyo events-map applies — so a consolidation merge-cancel can
 *    never email from either path.
 *  - Dedupe is an ATOMIC claim (transient CLAIMED NotificationLog row),
 *    not check-then-act: a SENT row or an earlier rival claim inside the
 *    window backs the bridge off; the claim is deleted after the send.
 *    Windows are per type (10 min for paused/cancelled — the webhook-race
 *    double-log pair — 60 s for service-only types, so a second distinct
 *    action still confirms).
 *  - enabled:false, missing contractId and unmapped events send nothing.
 *  - The bridge never throws into logEvent, and logEvent invokes it
 *    fire-and-forget (an email must never block a portal action).
 */

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
  logs: [] as Row[],
  seq: 0,
}));

const mocks = vi.hoisted(() => ({
  sendNotification: vi.fn(async (_input: Record<string, unknown>) => ({
    status: "SENT",
    klaviyoEnqueued: false,
    directEmailSent: true,
  })),
  // Contract mirror consulted by the provenance gate's fallback — the same
  // fallback the Klaviyo events-map applies. Default: no mirror data.
  contractFindUnique: vi.fn(async (): Promise<unknown> => null),
  emailsSetting: {
    templates: {} as Record<
      string,
      { enabled?: boolean; subject?: string; body?: string; sender?: string }
    >,
  },
}));

vi.mock("~/db.server", () => ({
  default: {
    notificationLog: {
      create: vi.fn(async (args: { data: Row }): Promise<Row> => {
        const row: Row = {
          id: `nlg_${++store.seq}`,
          createdAt: new Date(Date.now() + store.seq), // strictly increasing
          ...args.data,
        };
        store.logs.push(row);
        return row;
      }),
      findMany: vi.fn(
        async (args: {
          where: {
            contractId: string;
            template: string;
            status: { in: string[] };
            createdAt: { gte: Date };
          };
        }): Promise<Row[]> => {
          const w = args.where;
          return store.logs
            .filter(
              (r) =>
                r.contractId === w.contractId &&
                r.template === w.template &&
                w.status.in.includes(r.status as string) &&
                (r.createdAt as Date) >= w.createdAt.gte,
            )
            .sort((a, b) =>
              (a.createdAt as Date).getTime() !==
              (b.createdAt as Date).getTime()
                ? (a.createdAt as Date).getTime() -
                  (b.createdAt as Date).getTime()
                : String(a.id).localeCompare(String(b.id)),
            );
        },
      ),
      delete: vi.fn(async (args: { where: { id: string } }): Promise<Row> => {
        const idx = store.logs.findIndex((r) => r.id === args.where.id);
        if (idx >= 0) return store.logs.splice(idx, 1)[0];
        throw new Error("not found");
      }),
    },
    subscriberEvent: {
      create: vi.fn(async () => ({})),
    },
    subscriptionContract: {
      findUnique: mocks.contractFindUnique,
    },
  },
}));
vi.mock("~/lib/klaviyo/events-map.server", () => ({
  enqueueKlaviyoForEvent: vi.fn(async () => {}),
}));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (_shopId: string, key: string) => {
    if (key === "emails") return mocks.emailsSetting;
    return {};
  }),
}));
vi.mock("~/lib/notifications/send.server", () => ({
  sendNotification: mocks.sendNotification,
}));

import {
  CONFIRMATION_TEMPLATE_BY_EVENT,
  maybeSendConfirmationForEvent,
} from "~/lib/notifications/confirmations.server";

beforeEach(() => {
  vi.clearAllMocks();
  store.logs = [];
  store.seq = 0;
  mocks.emailsSetting.templates = {};
  mocks.contractFindUnique.mockResolvedValue(null);
});

const skipEvent = {
  shopId: "shop_1",
  contractId: "ctr_1",
  type: "cycle.skipped",
  source: "CUSTOMER_PORTAL" as const,
  payload: { cycleIndex: 3, weeks: 2, initiator: "CUSTOMER" },
};

describe("event → template mapping", () => {
  it("covers exactly the state-change confirmation moments", () => {
    expect(CONFIRMATION_TEMPLATE_BY_EVENT).toEqual({
      "cycle.skipped": "skip_confirmed",
      "cycle.unskipped": "unskip_confirmed",
      "cycle.delayed": "delay_confirmed",
      "contract.paused": "pause_confirmed",
      "contract.resumed": "resume_confirmed",
      "contract.line_swapped": "swap_confirmed",
      "contract.frequency_changed": "frequency_changed",
      "contract.cancelled": "cancel_confirmed",
    });
  });
});

describe("sender gating", () => {
  it("sends when the merchant flipped the template to sender app", async () => {
    mocks.emailsSetting.templates.skip_confirmed = { sender: "app", enabled: true };
    await maybeSendConfirmationForEvent(skipEvent);
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    const input = mocks.sendNotification.mock.calls[0][0];
    expect(input.template).toBe("skip_confirmed");
    expect(input.contractId).toBe("ctr_1");
    // Scalar payload values travel as copy placeholders.
    expect((input.vars as Record<string, unknown>).weeks).toBe(2);
    // The claim marker was cleaned up after the send.
    expect(store.logs.filter((r) => r.status === "CLAIMED")).toHaveLength(0);
  });

  it("does nothing without an override row (upgrade default)", async () => {
    await maybeSendConfirmationForEvent(skipEvent);
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it("does nothing for sender auto or klaviyo", async () => {
    mocks.emailsSetting.templates.skip_confirmed = { sender: "auto" };
    await maybeSendConfirmationForEvent(skipEvent);
    mocks.emailsSetting.templates.skip_confirmed = { sender: "klaviyo" };
    await maybeSendConfirmationForEvent(skipEvent);
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it("does nothing when the template is disabled", async () => {
    mocks.emailsSetting.templates.skip_confirmed = { sender: "app", enabled: false };
    await maybeSendConfirmationForEvent(skipEvent);
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });
});

describe("provenance gate", () => {
  beforeEach(() => {
    mocks.emailsSetting.templates.skip_confirmed = { sender: "app" };
    mocks.emailsSetting.templates.cancel_confirmed = { sender: "app" };
    mocks.emailsSetting.templates.resume_confirmed = { sender: "app" };
  });

  it("SYSTEM and SCHEDULER events never send (auto-resume, consolidation, stockout)", async () => {
    await maybeSendConfirmationForEvent({
      ...skipEvent,
      source: "SYSTEM",
    });
    await maybeSendConfirmationForEvent({
      shopId: "shop_1",
      contractId: "ctr_1",
      type: "contract.resumed",
      source: "SCHEDULER",
      payload: {},
    });
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it("non-CUSTOMER skip initiators never claim 'as requested'", async () => {
    await maybeSendConfirmationForEvent({
      ...skipEvent,
      source: "ADMIN",
      payload: { initiator: "ADMIN" },
    });
    await maybeSendConfirmationForEvent({
      ...skipEvent,
      source: "WEBHOOK",
      payload: { initiator: "STOCKOUT" },
    });
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it("a MERGED cancel (consolidation bookkeeping) never emails the customer", async () => {
    await maybeSendConfirmationForEvent({
      shopId: "shop_1",
      contractId: "ctr_1",
      type: "contract.cancelled",
      source: "ADMIN",
      payload: { reason: "MERGED", cancelSource: "SYSTEM" },
    });
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it("DUNNING and SYSTEM cancels are excluded; CUSTOMER and ADMIN cancels send", async () => {
    await maybeSendConfirmationForEvent({
      shopId: "shop_1",
      contractId: "ctr_1",
      type: "contract.cancelled",
      source: "WEBHOOK",
      payload: { reason: "PAYMENT_FAILED", cancelSource: "DUNNING" },
    });
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    await maybeSendConfirmationForEvent({
      shopId: "shop_1",
      contractId: "ctr_1",
      type: "contract.cancelled",
      source: "CUSTOMER_PORTAL",
      payload: { reason: "TOO_MUCH_PRODUCT", cancelSource: "CUSTOMER" },
    });
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
  });

  it("a webhook-observed cancel without a cancelSource (Shopify admin) sends", async () => {
    // The payload carries no provenance, so the gate consults the contract
    // mirror (same fallback as the Klaviyo events-map) — which here holds
    // nothing that gates it. A cancel with no non-person stamp ANYWHERE is
    // a real cancellation.
    await maybeSendConfirmationForEvent({
      shopId: "shop_1",
      contractId: "ctr_1",
      type: "contract.cancelled",
      source: "WEBHOOK",
      payload: {},
    });
    expect(mocks.contractFindUnique).toHaveBeenCalledTimes(1);
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
  });

  it("a consolidation merge-cancel's webhook twin (empty payload) consults the contract mirror and never sends", async () => {
    // mergeContracts cancels the source contract with reason MERGED /
    // cancelSource SYSTEM, but its Shopify mutation lands BEFORE the local
    // mirror write commits — so the SUBSCRIPTION_CONTRACTS_UPDATE status
    // diff can log a WEBHOOK contract.cancelled twin whose payload carries
    // NO provenance. The SYSTEM service leg was gated before it could
    // claim, so the atomic dedupe offers no protection: the mirror
    // fallback is the only gate between this twin and "your subscription
    // is cancelled" landing for a customer who never left.
    mocks.contractFindUnique.mockResolvedValue({
      cancelReason: "MERGED",
      cancelSource: "SYSTEM",
    });
    await maybeSendConfirmationForEvent({
      shopId: "shop_1",
      contractId: "ctr_1",
      type: "contract.cancelled",
      source: "WEBHOOK",
      payload: { previousStatus: "ACTIVE", status: "CANCELLED" },
    });
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it("the race-window mirror stamp (sync's first-observed EXTERNAL) blocks the twin too", async () => {
    // When the webhook beats the service's own mirror write, the sync
    // stamps cancelSource EXTERNAL (prior source null) — also a non-person
    // source, so the twin is blocked whichever side of the race the mirror
    // read lands on.
    mocks.contractFindUnique.mockResolvedValue({
      cancelReason: null,
      cancelSource: "EXTERNAL",
    });
    await maybeSendConfirmationForEvent({
      shopId: "shop_1",
      contractId: "ctr_1",
      type: "contract.cancelled",
      source: "WEBHOOK",
      payload: { previousStatus: "ACTIVE", status: "CANCELLED" },
    });
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it("a webhook twin whose mirror shows the customer's own cancel still sends (the atomic dedupe owns the double)", async () => {
    // The mirror fallback must not over-block: when the service write won
    // the race the mirror says CUSTOMER, the twin passes, and the
    // 10-minute claim window dedupes it against the service leg's send.
    mocks.contractFindUnique.mockResolvedValue({
      cancelReason: "TOO_MUCH_PRODUCT",
      cancelSource: "CUSTOMER",
    });
    await maybeSendConfirmationForEvent({
      shopId: "shop_1",
      contractId: "ctr_1",
      type: "contract.cancelled",
      source: "WEBHOOK",
      payload: { previousStatus: "ACTIVE", status: "CANCELLED" },
    });
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
  });

  it("cancel events whose payload carries full provenance never read the mirror", async () => {
    await maybeSendConfirmationForEvent({
      shopId: "shop_1",
      contractId: "ctr_1",
      type: "contract.cancelled",
      source: "CUSTOMER_PORTAL",
      payload: { reason: "TOO_MUCH_PRODUCT", cancelSource: "CUSTOMER" },
    });
    expect(mocks.contractFindUnique).not.toHaveBeenCalled();
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
  });
});

describe("scope + dedupe", () => {
  it("ignores unmapped events and events without a contract", async () => {
    mocks.emailsSetting.templates.skip_confirmed = { sender: "app" };
    await maybeSendConfirmationForEvent({ ...skipEvent, type: "notification.sent" });
    await maybeSendConfirmationForEvent({ ...skipEvent, type: "admin.action" });
    await maybeSendConfirmationForEvent({ ...skipEvent, contractId: null });
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it("backs off when a SENT row exists inside the window (and cleans its claim)", async () => {
    mocks.emailsSetting.templates.skip_confirmed = { sender: "app" };
    store.logs.push({
      id: "nlg_prior",
      contractId: "ctr_1",
      template: "skip_confirmed",
      status: "SENT",
      createdAt: new Date(Date.now() - 10_000),
    });
    await maybeSendConfirmationForEvent(skipEvent);
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(store.logs.filter((r) => r.status === "CLAIMED")).toHaveLength(0);
  });

  it("a SENT row OLDER than the 60s window does not suppress a second distinct action", async () => {
    mocks.emailsSetting.templates.swap_confirmed = { sender: "app" };
    store.logs.push({
      id: "nlg_prior",
      contractId: "ctr_1",
      template: "swap_confirmed",
      status: "SENT",
      createdAt: new Date(Date.now() - 120_000), // 2 min ago
    });
    await maybeSendConfirmationForEvent({
      shopId: "shop_1",
      contractId: "ctr_1",
      type: "contract.line_swapped",
      source: "CUSTOMER_PORTAL",
      payload: {},
    });
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
  });

  it("paused/cancelled use the long 10-minute window (webhook double-log pair)", async () => {
    mocks.emailsSetting.templates.pause_confirmed = { sender: "app" };
    store.logs.push({
      id: "nlg_prior",
      contractId: "ctr_1",
      template: "pause_confirmed",
      status: "SENT",
      createdAt: new Date(Date.now() - 120_000), // 2 min ago — inside 10 min
    });
    await maybeSendConfirmationForEvent({
      shopId: "shop_1",
      contractId: "ctr_1",
      type: "contract.paused",
      source: "WEBHOOK",
      payload: {},
    });
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it("an earlier rival CLAIM wins — the later invocation backs off", async () => {
    mocks.emailsSetting.templates.skip_confirmed = { sender: "app" };
    store.logs.push({
      id: "nlg_rival",
      contractId: "ctr_1",
      template: "skip_confirmed",
      status: "CLAIMED",
      createdAt: new Date(Date.now() - 1_000),
    });
    await maybeSendConfirmationForEvent(skipEvent);
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    // Our own claim was cleaned up; the rival's claim is untouched.
    const claims = store.logs.filter((r) => r.status === "CLAIMED");
    expect(claims).toHaveLength(1);
    expect(claims[0].id).toBe("nlg_rival");
  });
});

describe("logEvent integration", () => {
  it("logEvent drives the real bridge fire-and-forget — a portal skip with sender app sends the confirmation", async () => {
    mocks.emailsSetting.templates.skip_confirmed = { sender: "app" };
    const { logEvent } = await import("~/lib/events/log.server");
    await logEvent(skipEvent);
    // The bridge is deliberately NOT awaited by logEvent (an SMTP round-trip
    // must never block a portal action) — wait for the async leg to land.
    await vi.waitFor(() =>
      expect(mocks.sendNotification).toHaveBeenCalledTimes(1),
    );
    expect(mocks.sendNotification.mock.calls[0][0].template).toBe(
      "skip_confirmed",
    );
  });

  it("logEvent stays contained when the bridge's send explodes", async () => {
    mocks.emailsSetting.templates.skip_confirmed = { sender: "app" };
    mocks.sendNotification.mockRejectedValueOnce(new Error("boom"));
    const { logEvent } = await import("~/lib/events/log.server");
    await expect(logEvent(skipEvent)).resolves.toBeUndefined();
    // Give the unawaited leg a tick to run its catch path.
    await new Promise((r) => setTimeout(r, 10));
  });
});

describe("containment", () => {
  it("never throws when the settings read fails", async () => {
    const settings = await import("~/lib/settings/settings.server");
    (settings.getSetting as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("db down"),
    );
    await expect(maybeSendConfirmationForEvent(skipEvent)).resolves.toBeUndefined();
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it("never throws when sendNotification itself rejects (claim still cleaned up)", async () => {
    mocks.emailsSetting.templates.skip_confirmed = { sender: "app" };
    mocks.sendNotification.mockRejectedValueOnce(new Error("boom"));
    await expect(maybeSendConfirmationForEvent(skipEvent)).resolves.toBeUndefined();
    expect(store.logs.filter((r) => r.status === "CLAIMED")).toHaveLength(0);
  });
});
