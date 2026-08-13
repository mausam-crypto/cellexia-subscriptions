import { timingSafeEqual } from "node:crypto";
import { json, type ActionFunctionArgs } from "@remix-run/node";
import { z } from "zod";
import prisma from "~/db.server";
import { t } from "~/lib/i18n/i18n.server";
import { formatShopDate } from "~/lib/dates.server";
import { getSetting } from "~/lib/settings/settings.server";
import { logEvent } from "~/lib/events/log.server";
import { sha256 } from "~/lib/crypto/tokens.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import { delayNextCycle, skipNextCycle } from "~/lib/contracts/service.server";
import { resolveLockState } from "~/lib/contracts/lock.server";
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
 * STOP → win-back opt-out, handled here directly (see handleStop) — the only
 * writer of WinbackState.OPTED_OUT.
 *
 * Audit: every inbound intent logs a portal.sms_inbound event before its
 * response goes out — the magic-link rule ("every tapped link leaves a
 * trace, even if the verb fails") applies to texted verbs too, and rejected
 * intents (unknown phone = a data-quality signal on stored numbers, unknown
 * keyword = what customers actually try) were previously invisible. The
 * payload carries the hashed phone + last 4 digits and a capped keyword
 * excerpt — never the raw number or full free text.
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
  shopId: string;
  customerId: string;
  email: string;
  locale: string;
  shopDomain: string;
  ianaTimezone: string;
}

/**
 * Contracts whose phone matches on the last 10 digits (stored formats vary:
 * +44 7911..., (415) 555-..., so match on normalized suffix), newest first.
 *
 * OURS_ONLY + isDemo:false, because the keywords this resolves to are
 * MUTATIONS: SKIP and DELAY both call the contract services, which edit the
 * billing schedule ON SHOPIFY (and STOP suppresses OUR win-back campaign).
 * The store may run a second subscription app, and its subscribers' phone
 * numbers are in this table too — mirrored by the shared
 * SUBSCRIPTION_CONTRACTS_* webhooks. Without the filter, a Joy subscriber
 * texting SKIP would have Cellexia reschedule a contract Joy is billing, and
 * get a confirmation SMS from an app they never signed up to. The reply for
 * a phone we do not manage is the same "unknown phone" the caller already
 * handles — the other app's own keyword flow is what should answer it.
 *
 * `activeOnly` matches the verb's target: schedule verbs act on the ACTIVE
 * contract; STOP must also see CANCELLED ones (the win-back audience).
 */
async function contractsMatchingPhone(
  phone: string,
  opts: { activeOnly: boolean },
): Promise<MatchedContract[]> {
  const digits = normalizeDigits(phone);
  if (digits.length < 7) return [];
  const last10 = digits.slice(-10);

  const candidates = await prisma.subscriptionContract.findMany({
    where: {
      ...(opts.activeOnly ? { status: "ACTIVE" as const } : {}),
      phone: { not: null },
      isDemo: false,
      ...OURS_ONLY,
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      phone: true,
      shopId: true,
      customerId: true,
      email: true,
      locale: true,
      shop: { select: { domain: true, ianaTimezone: true } },
    },
  });

  const matches: MatchedContract[] = [];
  for (const candidate of candidates) {
    const d = normalizeDigits(candidate.phone ?? "");
    if (d.length >= 7 && d.slice(-10) === last10) {
      matches.push({
        id: candidate.id,
        shopId: candidate.shopId,
        customerId: candidate.customerId,
        email: candidate.email,
        locale: candidate.locale,
        shopDomain: candidate.shop.domain,
        ianaTimezone: candidate.shop.ianaTimezone,
      });
    }
  }
  return matches;
}

/** Newest ACTIVE contract for the phone — the schedule verbs' target. */
async function findContractByPhone(
  phone: string,
): Promise<MatchedContract | null> {
  return (await contractsMatchingPhone(phone, { activeOnly: true }))[0] ?? null;
}

/**
 * portal.sms_inbound audit event — one per inbound message, whatever the
 * outcome. Contained: an audit failure must never change the SMS reply.
 * Unknown phones have no contract to borrow a shopId from, so the primary
 * shop anchors those events (single-shop app; no shop yet = nothing to log
 * against).
 */
async function auditInboundSms(entry: {
  contract: MatchedContract | null;
  phone: string;
  keyword: string;
  outcome: "ok" | "unknown_phone" | "unknown_keyword" | "locked" | "error";
}): Promise<void> {
  try {
    const shopId =
      entry.contract?.shopId ?? (await getPrimaryShop())?.id ?? null;
    if (!shopId) return;
    const digits = normalizeDigits(entry.phone);
    await logEvent({
      shopId,
      contractId: entry.contract?.id ?? null,
      customerId: entry.contract?.customerId ?? null,
      email: entry.contract?.email ?? null,
      type: "portal.sms_inbound",
      source: "KLAVIYO",
      actor: "sms",
      payload: {
        verb: entry.keyword.trim().toUpperCase().split(/\s+/)[0].slice(0, 32),
        outcome: entry.outcome,
        phoneLast4: digits.slice(-4),
        phoneHash: sha256(digits),
        matched: entry.contract != null,
      },
    });
  } catch (err) {
    console.error("[sms-inbound] audit event failed", err);
  }
}

/**
 * STOP — the win-back opt-out writer, the only code path that enters the
 * OPTED_OUT state scheduleWinback has always guarded on. Matches the phone
 * across contracts of ANY status: win-back texts go to CANCELLED
 * subscribers, exactly who the ACTIVE-only matcher cannot see. Every ACTIVE
 * campaign belonging to the matched customer(s) flips OPTED_OUT (optedOutAt
 * stamped, pending touch cleared) and logs winback.opted_out; the
 * scheduleWinback guard then refuses any restart. The confirmation is sent
 * even when no campaign is currently ACTIVE — the customer asked to stop,
 * and "unknown phone" is only for numbers we cannot attribute at all.
 */
