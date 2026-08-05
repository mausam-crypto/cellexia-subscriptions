/**
 * ROUTINE BUILDER (widget D, portal edition) — an elegant four-step flow:
 *   1. choose your primary concern (from RoutineTemplate concerns)
 *   2. tick what you currently use
 *   3. see your recommended routine with coherence notes (AM/PM, staggering)
 *      — including the per-delivery subscriber price of each addition and
 *      the total, so subscribing is never a blind commitment
 *   4. subscribe to the full routine — always into the fewest shipments
 *      (consolidationPlan decides; merge happens before lines are added).
 *
 * Steps 1–3 are GET-driven (shareable, no JS needed); subscribing is a POST.
 * Variant lookups are availability-aware: a sold-out product is shown as
 * unavailable and is never subscribed to (no seeded billing failures).
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import prisma from "~/db.server";
import { logger } from "~/lib/logger.server";
import { appendAudit } from "~/services/audit.server";
import { getOfflineAdmin, toGid } from "~/services/core/shopifyClient.server";
import {
  addLineToContract,
  mergeContracts,
} from "~/services/core/contracts.server";
import { planAdjustedPriceCents } from "~/services/core/pure";
import {
  consolidationPlan,
  recommendRoutine,
} from "~/services/treatment/routines.server";
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
  coherenceNotes,
  contractPercentOff,
  formatCents,
  groupByTimeOfDay,
  isTerminalContractStatus,
  normalizeRoutineRecommendation,
} from "~/components/portal/logic";
import { WizardSteps } from "~/components/portal/WizardSteps";

export { PortalErrorBoundary as ErrorBoundary } from "~/components/portal/PortalErrorBoundary";

const WIZARD_LABELS = ["Your focus", "What you use", "Your routine", "Subscribe"];

async function safeConsolidationPlan(shop: string, shopifyCustomerId: string) {
  try {
    return await consolidationPlan(shop, shopifyCustomerId);
  } catch (error) {
    logger.warn("portal consolidation plan unavailable", {
      shop,
      error: String(error),
    });
    return null;
  }
}

// ─────────────────────────────── Loader ───────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  const customer = await requirePortalCustomer(request);
  const contract = await findPrimaryContract(customer);
  const url = new URL(request.url);
  const done = url.searchParams.get("done") === "1";
  const concern = url.searchParams.get("concern");
  const review = url.searchParams.get("review") === "1";
  const current = url.searchParams.getAll("current");

  const [templates, catalog] = await Promise.all([
    prisma.routineTemplate.findMany({
      where: { shop: customer.shop, active: true },
      orderBy: { name: "asc" },
    }),
    prisma.productMeta.findMany({
      where: { shop: customer.shop, subscribable: true, active: true },
      orderBy: { title: "asc" },
    }),
  ]);

  const concernsSeen = new Set<string>();
  const concerns = templates
    .filter((t) => {
      if (concernsSeen.has(t.concern)) return false;
      concernsSeen.add(t.concern);
      return true;
    })
    .map((t) => ({
      concern: t.concern,
      name: t.name,
      description: t.description,
    }));

  const titleMap: Record<string, string> = {};
  const timeMap: Record<string, string> = {};
  for (const product of catalog) {
    const gid = toGid("Product", product.shopifyProductId);
    titleMap[product.shopifyProductId] = product.title;
    titleMap[gid] = product.title;
    timeMap[product.shopifyProductId] = product.timeOfDay;
    timeMap[gid] = product.timeOfDay;
  }

  // A live plan can absorb new products; an ended one cannot — the subscribe
  // CTA renders only for live plans (the action re-checks server-side).
  const liveContract =
    contract && !isTerminalContractStatus(contract.status) ? contract : null;

  const ownedIds = new Set(
    (liveContract?.lines ?? []).map((line) =>
      toGid("Product", line.shopifyProductId),
    ),
  );

  const step = done ? 4 : !concern ? 1 : !review ? 2 : 3;

  let routineSteps: Array<{
    productId: string;
    title: string;
    role: string | null;
    timeOfDay: string | null;
    optional: boolean;
    owned: boolean;
    priceLabel: string | null;
    unavailable: boolean;
  }> = [];
  let notes: string[] = [];
  let totalPerDeliveryLabel: string | null = null;

  if (step === 3 && concern) {
    try {
      const recommendation = normalizeRoutineRecommendation(
        await recommendRoutine(customer.shop, {
          concern,
          currentProductIds: current,
        }),
      );
      routineSteps = recommendation.steps.map((s) => {
        const gid = toGid("Product", s.productId);
        return {
          productId: s.productId,
          title: s.title ?? titleMap[s.productId] ?? titleMap[gid] ?? "Cellexia product",
          role: s.role,
          timeOfDay: s.timeOfDay ?? timeMap[s.productId] ?? timeMap[gid] ?? null,
          optional: s.optional,
          owned:
            ownedIds.has(gid) ||
            current.includes(s.productId) ||
            current.includes(gid),
          priceLabel: null,
          unavailable: false,
        };
      });
      const edges = await prisma.compatibilityEdge.findMany({
        where: { shop: customer.shop },
      });
      const stepIds = routineSteps.flatMap((s) => [
        s.productId,
        toGid("Product", s.productId),
      ]);
      notes = [
        ...recommendation.notes,
        ...coherenceNotes(stepIds, titleMap, edges),
      ];

      // Price disclosure — per-delivery subscriber price for every product
      // that would be added, plus the total. Fail-soft: a Shopify hiccup or
      // demo mode hides prices, never fabricates them.
      if (liveContract) {
        try {
          const currency = liveContract.currencyCode;
          const { graphql } = await getOfflineAdmin(customer.shop);
          const discounts = await getPlanDiscounts(customer.shop);
          const percent = contractPercentOff(liveContract.lines, discounts, {
            initialDiscountPercent: liveContract.initialDiscountPercent,
          });
          const addGids = routineSteps
            .filter((s) => !s.owned)
            .map((s) => toGid("Product", s.productId));
          const variantsByProduct = await fetchVariantsByProduct(
            graphql,
            addGids,
          );
          let totalCents = 0;
          let totalKnown = routineSteps.some((s) => !s.owned);
          for (const stepRow of routineSteps) {
            if (stepRow.owned) continue;
            const gid = toGid("Product", stepRow.productId);
            const variants = variantsByProduct[gid];
            const variant = variants?.[0] ?? null;
            if (variants && variants.length === 0) {
              // Sold out: shown, marked, never subscribed to.
              stepRow.unavailable = true;
              continue;
            }
            if (!variant) {
              totalKnown = false;
              continue;
            }
            const cents = planAdjustedPriceCents(percent, variant.priceCents);
            stepRow.priceLabel = `${formatCents(cents, currency)} per delivery`;
            totalCents += cents;
          }
          if (totalKnown && totalCents > 0) {
            totalPerDeliveryLabel = formatCents(totalCents, currency);
          }
        } catch (error) {
          logger.warn("portal routine pricing unavailable", {
            shop: customer.shop,
            error: String(error),
          });
        }
      }
    } catch (error) {
      logger.warn("portal routine recommendation unavailable", {
        shop: customer.shop,
        error: String(error),
      });
    }
  }

  const grouped = groupByTimeOfDay(routineSteps);

  await trackPortal(
    customer.shop,
    customer.shopifyCustomerId,
    contract?.id ?? null,
    "VIEW",
    `routine:step-${step}`,
  );

  return json({
    step,
    concern,
    concerns,
    current,
    catalog: catalog.map((p) => ({
      productId: p.shopifyProductId,
      title: p.title,
      owned: ownedIds.has(toGid("Product", p.shopifyProductId)),
    })),
    routineSteps,
    am: grouped.am,
    pm: grouped.pm,
    anytime: grouped.anytime,
    notes,
    totalPerDeliveryLabel,
    hasContract: Boolean(liveContract),
    contractId: liveContract?.id ?? null,
  });
}

// ─────────────────────────────── Action ───────────────────────────────────

export async function action({ request }: ActionFunctionArgs) {
  const customer = await requirePortalCustomer(request);
  const form = await request.formData();
  if (String(form.get("intent")) !== "subscribe") {
    throw new Response("Bad request", { status: 400 });
  }
  // Ownership check before any mutation.
  let contract = await findOwnedContract(
    customer,
    String(form.get("contractId") ?? ""),
  );
  // Status guard: never add recurring lines to a plan that has ended.
  if (isTerminalContractStatus(contract.status)) {
    return redirect("/portal");
  }
  const requested = form
    .getAll("products")
    .map(String)
    .filter(Boolean)
    .slice(0, 8);

  // Only shop-approved, subscribable products can join a plan.
  const gids = requested.map((id) => toGid("Product", id));
  const valid = await prisma.productMeta.findMany({
    where: {
      shop: customer.shop,
      subscribable: true,
      active: true,
      OR: [
        { shopifyProductId: { in: requested } },
        { shopifyProductId: { in: gids } },
      ],
    },
  });
  if (valid.length === 0) {
    return redirect("/portal/routine?done=1");
  }

  const { graphql } = await getOfflineAdmin(customer.shop);

  // Fewest shipments, always: merge first when the plan suggests it.
  const plan = await safeConsolidationPlan(
    customer.shop,
    customer.shopifyCustomerId,
  );
  if (
    plan?.merge &&
    plan.targetContractId &&
    plan.sourceContractIds.length > 0
  ) {
    const target = await findOwnedContract(customer, plan.targetContractId);
    await mergeContracts(
      graphql,
      customer.shop,
      target.id,
      plan.sourceContractIds,
    );
    contract = await findOwnedContract(customer, target.id);
  }

  const ownedIds = new Set(
    contract.lines.map((line) => toGid("Product", line.shopifyProductId)),
  );
  let added = 0;
  for (const product of valid) {
    const gid = toGid("Product", product.shopifyProductId);
    if (ownedIds.has(gid)) continue;
    // Availability-aware: sold-out products are skipped, never subscribed to.
    const variant = await fetchDefaultVariant(graphql, gid);
    if (!variant) continue;
    // No explicit priceCents: core prices the line at the SUBSCRIBER price
    // (plan discount applied) — matching the loader's disclosed prices.
    await addLineToContract(graphql, customer.shop, contract.id, {
      variantGid: variant.id,
      quantity: 1,
    });
    added += 1;
  }

  await appendAudit({
    shop: customer.shop,
    actorType: "CUSTOMER",
    actorId: customer.shopifyCustomerId,
    action: "PORTAL_ROUTINE_SUBSCRIBED",
    subjectType: "SubscriptionContract",
    subjectId: contract.id,
    payload: { productsAdded: added, merged: Boolean(plan?.merge) },
  });

  await trackPortal(
    customer.shop,
    customer.shopifyCustomerId,
    contract.id,
    "ACTION",
    `routine-subscribe:${added}`,
  );

  return redirect("/portal/routine?done=1");
}

// ─────────────────────────────── View ─────────────────────────────────────

function RoutineStepRow({
  step,
  order,
}: {
  step: {
    title: string;
    role: string | null;
    optional: boolean;
    owned: boolean;
    priceLabel: string | null;
    unavailable: boolean;
  };
  order: number;
}) {
  return (
    <div className="cx-routine-step">
      <span className="cx-routine-step__order">{order}</span>
      <div>
        <p className="cx-product-card__title" style={{ marginBottom: 2 }}>
          {step.title}
          {step.owned ? <span className="cx-badge__date"> · already yours</span> : null}
          {step.optional ? <span className="cx-badge__date"> · optional</span> : null}
          {step.unavailable ? (
            <span className="cx-badge__date"> · temporarily unavailable</span>
          ) : null}
        </p>
        {step.role ? <p className="cx-product-card__meta">{step.role}</p> : null}
        {step.priceLabel && !step.owned && !step.unavailable ? (
          <p className="cx-product-card__meta">{step.priceLabel}</p>
        ) : null}
      </div>
    </div>
  );
}

export default function PortalRoutine() {
  const data = useLoaderData<typeof loader>();

  if (data.step === 4) {
    return (
      <div className="cx-auth-wrap">
        <WizardSteps labels={WIZARD_LABELS} current={4} />
        <div className="cx-card cx-card--accent cx-card--center">
          <span className="cx-eyebrow">Routine complete</span>
          <h1 className="cx-headline">Beautifully consistent</h1>
          <p className="cx-lead">
            Your routine now arrives together, in the fewest shipments
            possible. Changes apply from your next delivery.
          </p>
          <Link to="/portal" className="cx-btn cx-btn--primary">
            Back to my treatment
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div>
      <header className="cx-section">
        <span className="cx-eyebrow">My routine</span>
        <h1 className="cx-headline cx-headline--page">Build your routine</h1>
        <p className="cx-muted">
          A few quiet questions, then a routine that fits — AM to PM, in the
          right order.
        </p>
      </header>

      <WizardSteps labels={WIZARD_LABELS} current={data.step} />

      {data.step === 1 ? (
        <div className="cx-card">
          <h2 className="cx-headline">What's your main focus?</h2>
          {data.concerns.length === 0 ? (
            <p className="cx-muted">
              Routines are being curated — check back soon.
            </p>
          ) : (
            <form method="get">
              {data.concerns.map((c, index) => (
                <label className="cx-choice" key={c.concern}>
                  <input
                    type="radio"
                    name="concern"
                    value={c.concern}
                    defaultChecked={index === 0}
                    required
                  />
                  <span className="cx-choice__label">
                    {c.name}
                    {c.description ? (
                      <span className="cx-choice__hint">{c.description}</span>
                    ) : null}
                  </span>
                </label>
              ))}
              <button type="submit" className="cx-btn cx-btn--primary">
                Continue
              </button>
            </form>
          )}
        </div>
      ) : null}

      {data.step === 2 && data.concern ? (
        <div className="cx-card">
          <h2 className="cx-headline">What do you use today?</h2>
          <p className="cx-section__intro">
            Tick anything already in your routine — we'll build around it, not
            duplicate it.
          </p>
          <form method="get">
            <input type="hidden" name="concern" value={data.concern} />
            <input type="hidden" name="review" value="1" />
            {data.catalog.map((product) => (
              <label className="cx-choice" key={product.productId}>
                <input
                  type="checkbox"
                  name="current"
                  value={product.productId}
                  defaultChecked={product.owned}
                />
                <span className="cx-choice__label">
                  {product.title}
                  {product.owned ? (
                    <span className="cx-choice__hint">In your plan already</span>
                  ) : null}
                </span>
              </label>
            ))}
            <button type="submit" className="cx-btn cx-btn--primary">
              See my routine
            </button>
          </form>
        </div>
      ) : null}

      {data.step === 3 ? (
        <div>
          {data.routineSteps.length === 0 ? (
            <div className="cx-card cx-card--center">
              <p className="cx-lead">
                We're preparing your recommendation — please try again in a
                moment.
              </p>
              <Link to="/portal/routine" className="cx-btn cx-btn--secondary">
                Start over
              </Link>
            </div>
          ) : (
            <>
              <div className="cx-grid cx-grid--2">
                {data.am.length > 0 || data.pm.length > 0 ? (
                  <>
                    <div className="cx-card" style={{ marginBottom: 0 }}>
                      <span className="cx-eyebrow">Morning</span>
                      {data.am.length === 0 ? (
                        <p className="cx-muted">Keep mornings simple.</p>
                      ) : (
                        data.am.map((s, i) => (
                          <RoutineStepRow key={s.productId} step={s} order={i + 1} />
                        ))
                      )}
                    </div>
                    <div className="cx-card" style={{ marginBottom: 0 }}>
                      <span className="cx-eyebrow">Evening</span>
                      {data.pm.length === 0 ? (
                        <p className="cx-muted">Evenings stay easy.</p>
                      ) : (
                        data.pm.map((s, i) => (
                          <RoutineStepRow key={s.productId} step={s} order={i + 1} />
                        ))
                      )}
                    </div>
                  </>
                ) : null}
              </div>

              {data.anytime.length > 0 ? (
                <div className="cx-card" style={{ marginTop: 16 }}>
                  <span className="cx-eyebrow">Any time</span>
                  {data.anytime.map((s, i) => (
                    <RoutineStepRow key={s.productId} step={s} order={i + 1} />
                  ))}
                </div>
              ) : null}

              {data.notes.length > 0 ? (
                <div className="cx-banner cx-banner--info" style={{ marginTop: 16 }}>
                  <p className="cx-banner__title">A note on coherence</p>
                  {data.notes.map((note) => (
                    <p key={note}>{note}</p>
                  ))}
                </div>
              ) : null}

              <div className="cx-card cx-card--accent" style={{ marginTop: 16 }}>
                <h2 className="cx-headline">Make it continuous</h2>
                {data.hasContract && data.contractId ? (
                  <>
                    <p className="cx-section__intro">
                      New products join your existing plan — one delivery, one
                      rhythm, the fewest shipments possible.
                    </p>
                    {data.totalPerDeliveryLabel ? (
                      <p className="cx-lead">
                        {data.totalPerDeliveryLabel} per delivery for the new
                        additions, at your subscriber price — shown per product
                        above.
                      </p>
                    ) : null}
                    <form method="post">
                      <input type="hidden" name="intent" value="subscribe" />
                      <input type="hidden" name="contractId" value={data.contractId} />
                      {data.routineSteps
                        .filter((s) => !s.owned && !s.unavailable)
                        .map((s) => (
                          <input
                            key={s.productId}
                            type="hidden"
                            name="products"
                            value={s.productId}
                          />
                        ))}
                      <button type="submit" className="cx-btn cx-btn--primary">
                        Subscribe to my full routine
                      </button>
                    </form>
                  </>
                ) : (
                  <p className="cx-section__intro">
                    Your routine is ready. Start your Continuous Treatment plan
                    from any product page and it will appear here — or write to
                    us and we'll set it up for you.
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
