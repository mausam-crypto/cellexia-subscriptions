/**
 * The diagnostic cancel flow — consumes retention/cancellation.server.
 *
 * Step 1: choose a reason (the nine CancelReasons, human labels) — with a
 *         visible "just cancel" path, so the final cancel is never more than
 *         two clicks away.
 * Step 2: reason-specific save offers (structural first). Parameterised
 *         offers collect the customer's ACTUAL choice — delay weeks, pause
 *         length or exact resume date, swap target, removal pick, care
 *         details — and pass it to acceptOffer as chosenParams, so the flow
 *         executes exactly what was promised. Declining all is a single,
 *         clearly visible button.
 * Accept  → truthful per-offer confirmation ("A credit of €12 has been
 *          applied…", "Deliveries resume around 3 October…").
 * Decline → finalizeCancellation, graceful goodbye + "resume anytime".
 *
 * No dark patterns: no hidden buttons, no guilt, no countdowns.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import prisma from "~/db.server";
import { addDays, isoDate } from "~/lib/dates";
import { logger } from "~/lib/logger.server";
import { getOfflineAdmin, toGid } from "~/services/core/shopifyClient.server";
import {
  OfferChoiceError,
  acceptOffer,
  educationCareFollowUp,
  finalizeCancellation,
  getOffersForSession,
  startCancellationSession,
  submitReason,
} from "~/services/retention/cancellation.server";
import {
  getCancelGate,
  getPauseCancelWindowSettings,
  type CancelGate,
} from "~/services/retention/policy.server";
import {
  fetchDefaultVariant,
  findOwnedContract,
  findPrimaryContract,
  requirePortalCustomer,
  trackPortal,
  type PortalCustomer,
} from "~/services/portal/auth.server";
import {
  buildChosenParams,
  cancelReasonLabel,
  formatCents,
  humanDateLabel,
  isCancelReason,
  isTerminalContractStatus,
  resolvedSessionRedirect,
  savedOfferLead,
  sortOffersStructuralFirst,
  whitelistOfferParams,
  type PortalOfferChoice,
} from "~/components/portal/logic";
import {
  CANCEL_REASONS,
  SAVE_OFFER_TYPES,
  parseJson,
  type SaveOffer,
  type SaveOfferType,
} from "~/types/domain";
import { ConfirmBanner } from "~/components/portal/ConfirmBanner";
import { GateNotice } from "~/components/portal/GateNotice";
import { OfferCard } from "~/components/portal/OfferCard";

export { PortalErrorBoundary as ErrorBoundary } from "~/components/portal/PortalErrorBoundary";

async function requireOwnedSession(
  customer: PortalCustomer,
  sessionId: string,
) {
  const session = await prisma.cancellationSession.findUnique({
    where: { id: sessionId },
  });
  if (!session || session.shop !== customer.shop) {
    throw new Response("Not found", { status: 404 });
  }
  // Throws 404 unless the session's contract belongs to this customer.
  await findOwnedContract(customer, session.contractId);
  return session;
}

/** "3" → "3rd" — for "after your 3rd delivery" in the commitment copy. */
function ordinal(n: number): string {
  const rem10 = n % 10;
  const rem100 = n % 100;
  if (rem10 === 1 && rem100 !== 11) return `${n}st`;
  if (rem10 === 2 && rem100 !== 12) return `${n}nd`;
  if (rem10 === 3 && rem100 !== 13) return `${n}rd`;
  return `${n}th`;
}

/**
 * The calm gate screen rendered instead of the reason flow while cancelling
 * is locked (first-delivery window, or a committed plan mid-commitment).
 * Applies to the customer portal only — CS console and system cancels are
 * never gated. The window's day count lives in settings; the gate itself
 * only carries the unlock date.
 */
async function gatedView(shop: string, gate: CancelGate) {
  const windowDays =
    gate.reason === "WINDOW"
      ? (await getPauseCancelWindowSettings(shop)).days
      : null;
  return json({
    view: "gated" as const,
    reason: gate.reason,
    unlocksAtLabel: humanDateLabel(gate.unlocksAt),
    windowDays,
    completedDeliveries: gate.commitment?.completedDeliveries ?? 0,
    minDeliveries: gate.commitment?.minDeliveries ?? 0,
    supportEmail: process.env.PORTAL_SUPPORT_EMAIL || "care@cellexia.com",
  });
}

// ─────────────────────────────── Offer view models ────────────────────────

