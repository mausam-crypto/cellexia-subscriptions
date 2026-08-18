import type { SubscriptionContract } from "@prisma/client";
import prisma from "~/db.server";
import { logEvent } from "~/lib/events/log.server";
import { t } from "~/lib/i18n/i18n.server";
import { getSetting } from "~/lib/settings/settings.server";
import type { CustomerPaymentMethodSummary } from "~/lib/graphql/index.server";
import { emailCardLabel } from "~/lib/notifications/payment-method.server";
import { sendNotification } from "~/lib/notifications/send.server";
import {
  buildSetBackupUrl,
  buildUseMethodUrl,
} from "~/lib/magiclinks/builder.server";
import { derivePortalPaymentState } from "~/lib/portal/payment.server";
import { cardExpiryMoment } from "~/lib/dates.server";
import { isBillableOwnership } from "~/lib/ownership/shared";
import { OPEN_CASE_STATES } from "~/lib/dunning/states";

/**
 * New-method detection (v1.28.0, P1.8 — settings.dunning.newMethodDetection).
 *
 * CUSTOMER_PAYMENT_METHODS_CREATE/UPDATE used to ignore a method that is not
 * the contract's own (`if (!method) continue`). Yet a customer who saves a
 * NEW card while their subscription is in payment trouble has just handed us
 * the recovery — this module turns that moment into one of two things, per
 * contract of the customer whose primary is NOT the new method:
 *
 *  - the primary is DEAD (removed / expired) and `newMethodAutoSwitch` is on
 *    → `changePaymentMethod(trigger "new_method", source WEBHOOK)`; the
 *    service's closed loop tells the customer "we moved your subscription to
 *    your new card ····1234" (payment_method_updated, reason new_method) and
 *    an open case retries at once (`action: "switched"`);
 *  - otherwise (held payment / expiring-but-live card) → the
 *    `new_card_detected` email ("Cellexia New Card Detected") with a one-tap
 *    USE_METHOD button and a SET_BACKUP line, and the home banner picks the
 *    event up (`action: "notified"`).
 *
 * Gates (a miss is silent): the feature switch, SETUP launch mode, demo
 * contracts, FOREIGN / UNKNOWN ownership (golden rule — the other app's
 * mirrored contracts are never re-pointed nor messaged), contract status
 * outside ACTIVE / PAUSED / FAILED, the webhook topic (only
 * CUSTOMER_PAYMENT_METHODS_CREATE means "a NEW card" — an UPDATE about an
 * old vaulted card is a detail edit, never "you have a newer card"), an
 * already-expired target instrument (never switch onto / offer a dead card),
 * and the "in trouble" predicate — open DunningCase, status FAILED, revoked
 * primary, or a card inside `dunning.preExpiryNoticeDays` of expiry /
 * expired. A healthy subscriber saving a second card hears nothing.
 *
 * Idempotent per {contract, method}: the `dunning.new_method_detected` event
 * is the ledger (a redelivered CREATE, or the UPDATE that follows it, finds
 * the event and stops). Every step is contained — a failure here can never
 * break the webhook's mirror refresh, and a failed auto-switch degrades to
 * the notification so the customer still hears about their card.
 */

export type NewMethodAction = "switched" | "notified";

export interface NewMethodDetectionInput {
  shop: { id: string; domain: string; ianaTimezone: string };
  /** The customer whose method webhook this is. */
  customerGid: string;
  /** The method the webhook is about (must be in `methods`, non-revoked). */
  methodGid: string;
  /** All of the customer's contracts (the handler already loaded them). */
  contracts: SubscriptionContract[];
  /** listCustomerPaymentMethods for the customer (the handler's read). */
  methods: CustomerPaymentMethodSummary[];
  /**
   * Which webhook this is. Only CREATE is "a new card"; UPDATE (card-detail
   * edit / account-updater refresh of a method the customer has held for
   * years) is skipped — the copy "your new card" would be false and the
   * auto-switch would move a subscription onto a card nobody chose. Omitted
   * = CREATE (legacy callers).
   */
  topic?: "CREATE" | "UPDATE";
  now?: Date;
}

