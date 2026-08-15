/**
 * POST /api/survey — the post-purchase survey endpoint (v1.21.0).
 *
 * Called by the checkout UI extension (extensions/cellexia-survey) from the
 * Thank You and Order Status pages with a Shopify session token in the
 * Authorization header. `authenticate.public.checkout` answers the CORS
 * preflight itself, rejects missing/forged/expired tokens with a bare 401,
 * and verifies the HS256 signature against the app secret; we additionally
 * pin the audience to our own client id (the library deliberately skips
 * that check) and resolve the shop from the token's `dest` claim — the only
 * request fields the server trusts are the token's claims.
 *
 * Three kinds, one action (extensions send POST for everything; OPTIONS is
 * eaten by the authenticator):
 *   - status:     { kind, orderId }             → { ok, enabled, answered, completed }
 *   - impression: { kind, orderId, source, … }  → { ok }   (creates the shown-not-answered row)
 *   - answer:     { kind, orderId, source, question, option, … } → { ok, completed }
 *
 * Response conventions (api.sms.inbound.tsx family): 400 invalid_body,
 * business rejections { ok:false, message } WITH 200 (the extension must
 * never retry-storm), 500 on unexpected failure, every write path audited
 * via contained logEvent. Answer values are validated against the frozen
 * instrument in app/lib/survey/shared.ts — unknown questions/options are
 * rejected, never stored.
 *
 * Order↔customer binding (v1.22.0): body.orderId is client-supplied and
 * guessable, so writes are bound to the token's customer — a row or contract
 * claimed by a different customer rejects with `not_your_order`, tokens
 * without a customer may only merge into existing rows (never create), and
 * the status read hides another customer's answers. linkSurveyForContract
 * re-enforces the identity at the analytics gate for rows written inside the
 * webhook race window.
 */

import { json, type ActionFunctionArgs } from "@remix-run/node";
import { z } from "zod";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { logEvent } from "~/lib/events/log.server";
import { requireShop } from "~/lib/shop/install.server";
import { getSetting } from "~/lib/settings/settings.server";
import {
  SURVEY_QUESTION_SET_VERSION,
  SURVEY_SOURCES,
  isValidSurveyAnswer,
} from "~/lib/survey/shared";
import {
  getSurveyOrderStatus,
  recordSurveyWrite,
} from "~/lib/survey/service.server";

const orderGid = z
  .string()
  .regex(/^gid:\/\/shopify\/Order\/\d+$/, "order gid required");

const bodySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("status"),
    orderId: orderGid,
  }),
  z.object({
    kind: z.literal("impression"),
    orderId: orderGid,
    source: z.enum(SURVEY_SOURCES),
    locale: z.string().max(16).optional(),
    questionSetVersion: z.literal(SURVEY_QUESTION_SET_VERSION),
  }),
  z.object({
    kind: z.literal("answer"),
    orderId: orderGid,
    source: z.enum(SURVEY_SOURCES),
    locale: z.string().max(16).optional(),
    questionSetVersion: z.literal(SURVEY_QUESTION_SET_VERSION),
    question: z.string().min(1).max(64),
    option: z.string().min(1).max(64),
  }),
]);

