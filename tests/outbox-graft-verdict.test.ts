import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The cellexia_send merge rule (outbox.server.ts graft) — the full
 * dual-writer matrix.
 *
 * ROOT CAUSE this suite pins (pre-release v1.18.0 defect): the flag has TWO
 * writers whose "false" used to be byte-identical —
 *  - canonical dual-writer events (lifecycle.milestone_reached,
 *    lifecycle.rewards_unlocked, lifecycle.gift_scheduled,
 *    billing.attempt_failed) wrote a DEFAULT the router's content-carrying
 *    leg is expected to supersede;
 *  - confirmation events (contract.cancelled, …) write a provenance
 *    VERDICT that must never be flipped.
 * An add-only guard froze the default at "false" on the metrics where the
 * canonical leg deterministically lands first, silently killing those
 * emails' auto-created flows while NotificationLog said SENT.
 *
 * The rule now keys on the surviving row's own event_type: only a
 * confirmation row's flag is a verdict. Everything else — including legacy
 * rows written by older code that stamped the ambiguous default — is
 * superseded together with the content.
 *
 * Two later strands of the same matrix are pinned below:
 *  - SENT-swallow (pre-live fix): a canonical row the 1-minute flush already
 *    delivered (SENT) can never carry the router's content — the delivered
 *    event had no content/flag, so the flow never fired. Deduping the
 *    content enqueue onto it swallowed the customer's email while
 *    NotificationLog said SENT. The content leg now escapes as its own row;
 *    FAILED rows (still retrying) stay graftable instead; confirmation
 *    verdict rows still own their moment (a gated twin never escapes).
 *  - Delivery-leg key (pre-live fix): the dunning EMAIL rung and SMS leg
 *    share the "Cellexia Payment Failed" metric for the same
 *    profile+contract — without a channel dimension in the dedupe key one
 *    leg silently ate the other. Distinct legs never dedupe; same-leg true
 *    duplicates still do.
 */

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
  duplicate: null as Row | null,
  created: [] as Row[],
}));

vi.mock("~/db.server", () => ({
  default: {
    klaviyoOutbox: {
      findMany: vi.fn(
        async (): Promise<Row[]> => (store.duplicate ? [store.duplicate] : []),
      ),
      create: vi.fn(async (args: { data: Row }): Promise<Row> => {
        const row: Row = { id: "obx_new", status: "PENDING", ...args.data };
        store.created.push(row);
        return row;
      }),
      update: vi.fn(
        async (args: { where: { id: string }; data: Row }): Promise<Row | null> => {
          if (store.duplicate && store.duplicate.id === args.where.id) {
            Object.assign(store.duplicate, args.data);
            return store.duplicate;
          }
          return null;
        },
      ),
    },
  },
}));

import { enqueue } from "~/lib/klaviyo/outbox.server";

beforeEach(() => {
  vi.clearAllMocks();
  store.duplicate = null;
  store.created = [];
});

function survivingRow(eventType: string, flag?: string): Row {
  return {
    id: "obx_prior",
    status: "PENDING",
    properties: {
      event_type: eventType,
      contract_id: "ctr_1",
      ...(flag !== undefined ? { cellexia_send: flag } : {}),
    },
  };
}

const CONTENT_TRUE = {
  content_subject: "S",
  content_html: "<div>H</div>",
  content_text: "T",
  template: "milestone_gift",
  cellexia_send: "true",
  contract_id: "ctr_1",
};

async function graftOnto(row: Row, properties: Record<string, unknown>) {
  store.duplicate = row;
  await enqueue("shop_1", {
    eventName: "Cellexia Milestone Reached",
    email: "anna@example.com",
    properties,
  });
  return (store.duplicate.properties ?? {}) as Row;
}

describe("dual-writer defaults are superseded with the content", () => {
  for (const eventType of [
    "lifecycle.milestone_reached",
    "lifecycle.rewards_unlocked",
    "lifecycle.gift_scheduled",
    "billing.attempt_failed",
  ]) {
    it(`${eventType}: a legacy default 'false' flips to 'true' when the router's content grafts in`, async () => {
      const properties = await graftOnto(
        survivingRow(eventType, "false"),
        CONTENT_TRUE,
      );
      expect(properties.content_html).toBe("<div>H</div>");
      expect(properties.cellexia_send).toBe("true"); // never frozen
      expect(store.created).toHaveLength(0); // deduped, no second row
    });
  }

  it("an unstamped canonical row (current writers) gets the flag with the content", async () => {
    const properties = await graftOnto(
      survivingRow("lifecycle.milestone_reached"),
      CONTENT_TRUE,
    );
    expect(properties.cellexia_send).toBe("true");
  });
});

