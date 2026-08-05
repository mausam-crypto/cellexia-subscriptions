/**
 * THE TREATMENT DASHBOARD — the heart of the portal.
 *
 * Current routine, next delivery + countdown, supply remaining per product,
 * subscriber savings, treatment duration, milestones, recommended additions
 * (one-click add), and the four prominent actions. Cancel lives behind
 * "Manage subscription" — visible there, never central here.
 *
 * Status-aware: CANCELLED / EXPIRED plans render a closed-plan screen (warm
 * win-back, no live delivery copy); FAILED plans lead with the payment issue
 * and suppress the serene countdown. Live copy only for live plans.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import prisma from "~/db.server";
import { logger } from "~/lib/logger.server";
import { generateToken } from "~/lib/crypto.server";
import { appendAudit } from "~/services/audit.server";
import { emitLifecycleEvent } from "~/services/events.server";
import { withIdempotency } from "~/services/idempotency.server";
import { rankAddOnCandidates } from "~/services/offers/preShipment.server";
import { commitmentStatusFor } from "~/services/retention/policy.server";
import {
  getOfflineAdmin,
  toGid,
} from "~/services/core/shopifyClient.server";
import {
  fetchVariantsByProduct,
  findOwnedContract,
  findPrimaryContract,
  getPlanDiscounts,
  requirePortalCustomer,
  trackPortal,
  type PortalContract,
} from "~/services/portal/auth.server";
import {
  buildAddOnRankingInputs,
  cadenceLabel,
  daysUntil,
  deliveryCountdownLabel,
  describeSupplyRemaining,
  formatCents,
  humanDateLabel,
  isPaymentHoldStatus,
  isTerminalContractStatus,
  lifetimeSavingsCents,
  milestoneLabel,
  normalizeRankedAddOns,
  perDeliverySavingsCents,
  resolveLinePercentOff,
  treatmentWeekLabel,
  type PortalAddOnSuggestion,
  type SuggestionCatalogRow,
} from "~/components/portal/logic";
import { ActionCard } from "~/components/portal/ActionCard";
import { ConfirmBanner } from "~/components/portal/ConfirmBanner";
import { MilestoneBadge } from "~/components/portal/MilestoneBadge";
import { ProductCard } from "~/components/portal/ProductCard";
import { StatTile } from "~/components/portal/StatTile";

export { PortalErrorBoundary as ErrorBoundary } from "~/components/portal/PortalErrorBoundary";

// ─────────────────────────────── Suggestions ──────────────────────────────

/**
 * Recommended additions, built from GENUINE `AddOnRankingInputs`: contract
 * lines → currentProductIds, ProductMeta joined with a real default variant
 * (id + live price via the shop's admin API) → candidates, compatibility
 * edges filtered to known relations, concerns derived from the current
 * routine. Prices are NEVER fabricated: a product without a currently
 * sellable variant and price is dropped, and any failure (demo mode, Shopify
 * hiccup) simply hides the section.
 */
