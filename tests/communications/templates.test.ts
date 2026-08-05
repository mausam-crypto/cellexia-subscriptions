/**
 * Guards the merchant-facing Klaviyo blueprint (SUGGESTED_FLOWS) against
 * drifting from the payloads the emitters actually deliver. Every
 * {placeholder} in a copy skeleton must resolve, at flow-build time, to:
 * - a key of the corresponding emitter's event payload,
 * - a documented enrichment ({portalUrl} added in klaviyo.server.ts,
 *   {firstName} from the Klaviyo profile), or
 * - the `<dateField>Human` companion of an emitted ISO-date field.
 *
 * When an emitter's payload changes, update EMITTED_PAYLOADS below — and
 * remember that renaming an emitted key breaks any Klaviyo flow merchants
 * have already built on the old property name.
 */
import { describe, expect, it } from "vitest";
import type { LifecycleEvent } from "~/types/domain";
import {
  SUGGESTED_FLOWS,
  type SuggestedFlow,
} from "~/services/communications/templates.server";

/** Fields available on every event regardless of emitter. */
const GLOBAL_FIELDS = ["portalUrl", "firstName"];

interface PayloadContract {
  /** Non-date payload keys delivered with the event. */
  keys: string[];
  /** ISO-date payload keys; enrichment adds a `<key>Human` companion. */
  dateKeys?: string[];
}

/**
 * Payload keys delivered with each blueprint trigger event, per emitter.
 * Events whose skeleton only uses GLOBAL_FIELDS list no extra keys. Events
 * without an emitter yet (scheduler contracts) document the intended payload.
 */
const EMITTED_PAYLOADS: Partial<Record<LifecycleEvent, PayloadContract>> = {
  SUBSCRIPTION_STARTED: { keys: [] },
  // Pre-billing scheduler contract (no emitter yet).
  FIRST_CHARGE_APPROACHING: { keys: [], dateKeys: ["nextBillingDate"] },
  CHARGE_COMPLETED: { keys: [] },
  CHARGE_FAILED: { keys: [] },
  // retention/dunning.server.ts (pre-dunning scan)
  CARD_EXPIRING: {
    keys: ["message", "cardLastDigits", "cardExpiryMonth", "cardExpiryYear"],
    dateKeys: ["nextBillingDate"],
  },
  // offers/preShipment.server.ts
  PRE_SHIPMENT_WINDOW_OPEN: {
    keys: [
      "intervalWeeks",
      "currencyCode",
      "expectedOrderValueCents",
      "candidates",
      "amountToGiftCents",
      "giftThresholdCents",
    ],
    dateKeys: ["nextBillingDate"],
  },
  // Resume scheduler contract (no emitter yet).
  PAUSE_ENDING: { keys: [], dateKeys: ["resumeDate"] },
  // treatment/milestones.server.ts
  TREATMENT_MILESTONE: { keys: ["kind", "milestone", "reward"] },
  CANCELLATION_SAVED: { keys: [] },
  CANCELLATION_COMPLETED: { keys: [] },
  // portal/auth.server.ts (requestMagicLink)
  MAGIC_LINK_REQUESTED: { keys: ["link", "expiresMinutes"] },
  HIGH_CHURN_RISK: { keys: [] },
  LIKELY_EXCESS_INVENTORY: { keys: [] },
  // core/webhooks/handlers.server.ts
  PRODUCT_BACK_IN_STOCK: { keys: ["productId", "title"] },
  SUBSCRIBER_ANNIVERSARY: { keys: [] },
};

/** Matches {placeholder} but not Klaviyo tag syntax like {% for ... %}. */
const PLACEHOLDER_RE = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

function extractPlaceholders(flow: SuggestedFlow): string[] {
  const texts = [
    flow.copySkeleton.subject,
    flow.copySkeleton.preview,
    ...flow.copySkeleton.body,
  ];
  const found: string[] = [];
  for (const text of texts) {
    for (const match of text.matchAll(PLACEHOLDER_RE)) {
      found.push(match[1]!);
    }
  }
  return found;
}

describe("SUGGESTED_FLOWS placeholders", () => {
  it("has a payload contract for every flow trigger event", () => {
    for (const flow of SUGGESTED_FLOWS) {
      expect(
        EMITTED_PAYLOADS[flow.triggerEvent],
        `no payload contract for ${flow.triggerEvent} (flow "${flow.key}") — add its emitted keys to EMITTED_PAYLOADS`,
      ).toBeDefined();
    }
  });

  it("only references delivered event properties (or Human date companions)", () => {
    for (const flow of SUGGESTED_FLOWS) {
      const contract = EMITTED_PAYLOADS[flow.triggerEvent];
      if (!contract) continue; // reported by the previous test
      const dateKeys = contract.dateKeys ?? [];
      const allowed = new Set([
        ...GLOBAL_FIELDS,
        ...contract.keys,
        ...dateKeys,
        ...dateKeys.map((key) => `${key}Human`),
      ]);
      for (const placeholder of extractPlaceholders(flow)) {
        expect(
          allowed.has(placeholder),
          `flow "${flow.key}" references {${placeholder}}, which is not delivered with ${flow.metricName}`,
        ).toBe(true);
      }
    }
  });
});
