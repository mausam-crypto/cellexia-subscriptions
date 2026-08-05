/**
 * [account-ext] — unit tests for the pure portal hand-off URL logic used by
 * the customer account UI extension (extensions/customer-portal-link).
 */
import { describe, expect, it } from "vitest";
import {
  PORTAL_HANDOFF_PATH,
  buildPortalHandoffUrl,
} from "../extensions/customer-portal-link/src/portalUrl";

describe("PORTAL_HANDOFF_PATH", () => {
  it("matches the app proxy subpath configured in shopify.app.toml", () => {
    expect(PORTAL_HANDOFF_PATH).toBe("/apps/cellexia-subscriptions/portal-link");
  });
});

describe("buildPortalHandoffUrl", () => {
  it("prefixes the shop storefront URL when available", () => {
    expect(buildPortalHandoffUrl("https://cellexia.com")).toBe(
      "https://cellexia.com/apps/cellexia-subscriptions/portal-link",
    );
  });

  it("tolerates a trailing slash on the storefront URL", () => {
    expect(buildPortalHandoffUrl("https://cellexia.com/")).toBe(
      "https://cellexia.com/apps/cellexia-subscriptions/portal-link",
    );
    expect(buildPortalHandoffUrl("https://cellexia.com///")).toBe(
      "https://cellexia.com/apps/cellexia-subscriptions/portal-link",
    );
  });

  it("falls back to the relative path when the storefront URL is missing", () => {
    expect(buildPortalHandoffUrl(undefined)).toBe(PORTAL_HANDOFF_PATH);
    expect(buildPortalHandoffUrl(null)).toBe(PORTAL_HANDOFF_PATH);
    expect(buildPortalHandoffUrl("")).toBe(PORTAL_HANDOFF_PATH);
    expect(buildPortalHandoffUrl("   ")).toBe(PORTAL_HANDOFF_PATH);
  });

  it("trims surrounding whitespace before joining", () => {
    expect(buildPortalHandoffUrl("  https://cellexia.com  ")).toBe(
      "https://cellexia.com/apps/cellexia-subscriptions/portal-link",
    );
  });
});