async function computeSuggestions(
  shop: string,
  contract: PortalContract,
): Promise<PortalAddOnSuggestion[]> {
  try {
    const ownedGids = new Set(
      contract.lines.map((line) => toGid("Product", line.shopifyProductId)),
    );
    const [catalog, edges] = await Promise.all([
      prisma.productMeta.findMany({
        where: { shop, subscribable: true, active: true },
      }),
      prisma.compatibilityEdge.findMany({ where: { shop } }),
    ]);
    const candidatesMeta = catalog.filter(
      (p) => !ownedGids.has(toGid("Product", p.shopifyProductId)),
    );
    if (candidatesMeta.length === 0) return [];

    // Real price + variant source. getOfflineAdmin throws in demo mode /
    // before install — the catch below fail-softs to "no suggestions".
    const { graphql } = await getOfflineAdmin(shop);
    const variantsByProduct = await fetchVariantsByProduct(
      graphql,
      candidatesMeta.map((p) => toGid("Product", p.shopifyProductId)),
    );

    const catalogRows: SuggestionCatalogRow[] = candidatesMeta.map((p) => {
      const gid = toGid("Product", p.shopifyProductId);
      const variant = (variantsByProduct[gid] ?? [])[0] ?? null;
      return {
        shopifyProductId: gid,
        title: p.title,
        concern: p.concern,
        grossMarginPercent: p.grossMarginPercent,
        variantId: variant?.id ?? null,
        priceCents: variant?.priceCents ?? null,
        availableForSale: Boolean(variant),
      };
    });

    const concernByProductId: Record<string, string | null | undefined> = {};
    for (const p of catalog) {
      concernByProductId[p.shopifyProductId] = p.concern;
      concernByProductId[toGid("Product", p.shopifyProductId)] = p.concern;
    }

    const inputs = buildAddOnRankingInputs({
      lines: contract.lines.map((line) => ({
        shopifyProductId: toGid("Product", line.shopifyProductId),
      })),
      catalog: catalogRows,
      edges: edges.map((edge) => ({
        fromProductId: edge.fromProductId,
        toProductId: edge.toProductId,
        relation: edge.relation,
        strength: edge.strength,
      })),
      concernByProductId,
    });

    return normalizeRankedAddOns(rankAddOnCandidates(inputs))
      .filter((s) => !ownedGids.has(toGid("Product", s.shopifyProductId)))
      .slice(0, 3);
  } catch (error) {
    logger.warn("portal add-on suggestions unavailable", {
      shop,
      error: String(error),
    });
    return [];
  }
}

