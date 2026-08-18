import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { settingsSchemas } from "~/lib/settings/registry.server";

/**
 * Admin Cancel-flow page completeness (v1.28.0 follow-up): every key of the
 * `cancelFlow` setting must be editable on app/routes/app.cancel-flow.tsx
 * (read in the save action, submitted by the form, rendered as a field) —
 * a registry key that only the generic Settings renderer could reach is a
 * setting the merchant will never find.
 */
const page = readFileSync(
  new URL("../app/routes/app.cancel-flow.tsx", import.meta.url),
  "utf8",
);

const cancelFlowKeys = Object.keys(
  (settingsSchemas.cancelFlow._def.innerType as { shape: Record<string, unknown> })
    .shape,
);

describe("cancel-flow admin page covers every cancelFlow registry key", () => {
  it("has at least the v1.28.0 keys in the registry", () => {
    for (const key of [
      "conciergeHoldDays",
      "conciergeHoldMinLeadHours",
      "scheduledCancelEnabled",
      "scheduledCancelNoticeDays",
      "keepLinkTtlDays",
      "intentFollowupEnabled",
      "intentFollowupHours",
      "intentFollowupChargeBufferHours",
      "intentFollowupCooldownDays",
      "intentBannerDays",
      "delaySaveEnabled",
      "delaySaveMaxDays",
      "downsizeSaveEnabled",
    ]) {
      expect(cancelFlowKeys).toContain(key);
    }
  });

  it.each(cancelFlowKeys)("%s is read by the save action and bound to a field", (key) => {
    // Action: intField("key") for numbers, formData.get("key") for booleans.
    expect(page).toMatch(
      new RegExp(`(intField|formData\\.get)\\("${key}"\\)`),
    );
    // Form: submitted under its own name and shown with its zod error.
    expect(page).toMatch(new RegExp(`\\b${key}[,:]`));
    // Numeric fields surface their zod issue inline (Checkboxes cannot fail
    // validation; the final-offer slider shows its error under the slider).
    const isBoolean = /Enabled$|^enabled$/.test(key);
    if (!isBoolean) {
      expect(page).toContain(`errors.${key}`);
    }
  });
});