export interface NewMethodDetectionResult {
  contractId: string;
  action: NewMethodAction | "skipped";
  reason?: string;
}

const CANDIDATE_STATUSES = new Set(["ACTIVE", "PAUSED", "FAILED"]);
const CREATED_VIA = "NEW_CARD_DETECTED";
/** Grace over the ladder's cancel-after horizon, like the UPDATE_CARD link. */
const LINK_GRACE_DAYS = 7;

/** Why the contract counts as "in trouble" (event payload + copy choice). */
type TroubleReason = "open_case" | "failed" | "revoked" | "expired" | "expiring";

function troubleReason(
  contract: SubscriptionContract,
  opts: { hasOpenCase: boolean; preExpiryNoticeDays: number; tz: string | null; now: Date },
): TroubleReason | null {
  const payment = derivePortalPaymentState(contract, {
    now: opts.now,
    preExpiryNoticeDays: opts.preExpiryNoticeDays,
    tz: opts.tz,
  });
  if (payment.state === "REVOKED") return "revoked";
  if (payment.state === "EXPIRED") return "expired";
  if (opts.hasOpenCase) return "open_case";
  if (contract.status === "FAILED") return "failed";
  if (payment.state === "EXPIRING") return "expiring";
  return null;
}

/** Already handled this method for this contract? (event ledger, any age). */
async function alreadyDetected(contractId: string, methodGid: string): Promise<boolean> {
  const prior = await prisma.subscriberEvent.findFirst({
    where: {
      contractId,
      type: "dunning.new_method_detected",
      payload: { path: ["paymentMethodId"], equals: methodGid },
    },
    select: { id: true },
  });
  return prior != null;
}

/**
 * Detect + act for every contract of the customer. Never throws; returns the
 * per-contract outcome for the handler's logging / tests.
 */
