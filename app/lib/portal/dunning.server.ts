import type {
  BillingAttempt,
  DunningCase,
  SubscriptionContract,
} from "@prisma/client";
import prisma from "~/db.server";
import { logEvent } from "~/lib/events/log.server";
import { OPEN_CASE_STATES } from "~/lib/dunning/states";
import {
  categorizeDeclineCode,
  type CustomerAction,
  type DeclineCategory,
} from "~/lib/dunning/decline-codes.server";

/**
 * The portal's read model of a contract's payment trouble (v1.28.0).
 *
 * The portal used to read no DunningCase at all: an ACTIVE contract with an
 * open case looked healthy for up to 30 days ("Next order {date}" while the
 * order was actually held), and a FAILED one showed a generic note. This
 * module turns the engine's case into ONE view-model the home cards, the
 * detail banner and the retry / 3DS verbs all agree on:
 *
 *  - the OPEN case (resolvedAt null) of the contract, or — when the contract
 *    is FAILED — its newest EXHAUSTED case (the one a customer retry reopens);
 *  - the state the copy keys on (RETRYING / AWAITING_CUSTOMER /
 *    AWAITING_3DS / EXHAUSTED); a case whose cycle still holds a CHALLENGED
 *    attempt reads as AWAITING_3DS whatever the case says — the bank is the
 *    blocker;
 *  - the CTA group by decline category (SOFT → retry / delay / skip / pause;
 *    HARD or update-card declines → update / use another card; AUTH_REQUIRED
 *    → confirm with the bank), with a revoked primary always routed to the
 *    update-card group (nothing else can succeed);
 *  - the money and dates the banner names: amount at risk (case-open
 *    estimate, or the current order total), the failure instant (trigger
 *    attempt completedAt, else case openedAt), the next scheduled retry.
 *
 * Read-only. Failures in the impression event are contained.
 */

export type PortalDunningState =
  | "RETRYING"
  | "AWAITING_CUSTOMER"
  | "AWAITING_3DS"
  | "EXHAUSTED";

export type PortalDunningCtaGroup = "SOFT" | "UPDATE_CARD" | "AUTH_REQUIRED";

export interface PortalDunningView {
  caseId: string;
  state: PortalDunningState;
  /** Raw engine state (OPEN cases read as RETRYING in `state`). */
  caseState: DunningCase["state"];
  openedAt: Date;
  /** Failure instant named in the banner. */
  failedAt: Date;
  amountCents: number | null;
  currencyCode: string | null;
  declineCode: string | null;
  declineCategory: DeclineCategory;
  customerAction: CustomerAction;
  /** Taxonomy description (English, admin/email `decline_human`). */
  declineHuman: string;
  /** i18n key of the customer-facing one-liner explaining the decline. */
  reasonKey: string;
  ctaGroup: PortalDunningCtaGroup;
  nextRetryAt: Date | null;
  /** Engine currently charging the backup method (pointer equality). */
  onBackup: boolean;
  /** A CHALLENGED (3DS) attempt of the case's cycle is still unresolved. */
  challenged: boolean;
  challengedAttemptId: string | null;
  customerRetryAt: Date | null;
  /** The contract's primary method was revoked on Shopify. */
  primaryRevoked: boolean;
  /**
   * A PENDING attempt of the case's cycle is on its way to Shopify (outcome
   * webhook pending) — the only moment "we're waiting for your bank's
   * answer" is true.
   */
  inFlight: boolean;
  /**
   * The held order's cycle index / date (trigger attempt), when known —
   * what "Skip that order and continue from {date}" (P1.9) skips. Null on
   * legacy cases without a trigger attempt.
   */
  heldCycleIndex: number | null;
  heldCycleDate: Date | null;
}

type ContractForDunning = Pick<
  SubscriptionContract,
  | "id"
  | "status"
  | "paymentMethodId"
  | "backupPaymentMethodId"
  | "paymentMethodRevokedAt"
  | "currencyCode"
  | "deliveryPriceCents"