/** JSON-safe choice knobs the offers screen renders. */
interface OfferChoiceView {
  skipAction: boolean;
  delayWeeksOptions: number[];
  defaultDelayWeeks: number | null;
  intervalWeeksOptions: number[];
  defaultIntervalWeeks: number | null;
  daysOptions: number[];
  defaultDays: number | null;
  customResumeDateAllowed: boolean;
  swapOptions: Array<{ productId: string; title: string }>;
  lineOptions: Array<{ lineId: string; title: string }>;
  suggestedLineId: string | null;
  collectDetails: boolean;
}

interface OfferView {
  type: SaveOfferType;
  title: string;
  description: string;
  structural: boolean;
  choice: OfferChoiceView;
}

/**
 * Prepare the persisted offers for rendering: whitelist params, resolve swap
 * candidate titles from ProductMeta, and drop a swap offer that has nothing
 * concrete to swap to — the portal never renders a promise it cannot keep.
 * Swap offers without advertised lineOptions pick from the contract's own
 * lines (the customer chooses which of their products to change). An
 * EDUCATION offer already acknowledged in this session is not shown twice.
 */
async function buildOfferViews(
  shop: string,
  offers: SaveOffer[],
  contractLines: Array<{ lineId: string; title: string }>,
): Promise<OfferView[]> {
  const candidateIds = [
    ...new Set(
      offers.flatMap((offer) =>
        offer.type === "PRODUCT_SWAP"
          ? whitelistOfferParams(offer.params ?? {}).candidateProductIds
          : [],
      ),
    ),
  ];
  const titleByCandidate: Record<string, string> = {};
  if (candidateIds.length > 0) {
    const metas = await prisma.productMeta.findMany({
      where: {
        shop,
        subscribable: true,
        active: true,
        shopifyProductId: {
          in: [
            ...candidateIds,
            ...candidateIds.map((id) => toGid("Product", id)),
          ],
        },
      },
      select: { shopifyProductId: true, title: true },
    });
    const byAnyForm: Record<string, string> = {};
    for (const meta of metas) {
      byAnyForm[meta.shopifyProductId] = meta.title;
      byAnyForm[toGid("Product", meta.shopifyProductId)] = meta.title;
    }
    for (const id of candidateIds) {
      const title = byAnyForm[id] ?? byAnyForm[toGid("Product", id)];
      if (title) titleByCandidate[id] = title;
    }
  }

  const views: OfferView[] = [];
  for (const offer of offers) {
    const choice: PortalOfferChoice = whitelistOfferParams(offer.params ?? {});
    if (
      offer.type === "EDUCATION" &&
      (offer.params as Record<string, unknown> | undefined)?.accepted === true
    ) {
      continue;
    }
    const swapOptions =
      offer.type === "PRODUCT_SWAP"
        ? choice.candidateProductIds
            .filter((id) => titleByCandidate[id])
            .map((id) => ({ productId: id, title: titleByCandidate[id] }))
        : [];
    if (offer.type === "PRODUCT_SWAP" && swapOptions.length === 0) {
      // Nothing nameable to swap to — showing this offer would be a promise
      // the accept step cannot honour.
      continue;
    }
    if (offer.type === "PRODUCT_SWAP" && choice.lineOptions.length === 0) {
      choice.lineOptions = contractLines;
    }
    views.push({
      type: offer.type,
      title: offer.title,
      description: offer.description,
      structural: offer.costCents === 0,
      choice: {
        skipAction: choice.action === "SKIP_NEXT",
        delayWeeksOptions: choice.delayWeeksOptions,
        defaultDelayWeeks: choice.defaultDelayWeeks,
        intervalWeeksOptions: choice.intervalWeeksOptions,
        defaultIntervalWeeks: choice.defaultIntervalWeeks,
        daysOptions: choice.daysOptions,
        defaultDays: choice.defaultDays,
        customResumeDateAllowed: choice.customResumeDateAllowed,
        swapOptions,
        lineOptions: choice.lineOptions,
        suggestedLineId: choice.suggestedLineId,
        collectDetails: choice.collectDetails,
      },
    });
  }
  return views;
}

