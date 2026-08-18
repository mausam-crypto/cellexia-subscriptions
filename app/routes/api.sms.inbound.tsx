import { timingSafeEqual } from "node:crypto";
import { json, type ActionFunctionArgs } from "@remix-run/node";
import type { ContractStatus } from "@prisma/client";
import { z } from "zod";
import prisma from "~/db.server";
import { t } from "~/lib/i18n/i18n.server";
import { formatShopDate } from "~/lib/dates.server";
import { getSetting } from "~/lib/settings/settings.server";
import { logEvent } from "~/lib/events/log.server";
import { sha256 } from "~/lib/crypto/tokens.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import { isSetupMode } from "~/lib/launch/launch.server";
import {
  delayNextCycle,
  delaySchedule,
  skipNextCycle,
} from "~/lib/contracts/service.server";
import { resolveLockState } from "~/lib/contracts/lock.server";
import { OURS_ONLY } from "~/lib/ownership/ownership.server";
import { findPortalDunningCase } from "~/lib/portal/dunning.server";
import { delayModeFor } from "~/lib/portal/schedule.server";
import {
  isPreparingOrder,
  resolveChargeTiming,
} from "~/lib/billing/timing.server";
import {
  UNDOABLE_EVENT_TYPES,
  performUndo,
  undoSpecFromEvent,
  undoWindowSeconds,
} from "~/lib/portal/undo.server";

/**
 * POST /api/sms/inbound — Klaviyo SMS keyword webhook ("text-to-skip").
 *
 * Klaviyo flows POST `{ phone, keyword }` here when a subscriber replies with
 * a keyword; the JSON `message` in the response can be sent back as the SMS
 * reply. Auth: `x-cellexia-secret` must equal env CRON_SECRET (fail closed).
 *
 * Keywords: SKIP → skip next cycle; DELAY → push the next order 2 weeks
 * (portal.delayReanchors decides whether the whole schedule moves or only
 * this order — the same setting the portal follows, see delayModeFor);
 * UNDO (v1.28.0) → reverse the customer's most recent delay / next-date /
 * frequency change inside the undo window (see handleUndo). All mutations
 * go through the contract services with source MAGIC_LINK / actor "sms"
 * (one-tap-verb semantics, no login), which log the canonical events.
 * STOP → win-back opt-out, handled here directly (see handleStop) — the only
 * writer of WinbackState.OPTED_OUT. RETRY (v1.28.0) → customer "Retry now"
 * on the held payment through the dunning engine's requestCustomerRetry
 * (open case or FAILED contract; per-case cooldown; see handleRetry).
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
  status: ContractStatus;
  nextBillingDate: Date | null;
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
      status: true,
      nextBillingDate: true,
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
        status: candidate.status,
        nextBillingDate: candidate.nextBillingDate ?? null,
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
  outcome:
    | "ok"
    | "unknown_phone"
    | "unknown_keyword"
    | "locked"
    | "refused"
    | "setup_mode"
    | "error";
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

/**
 * RETRY — customer "Retry now" by text (v1.28.0). Target: the newest
 * ACTIVE / PAUSED / FAILED contract on the phone that has a case to retry
 * (open, or newest EXHAUSTED while FAILED); without one, the newest such
 * contract (the engine answers "nothing to retry"). Same engine guards as
 * the portal button and the RETRY_PAYMENT magic link — per-case cooldown,
 * paused / challenge-pending refusals — so a repeated text can never fire
 * a second charge attempt.
 */
