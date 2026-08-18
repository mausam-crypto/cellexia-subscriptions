import { describe, expect, it } from "vitest";
import { paymentMethodLabel } from "~/lib/portal/payment.server";
import { t } from "~/lib/i18n/i18n.server";

/**
 * Instrument-aware payment label (v1.28.0, P1.1 §2.2 item 1): a PayPal
 * contract used to render "PayPal ending in ····" and Shop Pay "Shop Pay
 * ending in 1234". The legacy `portal.payment.card_summary` key keeps working
 * for cards and for pre-0027 rows whose instrument type is not mirrored yet.
 */
describe("paymentMethodLabel", () => {
  it("Shop Pay → 'Shop Pay ····{last4}'", () => {
    expect(
      paymentMethodLabel("en", {
        paymentInstrumentType: "SHOP_PAY",
        cardBrand: "Shop Pay",
        cardLast4: "1234",
      }),
    ).toBe("Shop Pay ····1234");
  });

  it("PayPal → 'PayPal' (no digits, no 'ending in')", () => {
    const label = paymentMethodLabel("en", {
      paymentInstrumentType: "PAYPAL",
      cardBrand: "PayPal",
      cardLast4: null,
    });
    expect(label).toBe("PayPal");
    expect(label).not.toContain("····");
  });

  it("card → legacy brand + last4 copy", () => {
    expect(
      paymentMethodLabel("en", {
        paymentInstrumentType: "CREDIT_CARD",
        cardBrand: "Visa",
        cardLast4: "4242",
      }),
    ).toBe(t("en", "portal.payment.card_summary", { brand: "Visa", last4: "4242" }));
  });

  it("type not mirrored yet (pre-0027 row) → legacy copy, generic brand fallback", () => {
    expect(
      paymentMethodLabel("en", { cardBrand: null, cardLast4: "9999" }),
    ).toBe(t("en", "portal.payment.card_summary", { brand: t("en", "portal.payment.card_generic"), last4: "9999" }));
  });

  it("the toast + manage-link + magic copy keys exist in en.json", () => {
    for (const key of [
      "portal.toast.card_link_sent",
      "portal.payment.manage_in_account",
      "portal.payment.revoked_note",
      "portal.payment.shop_pay_summary",
      "portal.payment.paypal_summary",
      "magic.update_card.email_sent_title",
      "magic.update_card.email_sent_sub",
      "magic.update_card.revoked_title",
      "magic.update_card.unavailable_title",
    ]) {
      expect(t("en", key), key).not.toBe(key);
    }
    // Honesty: the toast names the 48-hour validity Shopify documents.
    expect(t("en", "portal.toast.card_link_sent")).toMatch(/48 hours/);
  });
});