/** No loader — GET is not served; the extension always POSTs. */
export const action = async ({ request }: ActionFunctionArgs) => {
  // Throws the OPTIONS preflight response and 401s invalid tokens itself.
  const { sessionToken, cors } = await authenticate.public.checkout(request);

  // The library skips the audience check ({ checkAudience: false }); pin it
  // so a token minted for another app on the same shop is refused.
  const expectedAud = process.env.SHOPIFY_API_KEY;
  const aud = sessionToken.aud;
  const audMatches = Array.isArray(aud)
    ? aud.includes(expectedAud ?? "")
    : aud === expectedAud;
  if (!expectedAud || !audMatches) {
    return cors(json({ error: "unauthorized" }, { status: 401 }));
  }

  if (request.method !== "POST") {
    return cors(json({ error: "method_not_allowed" }, { status: 405 }));
  }

  // dest is a URL ("https://shop.myshopify.com"); requireShop wants the bare domain.
  const shopDomain = String(sessionToken.dest ?? "").replace(/^https?:\/\//, "");
  let shop;
  try {
    shop = await requireShop(shopDomain);
  } catch {
    return cors(json({ error: "unauthorized" }, { status: 401 }));
  }

  let rawBody: unknown = null;
  try {
    rawBody = await request.json();
  } catch {
    rawBody = null;
  }
  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return cors(json({ ok: false, message: "invalid_body" }, { status: 400 }));
  }
  const body = parsed.data;

  try {
    const surveySettings = await getSetting(shop.id, "survey");

    // Customer identity from the verified token only — never from the body.
    const sub = typeof sessionToken.sub === "string" ? sessionToken.sub : null;
    const customerId =
      sub && sub.startsWith("gid://shopify/Customer/") ? sub : null;

    if (body.kind === "status") {
      const status = await getSurveyOrderStatus(shop.id, body.orderId, customerId);
      return cors(json({ ok: true, ...status }));
    }

    if (!surveySettings.enabled) {
      return cors(json({ ok: false, message: "disabled" }));
    }

    // ── Order↔customer binding ────────────────────────────────────────────
    // The token authenticates a SHOPPER; body.orderId is client-supplied and
    // numeric order ids are guessable. Without this binding any shopper
    // could write answers against another customer's order — poisoning that
    // contract's churn-risk features, predicted LTGP and the survey.answered
    // Klaviyo event (which emails the VICTIM). Three rules, fail-closed:
    //   1. a row already claimed by a different customer is never writable;
    //   2. an order whose contract mirror names a different customer is
    //      never writable (ownership is checked regardless of OURS/FOREIGN —
    //      identity evidence is identity evidence);
    //   3. a token with no customer (logged-out order-status revisit) may
    //      only MERGE into an existing row, never create one — subscription
    //      checkouts always have a customer, so the creating write on the
    //      thank-you page always carries the sub claim.
    // linkSurveyForContract enforces the same identity at link time, so a
    // row that slips through the race window still never reaches analytics.
    const [existingRow, orderContract] = await Promise.all([
      prisma.surveyResponse.findUnique({
        where: { orderId: body.orderId },
        select: { customerId: true },
      }),
      prisma.subscriptionContract.findFirst({
        where: { shopId: shop.id, originOrderId: body.orderId, isDemo: false },
        select: { customerId: true },
      }),
    ]);
    if (
      customerId &&
      existingRow?.customerId &&
      existingRow.customerId !== customerId
    ) {
      return cors(json({ ok: false, message: "not_your_order" }));
    }
    if (
      customerId &&
      orderContract?.customerId &&
      orderContract.customerId !== customerId
    ) {
      return cors(json({ ok: false, message: "not_your_order" }));
    }
    if (!customerId && !existingRow) {
      return cors(json({ ok: false, message: "not_your_order" }));
    }

    // Abuse ceiling: shop-wide writes per rolling hour. The per-order unique
    // key bounds rows per real order; this bounds synthetic-order spam.
    const hourAgo = new Date(Date.now() - 3600_000);
    const recentWrites = await prisma.surveyResponse.count({
      where: { shopId: shop.id, updatedAt: { gte: hourAgo } },
    });
    if (recentWrites >= surveySettings.writesPerHour) {
      await logEvent({
        shopId: shop.id,
        type: "admin.action",
        source: "SYSTEM",
        actor: "system",
        payload: { action: "survey_rate_limited", orderId: body.orderId },
      });
      return cors(json({ ok: false, message: "rate_limited" }));
    }

    if (body.kind === "answer" && !isValidSurveyAnswer(body.question, body.option)) {
      return cors(json({ ok: false, message: "unknown_answer" }));
    }

    const { response } = await recordSurveyWrite(shop.id, {
      orderId: body.orderId,
      source: body.source,
      locale: body.locale ?? null,
      customerId,
      answer:
        body.kind === "answer"
          ? { question: body.question, option: body.option }
          : null,
    });

    return cors(
      json({ ok: true, completed: Boolean(response.completedAt) }),
    );
  } catch (err) {
    console.error("[survey] write failed", body.orderId, err);
    return cors(json({ ok: false, message: "internal_error" }, { status: 500 }));
  }
};