// ─────────────────────────────── Loader ───────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  const customer = await requirePortalCustomer(request);
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("session");
  const cancelled = url.searchParams.get("cancelled") === "1";
  const saved = url.searchParams.get("saved") === "1";
  const errorParam = url.searchParams.get("error");

  if (cancelled) {
    await trackPortal(
      customer.shop,
      customer.shopifyCustomerId,
      null,
      "VIEW",
      "cancel:goodbye",
    );
    return json({ view: "goodbye" as const });
  }

  if (sessionId) {
    const session = await requireOwnedSession(customer, sessionId);
    const contract = await findOwnedContract(customer, session.contractId);
    // Resolved sessions only render their terminal view — never the offers
    // form again (Back button, stale tab).
    if (session.outcome === "CANCELLED") {
      throw redirect("/portal/cancel?cancelled=1");
    }
    if (session.outcome === "SAVED" && !saved) {
      throw redirect(`/portal/cancel?session=${sessionId}&saved=1`);
    }
    if (saved && session.outcome === "SAVED") {
      // Truthful, per-offer confirmation: state exactly what happened.
      const offers = parseJson<SaveOffer[]>(session.offersJson, []);
      const savedType = session.savedByOffer;
      const offer = offers.find((o) => o.type === savedType) ?? null;
      const params = (offer?.params ?? {}) as Record<string, unknown>;

      const amountCentsRaw =
        typeof params.amountCents === "number"
          ? params.amountCents
          : typeof params.estimatedCostCents === "number"
            ? params.estimatedCostCents
            : null;

      // REMOVE_ITEM: the advertised line that is no longer on the plan is
      // the one that was removed.
      let removedTitle: string | null = null;
      if (savedType === "REMOVE_ITEM") {
        const currentLineIds = new Set(contract.lines.map((l) => l.id));
        const choice = whitelistOfferParams(params);
        removedTitle =
          choice.lineOptions.find((o) => !currentLineIds.has(o.lineId))
            ?.title ?? null;
      }

      // PRODUCT_SWAP: the line now carrying a candidate product is the
      // swapped-in one.
      let swapTitle: string | null = null;
      if (savedType === "PRODUCT_SWAP") {
        const choice = whitelistOfferParams(params);
        const candidateSet = new Set(
          choice.candidateProductIds.flatMap((id) => [
            id,
            toGid("Product", id),
          ]),
        );
        swapTitle =
          contract.lines.find(
            (l) =>
              candidateSet.has(l.shopifyProductId) ||
              candidateSet.has(toGid("Product", l.shopifyProductId)),
          )?.title ?? null;
      }

      const lead = savedOfferLead({
        offerType: savedType,
        nextDeliveryLabel: humanDateLabel(
          contract.nextDeliveryDate ?? contract.nextBillingDate,
        ),
        pausedUntilLabel: humanDateLabel(contract.pausedUntil),
        amountLabel:
          amountCentsRaw !== null
            ? formatCents(amountCentsRaw, contract.currencyCode)
            : null,
        removedTitle,
        intervalWeeks:
          savedType === "CHANGE_FREQUENCY" ? contract.intervalWeeks : null,
        quantity:
          savedType === "CHANGE_QUANTITY" &&
          typeof params.defaultQuantity === "number"
            ? params.defaultQuantity
            : null,
        swapTitle,
      });
      await trackPortal(
        customer.shop,
        customer.shopifyCustomerId,
        contract.id,
        "VIEW",
        "cancel:saved",
      );
      return json({ view: "saved" as const, lead });
    }
    // A session a housekeeping job resolved behind the customer's back
    // (ABANDONED after 48h, or the zombie sweep) must never render the live
    // offers form — its accept and decline buttons could only throw. Restart
    // the flow gently instead.
    const staleRedirect = resolvedSessionRedirect(session.outcome, session.id);
    if (staleRedirect) throw redirect(staleRedirect);
    // Gate before continuing an in-flight session: a lock that engaged after
    // the session opened still holds (Back button, stale tab, direct URL).
    const gate = await getCancelGate(customer.shop, contract.id);
    if (!gate.allowed) return gatedView(customer.shop, gate);
    let offerViews: OfferView[] = [];
    try {
      const offers = sortOffersStructuralFirst(
        await getOffersForSession(sessionId),
      );
      offerViews = await buildOfferViews(
        customer.shop,
        offers,
        contract.lines.map((line) => ({ lineId: line.id, title: line.title })),
      );
    } catch (error) {
      logger.warn("portal cancel offers unavailable", {
        sessionId,
        error: String(error),
      });
    }
    await trackPortal(
      customer.shop,
      customer.shopifyCustomerId,
      contract.id,
      "VIEW",
      "cancel:offers",
    );
    return json({
      view: "offers" as const,
      sessionId,
      offers: offerViews,
      // Custom pause resume dates the accept action will honour: tomorrow
      // through six months out (mirrors retention's CUSTOM_PAUSE_MAX_DAYS).
      pauseMinDate: isoDate(addDays(new Date(), 1)),
      pauseMaxDate: isoDate(addDays(new Date(), 180)),
      done: url.searchParams.get("done"),
      error: errorParam,
      errorMessage: url.searchParams.get("msg"),
    });
  }

  const contract = await findPrimaryContract(customer);
  if (!contract || isTerminalContractStatus(contract.status)) {
    throw redirect("/portal");
  }
  // Gate BEFORE the reason flow — no cancellation session is ever created
  // while pausing/cancelling is locked for this contract.
  const gate = await getCancelGate(customer.shop, contract.id);
  if (!gate.allowed) return gatedView(customer.shop, gate);
  await trackPortal(
    customer.shop,
    customer.shopifyCustomerId,
    contract.id,
    "VIEW",
    "cancel:reasons",
  );
  return json({
    view: "reasons" as const,
    contractId: contract.id,
    // A resolved-session redirect landed here: acknowledge the expired page
    // so the customer knows nothing happened and can simply start again.
    expired: url.searchParams.get("expired") === "1",
    reasons: CANCEL_REASONS.map((reason) => ({
      value: reason,
      label: cancelReasonLabel(reason),
    })),
  });
}