export async function detectNewPaymentMethod(
  input: NewMethodDetectionInput,
): Promise<NewMethodDetectionResult[]> {
  const results: NewMethodDetectionResult[] = [];
  const now = input.now ?? new Date();
  const method = input.methods.find((m) => m.id === input.methodGid) ?? null;
  if (!method || method.revoked) return results;

  const candidates = input.contracts.filter(
    (c) =>
      !c.isDemo &&
      isBillableOwnership(c.ownership) &&
      CANDIDATE_STATUSES.has(c.status) &&
      c.paymentMethodId !== input.methodGid &&
      c.customerId === input.customerGid,
  );
  if (candidates.length === 0) return results;

  // Only a CREATE is "a new card" (see NewMethodDetectionInput.topic).
  if (input.topic === "UPDATE") {
    for (const c of candidates) {
      results.push({ contractId: c.id, action: "skipped", reason: "not_new" });
    }
    return results;
  }
  // Never switch onto / offer an instrument that is already dead: Shopify
  // keeps expired vaulted cards non-revoked, so `!revoked` is not "live".
  const targetExpiresAt = cardExpiryMoment(
    method.instrument?.expiryMonth,
    method.instrument?.expiryYear,
    input.shop.ianaTimezone,
  );
  if (targetExpiresAt && targetExpiresAt.getTime() <= now.getTime()) {
    for (const c of candidates) {
      results.push({ contractId: c.id, action: "skipped", reason: "target_expired" });
    }
    return results;
  }

  let dunning: {
    newMethodDetection?: boolean;
    newMethodAutoSwitch?: boolean;
    preExpiryNoticeDays?: number;
    cancelAfterFailedDays?: number;
  };
  try {
    dunning = (await getSetting(input.shop.id, "dunning")) as typeof dunning;
  } catch (err) {
    console.error("[dunning] new-method detection settings read failed", err);
    return results;
  }
  if (dunning.newMethodDetection === false) return results;

  try {
    const { isSetupMode } = await import("~/lib/launch/launch.server");
    if (await isSetupMode(input.shop.id)) return results;
  } catch (err) {
    console.error("[dunning] new-method detection launch read failed", err);
    return results;
  }

  const preExpiryNoticeDays = dunning.preExpiryNoticeDays ?? 30;
  const ttlDays = (dunning.cancelAfterFailedDays ?? 30) + LINK_GRACE_DAYS;
  const locale = (l: string | null) => l ?? "en";

  for (const contract of candidates) {
    try {
      const openCase = await prisma.dunningCase.findFirst({
        where: { contractId: contract.id, resolvedAt: null },
        select: { id: true },
      });
      const reason = troubleReason(contract, {
        hasOpenCase: openCase != null,
        preExpiryNoticeDays,
        tz: input.shop.ianaTimezone,
        now,
      });
      if (!reason) {
        results.push({ contractId: contract.id, action: "skipped", reason: "healthy" });
        continue;
      }
      if (await alreadyDetected(contract.id, input.methodGid)) {
        results.push({ contractId: contract.id, action: "skipped", reason: "duplicate" });
        continue;
      }

      const primaryDead = reason === "revoked" || reason === "expired";
      let action: NewMethodAction = "notified";
      if (primaryDead && dunning.newMethodAutoSwitch !== false) {
        try {
          const { changePaymentMethod } = await import("~/lib/contracts/service.server");
          await changePaymentMethod(input.shop.domain, contract.id, input.methodGid, {
            source: "WEBHOOK",
            actor: "system",
            trigger: "new_method",
          });
          action = "switched";
        } catch (err) {
          // Contained: the customer still hears about their card.
          console.error(
            "[dunning] new-method auto-switch failed — falling back to the notice",
            contract.id,
            err,
          );
        }
      }

      if (action === "notified") {
        const status = await sendNewCardDetected({
          shop: input.shop,
          contract,
          method,
          reason,
          hasOpenCase: openCase != null,
          ttlDays,
          locale: locale(contract.locale),
        });
        if (status !== "SENT") {
          // Not delivered (suppressed / failed): no ledger row, so the next
          // webhook about this method may try again — but the banner must
          // not promise a card the customer was never told about either
          // way, so only a SENT notice is recorded.
          results.push({ contractId: contract.id, action: "skipped", reason: `notice_${status}` });
          continue;
        }
      }

      await logEvent({
        shopId: input.shop.id,
        contractId: contract.id,
        customerId: contract.customerId,
        email: contract.email,
        type: "dunning.new_method_detected",
        source: "WEBHOOK",
        actor: "system",
        payload: {
          contractId: contract.id,
          paymentMethodId: input.methodGid,
          action,
          reason,
          previousPaymentMethodId: contract.paymentMethodId,
          instrumentType: method.instrument?.type ?? null,
          cardBrand: method.instrument?.brand ?? null,
          cardLast4: method.instrument?.lastDigits ?? null,
        },
      });
      results.push({ contractId: contract.id, action, reason });
    } catch (err) {
      console.error("[dunning] new-method detection failed", contract.id, err);
      results.push({ contractId: contract.id, action: "skipped", reason: "error" });
    }
  }
  return results;
}

/**
 * The `new_card_detected` notice: intro line by situation, one-tap USE_METHOD
 * as the button, SET_BACKUP line (omitted when the link could not be minted
 * — never a raw placeholder). Returns the router status; never throws.
 */