// ─────────────────────────────── Loader ───────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  const customer = await requirePortalCustomer(request);
  const contract = await findPrimaryContract(customer);
  const url = new URL(request.url);
  const done = url.searchParams.get("done");
  const doneTitle = url.searchParams.get("title");
  const supportEmail = process.env.PORTAL_SUPPORT_EMAIL || "care@cellexia.com";

  if (!contract) {
    await trackPortal(
      customer.shop,
      customer.shopifyCustomerId,
      null,
      "VIEW",
      "dashboard-empty",
    );
    return json({ view: null, closed: null, done, doneTitle, supportEmail });
  }

  // Closed plans (cancelled / expired) never render live delivery copy —
  // a cancelled customer must not be told a delivery is being scheduled.
  if (isTerminalContractStatus(contract.status)) {
    await trackPortal(
      customer.shop,
      customer.shopifyCustomerId,
      contract.id,
      "VIEW",
      "dashboard-closed",
    );
    return json({
      view: null,
      closed: {
        status: contract.status,
        endedAtLabel: humanDateLabel(contract.cancelledAt),
        lineTitles: contract.lines.map((line) => line.title),
      },
      done,
      doneTitle,
      supportEmail,
    });
  }

  const now = new Date();
  const currency = contract.currencyCode;
  const paymentHold = isPaymentHoldStatus(contract.status);
  const nextDate = contract.nextDeliveryDate ?? contract.nextBillingDate;
  const days = nextDate && !paymentHold ? daysUntil(nextDate, now) : null;

  const lines = contract.lines.map((line) => ({
    id: line.id,
    title: line.title,
    quantity: line.quantity,
    priceLabel: formatCents(line.currentPriceCents, currency),
    supplyLabel: describeSupplyRemaining(
      line.depletion?.predictedRunOutAt ?? null,
      now,
    ),
    meta: `Qty ${line.quantity} · ${cadenceLabel(contract.intervalWeeks)}`,
  }));

  // Applied add-ons already exist as real contract lines (the fulfillment
  // engine stamps appliedAt when it injects them) — listing them again here
  // would double-count the delivery contents.
  const upcomingAddOns = contract.addOns.filter(
    (addOn) =>
      addOn.appliedAt == null &&
      (addOn.mode === "RECURRING" ||
        addOn.mode === "NEXT_ONLY" ||
        (addOn.mode === "N_DELIVERIES" && (addOn.remainingDeliveries ?? 0) > 0)),
  );

  // Committed-plan progress — one quiet line on the routine card while the
  // commitment is underway; nothing once it's met (display only, the actual
  // gates live in the cancel and treatment routes).
  let commitmentLabel: string | null = null;
  let committedPlan = false;
  try {
    const commitment = await commitmentStatusFor(customer.shop, {
      id: contract.id,
      successfulOrders: contract.successfulOrders,
      lines: contract.lines,
    });
    committedPlan = commitment.committed;
    if (commitment.committed && !commitment.met) {
      commitmentLabel = `Committed plan — delivery ${commitment.completedDeliveries} of ${commitment.minDeliveries}`;
    }
  } catch (error) {
    logger.warn("portal commitment status unavailable", {
      shop: customer.shop,
      error: String(error),
    });
  }

  // Subscriber savings, derived per line from the selling plan the customer
  // actually signed up under (SellingPlanConfig lookup by sellingPlanId,
  // falling back to the shop's committed/standard defaults, then the recorded
  // checkout discount). Unknown discount → tile hidden, never a dash.
  let savingsPerDelivery: number | null = null;
  try {
    const discounts = await getPlanDiscounts(customer.shop);
    savingsPerDelivery = perDeliverySavingsCents(
      contract.lines.map((line) => ({
        quantity: line.quantity,
        currentPriceCents: line.currentPriceCents,
        percentOff: resolveLinePercentOff(line.sellingPlanId, discounts, {
          committedPlan,
          initialDiscountPercent: contract.initialDiscountPercent,
        }),
      })),
    );
  } catch (error) {
    logger.warn("portal savings unavailable", {
      shop: customer.shop,
      error: String(error),
    });
  }

  const view = {
    contractId: contract.id,
    status: contract.status,
    paymentHold,
    pausedUntilLabel: humanDateLabel(contract.pausedUntil),
    cadence: cadenceLabel(contract.intervalWeeks),
    weekLabel: treatmentWeekLabel(contract.treatmentStartedAt, now),
    nextDeliveryLabel: nextDate ? humanDateLabel(nextDate) : null,
    countdownLabel: days === null ? null : deliveryCountdownLabel(days),
    nextContents: [
      ...contract.lines.map((line) =>
        line.quantity > 1 ? `${line.quantity} × ${line.title}` : line.title,
      ),
      ...upcomingAddOns.map((addOn) =>
        addOn.quantity > 1 ? `${addOn.quantity} × ${addOn.title}` : addOn.title,
      ),
    ],
    lines,
    savingsPerDeliveryLabel:
      savingsPerDelivery !== null && savingsPerDelivery > 0
        ? formatCents(savingsPerDelivery, currency)
        : null,
    savingsLifetimeLabel:
      savingsPerDelivery !== null &&
      savingsPerDelivery > 0 &&
      contract.successfulOrders > 0
        ? formatCents(
            lifetimeSavingsCents(savingsPerDelivery, contract.successfulOrders),
            currency,
          )
        : null,
    milestones: contract.milestones.map((m) => ({
      label: milestoneLabel(m.type),
      dateLabel: humanDateLabel(m.achievedAt),
    })),
    commitmentLabel,
    // No upsell on a plan that's on payment hold — fixing the card comes first.
    suggestions: paymentHold
      ? []
      : (await computeSuggestions(customer.shop, contract)).map((s) => ({
          productId: s.shopifyProductId,
          title: s.title,
          priceLabel: formatCents(s.priceCents, currency),
          reason: s.reason,
        })),
    nonce: generateToken(8),
  };

  await trackPortal(
    customer.shop,
    customer.shopifyCustomerId,
    contract.id,
    "VIEW",
    "dashboard",
  );

  return json({ view, closed: null, done, doneTitle, supportEmail });
}

// ─────────────────────────────── Action ───────────────────────────────────