// ─────────────────────────────── Action ───────────────────────────────────

const CHOICE_FIELDS = [
  "delayWeeks",
  "intervalWeeks",
  "pauseOption",
  "pauseCustomDate",
  "swapProductId",
  "swapLineId",
  "removeLineId",
  "details",
] as const;

export async function action({ request }: ActionFunctionArgs) {
  const customer = await requirePortalCustomer(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  // Every intent re-checks the cancel gate server-side: the gate must hold
  // even against direct POSTs that skip the loader's gate screen.
  if (intent === "choose-reason") {
    const contract = await findOwnedContract(
      customer,
      String(form.get("contractId") ?? ""),
    );
    if (isTerminalContractStatus(contract.status)) return redirect("/portal");
    const gate = await getCancelGate(customer.shop, contract.id);
    if (!gate.allowed) return redirect("/portal/cancel");
    const reason = String(form.get("reason") ?? "");
    if (!isCancelReason(reason)) {
      throw new Response("Bad request", { status: 400 });
    }
    const detail = String(form.get("detail") ?? "").trim();
    const session = await startCancellationSession(customer.shop, contract.id);
    await submitReason(session.id, reason, detail || undefined);
    await trackPortal(
      customer.shop,
      customer.shopifyCustomerId,
      contract.id,
      "ACTION",
      `cancel-start:${reason}`,
    );
    return redirect(`/portal/cancel?session=${session.id}`);
  }

  if (intent === "accept-offer") {
    const session = await requireOwnedSession(
      customer,
      String(form.get("sessionId") ?? ""),
    );
    // Already resolved (double submit, Back button, stale tab, or expired by
    // a housekeeping job): show the truthful terminal view — or restart the
    // flow — instead of executing anything further.
    const resolvedAccept = resolvedSessionRedirect(session.outcome, session.id);
    if (resolvedAccept) return redirect(resolvedAccept);
    const gate = await getCancelGate(customer.shop, session.contractId);
    if (!gate.allowed) return redirect("/portal/cancel");
    const offerType = String(form.get("offerType") ?? "");
    if (!(SAVE_OFFER_TYPES as readonly string[]).includes(offerType)) {
      throw new Response("Bad request", { status: 400 });
    }
    // The choice must be one the persisted offer genuinely advertised —
    // validated here (defence in depth) and again inside acceptOffer.
    const offers = parseJson<SaveOffer[]>(session.offersJson, []);
    const offer = offers.find((o) => o.type === offerType);
    if (!offer) {
      return redirect(`/portal/cancel?session=${session.id}&error=offer`);
    }
    const contract = await findOwnedContract(customer, session.contractId);
    const choice = whitelistOfferParams(offer.params ?? {});
    if (offerType === "PRODUCT_SWAP" && choice.lineOptions.length === 0) {
      // Same effective pick list the offers view rendered: the contract's
      // own lines (still ownership-scoped — they ARE this customer's lines).
      choice.lineOptions = contract.lines.map((line) => ({
        lineId: line.id,
        title: line.title,
      }));
    }
    const raw: Record<string, string> = {};
    for (const field of CHOICE_FIELDS) {
      raw[field] = String(form.get(field) ?? "");
    }
    const built = buildChosenParams(
      offerType as SaveOfferType,
      choice,
      raw,
      new Date(),
    );
    if (!built.ok) {
      return redirect(
        `/portal/cancel?session=${session.id}&error=${built.error}`,
      );
    }
    const { graphql } = await getOfflineAdmin(customer.shop);
    let chosen = built.chosen;
    if (
      offerType === "PRODUCT_SWAP" &&
      chosen &&
      typeof chosen.targetProductId === "string"
    ) {
      // The service executes a concrete variant swap: resolve the chosen
      // candidate product to its first sellable variant, server-side.
      const variant = await fetchDefaultVariant(graphql, chosen.targetProductId);
      if (!variant) {
        return redirect(
          `/portal/cancel?session=${session.id}&error=swap-unavailable`,
        );
      }
      chosen = { lineId: chosen.lineId, newVariantGid: variant.id };
    }
    try {
      await acceptOffer(graphql, session.id, offerType as SaveOfferType, chosen);
    } catch (error) {
      logger.warn("portal accept-offer failed", {
        sessionId: session.id,
        offerType,
        error: String(error),
      });
      if (error instanceof OfferChoiceError) {
        // Customer-safe, specific server message ("pick a date between…",
        // "a thank-you benefit was applied recently…").
        return redirect(
          `/portal/cancel?session=${session.id}&error=server&msg=${encodeURIComponent(error.message)}`,
        );
      }
      return redirect(`/portal/cancel?session=${session.id}&error=offer`);
    }
    await trackPortal(
      customer.shop,
      customer.shopifyCustomerId,
      session.contractId,
      "ACTION",
      `cancel-save:${offerType}`,
    );
    if (offerType === "EDUCATION") {
      // Education is an acknowledgement — the session stays open (nothing
      // structural changed), so the customer returns to the offers, decline
      // path still visible. The confirmation must match what was recorded:
      // the care-team promise only when a care follow-up actually exists
      // (same predicate the service applies), a plain acknowledgement
      // otherwise.
      const care = educationCareFollowUp(offer.params ?? {});
      return redirect(
        `/portal/cancel?session=${session.id}&done=${care ? "care" : "noted"}`,
      );
    }
    return redirect(`/portal/cancel?session=${session.id}&saved=1`);
  }

  if (intent === "finalize") {
    const session = await requireOwnedSession(
      customer,
      String(form.get("sessionId") ?? ""),
    );
    // A session already saved must not cancel the contract the merchant just
    // paid a concession to keep; an already-cancelled one has nothing to do;
    // an expired (ABANDONED) one restarts the flow instead of throwing.
    const resolvedFinal = resolvedSessionRedirect(session.outcome, session.id);
    if (resolvedFinal) return redirect(resolvedFinal);
    const gate = await getCancelGate(customer.shop, session.contractId);
    if (!gate.allowed) return redirect("/portal/cancel");
    const { graphql } = await getOfflineAdmin(customer.shop);
    try {
      await finalizeCancellation(graphql, session.id);
    } catch (error) {
      logger.warn("portal finalize failed", {
        sessionId: session.id,
        error: String(error),
      });
      // Race loser (another tab accepted or finalized between our check and
      // the claim) or a housekeeping expiry: land on the session's actual
      // terminal view, never the error boundary.
      const fresh = await prisma.cancellationSession.findUnique({
        where: { id: session.id },
      });
      const target = fresh
        ? resolvedSessionRedirect(fresh.outcome, fresh.id)
        : "/portal/cancel?expired=1";
      if (target) return redirect(target);
      // Still IN_PROGRESS: a genuine transient failure (the service released
      // its claim). Nothing was cancelled — say so, and let them retry.
      return redirect(`/portal/cancel?session=${session.id}&error=offer`);
    }
    await trackPortal(
      customer.shop,
      customer.shopifyCustomerId,
      session.contractId,
      "ACTION",
      "cancel-finalize",
    );
    return redirect("/portal/cancel?cancelled=1");
  }

  if (intent === "cancel-now") {
    // The visible fast lane: reason step → cancelled, one click.
    const contract = await findOwnedContract(
      customer,
      String(form.get("contractId") ?? ""),
    );
    if (isTerminalContractStatus(contract.status)) return redirect("/portal");
    const gate = await getCancelGate(customer.shop, contract.id);
    if (!gate.allowed) return redirect("/portal/cancel");
    const session = await startCancellationSession(customer.shop, contract.id);
    await submitReason(session.id, "OTHER", "Quick cancel from portal");
    const { graphql } = await getOfflineAdmin(customer.shop);
    await finalizeCancellation(graphql, session.id);
    await trackPortal(
      customer.shop,
      customer.shopifyCustomerId,
      contract.id,
      "ACTION",
      "cancel-now",
    );
    return redirect("/portal/cancel?cancelled=1");
  }

  throw new Response("Bad request", { status: 400 });
}

// ─────────────────────────────── View ─────────────────────────────────────

const OFFER_ERROR_COPY: Record<string, string> = {
  choice: "Pick one of the options shown — then we'll take care of it.",
  "pause-date": "Pick a resume date that's ahead of today.",
  details:
    "Tell us a little about what you experienced, so our care team can genuinely help.",
  "swap-unavailable":
    "That swap isn't available right now — the other options still are, and cancelling stays one click away.",
  // Careful: never assert "your plan is unchanged" — a failure can land
  // after the concession partially applied, and the copy must stay truthful.
  offer:
    "We hit a snag confirming this — nothing has been cancelled. Please try again so we can finish up, or write to us.",
};

const inlineChoiceStyle = { margin: "0 0 12px" } as const;

function OfferChoiceInputs({
  offer,
  pauseMinDate,
  pauseMaxDate,
}: {
  offer: OfferView;
  pauseMinDate: string;
  pauseMaxDate: string;
}) {
  const { choice } = offer;

  if (
    offer.type === "CHANGE_DELIVERY_DATE" &&
    !choice.skipAction &&
    choice.delayWeeksOptions.length > 0
  ) {
    const preset = choice.defaultDelayWeeks ?? choice.delayWeeksOptions[0];
    return (
      <div className="cx-field" style={inlineChoiceStyle}>
        <span className="cx-field__label">How much breathing room?</span>
        {choice.delayWeeksOptions.map((weeks) => (
          <label className="cx-choice" key={weeks}>
            <input
              type="radio"
              name="delayWeeks"
              value={weeks}
              defaultChecked={weeks === preset}
              required
            />
            <span className="cx-choice__label">
              {weeks} week{weeks > 1 ? "s" : ""} later
            </span>
          </label>
        ))}
      </div>
    );
  }

  if (
    offer.type === "CHANGE_FREQUENCY" &&
    choice.intervalWeeksOptions.length > 0
  ) {
    const preset =
      choice.defaultIntervalWeeks ?? choice.intervalWeeksOptions[0];
    return (
      <div className="cx-field" style={inlineChoiceStyle}>
        <span className="cx-field__label">Pick your new rhythm</span>
        {choice.intervalWeeksOptions.map((weeks) => (
          <label className="cx-choice" key={weeks}>
            <input
              type="radio"
              name="intervalWeeks"
              value={weeks}
              defaultChecked={weeks === preset}
              required
            />
            <span className="cx-choice__label">Every {weeks} weeks</span>
          </label>
        ))}
      </div>
    );
  }

  if (
    offer.type === "TEMPORARY_PAUSE" &&
    (choice.daysOptions.length > 0 || choice.customResumeDateAllowed)
  ) {
    const preset = choice.defaultDays ?? choice.daysOptions[0] ?? null;
    return (
      <div className="cx-field" style={inlineChoiceStyle}>
        <span className="cx-field__label">How long suits you?</span>
        {choice.daysOptions.map((days) => (
          <label className="cx-choice" key={days}>
            <input
              type="radio"
              name="pauseOption"
              value={days}
              defaultChecked={days === preset}
              required
            />
            <span className="cx-choice__label">{days} days</span>
          </label>
        ))}
        {choice.customResumeDateAllowed ? (
          <label className="cx-choice">
            <input type="radio" name="pauseOption" value="custom" required />
            <span className="cx-choice__label">
              Until a date of my choosing
              <span className="cx-choice__hint">
                <input
                  type="date"
                  name="pauseCustomDate"
                  className="cx-input"
                  style={{ maxWidth: 200, marginTop: 6 }}
                  min={pauseMinDate}
                  max={pauseMaxDate}
                  aria-label="Resume date"
                />
              </span>
            </span>
          </label>
        ) : null}
      </div>
    );
  }

  if (offer.type === "PRODUCT_SWAP" && choice.swapOptions.length > 0) {
    return (
      <div className="cx-field" style={inlineChoiceStyle}>
        {choice.lineOptions.length > 1 ? (
          <>
            <label className="cx-field__label" htmlFor={`swap-line-${offer.type}`}>
              Which product would you like to change?
            </label>
            <select
              id={`swap-line-${offer.type}`}
              className="cx-select"
              name="swapLineId"
              defaultValue={choice.suggestedLineId ?? choice.lineOptions[0].lineId}
            >
              {choice.lineOptions.map((line) => (
                <option key={line.lineId} value={line.lineId}>
                  {line.title}
                </option>
              ))}
            </select>
          </>
        ) : null}
        <label className="cx-field__label" htmlFor={`swap-target-${offer.type}`}>
          Swap to
        </label>
        <select
          id={`swap-target-${offer.type}`}
          className="cx-select"
          name="swapProductId"
          required
        >
          {choice.swapOptions.map((option) => (
            <option key={option.productId} value={option.productId}>
              {option.title}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (offer.type === "REMOVE_ITEM" && choice.lineOptions.length > 0) {
    return (
      <div className="cx-field" style={inlineChoiceStyle}>
        <label className="cx-field__label" htmlFor="remove-line-select">
          Which one should go?
        </label>
        <select
          id="remove-line-select"
          className="cx-select"
          name="removeLineId"
          defaultValue={choice.suggestedLineId ?? choice.lineOptions[0].lineId}
          required
        >
          {choice.lineOptions.map((line) => (
            <option key={line.lineId} value={line.lineId}>
              {line.title}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (offer.type === "EDUCATION" && choice.collectDetails) {
    return (
      <div className="cx-field" style={inlineChoiceStyle}>
        <label className="cx-field__label" htmlFor="care-details">
          Tell us what you experienced
        </label>
        <textarea
          id="care-details"
          className="cx-textarea"
          name="details"
          placeholder="Where, when, and how your skin reacted — whatever feels relevant."
          required
        />
      </div>
    );
  }

  return null;
}

export default function PortalCancel() {
  const data = useLoaderData<typeof loader>();

  if (data.view === "goodbye") {
    return (
      <div className="cx-auth-wrap">
        <div className="cx-card cx-card--accent cx-card--center">
          <span className="cx-eyebrow">All taken care of</span>
          <h1 className="cx-headline">Your treatment is cancelled</h1>
          <p className="cx-lead">
            No more deliveries, no more charges. Your routine and history stay
            safely saved — you can resume anytime, exactly where you left off.
          </p>
          <p className="cx-note">
            Thank you for the time you spent with us. Take good care of your
            skin.
          </p>
          <Link to="/portal" className="cx-btn cx-btn--secondary">
            Back to my space
          </Link>
        </div>
      </div>
    );
  }

  if (data.view === "saved") {
    return (
      <div className="cx-auth-wrap">
        <div className="cx-card cx-card--accent cx-card--center">
          <span className="cx-eyebrow">Done — and thank you</span>
          <h1 className="cx-headline">That's all sorted</h1>
          <p className="cx-lead">{data.lead}</p>
          <Link to="/portal" className="cx-btn cx-btn--primary">
            Back to my treatment
          </Link>
        </div>
      </div>
    );
  }

  if (data.view === "gated") {
    const isCommitment = data.reason === "COMMITMENT";
    const title = isCommitment
      ? `You're ${data.completedDeliveries} of ${data.minDeliveries} deliveries into your committed plan`
      : "Your treatment is just getting started";
    const line = isCommitment
      ? `Cancelling opens after your ${ordinal(data.minDeliveries)} delivery — that's how you keep your committed price. Your deliveries continue as scheduled until then, and you can still adjust products anytime.`
      : data.unlocksAtLabel
        ? `Pausing or cancelling opens on ${data.unlocksAtLabel}${
            data.windowDays
              ? ` — ${data.windowDays} days after your first delivery`
              : ""
          }. Until then you stay in control: move your next delivery, or skip a shipment.`
        : "Pausing or cancelling opens a little later in your treatment. Until then you stay in control: move your next delivery, or skip a shipment.";
    return (
      <div className="cx-auth-wrap">
        <GateNotice
          eyebrow={isCommitment ? "Your committed plan" : "Your treatment plan"}
          title={title}
          lines={[line]}
          actions={
            isCommitment
              ? [
                  { to: "/portal/treatment", label: "Adjust products" },
                  { to: "/portal", label: "Back to my treatment" },
                ]
              : [
                  { to: "/portal/delivery", label: "Change my delivery" },
                  { to: "/portal", label: "Back to my treatment" },
                ]
          }
          supportEmail={data.supportEmail}
        />
      </div>
    );
  }

  if (data.view === "offers") {
    const errorCopy =
      data.error === "server"
        ? (data.errorMessage ?? OFFER_ERROR_COPY.offer)
        : data.error
          ? OFFER_ERROR_COPY[data.error]
          : undefined;
    return (
      <div>
        {data.done === "care" ? (
          <ConfirmBanner title="Our care team is on it">
            Thank you for telling us — someone will review this with you
            personally. Everything below is still available, and cancelling
            stays one click away.
          </ConfirmBanner>
        ) : data.done === "noted" ? (
          <ConfirmBanner title="Good to know">
            Everything below is still available, and cancelling stays one
            click away.
          </ConfirmBanner>
        ) : null}
        {errorCopy ? (
          <ConfirmBanner tone="info" title="One small thing">
            {errorCopy}
          </ConfirmBanner>
        ) : null}
        <header className="cx-section">
          <span className="cx-eyebrow">Before you go</span>
          <h1 className="cx-headline cx-headline--page">
            Would any of these help?
          </h1>
          <p className="cx-muted">
            Based on what you told us — each is one click, and none commits you
            to anything new.
          </p>
        </header>

        {data.offers.length > 0 ? (
          <div className="cx-grid cx-grid--2">
            {data.offers.map((offer) => (
              <OfferCard
                key={offer.type}
                sessionId={data.sessionId ?? ""}
                offerType={offer.type}
                title={offer.title}
                description={offer.description}
                structural={offer.structural}
              >
                <OfferChoiceInputs
                  offer={offer}
                  pauseMinDate={data.pauseMinDate}
                  pauseMaxDate={data.pauseMaxDate}
                />
              </OfferCard>
            ))}
          </div>
        ) : (
          <div className="cx-card cx-card--center">
            <p className="cx-lead">We understand — sometimes it's simply time.</p>
          </div>
        )}

        <div className="cx-card cx-card--center" style={{ marginTop: 20 }}>
          <p className="cx-section__intro">
            None of these quite fit? That's completely fine.
          </p>
          <form method="post">
            <input type="hidden" name="intent" value="finalize" />
            <input type="hidden" name="sessionId" value={data.sessionId ?? ""} />
            <button type="submit" className="cx-btn cx-btn--secondary">
              No thanks — cancel my treatment
            </button>
          </form>
        </div>
      </div>
    );
  }

  // view === "reasons"
  return (
    <div>
      {data.expired ? (
        <ConfirmBanner tone="info" title="That page had expired">
          Nothing was changed — your plan is exactly as it was. Let&apos;s pick
          up where you left off.
        </ConfirmBanner>
      ) : null}
      <header className="cx-section">
        <span className="cx-eyebrow">Cancel my treatment</span>
        <h1 className="cx-headline cx-headline--page">
          Help us understand, if you'd like
        </h1>
        <p className="cx-muted">
          One question, then you're done. Whatever you choose, cancelling stays
          one click away.
        </p>
      </header>

      <div className="cx-card">
        <form method="post">
          <input type="hidden" name="intent" value="choose-reason" />
          <input type="hidden" name="contractId" value={data.contractId ?? ""} />
          {data.reasons.map((reason, index) => (
            <label className="cx-choice" key={reason.value}>
              <input
                type="radio"
                name="reason"
                value={reason.value}
                defaultChecked={index === 0}
                required
              />
              <span className="cx-choice__label">{reason.label}</span>
            </label>
          ))}
          <div className="cx-field" style={{ marginTop: 14 }}>
            <label className="cx-field__label" htmlFor="cancel-detail">
              Anything you'd like us to know? (optional)
            </label>
            <textarea
              id="cancel-detail"
              className="cx-textarea"
              name="detail"
              placeholder="Only if you feel like it."
            />
          </div>
          <button type="submit" className="cx-btn cx-btn--primary">
            Continue
          </button>
        </form>
        <hr className="cx-divider" />
        <form method="post" className="cx-center">
          <input type="hidden" name="intent" value="cancel-now" />
          <input type="hidden" name="contractId" value={data.contractId ?? ""} />
          <button type="submit" className="cx-link-quiet">
            Prefer to skip this? Cancel right away
          </button>
        </form>
      </div>
    </div>
  );
}
