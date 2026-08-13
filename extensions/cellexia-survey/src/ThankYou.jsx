/**
 * Thank You page target (purchase.thank-you.block.render). Shopify shows the
 * Thank You page exactly once — revisits land on the Order Status page, whose
 * sibling target (OrderStatus.jsx) carries the survey from there.
 */

import {
  reactExtension,
  useApi,
  useSubscription,
  BlockStack,
  Button,
  Heading,
  Text,
  View,
} from "@shopify/ui-extensions-react/checkout";
import { useEffect, useMemo, useState } from "react";
import { createSurveyBlock } from "./survey-core.jsx";

export default createSurveyBlock({
  reactExtension,
  target: "purchase.thank-you.block.render",
  source: "THANK_YOU",
  orderSource: "confirmation",
  ui: { BlockStack, Button, Heading, Text, View },
  hooks: { useApi, useSubscription, useEffect, useMemo, useState },
});
