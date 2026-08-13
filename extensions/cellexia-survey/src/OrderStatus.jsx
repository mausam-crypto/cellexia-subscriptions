/**
 * Order Status page target (customer-account.order-status.block.render).
 * Renders on every revisit of the order page, so the backend status read
 * (already completed? survey disabled?) is what keeps it from re-asking —
 * device-local flags alone would re-ask on a second device.
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
} from "@shopify/ui-extensions-react/customer-account";
import { useEffect, useMemo, useState } from "react";
import { createSurveyBlock } from "./survey-core.jsx";

export default createSurveyBlock({
  reactExtension,
  target: "customer-account.order-status.block.render",
  source: "ORDER_STATUS",
  orderSource: "order",
  ui: { BlockStack, Button, Heading, Text, View },
  hooks: { useApi, useSubscription, useEffect, useMemo, useState },
});
