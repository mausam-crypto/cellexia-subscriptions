/**
 * Shared survey UI + client logic for both render targets (v1.21.1).
 *
 * MIGRATED OFF REACT (v1.21.1): checkout UI extensions dropped their React
 * bindings after API 2025-07 — `@shopify/ui-extensions-react` has no
 * 2025-10+ release, so a React extension cannot target any API version
 * Shopify still accepts. This is now a Preact extension on the current
 * component model: `s-*` custom elements in JSX, the injected `shopify`
 * global (Preact signals — reading `.value` inside a component subscribes
 * it), and per-target entry files that `render(<Survey/>, document.body)`.
 * Both surfaces share this ONE component: the s-* elements and the global
 * are identical across checkout and customer-account, so the old
 * inject-your-package's-exports factory is gone.
 *
 * Behavior (unchanged from v1.21.0):
 *  - renders nothing until: the App URL block setting is configured, the
 *    order contains a subscription (selling-plan) line, the backend reports
 *    the survey enabled, and this order hasn't completed it already;
 *  - one question per screen, single-tap answers, auto-advance;
 *  - every tap POSTs immediately (partial answers survive abandonment);
 *  - an impression POST fires once when the survey becomes visible — the
 *    shown-but-never-answered gap is itself a churn signal server-side;
 *  - all requests carry a fresh Shopify session token (Bearer); the backend
 *    trusts only the token's claims;
 *  - every failure path renders nothing or stops quietly — a survey must
 *    never degrade an order-confirmation page. No retry storms: one attempt
 *    per tap, refusals ({ok:false}) end the flow silently.
 *
 * CHECKOUT-EDITOR PREVIEW (v1.21.2): inside the theme editor
 * (shopify.extension.editor is set) every production gate fails by design —
 * the sample order has no selling-plan line, the backend status call cannot
 * answer, and the App URL may not be saved yet — so the block used to render
 * nothing there and merchants could neither see nor position it. In the
 * editor the survey now renders immediately in a LOCAL demo mode: the real
 * question flow, taps advance locally, and no network request of any kind is
 * made (no status read, no impression, no answers — editor sessions must
 * never write survey rows). Real pages are unaffected: the gates above stay
 * exactly as strict.
 */

import { useEffect, useState } from "preact/hooks";
import questionSet from "./questions.json";

export function Survey({
  source,
  /** "confirmation" (Thank You: shopify.orderConfirmation → {order:{id}}) or
   *  "order" (Order Status: shopify.order → {id}) — fixed per target. */
  orderSource,
}) {
  const inEditor = Boolean(shopify.extension?.editor);
  const orderId =
    orderSource === "confirmation"
      ? (shopify.orderConfirmation.value?.order?.id ?? null)
      : (shopify.order.value?.id ?? null);
  const lines = shopify.lines.value;
  const hasSubscription =
    Array.isArray(lines) &&
    lines.some((line) => Boolean(line?.merchandise?.sellingPlan));
  const settings = shopify.settings.value;
  const appUrl = (settings?.app_url ?? "").trim().replace(/\/+$/, "");
  const locale = shopify.localization?.language?.value?.isoCode;

  const [phase, setPhase] = useState("loading"); // loading | active | done | hidden
  const [answers, setAnswers] = useState({});
  const [step, setStep] = useState(0);
  const [impressionSent, setImpressionSent] = useState(false);

  const questions = questionSet.questions;

  async function post(body) {
    const token = await shopify.sessionToken.get();
    const response = await fetch(`${appUrl}/api/survey`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`survey http ${response.status}`);
    return response.json();
  }

  // Gate + status: decide whether to show at all.
  useEffect(() => {
    let cancelled = false;
    async function decide() {
      if (inEditor) {
        // Editor demo: visible immediately, no gating, no network.
        setPhase("active");
        return;
      }
      if (!appUrl || !orderId || !hasSubscription) return; // stay loading/hidden
      try {
        const status = await post({ kind: "status", orderId });
        if (cancelled) return;
        if (!status?.ok || !status.enabled || status.completed) {
          setPhase("hidden");
          return;
        }
        const already = status.answered ?? {};
        setAnswers(already);
        const firstUnanswered = questions.findIndex((q) => !already[q.key]);
        setStep(firstUnanswered === -1 ? questions.length : firstUnanswered);
        setPhase("active");
      } catch {
        if (!cancelled) setPhase("hidden");
      }
    }
    decide();
    return () => {
      cancelled = true;
    };
  }, [appUrl, orderId, hasSubscription]);

  // One impression per mount, once actually visible. Never from the editor:
  // an editor session is not a shopper and must not create survey rows.
  useEffect(() => {
    if (phase !== "active" || impressionSent || inEditor) return;
    setImpressionSent(true);
    post({
      kind: "impression",
      orderId,
      source,
      locale,
      questionSetVersion: questionSet.questionSetVersion,
    }).catch(() => {});
  }, [phase, impressionSent]);

  if (phase === "hidden" || phase === "loading") return null;

  if (phase === "done" || step >= questions.length) {
    return (
      <s-box border="base" borderRadius="base" padding="base">
        <s-stack gap="small-200">
          <s-heading>{shopify.i18n.translate("doneTitle")}</s-heading>
          <s-text color="subdued">{shopify.i18n.translate("doneBody")}</s-text>
        </s-stack>
      </s-box>
    );
  }

  const question = questions[step];

  async function tap(optionKey) {
    const nextAnswers = { ...answers, [question.key]: optionKey };
    setAnswers(nextAnswers);
    const nextStep = step + 1;
    setStep(nextStep);
    if (nextStep >= questions.length) setPhase("done");
    if (inEditor) return; // editor demo advances locally, never posts
    try {
      await post({
        kind: "answer",
        orderId,
        source,
        locale,
        questionSetVersion: questionSet.questionSetVersion,
        question: question.key,
        option: optionKey,
      });
    } catch {
      // Lost tap = one missing answer server-side (writes are per-answer;
      // partials are expected and carry signal). Keep the UI moving —
      // never block or retry-storm a confirmation page over survey data.
    }
  }

  return (
    <s-box border="base" borderRadius="base" padding="base">
      <s-stack gap="base">
        <s-stack gap="small-300">
          <s-heading>{shopify.i18n.translate("introTitle")}</s-heading>
          <s-text color="subdued" type="small">
            {shopify.i18n.translate("progress", {
              current: step + 1,
              total: questions.length,
            })}
          </s-text>
        </s-stack>
        <s-text type="strong">
          {shopify.i18n.translate(`q.${question.key}.title`)}
        </s-text>
        <s-stack gap="small-200">
          {question.options.map((optionKey) => (
            <s-button
              key={optionKey}
              variant="secondary"
              onClick={() => tap(optionKey)}
            >
              {shopify.i18n.translate(`q.${question.key}.${optionKey}`)}
            </s-button>
          ))}
        </s-stack>
      </s-stack>
    </s-box>
  );
}