describe("confirmation verdicts are final", () => {
  it("a gated 'false' on a confirmation row survives a content-carrying twin (merge-cancel protection)", async () => {
    // Residual race: a webhook cancel twin that beat the mirror update could
    // arrive carrying content + "true"; the service twin's verdict must win.
    const properties = await graftOnto(
      survivingRow("contract.cancelled", "false"),
      { ...CONTENT_TRUE, template: "cancel_confirmed" },
    );
    expect(properties.content_html).toBe("<div>H</div>"); // content still grafts
    expect(properties.cellexia_send).toBe("false"); // the verdict does not
  });

  it("every mapped confirmation event type is verdict-protected", async () => {
    for (const eventType of [
      "cycle.skipped",
      "cycle.unskipped",
      "cycle.delayed",
      "contract.paused",
      "contract.resumed",
      "contract.line_swapped",
      "contract.frequency_changed",
      "contract.cancelled",
    ]) {
      const properties = await graftOnto(
        survivingRow(eventType, "false"),
        CONTENT_TRUE,
      );
      expect(properties.cellexia_send, eventType).toBe("false");
    }
  });
});

describe("graft preconditions unchanged", () => {
  it("a content-less incoming twin grafts nothing", async () => {
    const properties = await graftOnto(
      survivingRow("lifecycle.milestone_reached", "false"),
      { event_type: "lifecycle.milestone_reached", contract_id: "ctr_1" },
    );
    expect(properties.content_html).toBeUndefined();
    expect(properties.cellexia_send).toBe("false"); // untouched — no graft ran
  });

  it("a row that already has content is never grafted", async () => {
    const row = survivingRow("lifecycle.milestone_reached", "false");
    // Full EMAIL-leg content (subject + text) — a real content-carrying row;
    // a text-only body would be the SMS leg and no duplicate at all.
    (row.properties as Row).content_subject = "S0";
    (row.properties as Row).content_text = "already";
    const properties = await graftOnto(row, CONTENT_TRUE);
    expect(properties.cellexia_send).toBe("false");
    expect(properties.content_html).toBeUndefined();
    expect(store.created).toHaveLength(0); // still deduped — no second row
  });
});