> & {
  lines?: Array<{ currentPriceCents: number; quantity: number }>;
};

type AttemptFacts = Pick<
  BillingAttempt,
  "id" | "status" | "cycleIndex" | "completedAt" | "shopifyAttemptId"
> & {
  /** The cycle date the attempt was due on (= the held order's date). */
  scheduledFor?: Date | null;
};

/** i18n key of the customer-facing decline explanation, by taxonomy. */
export function dunningReasonKey(
  category: DeclineCategory,
  customerAction: CustomerAction,
  primaryRevoked: boolean,
): string {
  if (primaryRevoked) return "portal.dunning.reason.card_removed";
  if (category === "AUTH_REQUIRED" || customerAction === "AUTHENTICATE") {
    return "portal.dunning.reason.auth_required";
  }
  if (category === "HARD" || customerAction === "UPDATE_CARD") {
    return "portal.dunning.reason.update_card";
  }
  return "portal.dunning.reason.soft";
}

/** CTA group by taxonomy — the buttons the banner offers. */
export function dunningCtaGroup(
  category: DeclineCategory,
  customerAction: CustomerAction,
  primaryRevoked: boolean,
): PortalDunningCtaGroup {
  if (primaryRevoked) return "UPDATE_CARD";
  if (category === "AUTH_REQUIRED" || customerAction === "AUTHENTICATE") {
    return "AUTH_REQUIRED";
  }
  if (category === "HARD" || customerAction === "UPDATE_CARD") {
    return "UPDATE_CARD";
  }
  return "SOFT";
}

function currentOrderTotalCents(contract: ContractForDunning): number | null {
  if (!contract.lines) return null;
  return (
    contract.lines.reduce((sum, l) => sum + l.currentPriceCents * l.quantity, 0) +
    contract.deliveryPriceCents
  );
}

/**
 * Pure builder — the loader feeds it the case + the attempts of the case's
 * cycle; tests feed it fixtures. `attempts` may be any superset: only the
 * trigger attempt and CHALLENGED rows are read.
 */
