import { timingSafeEqual } from "node:crypto";
import { json, type ActionFunctionArgs } from "@remix-run/node";
import { z } from "zod";
import prisma from "~/db.server";
import { t } from "~/lib/i18n/i18n.server";
import { formatShopDate } from "~/lib/dates.server";
import { delayNextCycle, skipNextCycle } from "~/lib/contracts/service.server";
import { OURS_ONLY } from "~/lib/ownership/ownership.server";

/**
 * POST /api/sms/inbound — Klaviyo SMS keyword webhook ("text-to-skip").
 *
 * Klaviyo flows POST `{ phone, keyword }` here when a subscriber replies with
 * a keyword; the JSON `message` in the response can be sent back as the SMS
 * reply. Auth: `x-cellexia-secret` must equal env CRON_SECRET (fail closed).
 *
 * Keywords: SKIP → skip next cycle; DELAY → push next cycle 2 weeks. All
 * mutations go through the contract services with source MAGIC_LINK / actor
 * "sms" (one-tap-verb semantics, no login), which log the canonical events.
 *
 * Unknown phone or keyword → `{ ok: false }` with 200 so Klaviyo does not
 * retry-storm; unexpected failures → 500 (skip/delay are idempotent, retries
 * are safe). No loader — GET is not served.
 */

const DELAY_WEEKS = 2;

const bodySchema = z.object({
  phone: z.string().min(5),
  keyword: z.string().min(1),
});

function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Klaviyo may send JSON or form-encoded — accept both. */
async function readBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return await request.json();
    } catch {
      return null;
    }
  }
  try {
    const form = await request.formData();
    return Object.fromEntries(form.entries());
  } catch {
    return null;
  }
}

function normalizeDigits(phone: string): string {
  return phone.replace(/\D+/g, "");
}

interface MatchedContract {
  id: string;
  locale: string;
  shopDomain: string;
  ianaTimezone: string;
}

/**
 * Newest ACTIVE contract whose phone matches on the last 10 digits (stored
 * formats vary: +44 7911..., (415) 555-..., so match on normalized suffix).
 *
 * OURS_ONLY + isDemo:false, because the keywords this resolves to are
 * MUTATIONS: SKIP and DELAY both call the contract services, which edit the
 * billing schedule ON SHOPIFY. The store may run a second subscription app,
 * and its subscribers' phone numbers are in this table too — mirrored by the
 * shared SUBSCRIPTION_CONTRACTS_* webhooks. Without the filter, a Joy
 * subscriber texting SKIP would have Cellexia reschedule a contract Joy is
 * billing, and get a confirmation SMS from an app they never signed up to.
 * The reply for a phone we do not manage is the same "unknown phone" the
 * caller already handles — the other app's own keyword flow is what should
 * answer it.
 */
async function findContractByPhone(
  phone: string,
): Promise<MatchedContract | null> {
  const digits = normalizeDigits(phone);
  if (digits.length < 7) return null;
  const last10 = digits.slice(-10);

  const candidates = await prisma.subscriptionContract.findMany({
    where: { status: "ACTIVE", phone: { not: null }, isDemo: false, ...OURS_ONLY },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      phone: true,
      locale: true,
      shop: { select: { domain: true, ianaTimezone: true } },
    },
  });

  for (const candidate of candidates) {
    const d = normalizeDigits(candidate.phone ?? "");
    if (d.length >= 7 && d.slice(-10) === last10) {
      return {
        id: candidate.id,
        locale: candidate.locale,
        shopDomain: candidate.shop.domain,
        ianaTimezone: candidate.shop.ianaTimezone,
      };
    }
  }
  return null;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, { status: 405 });
  }

  const expected = process.env.CRON_SECRET;
  const provided = request.headers.get("x-cellexia-secret");
  // Fail closed when CRON_SECRET is unset — never an open mutation endpoint.
  if (!expected || !provided || !secretsMatch(provided, expected)) {
    return json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await readBody(request));
  if (!parsed.success) {
    return json({ ok: false, message: "invalid_body" }, { status: 400 });
  }
  const { phone, keyword } = parsed.data;

  const contract = await findContractByPhone(phone);
  if (!contract) {
    return json(
      { ok: false, message: t("en", "magic.sms.unknown_phone") },
      { status: 200 },
    );
  }

  const { locale } = contract;
  // First word only — subscribers text "SKIP please" etc.
  const verb = keyword.trim().toUpperCase().split(/\s+/)[0];
  const opts = { source: "MAGIC_LINK" as const, actor: "sms" };

  try {
    switch (verb) {
      case "SKIP": {
        const updated = await skipNextCycle(contract.shopDomain, contract.id, opts);
        const message = updated.nextBillingDate
          ? t(locale, "magic.sms.skip_done", {
              date: formatShopDate(
                updated.nextBillingDate,
                contract.ianaTimezone,
                locale,
              ),
            })
          : t(locale, "magic.sms.skip_done_nodate");
        return json({ ok: true, message });
      }

      case "DELAY": {
        const updated = await delayNextCycle(
          contract.shopDomain,
          contract.id,
          { weeks: DELAY_WEEKS },
          opts,
        );
        const message = updated.nextBillingDate
          ? t(locale, "magic.sms.delay_done", {
              date: formatShopDate(
                updated.nextBillingDate,
                contract.ianaTimezone,
                locale,
              ),
            })
          : t(locale, "magic.sms.delay_done_nodate");
        return json({ ok: true, message });
      }

      default:
        return json(
          { ok: false, message: t(locale, "magic.sms.unknown_keyword") },
          { status: 200 },
        );
    }
  } catch (err) {
    console.error("[sms-inbound] keyword action failed", verb, contract.id, err);
    return json(
      { ok: false, message: t(locale, "magic.sms.error") },
      { status: 500 },
    );
  }
};