async function sendNewCardDetected(input: {
  shop: { id: string; domain: string; ianaTimezone: string };
  contract: SubscriptionContract;
  method: CustomerPaymentMethodSummary;
  reason: TroubleReason;
  hasOpenCase: boolean;
  ttlDays: number;
  locale: string;
}): Promise<"SENT" | "SUPPRESSED" | "FAILED"> {
  const { contract, method, locale } = input;
  const inst = method.instrument;
  const cardLabel =
    emailCardLabel(locale, {
      paymentInstrumentType: inst?.type ?? null,
      cardBrand: inst?.brand ?? null,
      cardLast4: inst?.lastDigits ?? null,
    }) || t(locale, "portal.payment.card_generic");
  const currentLabel = emailCardLabel(locale, contract);

  const held = input.hasOpenCase || input.reason === "failed" || contract.status === "FAILED";
  const introKey = held
    ? "email.new_card_detected.intro_held"
    : input.reason === "expiring" && currentLabel
      ? "email.new_card_detected.intro_expiring"
      : "email.new_card_detected.intro_generic";
  const introLine = t(locale, introKey, {
    card_label: cardLabel,
    current_card_label: currentLabel,
  });

  const linkBase = {
    contractId: contract.id,
    customerId: contract.customerId,
    email: contract.email ?? undefined,
    createdVia: CREATED_VIA,
    ttlDays: input.ttlDays,
    paymentMethodId: method.id,
    label: cardLabel,
  };
  let useUrl: string | null = null;
  let backupUrl: string | null = null;
  try {
    useUrl = await buildUseMethodUrl(linkBase);
  } catch (err) {
    console.error("[dunning] new_card_detected USE_METHOD link failed", contract.id, err);
  }
  try {
    backupUrl = await buildSetBackupUrl(linkBase);
  } catch (err) {
    console.error("[dunning] new_card_detected SET_BACKUP link failed", contract.id, err);
  }
  const backupLine = backupUrl
    ? t(
        locale,
        currentLabel
          ? "email.new_card_detected.backup_line"
          : "email.new_card_detected.backup_line_generic",
        { current_card_label: currentLabel, backup_url: backupUrl },
      )
    : "";

  try {
    const result = await sendNotification({
      shopId: input.shop.id,
      contractId: contract.id,
      template: "new_card_detected",
      vars: {
        card_label: cardLabel,
        current_card_label: currentLabel,
        intro_line: introLine,
        backup_line: backupLine,
        new_method_reason: input.reason,
        // The button IS the one-tap switch; without a link the body's `{cta}`
        // renders nothing and the portal link in the shell still carries.
        ...(useUrl ? { use_url: useUrl, cta_url: useUrl } : {}),
        ...(backupUrl ? { backup_url: backupUrl } : {}),
        // Klaviyo segmentation: the new instrument.
        new_card_last4: inst?.lastDigits ?? "",
        new_card_type: inst?.type ?? "",
      },
    });
    return result.status;
  } catch (err) {
    console.error("[dunning] new_card_detected send failed", contract.id, err);
    return "FAILED";
  }
}

// ── Home banner ──────────────────────────────────────────────────────────────

export const NEW_CARD_BANNER_WINDOW_DAYS = 30;

export interface NewCardBannerHit {
  contractId: string;
  paymentMethodId: string;
  cardBrand: string | null;
  cardLast4: string | null;
  instrumentType: string | null;
}

export interface NewCardBannerOptions {
  now?: Date;
  windowDays?: number;
  /** settings.dunning.preExpiryNoticeDays (default 30) — the trouble re-check. */
  preExpiryNoticeDays?: number;
  /** Shop timezone for the expiry re-check. */
  tz?: string | null;
  /**
   * Live (non-revoked) method ids on the customer's account, or null when
   * unknown (read failed / not attempted → the hit is kept). Called at most
   * once per customer; the caller shares the portal's 60 s memo.
   */
  liveMethodIds?: (customerGid: string) => Promise<Set<string> | null>;
}

/**
 * Contracts that were TOLD about a newer card (action "notified") inside the
 * banner window and would still benefit from switching — the portal home
 * reads this to render "You have a newer card on file — use it?". One query
 * for the page; contained (empty map on any failure).
 *
 * A hit is dropped when (Stage G review fixes):
 *  - the contract already pays with that method (portal / magic / admin
 *    switch) or has made it its BACKUP (the email's second answer — the
 *    banner must not contradict the choice just made);
 *  - a newer `dunning.new_method_detected` row exists for the contract with
 *    another action / method (the newest row per contract is terminal, so
 *    an auto-switch to card C never resurfaces an older notice about A);
 *  - the contract is no longer in trouble (no open case, not FAILED, primary
 *    live and outside the pre-expiry window) — the nudge exists to fix a
 *    payment, not to sell a card swap to a healthy subscriber;
 *  - the notified method is no longer live on the account (revoked) — the
 *    one-tap would only earn a "not on your account" toast.
 */