export function buildPortalDunningView(input: {
  kase: DunningCase;
  contract: ContractForDunning;
  attempts: AttemptFacts[];
  /**
   * THE next-order estimate's total for this contract (estimateNextCharge —
   * grant / parked marker / per-line edits applied), when the caller has it:
   * the banner then names the SAME figure as the items card and the hero on
   * the same page. Falls back to the case's frozen at-risk figure, then the
   * plan sum.
   */
  heldOrderTotalCents?: number | null;
}): PortalDunningView {
  const { kase, contract, attempts } = input;
  const heldOrderTotalCents =
    typeof input.heldOrderTotalCents === "number" &&
    Number.isFinite(input.heldOrderTotalCents)
      ? input.heldOrderTotalCents
      : null;
  const trigger = kase.triggerAttemptId
    ? (attempts.find((a) => a.id === kase.triggerAttemptId) ?? null)
    : null;
  const cycleIndex = trigger?.cycleIndex ?? null;
  const challenged =
    attempts.find(
      (a) =>
        a.status === "CHALLENGED" &&
        a.shopifyAttemptId != null &&
        (cycleIndex == null || a.cycleIndex === cycleIndex),
    ) ?? null;
  const inFlight = attempts.some(
    (a) =>
      a.status === "PENDING" &&
      a.shopifyAttemptId != null &&
      (cycleIndex == null || a.cycleIndex === cycleIndex),
  );

  const info = categorizeDeclineCode(kase.declineCode);
  const category: DeclineCategory =
    kase.declineCategory === "HARD" ||
    kase.declineCategory === "AUTH_REQUIRED" ||
    kase.declineCategory === "SOFT"
      ? kase.declineCategory
      : info.category;
  const primaryRevoked = contract.paymentMethodRevokedAt != null;

  let state: PortalDunningState;
  if (challenged) state = "AWAITING_3DS";
  else if (kase.state === "EXHAUSTED") state = "EXHAUSTED";
  else if (kase.state === "AWAITING_CUSTOMER") state = "AWAITING_CUSTOMER";
  else if (kase.state === "AWAITING_3DS") state = "AWAITING_3DS";
  else state = "RETRYING"; // OPEN / RETRYING

  return {
    caseId: kase.id,
    state,
    caseState: kase.state,
    openedAt: kase.openedAt,
    failedAt: trigger?.completedAt ?? kase.openedAt,
    amountCents:
      heldOrderTotalCents ??
      kase.amountAtRiskCents ??
      currentOrderTotalCents(contract),
    currencyCode:
      heldOrderTotalCents == null && kase.amountAtRiskCents != null
        ? (kase.amountAtRiskCurrencyCode ?? contract.currencyCode)
        : contract.currencyCode,
    declineCode: kase.declineCode ?? null,
    declineCategory: category,
    customerAction: info.customerAction,
    declineHuman: info.description,
    reasonKey: dunningReasonKey(category, info.customerAction, primaryRevoked),
    ctaGroup: dunningCtaGroup(category, info.customerAction, primaryRevoked),
    nextRetryAt: state === "RETRYING" ? (kase.nextRetryAt ?? null) : null,
    // Pointer equality is the engine's "on backup" marker only while the
    // case that swapped is still open (a RECOVERED / EXHAUSTED case has had
    // its marker collapsed; if that collapse failed the marker is stale).
    onBackup:
      kase.resolvedAt == null &&
      contract.backupPaymentMethodId != null &&
      contract.paymentMethodId === contract.backupPaymentMethodId,
    challenged: challenged != null,
    challengedAttemptId: challenged?.id ?? null,
    customerRetryAt: kase.customerRetryAt ?? null,
    primaryRevoked,
    inFlight,
    heldCycleIndex: cycleIndex,
    heldCycleDate: trigger?.scheduledFor ?? null,
  };
}

/**
 * The case the portal shows for a contract: the open one, or the newest
 * EXHAUSTED one while the contract is FAILED. Null = nothing to show.
 */
export async function findPortalDunningCase(
  contract: Pick<SubscriptionContract, "id" | "status">,
): Promise<DunningCase | null> {
  const open = await prisma.dunningCase.findFirst({
    where: { contractId: contract.id, state: { in: OPEN_CASE_STATES } },
    orderBy: { openedAt: "desc" },
  });
  if (open) return open;
  if (contract.status !== "FAILED") return null;
  return prisma.dunningCase.findFirst({
    where: { contractId: contract.id, state: "EXHAUSTED" },
    orderBy: { openedAt: "desc" },
  });
}

async function attemptsForCase(kase: DunningCase): Promise<AttemptFacts[]> {
  const select = {
    id: true,
    status: true,
    cycleIndex: true,
    completedAt: true,
    shopifyAttemptId: true,
    scheduledFor: true,
  } as const;
  const trigger = kase.triggerAttemptId
    ? await prisma.billingAttempt.findUnique({
        where: { id: kase.triggerAttemptId },
        select,
      })
    : null;
  // CHALLENGED (3DS pending) and in-flight PENDING (outcome webhook pending)
  // rows of the case's cycle — the view's `challenged` / `inFlight` facts.
  const live = await prisma.billingAttempt.findMany({
    where: {
      contractId: kase.contractId,
      status: { in: ["CHALLENGED", "PENDING"] },
      shopifyAttemptId: { not: null },
      ...(trigger ? { cycleIndex: trigger.cycleIndex } : {}),
    },
    orderBy: [{ cycleIndex: "desc" }, { attemptNumber: "desc" }],
    select,
  });
  return [...(trigger ? [trigger] : []), ...live];
}

