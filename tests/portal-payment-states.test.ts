import { describe, expect, it } from "vitest";
import {
  cardExpiresAt,
  derivePortalPaymentState,
  nextChargeLine,
  paymentChipKey,
  paymentDetailsOpen,
  paymentMethodShortLabel,
  type PortalPaymentContract,
} from "~/lib/portal/payment.server";
import { t } from "~/lib/i18n/i18n.server";

/**
 * Payment section states (v1.28.0, P1.5 §2.2 item 1): derived from the
 * mirrored fields + settings.dunning.preExpiryNoticeDays only — the same
 * fields the engine charges against. Precedence NONE > REVOKED > EXPIRED >
 * EXPIRING > OK; the home chip yields to "Payment issue"; the <details>
 * opens whenever there is something to act on.
 */

const NOW = new Date("2026-08-17T10:00:00Z");

function contract(
  over: Partial<PortalPaymentContract> = {},
): PortalPaymentContract {
  return {
    paymentMethodId: "gid://shopify/CustomerPaymentMethod/1",
    backupPaymentMethodId: null,
    paymentInstrumentType: "CREDIT_CARD",
    paymentMethodRevokedAt: null,
    cardBrand: "Visa",
    cardLast4: "4242",
    cardExpiryMonth: 12,
    cardExpiryYear: 2027,
    nextBillingDate: new Date("2026-09-03T00:00:00Z"),
    ...over,
  };
}

const opts = { now: NOW, preExpiryNoticeDays: 30 };

