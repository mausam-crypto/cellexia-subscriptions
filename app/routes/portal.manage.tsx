/**
 * Manage subscription — delivery address (incl. the company/building line),
 * payment method (secure update link by email; card details never touch the
 * portal), autopilot guardrails, a merge-shipments suggestion when
 * consolidationPlan proposes one, and the cancel link: visible, calm, never
 * buried.
 *
 * Address saves surface Shopify validation problems as a friendly banner with
 * the typed values preserved — never a raw error screen. Confirmations are
 * truthful: "Shipments combined" only renders when a merge actually ran.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Link, useActionData, useLoaderData } from "@remix-run/react";
import prisma from "~/db.server";
import { logger } from "~/lib/logger.server";
import { appendAudit } from "~/services/audit.server";
import {
  getOfflineAdmin,
  ShopifyGraphqlError,
} from "~/services/core/shopifyClient.server";
import {
  mergeContracts,
  sendPaymentUpdateEmail,
  updateDeliveryAddress,
} from "~/services/core/contracts.server";
import { consolidationPlan } from "~/services/treatment/routines.server";
import {
  findOwnedContract,
  findPrimaryContract,
  requirePortalCustomer,
  trackPortal,
} from "~/services/portal/auth.server";
import {
  humanDateLabel,
  isTerminalContractStatus,
  parseGuardrailsForm,
} from "~/components/portal/logic";
import { parseJson, type AutopilotGuardrails } from "~/types/domain";
import { ConfirmBanner } from "~/components/portal/ConfirmBanner";

export { PortalErrorBoundary as ErrorBoundary } from "~/components/portal/PortalErrorBoundary";

interface DeliveryAddress {
  address1?: string;
  address2?: string;
  company?: string;
  city?: string;
  provinceCode?: string;
  zip?: string;
  countryCode?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
}

const DEFAULT_GUARDRAILS: AutopilotGuardrails = {
  maxChargeCents: null,
  askBeforeAdding: true,
  minIntervalWeeks: null,
  notifyDaysBefore: 3,
};

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

/** Customer-safe sentence out of a Shopify address validation failure. */
function friendlyAddressError(error: ShopifyGraphqlError): string {
  const details = (error.userErrors ?? [])
    .map((e) => e.message)
    .filter(Boolean)
    .join(" · ");
  return details
    ? `We couldn't save that address: ${details}. Have a look and try again — nothing has been changed yet.`
    : "We couldn't save that address — please double-check the details and try again. Nothing has been changed yet.";
}

