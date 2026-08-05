/**
 * App-proxy storefront API: GET /apps/cellexia-subscriptions/api/widget-config
 *
 * Returns the resolved widget for a storefront context:
 *   { widgetType, settings, cadenceDefaults, experimentKey?, suggestedIntervalWeeks? }
 *
 * Query params (all optional): product_id, market, src (traffic source), qty,
 * widget (widget type filter), visitor (anonymous bucketing token — used only
 * for experiment assignment, never as identity). `returning` derives solely
 * from the HMAC-verified `logged_in_customer_id` the proxy appends; no other
 * query parameter is ever trusted for identity.
 */
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "~/shopify.server";
import {
  cadenceFromDefaults,
  isWidgetType,
  resolveWidget,
} from "~/services/offers/widgets.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) {
    return json({ error: "App not installed" }, { status: 404 });
  }

  const url = new URL(request.url);
  const productId = url.searchParams.get("product_id") ?? undefined;
  const market = url.searchParams.get("market") ?? undefined;
  const trafficSource = url.searchParams.get("src") ?? undefined;
  const widgetParam = url.searchParams.get("widget") ?? "";
  const widgetType = isWidgetType(widgetParam) ? widgetParam : undefined;

  // Identity: only the verified logged_in_customer_id, appended by Shopify
  // after HMAC verification. The `visitor` param is an anonymous bucketing
  // token only (experiment assignment), never identity.
  const loggedInCustomerId =
    url.searchParams.get("logged_in_customer_id") || null;
  const returning = Boolean(loggedInCustomerId);
  const anonymousVisitor = url.searchParams.get("visitor") ?? undefined;
  const visitorKey = loggedInCustomerId ?? anonymousVisitor;

  const resolved = await resolveWidget(session.shop, {
    productId,
    market,
    trafficSource,
    returning,
    visitorKey,
    widgetType,
  });

  const qtyRaw = url.searchParams.get("qty");
  const qty = qtyRaw ? Number.parseInt(qtyRaw, 10) : Number.NaN;
  const suggestedIntervalWeeks =
    Number.isFinite(qty) && qty > 0
      ? cadenceFromDefaults(resolved.cadenceDefaults, qty)
      : null;

  return json(
    {
      widgetType: resolved.widgetType,
      settings: resolved.settings,
      cadenceDefaults: resolved.cadenceDefaults,
      ...(resolved.experimentKey
        ? { experimentKey: resolved.experimentKey }
        : {}),
      ...(suggestedIntervalWeeks !== null ? { suggestedIntervalWeeks } : {}),
    },
    { headers: { "Cache-Control": "public, max-age=60" } },
  );
};
