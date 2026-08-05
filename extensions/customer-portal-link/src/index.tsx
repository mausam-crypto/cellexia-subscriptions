/**
 * Cellexia Continuous Treatment — customer account portal entry card.
 *
 * Renders on both the Profile page and the Order index page of the new
 * customer accounts. Deliberately a pure link surface: no data fetching, no
 * network access, no session tokens — it cannot break even if the app backend
 * is briefly unavailable. The real work (verifying the customer via the app
 * proxy's `logged_in_customer_id` and opening a portal session) happens on
 * the server side of /apps/cellexia-subscriptions/portal-link.
 */
import {
  BlockStack,
  Button,
  Card,
  Heading,
  TextBlock,
  reactExtension,
  useApi,
} from "@shopify/ui-extensions-react/customer-account";
import { buildPortalHandoffUrl } from "./portalUrl";

/**
 * Fallback copy (brand voice, see docs/BRAND.md). Used if a translation key
 * is ever missing so the card never renders blank.
 */
const FALLBACK_COPY = {
  title: "Your Continuous Treatment",
  body: "View your routine, move a delivery, or adjust your treatment — no password needed.",
  cta: "Manage my treatment plan",
  reassurance: "Adjust, delay or cancel online.",
} as const;

type CopyKey = keyof typeof FALLBACK_COPY;

function PortalLinkCard() {
  const api = useApi();

  const t = (key: CopyKey): string => {
    try {
      const translated = api.i18n.translate(key);
      return typeof translated === "string" && translated.length > 0
        ? translated
        : FALLBACK_COPY[key];
    } catch {
      return FALLBACK_COPY[key];
    }
  };

  const portalUrl = buildPortalHandoffUrl(api.shop?.storefrontUrl ?? null);

  return (
    <Card padding>
      <BlockStack spacing="base">
        <Heading level={2}>{t("title")}</Heading>
        <TextBlock appearance="subdued">{t("body")}</TextBlock>
        <Button to={portalUrl} accessibilityLabel={t("cta")}>
          {t("cta")}
        </Button>
        <TextBlock appearance="subdued" size="small">
          {t("reassurance")}
        </TextBlock>
      </BlockStack>
    </Card>
  );
}

// One module serves both targets declared in shopify.extension.toml.
export const profileBlock = reactExtension(
  "customer-account.profile.block.render",
  () => <PortalLinkCard />,
);

export const orderIndexBlock = reactExtension(
  "customer-account.order-index.block.render",
  () => <PortalLinkCard />,
);
