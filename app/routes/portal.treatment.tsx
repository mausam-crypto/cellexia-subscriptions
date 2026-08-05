/**
 * Adjust my treatment — quantities, variant swaps, cadence, remove (keep-one
 * guard), pause/resume, and the add-product flow with mode choice
 * (next delivery only / every delivery / N deliveries / different cadence).
 *
 * All contract mutations go through core contract functions (draft workflow,
 * audit, events, idempotency live there) with the verified customer identity.
 * Ended (cancelled/expired) plans render a closed screen and every action is
 * status-guarded server-side, so a stale tab can never mutate a dead plan.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import prisma from "~/db.server";
import { addDays, isoDate } from "~/lib/dates";
import { logger } from "~/lib/logger.server";
import { generateToken } from "~/lib/crypto.server";
import { appendAudit } from "~/services/audit.server";
import { emitLifecycleEvent } from "~/services/events.server";
import { withIdempotency } from "~/services/idempotency.server";
import {
  getOfflineAdmin,
  toGid,
  ShopifyGraphqlError,
} from "~/services/core/shopifyClient.server";
import {
  AlreadyPausedError,
  KeepOneLineError,
  addLineToContract,
  pauseUntil,
  removeLineFromContract,
  resumeContract,
  swapLineVariant,
  switchCadence,
  updateLineQuantity,
} from "~/services/core/contracts.server";
import { planAdjustedPriceCents } from "~/services/core/pure";
import {
  getPauseGate,
  getScheduleGate,
} from "~/services/retention/policy.server";
import {
  fetchDefaultVariant,
  fetchVariantsByProduct,
  findOwnedContract,
  findPrimaryContract,
  getPlanDiscounts,
  requirePortalCustomer,
  trackPortal,
} from "~/services/portal/auth.server";
import {
  cadenceLabel,
  cadenceOptionsFromConfigs,
  canRemoveLine,
  clampQuantity,
  contractPercentOff,
  formatCents,
  humanDateLabel,
  isTerminalContractStatus,
  pauseResumeDate,
} from "~/components/portal/logic";
import { PAUSE_OPTIONS_DAYS } from "~/types/domain";
import { ConfirmBanner } from "~/components/portal/ConfirmBanner";
import { GateNotice } from "~/components/portal/GateNotice";
import { ProductCard } from "~/components/portal/ProductCard";
import { QuantityStepper } from "~/components/portal/Stepper";

export { PortalErrorBoundary as ErrorBoundary } from "~/components/portal/PortalErrorBoundary";

// ─────────────────────────────── Pause gate copy ──────────────────────────

/**
 * The one line shown wherever pausing is locked — on the disabled controls
 * and on the blocked-action notice alike. Reason-aware: the first-delivery
 * window still allows delaying/skipping, a committed plan does not.
 */
function pauseLockedLine(
  reason: string | null,
  dateLabel: string | null,
  progressLabel: string | null,
): string {
  if (reason === "COMMITMENT") {
    return progressLabel
      ? `Your committed plan keeps deliveries on schedule — pausing unlocks after your final committed delivery (you're at ${progressLabel}).`
      : "Your committed plan keeps deliveries on schedule — pausing unlocks after your final committed delivery.";
  }
  return dateLabel
    ? `Pausing opens on ${dateLabel} — until then you can delay or skip a delivery.`
    : "Pausing opens a little later in your treatment — until then you can delay or skip a delivery.";
}

/** Shown wherever schedule changes (cadence here) are locked by a commitment. */
function scheduleLockedLine(progressLabel: string | null): string {
  return progressLabel
    ? `Your delivery rhythm is set for your committed plan — changes unlock after your final committed delivery (you're at ${progressLabel}).`
    : "Your delivery rhythm is set for your committed plan — changes unlock after your final committed delivery.";
}

function commitmentProgressLabel(
  commitment: { completedDeliveries: number; minDeliveries: number } | null,
): string | null {
  if (!commitment) return null;
  return `${commitment.completedDeliveries} of ${commitment.minDeliveries} deliveries`;
}

