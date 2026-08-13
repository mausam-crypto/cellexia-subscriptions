/**
 * Shared survey UI + client logic for both render targets (v1.21.0).
 *
 * The Thank You target imports components/hooks from
 * `@shopify/ui-extensions-react/checkout` and the Order Status target from
 * `@shopify/ui-extensions-react/customer-account`; the component tree and
 * behavior are identical, so each thin target file injects its package's
 * exports into this factory (extension sandboxes cannot share a single
 * import — the two surfaces are different packages by design).
 *
 * Behavior:
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
 */

import questionSet from "./questions.json";

export function createSurveyBlock({
  reactExtension,
  target,
  source,
  /** "confirmation" (Thank You: api.orderConfirmation → {order:{id}}) or
   *  "order" (Order Status: api.order → {id}) — fixed per target, so the
   *  hooks below stay unconditional across renders. */
  orderSource,
  ui,
  hooks,
}) {
  const { BlockStack, Button, Heading, Text, View } = ui;
  const { useApi, useSubscription, useEffect, useMemo, useState } = hooks;

  function useOrderId(api) {
    const value = useSubscription(
      orderSource === "confirmation" ? api.orderConfirmation : api.order,
    );
    return orderSource === "confirmation"
      ? (value?.order?.id ?? null)
      : (value?.id ?? null);
  }

  function useHasSubscriptionLine(api) {
    const lines = useSubscription(api.lines);
    return useMemo(() => {
      if (!Array.isArray(lines)) return false;
      return lines.some((line) => Boolean(line?.merchandise?.sellingPlan));
    }, [lines]);
  }

  function Survey() {
    const api = useApi();
    const orderId = useOrderId(api);
    const hasSubscription = useHasSubscriptionLine(api);
    const settings = useSubscription(api.settings);
    const appUrl = (settings?.app_url ?? "").trim().replace(/\/+$/, "");

    const [phase, setPhase] = useState("loading"); // loading | active | done | hidden
    const [answers, setAnswers] = useState({});
    const [step, setStep] = useState(0);
    const [impressionSent, setImpressionSent] = useState(false);

    const questions = questionSet.questions;

    async function post(body) {
      const token = await api.sessionToken.get();
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

    // One impression per mount, once actually visible.
    useEffect(() => {
      if (phase !== "active" || impressionSent) return;
      setImpressionSent(true);
      post({
        kind: "impression",
        orderId,
        source,
        locale: api.localization?.language?.current?.isoCode,
        questionSetVersion: questionSet.questionSetVersion,
      }).catch(() => {});
    }, [phase, impressionSent]);

    if (phase === "hidden" || phase === "loading") return null;

    if (phase === "done" || step >= questions.length) {
      return (
        <View border="base" cornerRadius="base" padding="base">
          <BlockStack spacing="tight">
            <Heading level={3}>{api.i18n.translate("doneTitle")}</Heading>
            <Text appearance="subdued">{api.i18n.translate("doneBody")}</Text>
          </BlockStack>
        </View>
      );
    }

    const question = questions[step];

    async function tap(optionKey) {
      const nextAnswers = { ...answers, [question.key]: optionKey };
      setAnswers(nextAnswers);
      const nextStep = step + 1;
      setStep(nextStep);
      if (nextStep >= questions.length) setPhase("done");
      try {
        await post({
          kind: "answer",
          orderId,
          source,
          locale: api.localization?.language?.current?.isoCode,
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
      <View border="base" cornerRadius="base" padding="base">
        <BlockStack spacing="base">
          <BlockStack spacing="extraTight">
            <Heading level={3}>{api.i18n.translate("introTitle")}</Heading>
            <Text appearance="subdued" size="small">
              {api.i18n.translate("progress", {
                current: step + 1,
                total: questions.length,
              })}
            </Text>
          </BlockStack>
          <Text emphasis="bold">
            {api.i18n.translate(`q.${question.key}.title`)}
          </Text>
          <BlockStack spacing="tight">
            {question.options.map((optionKey) => (
              <Button
                key={optionKey}
                kind="secondary"
                onPress={() => tap(optionKey)}
              >
                {api.i18n.translate(`q.${question.key}.${optionKey}`)}
              </Button>
            ))}
          </BlockStack>
        </BlockStack>
      </View>
    );
  }

  return reactExtension(target, () => <Survey />);
}