/** Detail-page loader: one contract → its view-model (or null). */
export async function loadPortalDunning(
  contract: ContractForDunning,
  opts: { heldOrderTotalCents?: number | null } = {},
): Promise<PortalDunningView | null> {
  const kase = await findPortalDunningCase(contract);
  if (!kase) return null;
  const attempts = await attemptsForCase(kase);
  return buildPortalDunningView({
    kase,
    contract,
    attempts,
    heldOrderTotalCents: opts.heldOrderTotalCents,
  });
}

/**
 * Home loader: every contract on the page → view-models keyed by contract
 * id. Contracts that are neither ACTIVE/PAUSED-with-open-case nor FAILED
 * are skipped without a query.
 */
export async function loadPortalDunningMany(
  contracts: ContractForDunning[],
): Promise<Map<string, PortalDunningView>> {
  const out = new Map<string, PortalDunningView>();
  const candidates = contracts.filter(
    (c) => c.status === "ACTIVE" || c.status === "PAUSED" || c.status === "FAILED",
  );
  if (candidates.length === 0) return out;
  const openCases = await prisma.dunningCase.findMany({
    where: {
      contractId: { in: candidates.map((c) => c.id) },
      state: { in: OPEN_CASE_STATES },
    },
    orderBy: { openedAt: "desc" },
  });
  const byContract = new Map<string, DunningCase>();
  for (const kase of openCases) {
    if (!byContract.has(kase.contractId)) byContract.set(kase.contractId, kase);
  }
  for (const contract of candidates) {
    let kase = byContract.get(contract.id) ?? null;
    if (!kase && contract.status === "FAILED") {
      kase = await prisma.dunningCase.findFirst({
        where: { contractId: contract.id, state: "EXHAUSTED" },
        orderBy: { openedAt: "desc" },
      });
    }
    if (!kase) continue;
    const attempts = await attemptsForCase(kase);
    out.set(contract.id, buildPortalDunningView({ kase, contract, attempts }));
  }
  return out;
}

/**
 * Home-page ordering (v1.28.0): contracts with a payment issue come first —
 * an ACTIVE contract with an open case used to sort like any healthy ACTIVE
 * one and hide its held order below the fold. Lower sorts first; ties keep
 * the caller's status order.
 */
export function dunningSortRank(hasIssue: boolean, statusRank: number): number {
  return hasIssue ? -1 : statusRank;
}

/**
 * portal.dunning_banner_shown — the impression half of the recovery funnel,
 * logged at most once per case per `windowHours` (setting
 * portal.dunningBannerEventHours) by event lookup. Never for previews /
 * demo contracts (callers gate). Contained: a failed write must never break
 * the page. Returns true when an event was written.
 */
export async function logDunningBannerShown(input: {
  shopId: string;
  contract: Pick<SubscriptionContract, "id" | "customerId" | "email">;
  view: Pick<PortalDunningView, "caseId" | "state" | "ctaGroup">;
  surface: "home" | "detail";
  windowHours: number;
  now?: Date;
}): Promise<boolean> {
  const { shopId, contract, view } = input;
  const now = input.now ?? new Date();
  try {
    const since = new Date(now.getTime() - input.windowHours * 3600_000);
    const recent = await prisma.subscriberEvent.findFirst({
      where: {
        contractId: contract.id,
        type: "portal.dunning_banner_shown",
        createdAt: { gte: since },
        payload: { path: ["caseId"], equals: view.caseId },
      },
      select: { id: true },
    });
    if (recent) return false;
    await logEvent({
      shopId,
      contractId: contract.id,
      customerId: contract.customerId,
      email: contract.email,
      type: "portal.dunning_banner_shown",
      source: "CUSTOMER_PORTAL",
      actor: "customer",
      payload: {
        caseId: view.caseId,
        state: view.state,
        ctaGroup: view.ctaGroup,
        surface: input.surface,
      },
    });
    return true;
  } catch (err) {
    console.error("[portal] dunning banner event failed", contract.id, err);
    return false;
  }
}