// ─────────────────────────────── Loader ───────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  const customer = await requirePortalCustomer(request);
  const contract = await findPrimaryContract(customer);
  if (!contract) throw redirect("/portal");

  // A cancelled/expired plan renders a calm closed screen — never live
  // controls that would 500 against a dead Shopify contract.
  if (isTerminalContractStatus(contract.status)) {
    await trackPortal(
      customer.shop,
      customer.shopifyCustomerId,
      contract.id,
      "VIEW",
      "treatment-ended",
    );
    return json({
      ended: true as const,
      endedAtLabel: humanDateLabel(contract.cancelledAt),
    });
  }

  // Customer-facing gates (first-delivery window / committed plans): fetched
  // here so pause and cadence controls render disabled with an explanation
  // rather than disappearing. CS and system paths are never gated.
  const [pauseGate, scheduleGate] = await Promise.all([
    getPauseGate(customer.shop, contract.id),
    getScheduleGate(customer.shop, contract.id),
  ]);

  const url = new URL(request.url);
  const currency = contract.currencyCode;

  const configs = await prisma.sellingPlanConfig.findMany({
    where: { shop: customer.shop, active: true },
    select: { plansJson: true },
  });
  let cadences = cadenceOptionsFromConfigs(configs.map((c) => c.plansJson));
  if (!cadences.includes(contract.intervalWeeks)) {
    cadences = [...cadences, contract.intervalWeeks].sort((a, b) => a - b);
  }

  const ownedProductGids = new Set(
    contract.lines.map((line) => toGid("Product", line.shopifyProductId)),
  );
  const addable = (
    await prisma.productMeta.findMany({
      where: { shop: customer.shop, subscribable: true, active: true },
      orderBy: { title: "asc" },
    })
  ).filter((p) => !ownedProductGids.has(toGid("Product", p.shopifyProductId)));

  const lineProductGids = contract.lines.map((line) =>
    toGid("Product", line.shopifyProductId),
  );
  const addableGids = addable.map((p) => toGid("Product", p.shopifyProductId));

  // Variant options are an enhancement — a Shopify hiccup (or demo mode)
  // must never take the page down; swaps just fall back to "current only"
  // and add-price disclosure quietly hides.
  let variantsByProduct: Awaited<ReturnType<typeof fetchVariantsByProduct>> = {};
  try {
    const { graphql } = await getOfflineAdmin(customer.shop);
    variantsByProduct = await fetchVariantsByProduct(graphql, [
      ...lineProductGids,
      ...addableGids,
    ]);
  } catch (error) {
    logger.warn("portal treatment variant options unavailable", {
      shop: customer.shop,
      error: String(error),
    });
  }

  // The plan discount used to price additions — resolved from the lines'
  // selling plans (shop defaults / recorded checkout discount as fallbacks),
  // exactly how core prices an added line, so the shown price IS the price.
  const discounts = await getPlanDiscounts(customer.shop);
  const percent = contractPercentOff(contract.lines, discounts, {
    committedPlan: Boolean(scheduleGate.commitment),
    initialDiscountPercent: contract.initialDiscountPercent,
  });

  const addableView = addable.flatMap((p) => {
    const gid = toGid("Product", p.shopifyProductId);
    const variants = variantsByProduct[gid];
    // A product whose variants are ALL unavailable is never offered.
    if (variants && variants.length === 0) return [];
    const variant = variants?.[0] ?? null;
    return [
      {
        productId: p.shopifyProductId,
        title: p.title,
        oneTimePriceLabel: variant
          ? formatCents(variant.priceCents, currency)
          : null,
        subscriberPriceLabel: variant
          ? formatCents(planAdjustedPriceCents(percent, variant.priceCents), currency)
          : null,
      },
    ];
  });

  await trackPortal(
    customer.shop,
    customer.shopifyCustomerId,
    contract.id,
    "VIEW",
    "treatment",
  );

  return json({
    ended: false as const,
    contractId: contract.id,
    status: contract.status,
    pausedUntilLabel: humanDateLabel(contract.pausedUntil),
    intervalWeeks: contract.intervalWeeks,
    cadences: cadences.map((weeks) => ({ weeks, label: cadenceLabel(weeks) })),
    lines: contract.lines.map((line) => {
      const productGid = toGid("Product", line.shopifyProductId);
      return {
        id: line.id,
        title: line.title,
        quantity: line.quantity,
        priceLabel: formatCents(line.currentPriceCents, currency),
        currentVariantId: line.shopifyVariantId,
        variants: (variantsByProduct[productGid] ?? []).map((v) => ({
          id: v.id,
          title: v.title,
          priceLabel: formatCents(v.priceCents, currency),
        })),
      };
    }),
    canRemove: canRemoveLine(contract.lines.length),
    addable: addableView,
    pauseOptions: [...PAUSE_OPTIONS_DAYS],
    pauseGate: {
      allowed: pauseGate.allowed,
      reason: pauseGate.reason,
      unlocksAtLabel: humanDateLabel(pauseGate.unlocksAt),
      progressLabel: commitmentProgressLabel(pauseGate.commitment),
    },
    scheduleGate: {
      allowed: scheduleGate.allowed,
      progressLabel: commitmentProgressLabel(scheduleGate.commitment),
    },
    // Earliest custom resume date the action accepts (pauseResumeDate
    // requires a date strictly after today, UTC).
    pauseMinDate: isoDate(addDays(new Date(), 1)),
    focusAdd: url.searchParams.get("focus") === "add",
    done: url.searchParams.get("done"),
    doneTitle: url.searchParams.get("title"),
    doneDate: url.searchParams.get("date"),
    error: url.searchParams.get("error"),
    errorReason: url.searchParams.get("reason"),
    errorProgress: url.searchParams.get("progress"),
    nonce: generateToken(8),
  });
}

