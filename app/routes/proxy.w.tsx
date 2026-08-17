import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "~/shopify.server";
import { getPrimaryShop, requireShop } from "~/lib/shop/install.server";
import { getLaunchState } from "~/lib/launch/launch.server";
import { marketHandleForCountry } from "~/lib/design-measurement/markets.server";
import {
  TokenBucketLimiter,
  isBotUserAgent,
  parseVisitBeacon,
  recordVisit,
  visitDayKey,
} from "~/lib/design-measurement/visits.server";

/**
 * GET /apps/cellexia-subs/w?e=view|engage|atc&d=<design>&p=s|o|u&vid=…
 * (app proxy → this route): the buy-box VISIT BEACON (v1.27.0).
 *
 * The storefront embed fires this as an image request when the widget was
 * really on screen, when the shopper touched it and when our product was
 * added to the cart; the rows it writes (WidgetVisitorDay) are the
 * conversion denominator the Results tab pairs with SubscribableOrder.
 *
 * Contract with the storefront: the ONLY answer is 204 No Content with
 * Cache-Control: no-store. Never a 4xx/5xx to a shopper's browser: a beacon
 * is measurement, and measurement must not surface as a broken request in
 * a customer's console. Invalid input, a store not yet live, a crawler, a
 * flood, a database hiccup: all silently dropped. The one thing that is not
 * silent is the app-proxy signature: authenticate.public.appProxy runs
 * FIRST and rejects an unsigned request the way every proxy route does, so
 * nobody can write visit rows from outside the storefront.
 *
 * Gates, in order (cheapest first, so a flood never reaches the database):
 *   1. signature (Shopify HMAC over the whole query, our params included);
 *   2. param validation (parseVisitBeacon);
 *   3. bot User-Agent when the proxy forwards one;
 *   4. token buckets, per visitor id (60/min) and per shop (3,000/min):
 *      per-INSTANCE Maps, swept each minute (see TokenBucketLimiter);
 *   5. shop + launch mode: only a LIVE store records visits (SETUP renders
 *      the widget hidden anyway; the admin preview never sends beacons). The
 *      verdict is cached in-module for 60 s per shop so a busy product page
 *      costs one settings read a minute, not one per beacon;
 *   6. write: day = today in the shop timezone, market from the country via
 *      MarketCountryMap (null when unknown), then recordVisit's upsert.
 */

const VID_LIMIT_PER_MINUTE = 60;
const SHOP_LIMIT_PER_MINUTE = 3000;
const LIVE_VERDICT_TTL_MS = 60_000;

const vidBuckets = new TokenBucketLimiter(VID_LIMIT_PER_MINUTE);
const shopBuckets = new TokenBucketLimiter(SHOP_LIMIT_PER_MINUTE);
/** shopId → { live, expiresAt }: launch mode, cached one minute per shop. */
const liveVerdicts = new Map<string, { live: boolean; expiresAt: number }>();

async function isShopLive(shopId: string, now: number): Promise<boolean> {
  const cached = liveVerdicts.get(shopId);
  if (cached && cached.expiresAt > now) return cached.live;
  const live = (await getLaunchState(shopId)).mode === "LIVE";
  liveVerdicts.set(shopId, { live, expiresAt: now + LIVE_VERDICT_TTL_MS });
  return live;
}

const noContent = () =>
  new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Signature FIRST, outside the containment: an unsigned request gets the
  // library's own rejection, exactly like every other proxy route.
  const { session } = await authenticate.public.appProxy(request);

  try {
    const url = new URL(request.url);
    const beacon = parseVisitBeacon(url.searchParams);
    if (!beacon) return noContent();
    if (isBotUserAgent(request.headers.get("user-agent"))) return noContent();

    const now = new Date();
    const nowMs = now.getTime();
    // Single-shop app: the shop bucket is keyed by the proxy's shop domain
    // when present, so no database read is needed before the limiter runs.
    const shopKey = session?.shop ?? "primary";
    if (!vidBuckets.take(`${shopKey}:${beacon.vid}`, nowMs)) return noContent();
    if (!shopBuckets.take(shopKey, nowMs)) return noContent();

    const shop = session?.shop
      ? await requireShop(session.shop)
      : await getPrimaryShop();
    if (!shop) return noContent();
    if (!(await isShopLive(shop.id, nowMs))) return noContent();

    const marketHandle = await marketHandleForCountry(shop.id, beacon.countryCode);
    await recordVisit({
      shopId: shop.id,
      day: visitDayKey(now, shop.ianaTimezone),
      vid: beacon.vid,
      designKey: beacon.designKey,
      designPreselect: beacon.designPreselect,
      countryCode: beacon.countryCode,
      marketHandle,
      deviceType: beacon.deviceType,
      event: beacon.event,
      mode: beacon.mode,
      now,
    });
  } catch (err) {
    // Contained: measurement never answers with an error. Logged with the
    // house prefix so the failure still shows in the server log.
    console.error("[visits] beacon dropped", err);
  }
  return noContent();
};
