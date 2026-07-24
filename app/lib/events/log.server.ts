import prisma from "~/db.server";

export type EventSource =
  | "SYSTEM"
  | "WEBHOOK"
  | "ADMIN"
  | "CUSTOMER_PORTAL"
  | "MAGIC_LINK"
  | "SCHEDULER"
  | "KLAVIYO";

export interface LogEventInput {
  shopId: string;
  type: string; // dot-namespaced, e.g. "contract.created", "cycle.skipped", "dunning.retry_scheduled"
  source: EventSource;
  contractId?: string | null;
  customerId?: string | null;
  email?: string | null;
  actor?: string | null; // admin email, "customer", "system"
  payload?: Record<string, unknown>;
}

/**
 * Single funnel for every subscriber-affecting event. Writes the immutable
 * event log (timeline + audit + compliance) and forwards to the Klaviyo outbox
 * for event types that power flows/segments.
 *
 * Never throws — an analytics write must never break a billing operation.
 */
export async function logEvent(input: LogEventInput): Promise<void> {
  try {
    await prisma.subscriberEvent.create({
      data: {
        shopId: input.shopId,
        contractId: input.contractId ?? null,
        customerId: input.customerId ?? null,
        email: input.email ?? null,
        type: input.type,
        source: input.source,
        actor: input.actor ?? null,
        payload: (input.payload ?? {}) as object,
      },
    });
  } catch (err) {
    console.error("[events] failed to write event log", input.type, err);
  }

  try {
    // Klaviyo mapping lives in the Klaviyo module; lazy import avoids cycles.
    const { enqueueKlaviyoForEvent } = await import(
      "~/lib/klaviyo/events-map.server"
    );
    await enqueueKlaviyoForEvent(input);
  } catch (err) {
    console.error("[events] klaviyo enqueue failed", input.type, err);
  }
}

/** Timeline for one contract, newest first. */
export async function contractTimeline(contractId: string, limit = 200) {
  return prisma.subscriberEvent.findMany({
    where: { contractId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
