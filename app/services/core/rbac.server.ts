/**
 * Role-based access control for staff.
 *
 * OWNER/ADMIN pass every check; CS_AGENT and ANALYST only pass checks that
 * list them. First-run seed: while a shop has no StaffRole rows at all, any
 * authenticated session acts as OWNER so the installer can reach Settings and
 * create the role table.
 */
import prisma from "~/db.server";
import { isRoleAllowed } from "~/services/core/pure";
import type { StaffRoleName } from "~/types/domain";
import { STAFF_ROLE_NAMES } from "~/types/domain";

export interface RoleCheckResult {
  role: StaffRoleName;
  /** True when the shop has no StaffRole rows yet (first-run OWNER seed). */
  seeded: boolean;
}

/** Structural view of the Shopify admin Session that RBAC needs. */
export interface SessionLike {
  shop: string;
  email?: string | null;
  onlineAccessInfo?: {
    associated_user?: { email?: string | null } | null;
  } | null;
}

/** Best-available staff identity for audit trails: user email, else shop domain. */
export function staffEmailFromSession(session: SessionLike): string | null {
  return (
    session.email ?? session.onlineAccessInfo?.associated_user?.email ?? null
  );
}

/**
 * Throw a 403 Response unless the session's user holds one of `roles`
 * (or OWNER/ADMIN, which always pass). Empty `roles` = any staff role.
 */
export async function requireRole(
  session: SessionLike,
  ...roles: StaffRoleName[]
): Promise<RoleCheckResult> {
  const shop = session.shop;
  const sessionEmail = staffEmailFromSession(session);
  const staffCount = await prisma.staffRole.count({ where: { shop } });
  if (staffCount === 0) {
    // First run: nobody has been assigned yet — treat the session as OWNER.
    return { role: "OWNER", seeded: true };
  }

  if (!sessionEmail) {
    throw forbidden();
  }

  const row = await prisma.staffRole.findUnique({
    where: { shop_email: { shop, email: sessionEmail.toLowerCase() } },
  });
  if (!row) {
    throw forbidden();
  }

  const role = row.role as StaffRoleName;
  if (!(STAFF_ROLE_NAMES as readonly string[]).includes(role)) {
    throw forbidden();
  }
  if (!isRoleAllowed(role, roles)) {
    throw forbidden();
  }
  return { role, seeded: false };
}

function forbidden(): Response {
  return new Response("Forbidden: your role does not permit this action", {
    status: 403,
    headers: { "Content-Type": "text/plain" },
  });
}