export async function action({ request }: ActionFunctionArgs) {
  const customer = await requirePortalCustomer(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent !== "add-addon") {
    throw new Response("Bad request", { status: 400 });
  }

  // Ownership check: the contract must belong to this verified customer.
  const contract = await findOwnedContract(
    customer,
    String(form.get("contractId") ?? ""),
  );
  // Add-ons only attach to plans that can still ship them.
  if (contract.status !== "ACTIVE" && contract.status !== "PAUSED") {
    throw new Response("Bad request", { status: 400 });
  }
  const productId = String(form.get("productId") ?? "");
  const mode = String(form.get("mode") ?? "");
  const nonce = String(form.get("nonce") ?? "") || generateToken(8);
  if (mode !== "NEXT_ONLY" && mode !== "RECURRING") {
    throw new Response("Bad request", { status: 400 });
  }

  // Never trust prices from the form: re-rank server-side and match.
  const suggestion = (await computeSuggestions(customer.shop, contract)).find(
    (s) => s.shopifyProductId === productId,
  );
  if (!suggestion) {
    return redirect("/portal?done=addon-unavailable");
  }

  await withIdempotency(
    `portal:addon:${contract.id}:${suggestion.shopifyVariantId}:${mode}:${nonce}`,
    "portal-addon",
    async () => {
      await prisma.addOnItem.create({
        data: {
          contractId: contract.id,
          shopifyProductId: suggestion.shopifyProductId,
          shopifyVariantId: suggestion.shopifyVariantId,
          title: suggestion.title,
          quantity: 1,
          priceCents: suggestion.priceCents,
          mode,
          source: "portal",
        },
      });
      await appendAudit({
        shop: customer.shop,
        actorType: "CUSTOMER",
        actorId: customer.shopifyCustomerId,
        action: "PORTAL_ADD_ON_ADDED",
        subjectType: "SubscriptionContract",
        subjectId: contract.id,
        payload: { productId: suggestion.shopifyProductId, mode },
      });
      await emitLifecycleEvent({
        shop: customer.shop,
        name: "PRODUCT_ADDED",
        contractId: contract.id,
        shopifyCustomerId: customer.shopifyCustomerId,
        email: customer.email,
        payload: { title: suggestion.title, mode, source: "portal" },
      });
      return { added: suggestion.shopifyProductId };
    },
  );

  await trackPortal(
    customer.shop,
    customer.shopifyCustomerId,
    contract.id,
    "ACTION",
    `add-addon:${mode}`,
  );

  return redirect(
    `/portal?done=${mode === "RECURRING" ? "addon-every" : "addon-next"}&title=${encodeURIComponent(suggestion.title)}`,
  );
}

// ─────────────────────────────── View ─────────────────────────────────────

function DoneBanner({
  done,
  title,
}: {
  done: string | null;
  title: string | null;
}) {
  if (!done) return null;
  if (done === "addon-next") {
    return (
      <ConfirmBanner title="Added to your next delivery">
        {title ?? "Your addition"} will arrive with your next delivery —
        nothing else changes.
      </ConfirmBanner>
    );
  }
  if (done === "addon-every") {
    return (
      <ConfirmBanner title="Added to every delivery">
        {title ?? "Your addition"} now arrives with every delivery. You can
        adjust this anytime.
      </ConfirmBanner>
    );
  }
  if (done === "addon-unavailable") {
    return (
      <ConfirmBanner tone="info" title="That one slipped away">
        That recommendation isn't available right now — your plan is unchanged.
      </ConfirmBanner>
    );
  }
  return null;
}

