/**
 * Unit tests for the pure decision logic in
 * app/services/communications/klaviyo.server.ts:
 * - eventNameToMetric covers every LIFECYCLE_EVENTS member
 * - the retry backoff schedule is monotonic
 * - Klaviyo request bodies are dedupe-safe and deterministic
 */
import { describe, expect, it } from "vitest";
import { LIFECYCLE_EVENTS } from "~/types/domain";
import { humanDate } from "~/lib/dates";
import {
  MAX_OUTBOX_ATTEMPTS,
  backoffMinutes,
  buildKlaviyoEventBody,
  computeNextAttemptAt,
  enrichPayload,
  eventNameToMetric,
} from "~/services/communications/klaviyo.server";

describe("eventNameToMetric", () => {
  it("maps every lifecycle event to a Cellexia-prefixed Title Case metric", () => {
    for (const event of LIFECYCLE_EVENTS) {
      const metric = eventNameToMetric(event);
      expect(metric.startsWith("Cellexia ")).toBe(true);
      expect(metric).not.toMatch(/_/);
      const words = metric.split(" ");
      expect(words.length).toBeGreaterThanOrEqual(2);
      for (const word of words.slice(1)) {
        expect(word).toMatch(/^[A-Z][a-z]*$/);
      }
    }
  });

  it("produces a distinct metric for every event", () => {
    const metrics = new Set(LIFECYCLE_EVENTS.map((event) => eventNameToMetric(event)));
    expect(metrics.size).toBe(LIFECYCLE_EVENTS.length);
  });

  it("maps known examples exactly", () => {
    expect(eventNameToMetric("CHARGE_FAILED")).toBe("Cellexia Charge Failed");
    expect(eventNameToMetric("SUBSCRIPTION_STARTED")).toBe(
      "Cellexia Subscription Started",
    );
    expect(eventNameToMetric("PRE_SHIPMENT_WINDOW_OPEN")).toBe(
      "Cellexia Pre Shipment Window Open",
    );
    expect(eventNameToMetric("MAGIC_LINK_REQUESTED")).toBe(
      "Cellexia Magic Link Requested",
    );
    expect(eventNameToMetric("LIKELY_EXCESS_INVENTORY")).toBe(
      "Cellexia Likely Excess Inventory",
    );
  });
});

describe("backoff schedule", () => {
  it("is 2^attempts minutes and strictly monotonic up to the dead threshold", () => {
    const delays: number[] = [];
    for (let attempts = 1; attempts <= MAX_OUTBOX_ATTEMPTS; attempts++) {
      delays.push(backoffMinutes(attempts));
    }
    expect(delays[0]).toBe(2); // first retry after 2 minutes
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]!).toBeGreaterThan(delays[i - 1]!);
      expect(delays[i]!).toBe(delays[i - 1]! * 2);
    }
  });

  it("computes exact next-attempt timestamps from a fixed clock", () => {
    const now = new Date("2026-07-21T10:00:00.000Z");
    expect(computeNextAttemptAt(1, now).getTime()).toBe(
      now.getTime() + 2 * 60_000,
    );
    expect(computeNextAttemptAt(3, now).getTime()).toBe(
      now.getTime() + 8 * 60_000,
    );
    let previous = 0;
    for (let attempts = 1; attempts <= MAX_OUTBOX_ATTEMPTS; attempts++) {
      const at = computeNextAttemptAt(attempts, now).getTime();
      expect(at).toBeGreaterThan(previous);
      previous = at;
    }
  });

  it("never produces a negative or zero delay for weird inputs", () => {
    expect(backoffMinutes(0)).toBeGreaterThan(0);
    expect(backoffMinutes(-5)).toBeGreaterThan(0);
  });
});

describe("payload enrichment", () => {
  it("adds a portal deep link and does not mutate the input", () => {
    const original = { amountCents: 4900 };
    const copy = { ...original };
    const enriched = enrichPayload(original, "https://portal.cellexia.com");
    expect(enriched.portalUrl).toBe("https://portal.cellexia.com/portal");
    expect(enriched.amountCents).toBe(4900);
    expect(original).toEqual(copy);
  });

  it("normalizes trailing slashes on the portal base", () => {
    const enriched = enrichPayload({}, "https://portal.cellexia.com/");
    expect(enriched.portalUrl).toBe("https://portal.cellexia.com/portal");
  });

  it("adds a humanDate companion for ISO date fields only", () => {
    const iso = "2026-08-04T12:00:00.000Z";
    const enriched = enrichPayload(
      { nextBillingDate: iso, title: "Regenerating Serum", quantity: 2 },
      "https://portal.cellexia.com",
    );
    expect(enriched.nextBillingDateHuman).toBe(humanDate(new Date(iso)));
    expect(enriched.nextBillingDate).toBe(iso); // original preserved
    expect(enriched).not.toHaveProperty("titleHuman");
    expect(enriched).not.toHaveProperty("quantityHuman");
  });
});

describe("dedupe-safe Klaviyo body building", () => {
  const baseInput = {
    metricName: "Cellexia Charge Failed",
    email: "customer@example.com",
    payload: { amountCents: 4900, errorCode: "insufficient_funds" },
    dedupeKey: "abc123",
    time: new Date("2026-07-21T09:00:00.000Z"),
  };

  it("is deterministic: identical inputs give identical bodies", () => {
    const a = buildKlaviyoEventBody({ ...baseInput });
    const b = buildKlaviyoEventBody({ ...baseInput });
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("carries the dedupe key as Klaviyo unique_id so retries cannot double-count", () => {
    const body = buildKlaviyoEventBody({ ...baseInput });
    expect(body.data.attributes.unique_id).toBe("abc123");
    const other = buildKlaviyoEventBody({ ...baseInput, dedupeKey: "def456" });
    expect(other.data.attributes.unique_id).not.toBe(
      body.data.attributes.unique_id,
    );
  });

  it("addresses the right metric and profile", () => {
    const body = buildKlaviyoEventBody({ ...baseInput });
    expect(body.data.type).toBe("event");
    expect(body.data.attributes.metric.data.attributes.name).toBe(
      "Cellexia Charge Failed",
    );
    expect(body.data.attributes.profile.data.attributes.email).toBe(
      "customer@example.com",
    );
    expect(body.data.attributes.properties).toEqual(baseInput.payload);
    expect(body.data.attributes.time).toBe("2026-07-21T09:00:00.000Z");
  });

  it("omits the time attribute when no occurrence time is given", () => {
    const body = buildKlaviyoEventBody({
      metricName: baseInput.metricName,
      email: baseInput.email,
      payload: baseInput.payload,
      dedupeKey: baseInput.dedupeKey,
    });
    expect(body.data.attributes.time).toBeUndefined();
  });
});