async function handleRetry(phone: string, keyword: string) {
  const matches = (
    await contractsMatchingPhone(phone, { activeOnly: false })
  ).filter(
    (m) => m.status === "ACTIVE" || m.status === "PAUSED" || m.status === "FAILED",
  );
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

  let target = matches[0];
  for (const candidate of matches) {
    if (await findPortalDunningCase(candidate)) {
      target = candidate;
      break;
    }
  }
  const { locale } = target;
  try {
    const { requestCustomerRetry } = await import("~/lib/dunning/engine.server");
    const outcome = await requestCustomerRetry(target.id, {
      source: "MAGIC_LINK",
      actor: "sms",
    });
    let key: string;
    let ok = false;
    switch (outcome.kind) {
      case "started":
        key = "magic.sms.retry_done";
        ok = true;
        break;
      case "too_soon":
        key = "magic.sms.retry_too_soon";
        break;
      case "unavailable":
        if (outcome.reason === "claim_lost") {
          // A concurrent request won the claim — the retry is running.
          key = "magic.sms.retry_done";
          ok = true;
          break;
        }
        key =
          outcome.reason === "challenge_pending"
            ? "magic.sms.retry_needs_bank"
            : outcome.reason === "contract_paused"
              ? "magic.sms.retry_paused"
              : "magic.sms.retry_none";
        break;
      default:
        key = "magic.sms.retry_none";
    }
    await auditInboundSms({
      contract: target,
      phone,
      keyword,
      outcome: ok ? "ok" : "refused",
    });
    return json({ ok, message: t(locale, key) });
  } catch (err) {
    console.error("[sms-inbound] keyword action failed", "RETRY", target.id, err);
    await auditInboundSms({ contract: target, phone, keyword, outcome: "error" });
    return json(
      { ok: false, message: t(locale, "magic.sms.error") },
      { status: 500 },
    );
  }
}

/**
 * UNDO — reverse the customer's most recent undoable schedule change
 * (v1.28.0, P2.2): the newest cycle.delayed / contract.next_date_changed /
 * contract.frequency_changed the CUSTOMER made (portal, magic link or SMS —
 * never an admin edit) inside the undo window, restored from the previous
 * values its own payload stores (undoSpecFromEvent). A portal.undo that is
 * newer than any candidate means the last thing that happened WAS an undo —
 * texting UNDO again does not redo it. performUndo re-checks the contract
 * against the event's after-state, so a schedule that moved on since
 * (another change, a charge) answers "can't be undone" instead of
 * restoring a date the customer no longer expects.
 */