function ClosedPlanScreen({
  closed,
  supportEmail,
}: {
  closed: {
    status: string;
    endedAtLabel: string | null;
    lineTitles: string[];
  };
  supportEmail: string;
}) {
  return (
    <div className="cx-auth-wrap">
      <div className="cx-card cx-card--accent cx-card--center">
        <span className="cx-eyebrow">Your treatment space</span>
        <h1 className="cx-headline">
          {closed.endedAtLabel
            ? `Your treatment ended on ${closed.endedAtLabel}`
            : "Your treatment has ended"}
        </h1>
        <p className="cx-lead">
          No more deliveries, no more charges. Your routine
          {closed.lineTitles.length > 0
            ? ` — ${closed.lineTitles.join(", ")} —`
            : ""}{" "}
          and your history stay safely saved with us.
        </p>
        <p className="cx-note">
          Skin keeps its memory longer than you'd think. Whenever you're ready
          to pick your routine back up, we'll start you exactly where you left
          off — same products, same care.
        </p>
        <div
          className="cx-actions-row"
          style={{ justifyContent: "center", marginTop: 18 }}
        >
          <a
            href={`mailto:${supportEmail}?subject=Restarting%20my%20treatment`}
            className="cx-btn cx-btn--primary"
          >
            Restart my treatment
          </a>
          <Link to="/portal/routine" className="cx-btn cx-btn--secondary">
            Explore routines
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function PortalDashboard() {
  const { view, closed, done, doneTitle, supportEmail } =
    useLoaderData<typeof loader>();

  if (closed) {
    return <ClosedPlanScreen closed={closed} supportEmail={supportEmail} />;
  }

  if (!view) {
    return (
      <div className="cx-auth-wrap">
        <div className="cx-card cx-card--accent cx-card--center">
          <span className="cx-eyebrow">Your treatment space</span>
          <h1 className="cx-headline">No treatment plan yet</h1>
          <p className="cx-lead">
            When you start a Continuous Treatment plan, this is where you'll
            follow your routine, deliveries and progress.
          </p>
          <p className="cx-note">
            Already started one? Sign in with the email you used at checkout.
          </p>
          {/* /portal/logout clears the session first — a signed-in customer
              hitting /portal/login directly is bounced straight back here. */}
          <Link to="/portal/logout" className="cx-btn cx-btn--secondary">
            Sign in with another email
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div>
      <DoneBanner done={done} title={doneTitle} />

      {view.paymentHold ? (
        <ConfirmBanner tone="info" title="A payment needs your attention">
          Your last charge didn't go through, so your deliveries are on hold.
          It takes a minute to put right —{" "}
          <Link to="/portal/manage" className="cx-link-quiet">
            update your payment method
          </Link>{" "}
          and everything picks up where it left off.
        </ConfirmBanner>
      ) : null}

      {view.status === "PAUSED" ? (
        <ConfirmBanner tone="info" title="Your treatment is paused">
          {view.pausedUntilLabel
            ? `Deliveries resume around ${view.pausedUntilLabel}. `
            : "Deliveries are on hold. "}
          <Link to="/portal/treatment" className="cx-link-quiet">
            Resume whenever you're ready
          </Link>
          .
        </ConfirmBanner>
      ) : null}

      <header className="cx-section">
        {view.weekLabel ? (
          <span className="cx-eyebrow">{view.weekLabel}</span>
        ) : (
          <span className="cx-eyebrow">Your treatment</span>
        )}
        <h1 className="cx-headline cx-headline--page">Your treatment</h1>
        <p className="cx-muted">
          Everything about your routine, in one calm place. Adjust, delay or
          cancel online.
        </p>
      </header>

      <section className="cx-section">
        <div className="cx-grid cx-grid--4">
          <StatTile
            label="Next delivery"
            value={
              view.paymentHold
                ? "On hold"
                : (view.nextDeliveryLabel ?? "Being scheduled")
            }
            hint={
              view.paymentHold
                ? "Until payment is updated"
                : view.countdownLabel
            }
          />
          <StatTile label="Rhythm" value={view.cadence} hint="Change anytime" />
          {view.savingsPerDeliveryLabel ? (
            <StatTile
              label="Subscriber savings"
              value={view.savingsPerDeliveryLabel}
              hint={
                view.savingsLifetimeLabel
                  ? `${view.savingsLifetimeLabel} saved so far`
                  : "per delivery vs one-time"
              }
            />
          ) : null}
          <StatTile
            label="Treatment"
            value={view.weekLabel ? view.weekLabel.replace(" of your treatment", "") : "Underway"}
            hint="Consistency is the secret"
          />
        </div>
      </section>

      <section className="cx-section">
        <div className="cx-card cx-card--accent">
          <div className="cx-card__header">
            <h2 className="cx-headline">Next delivery</h2>
            {!view.paymentHold && view.countdownLabel ? (
              <span className="cx-muted">{view.countdownLabel}</span>
            ) : null}
          </div>
          <p className="cx-lead">
            {view.paymentHold
              ? "On hold until your payment method is updated."
              : view.nextDeliveryLabel
                ? `Arriving around ${view.nextDeliveryLabel}`
                : "We're scheduling your next delivery."}
          </p>
          <p className="cx-muted">{view.nextContents.join(" · ")}</p>
          <hr className="cx-divider" />
          <div className="cx-actions-row">
            {view.paymentHold ? (
              <Link to="/portal/manage" className="cx-btn cx-btn--primary">
                Update my payment method
              </Link>
            ) : (
              <Link to="/portal/delivery" className="cx-btn cx-btn--secondary">
                Change my next delivery
              </Link>
            )}
          </div>
        </div>
      </section>

      <section className="cx-section">
        <span className="cx-eyebrow">Current routine</span>
        {view.commitmentLabel ? (
          <div className="cx-badges" style={{ marginBottom: 12 }}>
            <span className="cx-badge">{view.commitmentLabel}</span>
          </div>
        ) : null}
        <div className="cx-grid cx-grid--2">
          {view.lines.map((line) => (
            <ProductCard
              key={line.id}
              title={line.title}
              meta={line.meta}
              supplyLabel={line.supplyLabel}
              priceLabel={line.priceLabel}
            />
          ))}
        </div>
      </section>

      {view.milestones.length > 0 ? (
        <section className="cx-section">
          <span className="cx-eyebrow">Milestones earned</span>
          <div className="cx-badges">
            {view.milestones.map((m) => (
              <MilestoneBadge
                key={m.label}
                label={m.label}
                dateLabel={m.dateLabel}
              />
            ))}
          </div>
        </section>
      ) : null}

      {view.suggestions.length > 0 ? (
        <section className="cx-section">
          <span className="cx-eyebrow">Pairs beautifully with your routine</span>
          <p className="cx-section__intro">
            Chosen for your skin and what you already use — only if you'd like.
          </p>
          <div className="cx-grid cx-grid--3">
            {view.suggestions.map((s) => (
              <div className="cx-card" key={s.productId} style={{ marginBottom: 0 }}>
                <h3 className="cx-product-card__title">{s.title}</h3>
                <p className="cx-product-card__meta">
                  {s.reason ?? "A natural next step for your routine."}
                </p>
                <p className="cx-product-card__price">{s.priceLabel}</p>
                <div className="cx-actions-row" style={{ marginTop: 14 }}>
                  <form method="post">
                    <input type="hidden" name="intent" value="add-addon" />
                    <input type="hidden" name="contractId" value={view.contractId} />
                    <input type="hidden" name="productId" value={s.productId} />
                    <input type="hidden" name="mode" value="NEXT_ONLY" />
                    <input type="hidden" name="nonce" value={view.nonce} />
                    <button type="submit" className="cx-btn cx-btn--secondary cx-btn--small">
                      Add to next delivery
                    </button>
                  </form>
                  <form method="post">
                    <input type="hidden" name="intent" value="add-addon" />
                    <input type="hidden" name="contractId" value={view.contractId} />
                    <input type="hidden" name="productId" value={s.productId} />
                    <input type="hidden" name="mode" value="RECURRING" />
                    <input type="hidden" name="nonce" value={view.nonce} />
                    <button type="submit" className="cx-btn cx-btn--primary cx-btn--small">
                      Add to every delivery
                    </button>
                  </form>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="cx-section">
        <span className="cx-eyebrow">In your hands</span>
        <div className="cx-grid cx-grid--4">
          <ActionCard
            to="/portal/treatment?focus=add"
            title="Add a product"
            description="Grow your routine at your own pace."
          />
          <ActionCard
            to="/portal/delivery"
            title="Change my next delivery"
            description="Bring it forward, delay it, or skip one."
          />
          <ActionCard
            to="/portal/treatment"
            title="Adjust my treatment"
            description="Quantities, sizes, rhythm or a pause."
          />
          <ActionCard
            to="/portal/manage"
            title="Manage subscription"
            description="Address, payment, autopilot — and cancelling, if you ever need."
          />
        </div>
      </section>
    </div>
  );
}
