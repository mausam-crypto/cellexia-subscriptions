/**
 * App-proxy storefront API: POST /apps/cellexia-subscriptions/api/events
 *
 * Widget telemetry (impressions, selections, conversions). Body (JSON), as
 * posted by the theme extension's tele()/track():
 *   { event, widget?: 'A'|'B'|'E'|'F', productId?, variantId?, qty?, planId?,
 *     experimentKey?, visitor?, path?, ts? }
 * `widgetType` / `variantKey` are also accepted directly. Field normalisation
 * lives in extractWidgetTelemetry (services/offers/widgets.server.ts) so the
 * persisted payload matches what analytics/metrics.server.ts reads
 * (widgetTypeOf / isSubscriptionSelection).
 *
 * Rows are written directly to AnalyticsEvent with
 * `name = "WIDGET_" + event.toUpperCase()`. These are storefront telemetry
 * names, deliberately distinct from the LIFECYCLE_EVENTS union, and are NOT
 * emitted through emitLifecycleEvent (no Klaviyo outbox, no dedupe needed).
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "~/db.server";
import { extractWidgetTelemetry } from "~/services/offers/widgets.server";
import { authenticate } from "~/shopify.server";

const MAX_EVENT_NAME_LENGTH = 40;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.public.appProxy(request);
  return json({ error: "Method not allowed" }, { status: 405 });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) {
    return json({ error: "App not installed" }, { status: 404 });
  }
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const rawEvent = typeof body.event === "string" ? body.event : "";
  const eventName = rawEvent
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .slice(0, MAX_EVENT_NAME_LENGTH);
  if (!eventName) {
    return json({ error: "Missing event" }, { status: 400 });
  }

  const fields = extractWidgetTelemetry(body);

  // Identity only from the HMAC-verified proxy parameter.
  const url = new URL(request.url);
  const loggedInCustomerId =
    url.searchParams.get("logged_in_customer_id") || null;

  await prisma.analyticsEvent.create({
    data: {
      shop: session.shop,
      name: `WIDGET_${eventName}`,
      shopifyCustomerId: loggedInCustomerId,
      payloadJson: JSON.stringify({ event: eventName, ...fields }),
    },
  });

  return json({ ok: true });
};