describe("cardExpiresAt", () => {
  it("is the first instant after the expiry month (UTC) — the card works through the last day", () => {
    expect(cardExpiresAt(9, 2026)?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(cardExpiresAt(12, 2026)?.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
  it("null when not mirrored or malformed", () => {
    expect(cardExpiresAt(null, 2026)).toBeNull();
    expect(cardExpiresAt(13, 2026)).toBeNull();
    expect(cardExpiresAt(0, 2026)).toBeNull();
  });
});

describe("derivePortalPaymentState", () => {
  it("OK when the card is live and expires well after the next order + notice window", () => {
    const view = derivePortalPaymentState(contract(), opts);
    expect(view.state).toBe("OK");
    expect(view.expiryLabel).toBe("12/2027");
    expect(view.onBackup).toBe(false);
    expect(view.last4).toBe("4242");
  });

  it("EXPIRED when month/year is already past (first instant of the following month)", () => {
    expect(
      derivePortalPaymentState(contract({ cardExpiryMonth: 7, cardExpiryYear: 2026 }), opts).state,
    ).toBe("EXPIRED");
    // Still inside the expiry month = not yet expired.
    expect(
      derivePortalPaymentState(contract({ cardExpiryMonth: 8, cardExpiryYear: 2026, nextBillingDate: new Date("2026-08-20T00:00:00Z") }), opts).state,
    ).toBe("EXPIRING");
    expect(
      derivePortalPaymentState(contract({ cardExpiryMonth: 8, cardExpiryYear: 2026 }), { ...opts, now: new Date("2026-09-01T00:00:00Z") }).state,
    ).toBe("EXPIRED");
  });

  it("EXPIRING when the mirrored expiry falls before the next order, even outside the notice window", () => {
    // Expires end of Nov 2026, next order 3 Dec 2026, now 17 Aug (> 30 days away).
    const view = derivePortalPaymentState(
      contract({
        cardExpiryMonth: 11,
        cardExpiryYear: 2026,
        nextBillingDate: new Date("2026-12-03T00:00:00Z"),
      }),
      opts,
    );
    expect(view.state).toBe("EXPIRING");
    expect(view.expiryLabel).toBe("11/2026");
  });

  it("EXPIRING within dunning.preExpiryNoticeDays even when the next order lands before expiry", () => {
    // Expires end of Sep 2026 → expiresAt 1 Oct; 30-day window opens 1 Sep.
    const c = contract({ cardExpiryMonth: 9, cardExpiryYear: 2026, nextBillingDate: new Date("2026-09-10T00:00:00Z") });
    expect(derivePortalPaymentState(c, { now: new Date("2026-08-17T00:00:00Z"), preExpiryNoticeDays: 30 }).state).toBe("OK");
    expect(derivePortalPaymentState(c, { now: new Date("2026-09-02T00:00:00Z"), preExpiryNoticeDays: 30 }).state).toBe("EXPIRING");
    // The window is a setting: 60 days already covers 17 Aug.
    expect(derivePortalPaymentState(c, { now: new Date("2026-08-17T00:00:00Z"), preExpiryNoticeDays: 60 }).state).toBe("EXPIRING");
  });

  it("no next order date: EXPIRING relies on the notice window alone", () => {
    const c = contract({ cardExpiryMonth: 9, cardExpiryYear: 2026, nextBillingDate: null });
    expect(derivePortalPaymentState(c, { now: new Date("2026-08-17T00:00:00Z"), preExpiryNoticeDays: 30 }).state).toBe("OK");
    expect(derivePortalPaymentState(c, { now: new Date("2026-09-15T00:00:00Z"), preExpiryNoticeDays: 30 }).state).toBe("EXPIRING");
  });

  it("REVOKED beats EXPIRED / EXPIRING (paymentMethodRevokedAt set)", () => {
    const view = derivePortalPaymentState(
      contract({ paymentMethodRevokedAt: new Date("2026-08-01T00:00:00Z"), cardExpiryMonth: 1, cardExpiryYear: 2020 }),
      opts,
    );
    expect(view.state).toBe("REVOKED");
  });

  it("NONE when nothing is mirrored (no method id, no brand/last4)", () => {
    expect(
      derivePortalPaymentState(contract({ paymentMethodId: null, cardBrand: null, cardLast4: null, cardExpiryMonth: null, cardExpiryYear: null }), opts).state,
    ).toBe("NONE");
    // A method id alone still counts as a mirror (label falls back to the generic card).
    expect(
      derivePortalPaymentState(contract({ cardBrand: null, cardLast4: null, cardExpiryMonth: null, cardExpiryYear: null }), opts).state,
    ).toBe("OK");
  });

  it("no expiry mirrored (Shop Pay / PayPal) → OK, expiryLabel null", () => {
    const view = derivePortalPaymentState(
      contract({ paymentInstrumentType: "PAYPAL", cardBrand: "PayPal", cardLast4: null, cardExpiryMonth: null, cardExpiryYear: null }),
      opts,
    );
    expect(view.state).toBe("OK");
    expect(view.expiryLabel).toBeNull();
    expect(view.expiresAt).toBeNull();
  });

  it("onBackup is scoped to an OPEN case when the caller knows: hasOpenCase false → never on backup (stale marker), true / omitted → pointer equality (Stage G review fix)", () => {
    const gid = "gid://shopify/CustomerPaymentMethod/9";
    const both = contract({ paymentMethodId: gid, backupPaymentMethodId: gid });
    expect(derivePortalPaymentState(both, { ...opts, hasOpenCase: false }).onBackup).toBe(false);
    expect(derivePortalPaymentState(both, { ...opts, hasOpenCase: true }).onBackup).toBe(true);
    expect(derivePortalPaymentState(both, opts).onBackup).toBe(true);
    expect(derivePortalPaymentState(contract({ backupPaymentMethodId: gid }), { ...opts, hasOpenCase: true }).onBackup).toBe(false);
  });

  it("onBackup = engine pointer equality (paymentMethodId === backupPaymentMethodId)", () => {
    const gid = "gid://shopify/CustomerPaymentMethod/9";
    expect(derivePortalPaymentState(contract({ paymentMethodId: gid, backupPaymentMethodId: gid }), opts).onBackup).toBe(true);
    expect(derivePortalPaymentState(contract({ backupPaymentMethodId: gid }), opts).onBackup).toBe(false);
    expect(derivePortalPaymentState(contract({ paymentMethodId: null, backupPaymentMethodId: null }), opts).onBackup).toBe(false);
  });

  it("an unset notice window (mocked settings) never throws and falls back to the next-order rule", () => {
    const c = contract({ cardExpiryMonth: 9, cardExpiryYear: 2026, nextBillingDate: new Date("2026-09-10T00:00:00Z") });
    expect(
      derivePortalPaymentState(c, { now: new Date("2026-09-20T00:00:00Z"), preExpiryNoticeDays: undefined as unknown as number }).state,
    ).toBe("OK");
    expect(
      derivePortalPaymentState(c, { now: new Date("2026-09-20T00:00:00Z"), preExpiryNoticeDays: 30 }).state,
    ).toBe("EXPIRING");
  });
});

describe("paymentChipKey — home card chip precedence", () => {
  it("Payment issue wins over any card state", () => {
    expect(paymentChipKey("EXPIRED", { status: "ACTIVE", hasIssue: true })).toBeNull();
    expect(paymentChipKey("EXPIRING", { status: "ACTIVE", hasIssue: true })).toBeNull();
    expect(paymentChipKey("REVOKED", { status: "ACTIVE", hasIssue: true })).toBeNull();
  });
  it("ACTIVE without an issue: expiring / expired / removed chips", () => {
    expect(paymentChipKey("EXPIRING", { status: "ACTIVE", hasIssue: false })).toBe("portal.card.chip_expiring");
    expect(paymentChipKey("EXPIRED", { status: "ACTIVE", hasIssue: false })).toBe("portal.card.chip_expired");
    expect(paymentChipKey("REVOKED", { status: "ACTIVE", hasIssue: false })).toBe("portal.card.chip_removed");
    expect(paymentChipKey("OK", { status: "ACTIVE", hasIssue: false })).toBeNull();
    expect(paymentChipKey("NONE", { status: "ACTIVE", hasIssue: false })).toBeNull();
  });
  it("non-ACTIVE statuses keep their status chip", () => {
    for (const status of ["PAUSED", "FAILED", "CANCELLED", "EXPIRED"]) {
      expect(paymentChipKey("EXPIRED", { status, hasIssue: false })).toBeNull();
    }
  });
});

describe("paymentDetailsOpen", () => {
  it("open in any non-OK state, or whenever a dunning banner is on the page", () => {
    expect(paymentDetailsOpen("OK", false)).toBe(false);
    expect(paymentDetailsOpen("OK", true)).toBe(true);
    for (const state of ["EXPIRING", "EXPIRED", "REVOKED", "NONE"] as const) {
      expect(paymentDetailsOpen(state, false)).toBe(true);
    }
  });
});

describe("next-charge line", () => {
  it("'{amount} on {date} · Visa ····4242' — reuses the surface's amount", () => {
    expect(
      nextChargeLine("en", {
        amount: "€49.00",
        date: "3 Sep 2026",
        cardLabel: paymentMethodShortLabel("en", { paymentInstrumentType: "CREDIT_CARD", cardBrand: "Visa", cardLast4: "4242" }),
      }),
    ).toBe("€49.00 on 3 Sep 2026 · Visa ····4242");
  });
  it("no amount → date + card; no card → amount + date only", () => {
    expect(nextChargeLine("en", { amount: null, date: "3 Sep 2026", cardLabel: "Visa ····4242" })).toBe("3 Sep 2026 · Visa ····4242");
    expect(nextChargeLine("en", { amount: "€49.00", date: "3 Sep 2026", cardLabel: null })).toBe("€49.00 on 3 Sep 2026");
  });
  it("short label is instrument-aware and null when nothing is mirrored", () => {
    expect(paymentMethodShortLabel("en", { paymentInstrumentType: "SHOP_PAY", cardBrand: "Shop Pay", cardLast4: "1234" })).toBe("Shop Pay ····1234");
    expect(paymentMethodShortLabel("en", { paymentInstrumentType: "PAYPAL", cardBrand: "PayPal", cardLast4: null })).toBe("PayPal");
    expect(paymentMethodShortLabel("en", { cardBrand: null, cardLast4: null })).toBeNull();
    expect(paymentMethodShortLabel("en", { cardBrand: null, cardLast4: "9999" })).toBe(
      t("en", "portal.card.short", { brand: t("en", "portal.payment.card_generic"), last4: "9999" }),
    );
  });
});

describe("i18n keys (English) exist and are honest", () => {
  it("state notes, chips and next-charge keys resolve", () => {
    for (const key of [
      "portal.payment.expiring_note",
      "portal.payment.expiring_note_nodate",
      "portal.payment.expired_note",
      "portal.payment.expired_note_nodate",
      "portal.payment.revoked_note",
      "portal.payment.on_backup",
      "portal.payment.on_backup_generic",
      "portal.card.chip_expiring",
      "portal.card.chip_expired",
      "portal.card.chip_removed",
      "portal.card.short",
      "portal.card.next_charge",
    ]) {
      expect(t("en", key)).not.toBe(key);
    }
  });
  it("expiring copy names last4, expiry and the next order date; none of the copy names cancellation", () => {
    const s = t("en", "portal.payment.expiring_note", { last4: "4242", expiry: "09/2026", date: "3 Sep" });
    expect(s).toContain("4242");
    expect(s).toContain("09/2026");
    expect(s).toContain("3 Sep");
    for (const key of ["portal.payment.expiring_note", "portal.payment.expired_note", "portal.payment.revoked_note", "portal.payment.on_backup"]) {
      expect(t("en", key).toLowerCase()).not.toContain("cancel");
    }
  });
});
