import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A SETTINGS SAVE MUST RECORD WHAT IT REPLACED — the app.settings action's
 * admin.action event, evaluated.
 *
 * The event used to carry only the NEXT value: the audit log could say what
 * the dunning ladder became, but never what it was — "who changed it and
 * from what" required replaying every save since install. The action now
 * reads the outgoing value (as getSetting resolves it, defaults included)
 * before the write and logs `{ previous, value }`; `value` keeps its
 * historical meaning (the next state — additive rule: event fields are never
 * repurposed).
 */

const mocks = vi.hoisted(() => ({
  authenticateAdmin: vi.fn(async (): Promise<unknown> => ({
    session: { shop: "cellexia.myshopify.com" },
  })),
  getPrimaryShop: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
  })),
  getSetting: vi.fn(async (): Promise<unknown> => ({})),
  setSetting: vi.fn(async (): Promise<void> => {}),
  getAllSettings: vi.fn(async (): Promise<unknown> => ({})),
  // Typed with the input param so the recorded call's payload type-checks.
  logEvent: vi.fn(async (_input?: unknown): Promise<void> => {}),
}));

vi.mock("~/shopify.server", () => ({
  authenticate: { admin: mocks.authenticateAdmin },
}));

vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: mocks.getPrimaryShop,
}));

vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: mocks.getSetting,
  setSetting: mocks.setSetting,
  getAllSettings: mocks.getAllSettings,
}));

vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));

const { action } = await import("~/routes/app.settings");

/** POST the save-section form the way the settings page does. */
function post(fields: Record<string, string>): Request {
  const body = new URLSearchParams(fields);
  return new Request("https://cellexia.example/app/settings", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

function invoke(request: Request) {
  return action({ request, params: {}, context: {} } as never) as Promise<
    Response
  >;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticateAdmin.mockResolvedValue({
    session: { shop: "cellexia.myshopify.com" },
  });
  mocks.getPrimaryShop.mockResolvedValue({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
  });
});

describe("settings save audit event", () => {
  it("logs admin.action with BOTH the previous and the next value", async () => {
    // The stored (outgoing) pause settings, as getSetting resolves them.
    mocks.getSetting.mockResolvedValue({
      maxMonths: 3,
      resumeReminderDaysBefore: 7,
    });

    const res = await invoke(
      post({
        intent: "save-section",
        section: "pause",
        f_maxMonths: "6",
        f_resumeReminderDaysBefore: "14",
      }),
    );

    expect(res.status).toBe(200);

    // previous was read BEFORE the write, for the same shop and key.
    expect(mocks.getSetting).toHaveBeenCalledWith("shop_1", "pause");
    expect(mocks.setSetting).toHaveBeenCalledWith(
      "shop_1",
      "pause",
      { maxMonths: 6, resumeReminderDaysBefore: 14 },
      expect.any(String),
    );

    expect(mocks.logEvent).toHaveBeenCalledTimes(1);
    const event = mocks.logEvent.mock.calls[0][0] as {
      type: string;
      source: string;
      payload: Record<string, unknown>;
    };
    expect(event.type).toBe("admin.action");
    expect(event.source).toBe("ADMIN");
    expect(event.payload).toMatchObject({
      action: "settings_updated",
      key: "pause",
      // `value` keeps its historical meaning: the state the settings became.
      value: { maxMonths: 6, resumeReminderDaysBefore: 14 },
      // `previous` is the state it replaced — the new audit half.
      previous: { maxMonths: 3, resumeReminderDaysBefore: 7 },
    });
  });

  it("does not write or log when validation rejects the section", async () => {
    const res = await invoke(
      post({
        intent: "save-section",
        section: "pause",
        f_maxMonths: "99", // above the schema max of 6
        f_resumeReminderDaysBefore: "7",
      }),
    );

    expect(res.status).toBe(422);
    expect(mocks.setSetting).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });
});
