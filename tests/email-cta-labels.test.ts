import { describe, expect, it } from "vitest";

import { renderEmail } from "~/lib/notifications/templates.server";

/**
 * CTA button localization (v1.24.0): the button label must read in the
 * CUSTOMER's language and match the template's intent — before this, every
 * email in all 22 locales shipped the hardcoded English "Manage
 * subscription", and the winback emails got it APPENDED after the sign-off
 * as a duplicate, mislabeled reactivation button.
 */

const CTA_URL = "https://example.com/act";

describe("renderEmail CTA labels", () => {
  it("payment emails get the localized update-card label", () => {
    const fr = renderEmail("payment_failed_2", "fr", {
      amount: "45,00 €",
      decline_human: "carte refusée",
      days_since_failure: 3,
      cta_url: CTA_URL,
      pause_url: "https://example.com/pause",
    });
    expect(fr.html).toContain("Mettre à jour ma carte");
    expect(fr.html).not.toContain("Manage subscription");
  });

  it("winback emails render the localized restart button IN PLACE, not appended", () => {
    const de = renderEmail("winback_discount", "de", {
      discount_pct: 20,
      discount_cycles: 2,
      cta_url: CTA_URL,
      reactivate_url: CTA_URL,
    });
    expect(de.html).toContain("Mein Abo neu starten");
    // Exactly one button: the {cta} slot consumed it, so nothing is appended.
    expect(de.html.split(CTA_URL).length - 1).toBe(1);
  });

  it("templates without an intent key fall back to the localized manage label", () => {
    const es = renderEmail("gift_announcement", "es", {
      gift_title: "Sérum",
      rule_name: "Regalo",
      gift_image_line: "",
      gift_worth_line: "",
      gift_date_line: "",
      portal_url: "https://example.com/account",
      cta_url: CTA_URL,
    });
    expect(es.html).toContain("Gestionar suscripción");
  });

  it("a caller-provided cta_label still wins", () => {
    const en = renderEmail("payment_failed_2", "en", {
      amount: "£45.00",
      decline_human: "card declined",
      days_since_failure: 3,
      cta_url: CTA_URL,
      cta_label: "Fix it now",
      pause_url: "https://example.com/pause",
    });
    expect(en.html).toContain("Fix it now");
  });
});