export async function newCardBannerHits(
  contracts: SubscriptionContract[],
  opts: NewCardBannerOptions = {},
): Promise<Map<string, NewCardBannerHit>> {
  const out = new Map<string, NewCardBannerHit>();
  const eligible = contracts.filter(
    (c) => !c.isDemo && CANDIDATE_STATUSES.has(c.status),
  );
  if (eligible.length === 0) return out;
  const now = opts.now ?? new Date();
  const since = new Date(
    now.getTime() - (opts.windowDays ?? NEW_CARD_BANNER_WINDOW_DAYS) * 86_400_000,
  );
  try {
    const rows = await prisma.subscriberEvent.findMany({
      where: {
        contractId: { in: eligible.map((c) => c.id) },
        type: "dunning.new_method_detected",
        createdAt: { gte: since },
      },
      orderBy: { createdAt: "desc" },
      select: { contractId: true, payload: true },
    });
    const byId = new Map(eligible.map((c) => [c.id, c]));
    const seen = new Set<string>();
    const candidates = new Map<string, NewCardBannerHit>();
    for (const row of rows) {
      if (!row.contractId || seen.has(row.contractId)) continue;
      // The newest row per contract decides — whatever its action.
      seen.add(row.contractId);
      const p = (row.payload ?? {}) as Record<string, unknown>;
      if (p.action !== "notified" || typeof p.paymentMethodId !== "string") continue;
      const contract = byId.get(row.contractId);
      if (!contract) continue;
      if (contract.paymentMethodId === p.paymentMethodId) continue; // already on it
      if (contract.backupPaymentMethodId === p.paymentMethodId) continue; // chose SET_BACKUP
      candidates.set(row.contractId, {
        contractId: row.contractId,
        paymentMethodId: p.paymentMethodId,
        cardBrand: typeof p.cardBrand === "string" ? p.cardBrand : null,
        cardLast4: typeof p.cardLast4 === "string" ? p.cardLast4 : null,
        instrumentType: typeof p.instrumentType === "string" ? p.instrumentType : null,
      });
    }
    if (candidates.size === 0) return out;

    // Still in trouble? (same predicate as detection time)
    const openCases = await prisma.dunningCase.findMany({
      where: {
        contractId: { in: [...candidates.keys()] },
        state: { in: OPEN_CASE_STATES },
      },
      select: { contractId: true },
    });
    const withOpenCase = new Set(openCases.map((k) => k.contractId));
    const preExpiryNoticeDays = opts.preExpiryNoticeDays ?? 30;
    const liveByCustomer = new Map<string, Set<string> | null>();
    for (const [contractId, hit] of candidates) {
      const contract = byId.get(contractId)!;
      const reason = troubleReason(contract, {
        hasOpenCase: withOpenCase.has(contractId),
        preExpiryNoticeDays,
        tz: opts.tz ?? null,
        now,
      });
      if (!reason) continue; // healthy again — nothing to nudge
      if (opts.liveMethodIds) {
        if (!liveByCustomer.has(contract.customerId)) {
          let live: Set<string> | null = null;
          try {
            live = await opts.liveMethodIds(contract.customerId);
          } catch (err) {
            console.error("[portal] new-card banner liveness read failed", contract.id, err);
          }
          liveByCustomer.set(contract.customerId, live);
        }
        const live = liveByCustomer.get(contract.customerId) ?? null;
        if (live && !live.has(hit.paymentMethodId)) continue; // revoked since
      }
      out.set(contractId, hit);
    }
  } catch (err) {
    console.error("[portal] new-card banner lookup failed", err);
  }
  return out;
}
