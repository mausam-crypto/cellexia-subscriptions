import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "~/shopify.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import { isKlaviyoConfigured } from "~/lib/klaviyo/client.server";
import { readCachedCoverage } from "~/lib/klaviyo/flows.server";
import { cachedCoverageRows, getFlowTask } from "~/lib/klaviyo/setup-task.server";

/**
 * Polling endpoint for the Klaviyo delivery setup page (v1.25.0):
 * `/app/emails/setup/status`. Returns the current background task (verify
 * or setup) plus the cached checklist — DB reads only, never a Klaviyo
 * call, so polling every 1.5 s costs nothing against Klaviyo's limits.
 * Resource route (no default export): the escaped file name keeps it out
 * of the setup page's and the overview's route nesting.
 *
 * `Cache-Control: no-store` is exported through the route `headers`
 * function, not only on the loader Response: the page polls with
 * `fetcher.load`, which under `v3_singleFetch` becomes a `.data` request
 * whose wire headers come from `headers` (loader Response headers other
 * than Set-Cookie are dropped there). A caching proxy must never serve a
 * stale task record.
 */
const NO_STORE = { "Cache-Control": "no-store" } as const;

export const headers: HeadersFunction = () => ({ ...NO_STORE });

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const shop = await getPrimaryShop();
  if (!shop) {
    throw new Response("App is not installed on any shop", { status: 503 });
  }
  const [configured, task, cached] = await Promise.all([
    isKlaviyoConfigured(shop.id).catch(() => false),
    getFlowTask(shop.id),
    readCachedCoverage(shop.id),
  ]);
  const rows = await cachedCoverageRows(shop.id, cached);
  return json(
    {
      configured,
      task,
      cached: {
        checkedAt: cached.checkedAt,
        setupRanAt: cached.setupRanAt,
        rows,
      },
    },
    { headers: { ...NO_STORE } },
  );
};