export async function loader({ request }: LoaderFunctionArgs) {
  const customer = await requirePortalCustomer(request);
  const contract = await findPrimaryContract(customer);
  if (!contract) throw redirect("/portal");
  const url = new URL(request.url);

  if (isTerminalContractStatus(contract.status)) {
    await trackPortal(
      customer.shop,
      customer.shopifyCustomerId,
      contract.id,
      "VIEW",
      "manage-ended",
    );
    return json({
      ended: true as const,
      endedAtLabel: humanDateLabel(contract.cancelledAt),
    });
  }

  const address = parseJson<DeliveryAddress>(contract.deliveryAddressJson, {});
  const guardrails = {
    ...DEFAULT_GUARDRAILS,
    ...parseJson<Partial<AutopilotGuardrails>>(contract.guardrailsJson, {}),
  };

  const plan = await safeConsolidationPlan(
    customer.shop,
    customer.shopifyCustomerId,
  );
  const mergeSuggested = Boolean(
    plan?.merge && plan.targetContractId && plan.sourceContractIds.length > 0,
  );

  await trackPortal(
    customer.shop,
    customer.shopifyCustomerId,
    contract.id,
    "VIEW",
    "manage",
  );

  return json({
    ended: false as const,
    contractId: contract.id,
    email: customer.email,
    address,
    card:
      contract.cardBrand && contract.cardLastDigits
        ? {
            brand: contract.cardBrand,
            lastDigits: contract.cardLastDigits,
            expiry:
              contract.cardExpiryMonth && contract.cardExpiryYear
                ? `${String(contract.cardExpiryMonth).padStart(2, "0")}/${String(contract.cardExpiryYear).slice(-2)}`
                : null,
          }
        : null,
    autopilotEnabled: contract.autopilotEnabled,
    guardrails,
    maxChargeValue:
      guardrails.maxChargeCents !== null
        ? (guardrails.maxChargeCents / 100).toFixed(2)
        : "",
    mergeSuggested,
    done: url.searchParams.get("done"),
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const customer = await requirePortalCustomer(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  // Ownership check before any mutation.
  const contract = await findOwnedContract(
    customer,
    String(form.get("contractId") ?? ""),
  );
  // Status guard: nothing to manage on a plan that has ended.
  if (isTerminalContractStatus(contract.status)) {
    return redirect("/portal/manage");
  }

  const trackAction = (detail: string) =>
    trackPortal(
      customer.shop,
      customer.shopifyCustomerId,
      contract.id,
      "ACTION",
      detail,
    );

  if (intent === "address") {
    const address: DeliveryAddress = {
      firstName: String(form.get("firstName") ?? "").trim() || undefined,
      lastName: String(form.get("lastName") ?? "").trim() || undefined,
      address1: String(form.get("address1") ?? "").trim(),
      address2: String(form.get("address2") ?? "").trim() || undefined,
      // The company/building line ships on every label — dropping it strands
      // parcels at offices and apartment complexes, so it round-trips here.
      company: String(form.get("company") ?? "").trim() || undefined,
      city: String(form.get("city") ?? "").trim(),
      provinceCode: String(form.get("provinceCode") ?? "").trim() || undefined,
      zip: String(form.get("zip") ?? "").trim(),
      countryCode: String(form.get("countryCode") ?? "").trim(),
      phone: String(form.get("phone") ?? "").trim() || undefined,
    };
    if (!address.address1 || !address.city || !address.zip || !address.countryCode) {
      return json(
        {
          error:
            "Address, city, postcode and country are needed so deliveries find you.",
          values: address,
        },
        { status: 400 },
      );
    }
    const { graphql } = await getOfflineAdmin(customer.shop);
    try {
      await updateDeliveryAddress(graphql, customer.shop, contract.id, address);
    } catch (error) {
      // Shopify validation problems (missing region for US, bad country
      // code…) come back as a calm banner with the typed values preserved.
      if (error instanceof ShopifyGraphqlError) {
        return json(
          { error: friendlyAddressError(error), values: address },
          { status: 400 },
        );
      }
      throw error;
    }
    await trackAction("address");
    return redirect("/portal/manage?done=address");
  }

  if (intent === "payment-link") {
    const { graphql } = await getOfflineAdmin(customer.shop);
    await sendPaymentUpdateEmail(graphql, customer.shop, contract.id);
    await trackAction("payment-link");
    return redirect("/portal/manage?done=payment");
  }

  if (intent === "autopilot") {
    // Deviation note: no autopilot contract is published in ARCHITECTURE.md,
    // so the portal writes the two contract columns directly (with audit).
    // Swap for the treatment module's setter at integration if one exists.
    const enabled = form.get("enabled") === "on";
    const guardrails = parseGuardrailsForm({
      maxCharge: String(form.get("maxCharge") ?? ""),
      askBeforeAdding: String(form.get("askBeforeAdding") ?? ""),
      minIntervalWeeks: String(form.get("minIntervalWeeks") ?? ""),
      notifyDaysBefore: String(form.get("notifyDaysBefore") ?? ""),
    });
    await prisma.subscriptionContract.update({
      where: { id: contract.id },
      data: {
        autopilotEnabled: enabled,
        guardrailsJson: JSON.stringify(guardrails),
      },
    });
    await appendAudit({
      shop: customer.shop,
      actorType: "CUSTOMER",
      actorId: customer.shopifyCustomerId,
      action: "PORTAL_AUTOPILOT_UPDATED",
      subjectType: "SubscriptionContract",
      subjectId: contract.id,
      payload: { enabled, guardrails: { ...guardrails } },
    });
    await trackAction("autopilot");
    return redirect("/portal/manage?done=autopilot");
  }

  if (intent === "merge") {
    // Never trust form data for merge targets: recompute server-side.
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
      const { graphql } = await getOfflineAdmin(customer.shop);
      await mergeContracts(
        graphql,
        customer.shop,
        target.id,
        plan.sourceContractIds,
      );
      await trackAction("merge");
      // "Shipments combined" only after a merge genuinely ran.
      return redirect("/portal/manage?done=merged");
    }
    // Honest no-op: the plan no longer proposes a merge (the other contract
    // may have ended in the meantime, or this is a double submit).
    return redirect("/portal/manage?done=merge-noop");
  }

  throw new Response("Bad request", { status: 400 });
}

const DONE_COPY: Record<string, { title: string; body: string }> = {
  address: {
    title: "Address updated",
    body: "Future deliveries head to your new address — starting with the next one.",
  },
  payment: {
    title: "Secure link sent",
    body: "Check your inbox — Shopify's secure page lets you update your card. We never see the details.",
  },
  autopilot: {
    title: "Autopilot updated",
    body: "Your preferences are saved. We'll always stay inside your guardrails.",
  },
  merged: {
    title: "Shipments combined",
    body: "Everything now arrives together — fewer boxes, one rhythm.",
  },
  "merge-noop": {
    title: "Nothing to combine",
    body: "Your deliveries are already arriving on a single schedule.",
  },
};

export default function PortalManage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<{
    error?: string;
    values?: DeliveryAddress;
  }>();

  if (data.ended) {
    return (
      <div className="cx-auth-wrap">
        <div className="cx-card cx-card--accent cx-card--center">
          <span className="cx-eyebrow">Settings</span>
          <h1 className="cx-headline">
            {data.endedAtLabel
              ? `Your treatment ended on ${data.endedAtLabel}`
              : "Your treatment has ended"}
          </h1>
          <p className="cx-lead">
            There's nothing to manage right now — no deliveries, no charges.
            Your routine and history stay saved should you ever return.
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

  const done = data.done ? DONE_COPY[data.done] : undefined;
  // A failed save re-populates the form from what was typed, never loses it.
  const address = actionData?.values ?? data.address;

  return (
    <div>
      {done ? <ConfirmBanner title={done.title}>{done.body}</ConfirmBanner> : null}
      {actionData?.error ? (
        <ConfirmBanner tone="info" title="One small thing with the address">
          {actionData.error}
        </ConfirmBanner>
      ) : null}

      <header className="cx-section">
        <span className="cx-eyebrow">Settings</span>
        <h1 className="cx-headline cx-headline--page">Manage subscription</h1>
        <p className="cx-muted">
          Address, payment, autopilot — and cancelling, if you ever need it.
        </p>
      </header>

      {data.mergeSuggested ? (
        <div className="cx-card cx-card--accent">
          <h2 className="cx-headline">One delivery instead of several</h2>
          <p className="cx-section__intro">
            You have more than one delivery schedule. We can combine them so
            everything arrives together — fewer boxes, nothing lost.
          </p>
          <form method="post">
            <input type="hidden" name="intent" value="merge" />
            <input type="hidden" name="contractId" value={data.contractId} />
            <button type="submit" className="cx-btn cx-btn--primary">
              Combine my shipments
            </button>
          </form>
        </div>
      ) : null}

      <section className="cx-section">
        <div className="cx-card">
          <h2 className="cx-headline">Delivery address</h2>
          <form method="post">
            <input type="hidden" name="intent" value="address" />
            <input type="hidden" name="contractId" value={data.contractId} />
            <div className="cx-grid cx-grid--2">
              <div className="cx-field">
                <label className="cx-field__label" htmlFor="firstName">First name</label>
                <input className="cx-input" id="firstName" name="firstName" defaultValue={address.firstName ?? ""} autoComplete="given-name" />
              </div>
              <div className="cx-field">
                <label className="cx-field__label" htmlFor="lastName">Last name</label>
                <input className="cx-input" id="lastName" name="lastName" defaultValue={address.lastName ?? ""} autoComplete="family-name" />
              </div>
            </div>
            <div className="cx-field">
              <label className="cx-field__label" htmlFor="address1">Address</label>
              <input className="cx-input" id="address1" name="address1" defaultValue={address.address1 ?? ""} autoComplete="address-line1" required />
            </div>
            <div className="cx-grid cx-grid--2">
              <div className="cx-field">
                <label className="cx-field__label" htmlFor="address2">Apartment, suite (optional)</label>
                <input className="cx-input" id="address2" name="address2" defaultValue={address.address2 ?? ""} autoComplete="address-line2" />
              </div>
              <div className="cx-field">
                <label className="cx-field__label" htmlFor="company">Company or building (optional)</label>
                <input className="cx-input" id="company" name="company" defaultValue={address.company ?? ""} autoComplete="organization" />
              </div>
            </div>
            <div className="cx-grid cx-grid--3">
              <div className="cx-field">
                <label className="cx-field__label" htmlFor="city">City</label>
                <input className="cx-input" id="city" name="city" defaultValue={address.city ?? ""} autoComplete="address-level2" required />
              </div>
              <div className="cx-field">
                <label className="cx-field__label" htmlFor="zip">Postcode</label>
                <input className="cx-input" id="zip" name="zip" defaultValue={address.zip ?? ""} autoComplete="postal-code" required />
              </div>
              <div className="cx-field">
                <label className="cx-field__label" htmlFor="countryCode">Country code</label>
                <input className="cx-input" id="countryCode" name="countryCode" defaultValue={address.countryCode ?? ""} placeholder="FR" maxLength={2} required />
              </div>
            </div>
            <div className="cx-grid cx-grid--2">
              <div className="cx-field">
                <label className="cx-field__label" htmlFor="provinceCode">Region (optional)</label>
                <input className="cx-input" id="provinceCode" name="provinceCode" defaultValue={address.provinceCode ?? ""} />
              </div>
              <div className="cx-field">
                <label className="cx-field__label" htmlFor="phone">Phone (optional)</label>
                <input className="cx-input" id="phone" name="phone" type="tel" defaultValue={address.phone ?? ""} autoComplete="tel" />
              </div>
            </div>
            <button type="submit" className="cx-btn cx-btn--primary">
              Save address
            </button>
          </form>
        </div>

        <div className="cx-card">
          <h2 className="cx-headline">Payment method</h2>
          {data.card ? (
            <p className="cx-lead">
              {data.card.brand.toUpperCase()} •••• {data.card.lastDigits}
              {data.card.expiry ? (
                <span className="cx-muted"> · expires {data.card.expiry}</span>
              ) : null}
            </p>
          ) : (
            <p className="cx-muted">Your payment method is held securely by Shopify.</p>
          )}
          <p className="cx-section__intro">
            Card details never pass through this portal. We'll email you a
            secure Shopify link to make any change.
          </p>
          <form method="post">
            <input type="hidden" name="intent" value="payment-link" />
            <input type="hidden" name="contractId" value={data.contractId} />
            <button type="submit" className="cx-btn cx-btn--secondary">
              Email me a secure update link
            </button>
          </form>
        </div>

        <div className="cx-card">
          <h2 className="cx-headline">Autopilot</h2>
          <p className="cx-section__intro">
            Let us quietly fine-tune your deliveries to how you actually use
            your products — always inside your guardrails, never beyond them.
          </p>
          <form method="post">
            <input type="hidden" name="intent" value="autopilot" />
            <input type="hidden" name="contractId" value={data.contractId} />
            <label className="cx-choice">
              <input type="checkbox" name="enabled" defaultChecked={data.autopilotEnabled} />
              <span className="cx-choice__label">
                Enable autopilot
                <span className="cx-choice__hint">
                  We adjust timing and quantities gently, based on your supply.
                </span>
              </span>
            </label>
            <div className="cx-grid cx-grid--2">
              <div className="cx-field">
                <label className="cx-field__label" htmlFor="maxCharge">
                  Never charge more than (per delivery)
                </label>
                <input
                  className="cx-input"
                  id="maxCharge"
                  name="maxCharge"
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="No limit"
                  defaultValue={data.maxChargeValue}
                />
              </div>
              <div className="cx-field">
                <label className="cx-field__label" htmlFor="minIntervalWeeks">
                  Never deliver more often than every (weeks)
                </label>
                <input
                  className="cx-input"
                  id="minIntervalWeeks"
                  name="minIntervalWeeks"
                  type="number"
                  min="1"
                  max="52"
                  placeholder="No limit"
                  defaultValue={data.guardrails.minIntervalWeeks ?? ""}
                />
              </div>
            </div>
            <label className="cx-choice">
              <input
                type="checkbox"
                name="askBeforeAdding"
                defaultChecked={data.guardrails.askBeforeAdding}
              />
              <span className="cx-choice__label">
                Always ask before adding a product
                <span className="cx-choice__hint">
                  Nothing new joins your plan without your yes.
                </span>
              </span>
            </label>
            <div className="cx-field">
              <label className="cx-field__label" htmlFor="notifyDaysBefore">
                Tell me about changes (days before a delivery)
              </label>
              <input
                className="cx-input"
                id="notifyDaysBefore"
                name="notifyDaysBefore"
                type="number"
                min="0"
                max="30"
                defaultValue={data.guardrails.notifyDaysBefore}
                style={{ maxWidth: 140 }}
              />
            </div>
            <button type="submit" className="cx-btn cx-btn--primary">
              Save autopilot settings
            </button>
          </form>
        </div>

        <div className="cx-card">
          <h2 className="cx-headline">Thinking of stopping?</h2>
          <p className="cx-section__intro">
            You're always in control — pause, slow down, or cancel your
            treatment online. No calls, no hoops.
          </p>
          <Link to="/portal/cancel" className="cx-btn cx-btn--secondary">
            Cancel my treatment
          </Link>
        </div>
      </section>
    </div>
  );
}
