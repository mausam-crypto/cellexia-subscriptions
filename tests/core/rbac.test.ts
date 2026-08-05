/**
 * Unit tests for the RBAC decision matrix and actor normalisation (pure).
 */
import { describe, expect, it } from "vitest";
import { isRoleAllowed, normalizeActor } from "~/services/core/pure";
import type { StaffRoleName } from "~/types/domain";

describe("isRoleAllowed", () => {
  it("OWNER and ADMIN pass every check", () => {
    const gates: StaffRoleName[][] = [[], ["CS_AGENT"], ["ANALYST"], ["OWNER"]];
    for (const gate of gates) {
      expect(isRoleAllowed("OWNER", gate)).toBe(true);
      expect(isRoleAllowed("ADMIN", gate)).toBe(true);
    }
  });

  it("CS_AGENT only passes checks that list CS_AGENT", () => {
    expect(isRoleAllowed("CS_AGENT", ["CS_AGENT"])).toBe(true);
    expect(isRoleAllowed("CS_AGENT", ["CS_AGENT", "ANALYST"])).toBe(true);
    expect(isRoleAllowed("CS_AGENT", ["ANALYST"])).toBe(false);
    expect(isRoleAllowed("CS_AGENT", ["OWNER"])).toBe(false);
  });

  it("ANALYST only passes checks that list ANALYST", () => {
    expect(isRoleAllowed("ANALYST", ["ANALYST"])).toBe(true);
    expect(isRoleAllowed("ANALYST", ["CS_AGENT"])).toBe(false);
  });

  it("an empty requirement list admits any staff role", () => {
    expect(isRoleAllowed("CS_AGENT", [])).toBe(true);
    expect(isRoleAllowed("ANALYST", [])).toBe(true);
  });

  it("declines the full matrix of non-privileged x privileged gates", () => {
    const nonPrivileged: StaffRoleName[] = ["CS_AGENT", "ANALYST"];
    const gates: StaffRoleName[][] = [["OWNER"], ["ADMIN"], ["OWNER", "ADMIN"]];
    for (const role of nonPrivileged) {
      for (const gate of gates) {
        expect(isRoleAllowed(role, gate)).toBe(false);
      }
    }
  });
});

describe("normalizeActor", () => {
  it("defaults to SYSTEM when absent", () => {
    expect(normalizeActor(null)).toEqual({ type: "SYSTEM", id: null });
    expect(normalizeActor(undefined)).toEqual({ type: "SYSTEM", id: null });
  });

  it("accepts a bare actor type string", () => {
    expect(normalizeActor("CUSTOMER")).toEqual({ type: "CUSTOMER", id: null });
    expect(normalizeActor("WEBHOOK")).toEqual({ type: "WEBHOOK", id: null });
  });

  it("treats any other string as a staff identifier", () => {
    expect(normalizeActor("cs@cellexia.com")).toEqual({
      type: "STAFF",
      id: "cs@cellexia.com",
    });
  });

  it("passes structured actors through", () => {
    expect(normalizeActor({ type: "CUSTOMER", id: "gid://shopify/Customer/1" }))
      .toEqual({ type: "CUSTOMER", id: "gid://shopify/Customer/1" });
    expect(normalizeActor({ type: "STAFF" })).toEqual({
      type: "STAFF",
      id: null,
    });
  });
});