describe("SENT-swallow: a delivered row can no longer carry the content", () => {
  it("a SENT canonical row (flushed before the router's leg) no longer eats the content enqueue — a fresh row carries it", async () => {
    // Soft-decline trace: billing.attempt_failed enqueues the canonical
    // content-less row at T+0, klaviyo_flush (1-min tick) delivers it, the
    // 10-min dunning sweep sends payment_failed_1 at T+90s. The delivered
    // event had no content and no cellexia_send, so no flow fired — the
    // dedupe used to return the SENT id, the email was never delivered and
    // NotificationLog said SENT forever.
    store.duplicate = {
      ...survivingRow("billing.attempt_failed"),
      status: "SENT",
    };
    const result = await enqueue("shop_1", {
      eventName: "Cellexia Payment Failed",
      email: "anna@example.com",
      properties: { ...CONTENT_TRUE, template: "payment_failed_1" },
    });
    expect(store.created).toHaveLength(1); // the escape row
    const created = (store.created[0].properties ?? {}) as Row;
    expect(created.content_html).toBe("<div>H</div>");
    expect(created.cellexia_send).toBe("true");
    // The caller's NotificationLog rides the fresh (deliverable) row.
    expect(result?.id).toBe("obx_new");
    // The delivered canonical row is untouched — no graft onto a SENT row.
    expect((store.duplicate!.properties as Row).content_html).toBeUndefined();
  });

  it("a FAILED canonical row (still retrying) is graftable — the retry delivers the content, no second event", async () => {
    const row = {
      ...survivingRow("lifecycle.milestone_reached", "false"),
      status: "FAILED",
    };
    const properties = await graftOnto(row, CONTENT_TRUE);
    expect(properties.content_html).toBe("<div>H</div>");
    expect(properties.cellexia_send).toBe("true"); // superseded with the content
    expect(store.created).toHaveLength(0);
  });

  it("a SENT row that already delivered WITH content suppresses a content twin (true duplicate — the flow fired)", async () => {
    const row = survivingRow("lifecycle.milestone_reached");
    (row.properties as Row).content_subject = "S0";
    (row.properties as Row).content_text = "T0";
    (row.properties as Row).cellexia_send = "true";
    row.status = "SENT";
    store.duplicate = row;
    const result = await enqueue("shop_1", {
      eventName: "Cellexia Milestone Reached",
      email: "anna@example.com",
      properties: CONTENT_TRUE,
    });
    expect(store.created).toHaveLength(0);
    expect(result?.id).toBe("obx_prior");
  });

  it("a SENT confirmation verdict row still owns its moment — the gated twin never escapes as a fresh row", async () => {
    // Merge-cancel protection extends past delivery: the service twin's
    // "false" verdict row flushed content-less BY DESIGN (the flow must send
    // nothing). The webhook race twin carrying content + "true" must stay
    // suppressed, not spawn a deliverable row.
    store.duplicate = {
      ...survivingRow("contract.cancelled", "false"),
      status: "SENT",
    };
    const result = await enqueue("shop_1", {
      eventName: "Cellexia Subscription Cancelled",
      email: "anna@example.com",
      properties: { ...CONTENT_TRUE, template: "cancel_confirmed" },
    });
    expect(store.created).toHaveLength(0);
    expect(result?.id).toBe("obx_prior");
    expect((store.duplicate!.properties as Row).cellexia_send).toBe("false");
    expect((store.duplicate!.properties as Row).content_html).toBeUndefined();
  });
});

describe("distinct delivery legs never dedupe (channel key)", () => {
  const SMS_PROPS = {
    // send.server.ts SMS shape: content_text only, never subject/html.
    content_text: "Payment failed — update your card: https://x.example/t",
    template: "payment_failed_sms",
    cellexia_send: "false",
    contract_id: "ctr_1",
  };

  it("the dunning SMS leg does not collapse onto the canonical/EMAIL row of the same metric", async () => {
    store.duplicate = survivingRow("billing.attempt_failed"); // PENDING, content-less
    const result = await enqueue("shop_1", {
      eventName: "Cellexia Payment Failed",
      email: "anna@example.com",
      properties: SMS_PROPS,
    });
    expect(store.created).toHaveLength(1); // its own row
    expect(result?.id).toBe("obx_new");
    const sms = (store.created[0].properties ?? {}) as Row;
    expect(sms.content_text).toBe(SMS_PROPS.content_text);
    expect(sms.cellexia_send).toBe("false");
    // The EMAIL-leg row was neither grafted nor consumed.
    expect((store.duplicate!.properties as Row).content_text).toBeUndefined();
  });

  it("an EMAIL content leg does not dedupe onto the SMS row either — the email is not eaten", async () => {
    store.duplicate = {
      id: "obx_prior",
      status: "PENDING",
      properties: { ...SMS_PROPS },
    };
    const result = await enqueue("shop_1", {
      eventName: "Cellexia Payment Failed",
      email: "anna@example.com",
      properties: { ...CONTENT_TRUE, template: "payment_failed_1" },
    });
    expect(store.created).toHaveLength(1);
    expect(result?.id).toBe("obx_new");
    expect((store.created[0].properties as Row).content_html).toBe(
      "<div>H</div>",
    );
    // The SMS row keeps its own body and flag.
    const smsRow = store.duplicate!.properties as Row;
    expect(smsRow.content_text).toBe(SMS_PROPS.content_text);
    expect(smsRow.content_html).toBeUndefined();
    expect(smsRow.cellexia_send).toBe("false");
  });

  it("two enqueues of the SAME leg still dedupe (true duplicate)", async () => {
    store.duplicate = {
      id: "obx_prior",
      status: "PENDING",
      properties: { ...SMS_PROPS },
    };
    const result = await enqueue("shop_1", {
      eventName: "Cellexia Payment Failed",
      email: "anna@example.com",
      properties: { ...SMS_PROPS },
    });
    expect(store.created).toHaveLength(0);
    expect(result?.id).toBe("obx_prior");
  });
});
