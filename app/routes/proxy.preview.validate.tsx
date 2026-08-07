import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { verifyMagicTokenSignature } from "~/lib/crypto/tokens.server";
import { authenticate } from "~/shopify.server";

/**
 * GET /apps/cellexia/preview/validate?token=... (app proxy → this route).
 *
 * Storefront-preview token check for the buy-box launch gate: while the app
 * is in setup mode the theme block renders hidden, and buy-box.js calls this
 * endpoint before revealing the widget in the admin's own browser session.
 *
 * Signature + expiry verified, never consumed — the same link must keep
 * working for the whole preview TTL — and restricted to action "PREVIEW" so
 * no other magic token can be repurposed as a reveal key. Every outcome is a
 * 200 { ok: boolean }: invalid input is a normal answer here, never a 500.
 * Cache-Control: no-store keeps CDNs from pinning a stale verdict.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.public.appProxy(request);

  let ok = false;
  try {
    const token = new URL(request.url).searchParams.get("token") ?? "";
    if (token) {
      const result = verifyMagicTokenSignature(token);
      if (result.ok) {
        // Widened to string so the check is independent of the MagicAction union.
        const action: string = result.payload.action;
        ok = action === "PREVIEW";
      }
    }
  } catch {
    ok = false;
  }

  return json({ ok }, { headers: { "Cache-Control": "no-store" } });
};