async function handleUndo(
  contract: MatchedContract,
  phone: string,
  keyword: string,
) {
  const { locale } = contract;
  try {
    let windowSeconds = 14 * 24 * 3600;
    try {
      windowSeconds = undoWindowSeconds(
        await getSetting(contract.shopId, "portal"),
      );
    } catch {
      /* default window */
    }
    const since = new Date(Date.now() - windowSeconds * 1000);
    const latest = await prisma.subscriberEvent.findFirst({
      where: {
        contractId: contract.id,
        type: { in: [...UNDOABLE_EVENT_TYPES, "portal.undo"] },
        source: { in: ["CUSTOMER_PORTAL", "MAGIC_LINK"] },
        createdAt: { gte: since },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { type: true, payload: true },
    });
    const spec =
      latest && latest.type !== "portal.undo"
        ? undoSpecFromEvent({ type: latest.type, payload: latest.payload })
        : null;
    if (!spec) {
      await auditInboundSms({ contract, phone, keyword, outcome: "refused" });
      return json({ ok: false, message: t(locale, "magic.sms.undo_none") });
    }
    const full = await prisma.subscriptionContract.findUnique({
      where: { id: contract.id },
      select: {
        id: true,
        shopId: true,
        customerId: true,
        email: true,
        status: true,
        nextBillingDate: true,
        intervalWeeks: true,
        billingIntervalUnit: true,
        billingIntervalCount: true,
      },
    });
    if (!full) {
      await auditInboundSms({ contract, phone, keyword, outcome: "refused" });
      return json({ ok: false, message: t(locale, "magic.sms.undo_none") });
    }
    // Preparing-your-order window (v1.28.0): an undo moves the schedule
    // like the verb it reverses — never while an attempt is in flight.
    const timing = await resolveChargeTiming(contract.shopId, contract.ianaTimezone);
    if (await isPreparingOrder(full, timing)) {
      await auditInboundSms({ contract, phone, keyword, outcome: "refused" });
      return json({ ok: false, message: t(locale, "magic.sms.preparing") });
    }
    const outcome = await performUndo(contract.shopDomain, full, spec, {
      source: "MAGIC_LINK",
      actor: "sms",
      via: "sms",
      timing,
    });
    if (outcome.kind === "restored") {
      await auditInboundSms({ contract, phone, keyword, outcome: "ok" });
      // Per-line edits (P2.5) never move the order date — the dated copy
      // ("back on {date}") would claim a move that did not happen.
      const lineEdit = spec.kind === "line_skip" || spec.kind === "line_qty_once";
      const message =
        outcome.nextBillingDate && !lineEdit
        ? t(locale, "magic.sms.undo_done", {
            date: formatShopDate(
              outcome.nextBillingDate,
              contract.ianaTimezone,
              locale,
            ),
          })
        : t(locale, "magic.sms.undo_done_nodate");
      return json({ ok: true, message });
    }
    await auditInboundSms({ contract, phone, keyword, outcome: "refused" });
    // stale / past / inactive: the schedule has moved on — nothing truthful
    // to restore.
    return json({ ok: false, message: t(locale, "magic.sms.undo_stale") });
  } catch (err) {
    console.error("[sms-inbound] keyword action failed", "UNDO", contract.id, err);
    await auditInboundSms({ contract, phone, keyword, outcome: "error" });
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
  // RETRY also dispatches before the ACTIVE-only match: FAILED contracts
  // (the exhausted-ladder cohort) are exactly who needs it.
  if (verb === "RETRY") {
    return handleRetry(phone, keyword);
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

  // ── Launch gate: a store in SETUP takes no zero-login mutations ────────────
  // Same rule as the portal dispatcher, the magic-link executor and the
  // jobs runner: after an emergency revertToSetup() everything is frozen and
  // goLive() re-staggers the overdue cycles — a texted SKIP / DELAY / UNDO
  // must not edit the live Shopify schedule meanwhile. RETRY gates itself in
  // requestCustomerRetry; STOP is an opt-out (no schedule mutation). The
  // inbound is audited with its own outcome; the reply is the portal's
  // setup copy (same read as the portal dispatcher's gate).
  if (verb === "SKIP" || verb === "DELAY" || verb === "UNDO") {
    if (await isSetupMode(contract.shopId)) {
      await auditInboundSms({ contract, phone, keyword, outcome: "setup_mode" });
      return json({ ok: false, message: t(locale, "portal.setup.body") });
    }
  }

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

  // ── Preparing-your-order window (v1.28.0) — same gate as the portal ──────
  // SKIP / DELAY edit the cycle being billed once the charge moment has
  // passed or an attempt is in flight; refuse with the preparing copy (the
  // read is contained — false on any failure).
  if (verb === "SKIP" || verb === "DELAY") {
    const preparing = await isPreparingOrder(
      { id: contract.id, status: contract.status, nextBillingDate: contract.nextBillingDate },
      await resolveChargeTiming(contract.shopId, contract.ianaTimezone),
    );
    if (preparing) {
      await auditInboundSms({ contract, phone, keyword, outcome: "refused" });
      return json({ ok: false, message: t(locale, "magic.sms.preparing") });
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
        // Same semantics setting as the portal's delay buttons; a broken
        // settings read falls back to the one-cycle delay (never breaks the
        // verb).
        let portalSettings: { delayReanchors?: boolean } | null = null;
        try {
          portalSettings = await getSetting(contract.shopId, "portal");
        } catch {
          portalSettings = null;
        }
        const updated =
          delayModeFor(portalSettings, null) === "reanchor"
            ? await delaySchedule(
                contract.shopDomain,
                contract.id,
                { weeks: DELAY_WEEKS },
                opts,
              )
            : await delayNextCycle(
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

      case "UNDO":
        return handleUndo(contract, phone, keyword);

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
