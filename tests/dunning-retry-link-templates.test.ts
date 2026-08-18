import { describe, expect, it, vi } from "vitest";

/**
 * Customer "Retry now" link in the dunning emails (v1.28.0, P1.3 — synthesis
 * §2.2 item 7: "Magic verb RETRY_PAYMENT in payment_failed_2/3").
 *
 * Pinned here:
 *  - the English payment_failed_2/3 bodies reference {retry_payment_url}
 *    (payment_failed_1 deliberately does not: the first notice says "you may
 *    not need to do anything");
 *  - the Emails page placeholder chips (catalog `links`) list
 *    retry_payment_url for every link-bundle template, so merchant overrides
 *    can use it;
 *  - the preview sample set carries the URL, so the Emails preview / test
 *    send never shows a raw placeholder and points at example.com only.
 */

vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async () => ({})),
}));

import { t } from "~/lib/i18n/i18n.server";
import { EMAIL_CATALOG } from "~/lib/notifications/catalog.server";
import { previewSampleVars } from "~/lib/notifications/preview.server";

describe("retry_payment_url in dunning templates", () => {
  it("payment_failed_2 and payment_failed_3 carry the one-tap retry link; payment_failed_1 does not", () => {
    for (const key of ["payment_failed_2", "payment_failed_3"] as const) {
      const body = t("en", `email.${key}.body`);
      expect(body).toContain("({retry_payment_url})");
      expect(body.toLowerCase()).not.toContain("cancel");
    }
    expect(t("en", "email.payment_failed_1.body")).not.toContain(
      "{retry_payment_url}",
    );
  });

  it("the catalog lists retry_payment_url as a placeholder for the dunning templates", () => {
    for (const key of ["payment_failed_1", "payment_failed_2", "payment_failed_3"] as const) {
      expect(EMAIL_CATALOG[key].links).toContain("retry_payment_url");
    }
  });

  it("the preview sample vars resolve it to an example.com URL", () => {
    for (const key of ["payment_failed_2", "payment_failed_3"] as const) {
      const vars = previewSampleVars(key);
      expect(String(vars.retry_payment_url)).toMatch(/^https:\/\/example\.com\//);
    }
  });
});