// ─────────────────────────────── Action ───────────────────────────────────

export async function action({ request }: ActionFunctionArgs) {
  const customer = await requirePortalCustomer(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  // Ownership check before any mutation.
  const contract = await findOwnedContract(
    customer,
    String(form.get("contractId") ?? ""),
  );
  // Status guard: direct POSTs cannot reach live mutations on a dead plan.
  if (isTerminalContractStatus(contract.status)) {
    return redirect("/portal");
  }
  const { graphql } = await getOfflineAdmin(customer.shop);
  const shop = customer.shop;

  const trackAction = (detail: string) =>
    trackPortal(shop, customer.shopifyCustomerId, contract.id, "ACTION", detail);

  if (intent === "quantity") {
    const line = contract.lines.find((l) => l.id === String(form.get("lineId")));
    if (!line) throw new Response("Not found", { status: 404 });
    const quantity = clampQuantity(Number(form.get("quantity")));
    if (quantity === line.quantity) return redirect("/portal/treatment");
    await updateLineQuantity(graphql, shop, contract.id, line.id, quantity);
    await trackAction("quantity");
    return redirect(
      `/portal/treatment?done=quantity&title=${encodeURIComponent(line.title)}`,
    );
  }

  if (intent === "swap") {
    const line = contract.lines.find((l) => l.id === String(form.get("lineId")));
    if (!line) throw new Response("Not found", { status: 404 });
    const requested = String(form.get("variantGid") ?? "");
    // Validate server-side that the variant really belongs to this product.
    const productGid = toGid("Product", line.shopifyProductId);
    const variants = (await fetchVariantsByProduct(graphql, [productGid]))[
      productGid
    ];
    if (!variants?.some((v) => v.id === requested)) {
      return redirect("/portal/treatment?error=variant");
    }
    if (requested === line.shopifyVariantId) return redirect("/portal/treatment");
    await swapLineVariant(graphql, shop, contract.id, line.id, requested);
    await trackAction("swap");
    return redirect(
      `/portal/treatment?done=swap&title=${encodeURIComponent(line.title)}`,
    );
  }

  if (intent === "cadence") {
    // Committed plans keep their schedule fixed until the commitment is met —
    // re-checked here so the gate holds even against direct POSTs.
    const schedule = await getScheduleGate(shop, contract.id);
    if (!schedule.allowed) {
      const progress = commitmentProgressLabel(schedule.commitment);
      return redirect(
        `/portal/treatment?error=schedule-locked${
          progress ? `&progress=${encodeURIComponent(progress)}` : ""
        }`,
      );
    }
    const weeks = Number(form.get("weeks"));
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > 52) {
      throw new Response("Bad request", { status: 400 });
    }
    if (weeks === contract.intervalWeeks) return redirect("/portal/treatment");
    await switchCadence(graphql, shop, contract.id, weeks);
    await trackAction("cadence");
    return redirect(`/portal/treatment?done=cadence`);
  }

  if (intent === "remove") {
    const line = contract.lines.find((l) => l.id === String(form.get("lineId")));
    if (!line) throw new Response("Not found", { status: 404 });
    // Keep-one guard, re-checked against a FRESH count just before the
    // mutation (the loader snapshot can be seconds stale across two tabs).
    const freshCount = await prisma.contractLine.count({
      where: { contractId: contract.id },
    });
    if (!canRemoveLine(freshCount)) {
      return redirect("/portal/treatment?error=keep-one");
    }
    try {
      // keepOne: core re-counts the REMOTE lines inside the idempotent edit,
      // closing the check-then-act race two concurrent tabs could win.
      await removeLineFromContract(graphql, shop, contract.id, line.id, {
        keepOne: true,
      });
    } catch (error) {
      // Friendly banner for the transactional guard and for any draft-commit
      // userError backstopping the residual race — never a raw 500, and the
      // plan is left unchanged.
      if (
        error instanceof KeepOneLineError ||
        error instanceof ShopifyGraphqlError
      ) {
        logger.warn("portal remove blocked", {
          shop,
          contractId: contract.id,
          error: String(error),
        });
        return redirect("/portal/treatment?error=keep-one");
      }
      throw error;
    }
    await trackAction("remove");
    return redirect(
      `/portal/treatment?done=remove&title=${encodeURIComponent(line.title)}`,
    );
  }

  if (intent === "pause") {
    // Re-check the pause gate on every attempt — the disabled controls are
    // a courtesy; the gate must hold even against direct POSTs.
    const gate = await getPauseGate(shop, contract.id);
    if (!gate.allowed) {
      const dateLabel = humanDateLabel(gate.unlocksAt);
      const progress = commitmentProgressLabel(gate.commitment);
      const params = new URLSearchParams({ error: "pause-locked" });
      if (gate.reason) params.set("reason", gate.reason);
      if (dateLabel) params.set("date", dateLabel);
      if (progress) params.set("progress", progress);
      return redirect(`/portal/treatment?${params.toString()}`);
    }
    const resumeDate = pauseResumeDate(
      String(form.get("option") ?? ""),
      new Date(),
      String(form.get("customDate") ?? ""),
    );
    if (!resumeDate) return redirect("/portal/treatment?error=pause-date");
    let updated;
    try {
      updated = await pauseUntil(graphql, shop, contract.id, resumeDate);
    } catch (error) {
      if (error instanceof AlreadyPausedError) {
        return redirect("/portal/treatment?error=already-paused");
      }
      throw error;
    }
    await trackAction("pause");
    return redirect(
      `/portal/treatment?done=pause&date=${encodeURIComponent(
        humanDateLabel(updated.pausedUntil ?? resumeDate) ?? "",
      )}`,
    );
  }

  if (intent === "resume") {
    await resumeContract(graphql, shop, contract.id);
    await trackAction("resume");
    return redirect("/portal/treatment?done=resume");
  }

  if (intent === "add-product") {
    const productId = String(form.get("productId") ?? "");
    const mode = String(form.get("mode") ?? "");
    const nonce = String(form.get("nonce") ?? "") || generateToken(8);
    const meta = await prisma.productMeta.findFirst({
      where: {
        shop,
        subscribable: true,
        active: true,
        shopifyProductId: { in: [productId, toGid("Product", productId)] },
      },
    });
    if (!meta) return redirect("/portal/treatment?error=product");
    // Availability-aware server-side lookup: price and variant always come
    // from Shopify, never from the form.
    const variant = await fetchDefaultVariant(graphql, meta.shopifyProductId);
    if (!variant) return redirect("/portal/treatment?error=product");

    if (mode === "EVERY" || mode === "DIFFERENT_CADENCE") {
      // No explicit priceCents: core prices the line at the SUBSCRIBER price
      // (plan discount applied) — the same figure the loader disclosed.
      await addLineToContract(graphql, shop, contract.id, {
        variantGid: variant.id,
        quantity: 1,
      });
      if (mode === "DIFFERENT_CADENCE") {
        const requestedWeeks = Number(form.get("cadence"));
        // The product joins the existing plan; the requested rhythm is
        // recorded for the care team to fine-tune (a contract has one cadence).
        await appendAudit({
          shop,
          actorType: "CUSTOMER",
          actorId: customer.shopifyCustomerId,
          action: "PORTAL_ADD_PRODUCT_CADENCE_REQUEST",
          subjectType: "SubscriptionContract",
          subjectId: contract.id,
          payload: {
            productId: meta.shopifyProductId,
            requestedIntervalWeeks: Number.isInteger(requestedWeeks)
              ? requestedWeeks
              : null,
          },
        });
      }
      await trackAction(`add-product:${mode}`);
      return redirect(
        `/portal/treatment?done=add-every&title=${encodeURIComponent(meta.title)}`,
      );
    }

    if (mode === "NEXT_ONLY" || mode === "N_DELIVERIES") {
      const count =
        mode === "N_DELIVERIES"
          ? Math.min(12, Math.max(2, Number(form.get("count")) || 3))
          : null;
      await withIdempotency(
        `portal:addon:${contract.id}:${variant.id}:${mode}:${nonce}`,
        "portal-addon",
        async () => {
          await prisma.addOnItem.create({
            data: {
              contractId: contract.id,
              shopifyProductId: toGid("Product", meta.shopifyProductId),
              shopifyVariantId: variant.id,
              title: meta.title,
              quantity: 1,
              priceCents: variant.priceCents,
              mode,
              remainingDeliveries: count,
              source: "portal",
            },
          });
          await appendAudit({
            shop,
            actorType: "CUSTOMER",
            actorId: customer.shopifyCustomerId,
            action: "PORTAL_ADD_ON_ADDED",
            subjectType: "SubscriptionContract",
            subjectId: contract.id,
            payload: { productId: meta.shopifyProductId, mode, count },
          });
          await emitLifecycleEvent({
            shop,
            name: "PRODUCT_ADDED",
            contractId: contract.id,
            shopifyCustomerId: customer.shopifyCustomerId,
            email: customer.email,
            payload: { title: meta.title, mode, count, source: "portal" },
          });
          return { added: meta.shopifyProductId };
        },
      );
      await trackAction(`add-product:${mode}`);
      return redirect(
        `/portal/treatment?done=${mode === "NEXT_ONLY" ? "add-next" : "add-n"}&title=${encodeURIComponent(meta.title)}`,
      );
    }

    throw new Response("Bad request", { status: 400 });
  }

  throw new Response("Bad request", { status: 400 });
}