async function handleStop(phone: string, keyword: string) {
  const matches = await contractsMatchingPhone(phone, { activeOnly: false });
  if (matches.length === 0) {
    await auditInboundSms({
      contract: null,
      phone,
      keyword,
      outcome: "unknown_phone",
    });
    return json(
      { ok: false, message: t("en", "magic.sms.unknown_phone") },
      { status: 200 },
    );
  }

  const newest = matches[0];
  const { locale } = newest;
  try {
    // Campaigns may live on the customer's OTHER contracts (an old number on
    // a previous contract) — opt out by customer, not just by matched row.
    const customerIds = [...new Set(matches.map((m) => m.customerId))];
    const contracts = await prisma.subscriptionContract.findMany({
      where: {
        shopId: newest.shopId,
        customerId: { in: customerIds },
        isDemo: false,
        ...OURS_ONLY,
      },
      select: { id: true, customerId: true, email: true },
    });
    const byContractId = new Map(contracts.map((c) => [c.id, c]));

    const states = await prisma.winbackState.findMany({
      where: {
        contractId: { in: contracts.map((c) => c.id) },
        status: "ACTIVE",
      },
    });
    const now = new Date();
    if (states.length > 0) {
      await prisma.winbackState.updateMany({
        where: { id: { in: states.map((s) => s.id) } },
        data: { status: "OPTED_OUT", optedOutAt: now, nextTouchAt: null },
      });
    }
    for (const state of states) {
      const contract = byContractId.get(state.contractId);
      await logEvent({
        shopId: newest.shopId,
        contractId: state.contractId,
        customerId: contract?.customerId ?? null,
        email: contract?.email ?? null,
        type: "winback.opted_out",
        source: "KLAVIYO",
        actor: "sms",
        payload: {
          stateId: state.id,
          stage: state.stage,
          via: "sms_stop",
          optedOutAt: now.toISOString(),
        },
      });
    }

    await auditInboundSms({ contract: newest, phone, keyword, outcome: "ok" });
    return json({ ok: true, message: t(locale, "magic.sms.stop_done") });
  } catch (err) {
    console.error("[sms-inbound] keyword action failed", "STOP", newest.id, err);
    await auditInboundSms({
      contract: newest,
      phone,
      keyword,
      outcome: "error",
    });
    return json(
      { ok: false, message: t(locale, "magic.sms.error") },
      { status: 500 },
    );
  }
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

  // First word only — subscribers text "SKIP please" etc.
  const verb = keyword.trim().toUpperCase().split(/\s+/)[0];

  // STOP dispatches before the ACTIVE-only match: it is the win-back
  // opt-out, and its audience is CANCELLED subscribers — the matcher below
  // would answer exactly them with "unknown phone".
  if (verb === "STOP") {
    return handleStop(phone, keyword);
  }

  const contract = await findContractByPhone(phone);
  if (!contract) {
    await auditInboundSms({
      contract: null,
      phone,
      keyword,
      outcome: "unknown_phone",
    });
    return json(
      { ok: false, message: t("en", "magic.sms.unknown_phone") },
      { status: 200 },
    );
  }

  const { locale } = contract;
  const opts = { source: "MAGIC_LINK" as const, actor: "sms" };

  // ── Plan lock window: SKIP and DELAY are reducing verbs ────────────────────
  // Same blocked set as the portal dispatcher and magic links. The phone
  // match carries no lock inputs, so they are fetched here — only for the
  // two verbs the lock can refuse.
  if (verb === "SKIP" || verb === "DELAY") {
    const lockable = await prisma.subscriptionContract.findUnique({
      where: { id: contract.id },
      select: {
        lockDays: true,
        firstChargeAt: true,
        createdAt: true,
        lines: { select: { sellingPlanId: true } },
      },
    });
    const lock = lockable
      ? await resolveLockState(contract.shopId, lockable, contract.ianaTimezone)
      : null;
    if (lock?.locked && lock.until) {
      await auditInboundSms({ contract, phone, keyword, outcome: "locked" });
      // Friendly variant (v1.19.0, portal.friendlyLockMessaging): the reply
      // frames the date as when skips UNLOCK and names what stays possible,
      // instead of the bare refusal. Failure-contained settings read —
      // classic copy on any problem.
      const date = formatShopDate(lock.until, contract.ianaTimezone, locale);
      let friendly = false;
      try {
        friendly = (await getSetting(contract.shopId, "portal"))
          .friendlyLockMessaging;
      } catch {
        friendly = false;
      }
      return json({
        ok: false,
        message: t(
          locale,
          friendly ? "magic.sms.locked_friendly" : "magic.sms.locked",
          { date },
        ),
      });
    }
  }

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
        await auditInboundSms({ contract, phone, keyword, outcome: "ok" });
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
        await auditInboundSms({ contract, phone, keyword, outcome: "ok" });
        return json({ ok: true, message });
      }

      default:
        await auditInboundSms({
          contract,
          phone,
          keyword,
          outcome: "unknown_keyword",
        });
        return json(
          { ok: false, message: t(locale, "magic.sms.unknown_keyword") },
          { status: 200 },
        );
    }
  } catch (err) {
    console.error("[sms-inbound] keyword action failed", verb, contract.id, err);
    await auditInboundSms({ contract, phone, keyword, outcome: "error" });
    return json(
      { ok: false, message: t(locale, "magic.sms.error") },
      { status: 500 },
    );
  }
};
