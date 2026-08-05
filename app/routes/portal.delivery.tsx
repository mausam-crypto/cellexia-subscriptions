/**
 * Change my next delivery — bring forward, delay (quick chips), pick an exact
 * date, or skip a shipment (with supply context from the depletion engine).
 * All mutations run through core contract functions with the verified
 * customer identity; core handles draft workflow, audit, events, idempotency.
 *
 * Ended (cancelled/expired) plans get a calm closed screen instead of live
 * controls, and every action re-checks status server-side so a stale tab can
 * never hit skip/set-date on a dead contract (raw 500s were the old failure).
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import { addDays, addWeeks, isoDate } from "~/lib/dates";
import { getOfflineAdmin } from "~/services/core/shopifyClient.server";
import {
  bringForward,
  delayByWeeks,
  setNextBillingDate,
  skipNextShipment,
} from "~/services/core/contracts.server";
import {
  findOwnedContract,
  findPrimaryContract,
  requirePortalCustomer,
  trackPortal,
} from "~/services/portal/auth.server";
import {
  chooseDeliveryDateAction,
  describeSupplyRemaining,
  humanDateLabel,
  humanDateUtc,
  isPaymentHoldStatus,
  isTerminalContractStatus,
  parseDateInput,
  skipSupplyNote,
} from "~/components/portal/logic";
import { ConfirmBanner } from "~/components/portal/ConfirmBanner";
import { DateChips } from "~/components/portal/DateChips";
import { GateNotice } from "~/components/portal/GateNotice";
import { getScheduleGate } from "~/services/retention/policy.server";

export { PortalErrorBoundary as ErrorBoundary } from "~/components/portal/PortalErrorBoundary";

const QUICK_DELAY_WEEKS = [1, 2, 4] as const;

export async function loader({ request }: LoaderFunctionArgs) {
  const customer = await requirePortalCustomer(request);
  const contract = await findPrimaryContract(customer);
  if (!contract) throw redirect("/portal");

  // No live delivery controls on a plan that has ended.
  if (isTerminalContractStatus(contract.status)) {
    await trackPortal(
      customer.shop,
      customer.shopifyCustomerId,
      contract.id,
      "VIEW",
      "delivery-ended",
    );
    return json({
      ended: true as const,
      endedAtLabel: humanDateLabel(contract.cancelledAt),
    });
  }

  const now = new Date();
  const nextDate = contract.nextDeliveryDate ?? contract.nextBillingDate;
  const base = nextDate ?? now;
  const url = new URL(request.url);

  // Committed plans keep their delivery schedule fixed until the commitment
  // is met — the whole page (delay / pick a date / skip) is gated.
  const scheduleGate = await getScheduleGate(customer.shop, contract.id);

  await trackPortal(
    customer.shop,
    customer.shopifyCustomerId,
    contract.id,
    "VIEW",
    "delivery",
  );

  return json({
    ended: false as const,
    paymentHold: isPaymentHoldStatus(contract.status),
    scheduleLocked: !scheduleGate.allowed,
    commitmentProgress: scheduleGate.commitment
      ? `${scheduleGate.commitment.completedDeliveries} of ${scheduleGate.commitment.minDeliveries}`
      : null,
    contractId: contract.id,
    nextDateLabel: nextDate ? humanDateLabel(nextDate) : null,
    // Tomorrow (UTC): the action rejects any date up to and including today,
    // so the picker must not offer a minimum value the server will bounce.
    minDate: isoDate(addDays(now, 1)),
    currentDateValue: nextDate ? isoDate(nextDate) : "",
    chips: QUICK_DELAY_WEEKS.map((weeks) => ({
      weeks,
      label: `+${weeks} week${weeks > 1 ? "s" : ""}`,
      // UTC-pinned so the chip's date always matches the stored calendar day.
      dateLabel: humanDateUtc(addWeeks(base, weeks)),
    })),
    supplyNote: skipSupplyNote(
      contract.lines.map((line) =>
        describeSupplyRemaining(line.depletion?.predictedRunOutAt ?? null, now),
      ),
    ),
    done: url.searchParams.get("done"),
    doneDate: url.searchParams.get("date"),
    error: url.searchParams.get("error"),
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
  // Status guard: a dead plan has no schedule to edit — direct POSTs bounce
  // to the closed screen instead of crashing in core/Shopify.
  if (isTerminalContractStatus(contract.status)) {
    return redirect("/portal/delivery");
  }

  // Every schedule intent re-checks the commitment gate server-side — the
  // gate must hold even against direct POSTs that skip the loader's UI.
  const scheduleGate = await getScheduleGate(customer.shop, contract.id);
  if (!scheduleGate.allowed) {
    return redirect("/portal/delivery");
  }

  const { graphql } = await getOfflineAdmin(customer.shop);
  const trackAction = (detail: string) =>
    trackPortal(
      customer.shop,
      customer.shopifyCustomerId,
      contract.id,
      "ACTION",
      detail,
    );

  if (intent === "delay") {
    const weeks = Number(form.get("weeks"));
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > 12) {
      throw new Response("Bad request", { status: 400 });
    }
    const updated = await delayByWeeks(graphql, customer.shop, contract.id, weeks);
    await trackAction(`delay:${weeks}w`);
    return redirect(
      `/portal/delivery?done=moved&date=${encodeURIComponent(
        humanDateLabel(updated.nextBillingDate) ?? "",
      )}`,
    );
  }

  if (intent === "set-date") {
    const target = parseDateInput(String(form.get("date") ?? ""));
    // Compare at date granularity (ISO strings sort lexicographically):
    // parseDateInput yields UTC midnight, which as an instant is always in
    // the past for "today" and would wrongly reject the picker's minimum.
    if (!target || isoDate(target) <= isoDate(new Date())) {
      return redirect("/portal/delivery?error=date");
    }
    const decision = chooseDeliveryDateAction(contract.nextBillingDate, target);
    const updated =
      decision === "BRING_FORWARD"
        ? await bringForward(graphql, customer.shop, contract.id, target)
        : await setNextBillingDate(graphql, customer.shop, contract.id, target);
    await trackAction(
      decision === "BRING_FORWARD" ? "bring-forward" : "set-date",
    );
    return redirect(
      `/portal/delivery?done=moved&date=${encodeURIComponent(
        humanDateLabel(updated.nextBillingDate) ?? humanDateUtc(target),
      )}`,
    );
  }

  if (intent === "skip") {
    const updated = await skipNextShipment(graphql, customer.shop, contract.id);
    await trackAction("skip");
    return redirect(
      `/portal/delivery?done=skipped&date=${encodeURIComponent(
        humanDateLabel(updated.nextBillingDate) ?? "",
      )}`,
    );
  }

  throw new Response("Bad request", { status: 400 });
}

export default function PortalDelivery() {
  const data = useLoaderData<typeof loader>();

  if (data.ended) {
    return (
      <div className="cx-auth-wrap">
        <div className="cx-card cx-card--accent cx-card--center">
          <span className="cx-eyebrow">Next delivery</span>
          <h1 className="cx-headline">
            {data.endedAtLabel
              ? `Your treatment ended on ${data.endedAtLabel}`
              : "Your treatment has ended"}
          </h1>
          <p className="cx-lead">
            No deliveries are scheduled and nothing will be charged. Whenever
            you'd like to restart, your routine is saved and waiting.
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

  const confirmedDate = data.doneDate;

  return (
    <div>
      {data.paymentHold ? (
        <ConfirmBanner tone="info" title="A payment needs your attention">
          Your deliveries are on hold until your payment method is updated —{" "}
          <Link to="/portal/manage" className="cx-link-quiet">
            sort it in a minute here
          </Link>
          .
        </ConfirmBanner>
      ) : null}
      {data.done === "moved" ? (
        <ConfirmBanner title="All rescheduled">
          {confirmedDate
            ? `Your next delivery now arrives around ${confirmedDate} — nothing else changes.`
            : "Your next delivery has moved — nothing else changes."}
        </ConfirmBanner>
      ) : null}
      {data.done === "skipped" ? (
        <ConfirmBanner title="Delivery skipped">
          {confirmedDate
            ? `No delivery this cycle. Your next one arrives around ${confirmedDate}.`
            : "No delivery this cycle. Your routine continues as planned after that."}
        </ConfirmBanner>
      ) : null}
      {data.error === "date" ? (
        <ConfirmBanner tone="info" title="Pick a date that's still ahead">
          Choose any future date and we'll take care of the rest.
        </ConfirmBanner>
      ) : null}

      <header className="cx-section">
        <span className="cx-eyebrow">Next delivery</span>
        <h1 className="cx-headline cx-headline--page">
          {data.nextDateLabel
            ? `Arriving around ${data.nextDateLabel}`
            : "Your next delivery"}
        </h1>
        <p className="cx-muted">
          {data.scheduleLocked
            ? "Your committed plan keeps deliveries on schedule."
            : "Life moves — your deliveries can too. No calls, no fees."}
        </p>
      </header>

      {data.scheduleLocked ? (
        <section className="cx-section">
          <GateNotice
            eyebrow="Your committed plan"
            title="Your delivery schedule is set"
            lines={[
              data.commitmentProgress
                ? `You're ${data.commitmentProgress} deliveries into your committed plan — delaying, skipping and date changes unlock after your final committed delivery. Your price stays our best throughout.`
                : "Delaying, skipping and date changes unlock after your final committed delivery. Your price stays our best throughout.",
            ]}
            actions={[
              { to: "/portal", label: "Back to my treatment" },
              { to: "/portal/treatment", label: "Adjust products" },
            ]}
            supportEmail={null}
          />
        </section>
      ) : (
      <section className="cx-section">
        <div className="cx-card">
          <h2 className="cx-headline">Delay a little</h2>
          <p className="cx-section__intro">
            One tap and your whole schedule shifts with it.
          </p>
          <DateChips contractId={data.contractId} options={data.chips} />
        </div>

        <div className="cx-card">
          <h2 className="cx-headline">Pick an exact date</h2>
          <p className="cx-section__intro">
            Earlier or later — whichever suits. Earlier dates bring your
            delivery forward.
          </p>
          <form method="post" className="cx-inline-form">
            <input type="hidden" name="intent" value="set-date" />
            <input type="hidden" name="contractId" value={data.contractId} />
            <input
              type="date"
              className="cx-input"
              style={{ maxWidth: 220 }}
              name="date"
              min={data.minDate}
              defaultValue={data.currentDateValue}
              aria-label="Next delivery date"
              required
            />
            <button type="submit" className="cx-btn cx-btn--primary">
              Move my delivery
            </button>
          </form>
        </div>

        <div className="cx-card">
          <h2 className="cx-headline">Skip this delivery</h2>
          {data.supplyNote ? (
            <p className="cx-section__intro">{data.supplyNote}</p>
          ) : (
            <p className="cx-section__intro">
              Skip one delivery — your routine picks right back up after.
            </p>
          )}
          <form method="post">
            <input type="hidden" name="intent" value="skip" />
            <input type="hidden" name="contractId" value={data.contractId} />
            <button type="submit" className="cx-btn cx-btn--secondary">
              Skip this delivery
            </button>
          </form>
        </div>
      </section>
      )}

      <p className="cx-center cx-muted">
        Prefer to change the ongoing rhythm?{" "}
        <Link to="/portal/treatment" className="cx-link-quiet">
          Adjust my treatment
        </Link>
      </p>
    </div>
  );
}