// ─────────────────────────────── View ─────────────────────────────────────

const DONE_COPY: Record<string, (title: string | null, date: string | null) => string> = {
  quantity: (t) => `Quantity updated for ${t ?? "your product"} — from your next delivery on.`,
  swap: (t) => `${t ?? "Your product"} has been switched — from your next delivery on.`,
  cadence: () => "Your delivery rhythm is updated. Everything else stays as it was.",
  remove: (t) => `${t ?? "That product"} has been removed from your plan.`,
  pause: (_t, d) =>
    d
      ? `Your treatment is paused. Deliveries resume around ${d} — we'll remind you before it resumes.`
      : "Your treatment is paused — we'll remind you before it resumes.",
  resume: () => "Welcome back — your deliveries are flowing again.",
  "add-every": (t) => `${t ?? "Your addition"} now arrives with every delivery.`,
  "add-next": (t) => `${t ?? "Your addition"} will arrive with your next delivery only.`,
  "add-n": (t) => `${t ?? "Your addition"} will arrive with your next few deliveries.`,
};

const ERROR_COPY: Record<string, string> = {
  "keep-one":
    "Your plan keeps at least one product — swap it for another instead, or pause your treatment.",
  variant: "That size isn't available right now — pick another option.",
  product: "That product isn't available to add right now.",
  "pause-date": "Pick a resume date that's ahead of today.",
  "already-paused":
    "Your treatment is already paused — resume it first if you'd like different dates.",
};

