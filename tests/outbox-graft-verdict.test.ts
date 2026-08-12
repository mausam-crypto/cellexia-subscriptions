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
 */

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
  duplicate: null as Row | null,
  created: [] as Row[],
}));

vi.mock("~/db.server", () => ({
  default: {
    klaviyoOutbox: {
      findFirst: vi.fn(async (): Promise<Row | null> => store.duplicate),
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
    (row.properties as Row).content_text = "already";
    const properties = await graftOnto(row, CONTENT_TRUE);
    expect(properties.cellexia_send).toBe("false");
    expect(properties.content_html).toBeUndefined();
  });
});