export default function PortalTreatment() {
  const data = useLoaderData<typeof loader>();

  if (data.ended) {
    return (
      <div className="cx-auth-wrap">
        <div className="cx-card cx-card--accent cx-card--center">
          <span className="cx-eyebrow">Adjust my treatment</span>
          <h1 className="cx-headline">
            {data.endedAtLabel
              ? `Your treatment ended on ${data.endedAtLabel}`
              : "Your treatment has ended"}
          </h1>
          <p className="cx-lead">
            There's nothing to adjust right now — no deliveries are scheduled
            and nothing will be charged. Your routine stays saved, ready
            whenever you are.
          </p>
          <div
            className="cx-actions-row"
            style={{ justifyContent: "center", marginTop: 18 }}
          >
            <Link to="/portal" className="cx-btn cx-btn--primary">
              Back to my space
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const doneCopy = data.done ? DONE_COPY[data.done] : undefined;

  return (
    <div>
      {doneCopy ? (
        <ConfirmBanner title="Done">
          {doneCopy(data.doneTitle, data.doneDate)}
        </ConfirmBanner>
      ) : null}
      {data.error === "pause-locked" ? (
        <GateNotice
          tone="banner"
          title="Not just yet"
          lines={[
            pauseLockedLine(data.errorReason, data.doneDate, data.errorProgress),
          ]}
        />
      ) : data.error === "schedule-locked" ? (
        <GateNotice
          tone="banner"
          title="Your schedule is set for now"
          lines={[scheduleLockedLine(data.errorProgress)]}
        />
      ) : data.error && ERROR_COPY[data.error] ? (
        <ConfirmBanner tone="info" title="One small thing">
          {ERROR_COPY[data.error]}
        </ConfirmBanner>
      ) : null}

      <header className="cx-section">
        <span className="cx-eyebrow">Adjust my treatment</span>
        <h1 className="cx-headline cx-headline--page">Make it yours</h1>
        <p className="cx-muted">
          Quantities, sizes, rhythm, pauses — changes apply from your next
          delivery. Adjust, delay or cancel online.
        </p>
      </header>

      {data.status === "PAUSED" ? (
        <div className="cx-card cx-card--accent">
          <h2 className="cx-headline">Your treatment is paused</h2>
          <p className="cx-section__intro">
            {data.pausedUntilLabel
              ? `Deliveries resume around ${data.pausedUntilLabel}. We'll remind you before it resumes.`
              : "Deliveries are on hold. We'll remind you before it resumes."}
          </p>
          <form method="post">
            <input type="hidden" name="intent" value="resume" />
            <input type="hidden" name="contractId" value={data.contractId} />
            <button type="submit" className="cx-btn cx-btn--primary">
              Resume my treatment
            </button>
          </form>
        </div>
      ) : null}

      <section className="cx-section">
        <span className="cx-eyebrow">My products</span>
        {data.lines.map((line) => (
          <ProductCard
            key={line.id}
            title={line.title}
            priceLabel={line.priceLabel}
          >
            <QuantityStepper
              contractId={data.contractId}
              lineId={line.id}
              quantity={line.quantity}
              title={line.title}
            />
            {line.variants.length > 1 ? (
              <form method="post" className="cx-inline-form">
                <input type="hidden" name="intent" value="swap" />
                <input type="hidden" name="contractId" value={data.contractId} />
                <input type="hidden" name="lineId" value={line.id} />
                <select
                  className="cx-select"
                  style={{ minHeight: 40, padding: "8px 10px", width: "auto" }}
                  name="variantGid"
                  defaultValue={line.currentVariantId}
                  aria-label={`Option for ${line.title}`}
                >
                  {line.variants.map((variant) => (
                    <option key={variant.id} value={variant.id}>
                      {variant.title} — {variant.priceLabel}
                    </option>
                  ))}
                </select>
                <button type="submit" className="cx-btn cx-btn--secondary cx-btn--small">
                  Switch
                </button>
              </form>
            ) : null}
            {data.canRemove ? (
              <form method="post">
                <input type="hidden" name="intent" value="remove" />
                <input type="hidden" name="contractId" value={data.contractId} />
                <input type="hidden" name="lineId" value={line.id} />
                <button type="submit" className="cx-link-quiet">
                  Remove
                </button>
              </form>
            ) : (
              <span className="cx-note">
                Your plan keeps at least one product — swap it, or pause below.
              </span>
            )}
          </ProductCard>
        ))}
      </section>

      <section className="cx-section">
        <div className="cx-card">
          <h2 className="cx-headline">Delivery rhythm</h2>
          <p className="cx-section__intro">
            Currently {cadenceLabel(data.intervalWeeks).toLowerCase()}. Pick the
            pace that fits how you actually use your products.
          </p>
          {!data.scheduleGate.allowed ? (
            <p className="cx-note" style={{ margin: "0 0 14px" }}>
              {scheduleLockedLine(data.scheduleGate.progressLabel)}
            </p>
          ) : null}
          <form method="post" className="cx-chip-row">
            <input type="hidden" name="intent" value="cadence" />
            <input type="hidden" name="contractId" value={data.contractId} />
            {data.cadences.map((option) => (
              <button
                key={option.weeks}
                type="submit"
                name="weeks"
                value={option.weeks}
                className={`cx-chip${option.weeks === data.intervalWeeks ? " is-selected" : ""}`}
                aria-pressed={option.weeks === data.intervalWeeks}
                disabled={!data.scheduleGate.allowed}
                aria-disabled={!data.scheduleGate.allowed || undefined}
                style={
                  !data.scheduleGate.allowed
                    ? { color: "var(--cx-grey-mid)", cursor: "not-allowed" }
                    : undefined
                }
              >
                {option.label}
              </button>
            ))}
          </form>
        </div>
      </section>

      <section className="cx-section" id="add">
        <div className={`cx-card${data.focusAdd ? " cx-card--accent" : ""}`}>
          <h2 className="cx-headline">Add a product</h2>
          <p className="cx-section__intro">
            Grow your routine at your own pace — on your terms. Prices shown
            are per delivery, before delivery-mode choices.
          </p>
          {data.addable.length === 0 ? (
            <p className="cx-muted">
              Your routine already includes everything available right now.
            </p>
          ) : (
            <form method="post">
              <input type="hidden" name="intent" value="add-product" />
              <input type="hidden" name="contractId" value={data.contractId} />
              <input type="hidden" name="nonce" value={data.nonce} />
              <div className="cx-field">
                <label className="cx-field__label" htmlFor="add-product-select">
                  Product
                </label>
                <select
                  id="add-product-select"
                  className="cx-select"
                  name="productId"
                  required
                >
                  {data.addable.map((product) => (
                    <option key={product.productId} value={product.productId}>
                      {product.title}
                      {product.subscriberPriceLabel
                        ? ` — ${product.subscriberPriceLabel} per delivery`
                        : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div className="cx-field">
                <span className="cx-field__label">How would you like it?</span>
                <label className="cx-choice">
                  <input type="radio" name="mode" value="NEXT_ONLY" defaultChecked />
                  <span className="cx-choice__label">
                    Next delivery only
                    <span className="cx-choice__hint">
                      A one-time addition at the standard price — try it once.
                    </span>
                  </span>
                </label>
                <label className="cx-choice">
                  <input type="radio" name="mode" value="EVERY" />
                  <span className="cx-choice__label">
                    Every delivery
                    <span className="cx-choice__hint">
                      Joins your plan with subscriber pricing — the per-delivery
                      price shown beside each product.
                    </span>
                  </span>
                </label>
                <label className="cx-choice">
                  <input type="radio" name="mode" value="N_DELIVERIES" />
                  <span className="cx-choice__label">
                    For a few deliveries
                    <span className="cx-choice__hint">
                      Choose how many:{" "}
                      <select name="count" defaultValue="3" className="cx-select" style={{ display: "inline-block", width: "auto", minHeight: 36, padding: "6px 8px" }}>
                        {[2, 3, 4, 6].map((n) => (
                          <option key={n} value={n}>{n}</option>
                        ))}
                      </select>
                    </span>
                  </span>
                </label>
                <label className="cx-choice">
                  <input type="radio" name="mode" value="DIFFERENT_CADENCE" />
                  <span className="cx-choice__label">
                    On its own rhythm
                    <span className="cx-choice__hint">
                      Preferred pace:{" "}
                      <select name="cadence" defaultValue={String(data.intervalWeeks)} className="cx-select" style={{ display: "inline-block", width: "auto", minHeight: 36, padding: "6px 8px" }}>
                        {data.cadences.map((option) => (
                          <option key={option.weeks} value={option.weeks}>{option.label}</option>
                        ))}
                      </select>{" "}
                      — it joins your plan and our care team aligns the rhythm.
                    </span>
                  </span>
                </label>
              </div>
              <button type="submit" className="cx-btn cx-btn--primary">
                Add to my treatment
              </button>
            </form>
          )}
        </div>
      </section>

      {data.status !== "PAUSED" ? (
        <section className="cx-section">
          <div className="cx-card">
            <h2 className="cx-headline">Take a break</h2>
            <p className="cx-section__intro">
              Pause your whole treatment — we'll remind you before it resumes.
            </p>
            {/* Locked controls stay visible and explained, never hidden. */}
            {!data.pauseGate.allowed ? (
              <p className="cx-note" style={{ margin: "0 0 14px" }}>
                {pauseLockedLine(
                  data.pauseGate.reason,
                  data.pauseGate.unlocksAtLabel,
                  data.pauseGate.progressLabel,
                )}
              </p>
            ) : null}
            <form method="post" className="cx-chip-row" style={{ marginBottom: 14 }}>
              <input type="hidden" name="intent" value="pause" />
              <input type="hidden" name="contractId" value={data.contractId} />
              {data.pauseOptions.map((days) => (
                <button
                  key={days}
                  type="submit"
                  name="option"
                  value={days}
                  className="cx-chip"
                  disabled={!data.pauseGate.allowed}
                  aria-disabled={!data.pauseGate.allowed || undefined}
                  style={
                    !data.pauseGate.allowed
                      ? { color: "var(--cx-grey-mid)", cursor: "not-allowed" }
                      : undefined
                  }
                >
                  {days} days
                </button>
              ))}
            </form>
            <form method="post" className="cx-inline-form">
              <input type="hidden" name="intent" value="pause" />
              <input type="hidden" name="contractId" value={data.contractId} />
              <input type="hidden" name="option" value="custom" />
              <label className="cx-muted" htmlFor="pause-custom-date">
                or until a date of your choosing
              </label>
              <input
                id="pause-custom-date"
                type="date"
                name="customDate"
                className="cx-input"
                style={{ maxWidth: 200 }}
                min={data.pauseMinDate}
                disabled={!data.pauseGate.allowed}
                required
              />
              <button
                type="submit"
                className="cx-btn cx-btn--secondary cx-btn--small"
                disabled={!data.pauseGate.allowed}
                aria-disabled={!data.pauseGate.allowed || undefined}
              >
                Pause until then
              </button>
            </form>
          </div>
        </section>
      ) : null}
    </div>
  );
}
