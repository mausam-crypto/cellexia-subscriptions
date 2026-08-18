import type { SubscriptionContract } from "@prisma/client";
import { getSetting } from "~/lib/settings/settings.server";
import type { SettingsValue } from "~/lib/settings/registry.server";
import { buildMagicUrl } from "~/lib/magiclinks/builder.server";
import { isBillableOwnership } from "~/lib/ownership/ownership.server";

/**
 * One-tap restart link minting (v1.28.0, P3.2) — dependency-light on purpose
 * (no engine import) so the engine, the notifications router and the
 * Klaviyo event map can all mint without a module cycle. Semantics are
 * documented in ./restart.server.ts.
 */

type WinbackSettings = SettingsValue<"winback">;

export const RESTART_LINK_TTL_DEFAULT_DAYS = 60;

export function restartLinkTtlDays(settings: WinbackSettings): number {
  const v = (settings as { restartLinkTtlDays?: unknown }).restartLinkTtlDays;
  return typeof v === "number" && Number.isFinite(v) && v >= 1
    ? Math.round(v)
    : RESTART_LINK_TTL_DEFAULT_DAYS;
}

/** The magic params a restart link carries — recognised by the executor. */
export const RESTART_LINK_PARAMS = {
  percent: 0,
  cycles: 0,
  gift: false,
  restart: true,
} as const;

/**
 * Mint the signed one-tap restart link for a cancelled contract. Single use,
 * TTL from settings.winback.restartLinkTtlDays. Throws on infrastructure
 * failure (callers that must never fail use `restartLinkVars`).
 */
export async function buildRestartUrl(
  contract: Pick<SubscriptionContract, "id" | "customerId" | "email" | "shopId">,
  opts: { createdVia?: string; settings?: WinbackSettings } = {},
): Promise<string> {
  const settings = opts.settings ?? (await getSetting(contract.shopId, "winback"));
  return buildMagicUrl({
    action: "APPLY_WINBACK",
    contractId: contract.id,
    customerId: contract.customerId,
    email: contract.email,
    params: { ...RESTART_LINK_PARAMS },
    ttlSeconds: restartLinkTtlDays(settings) * 24 * 3600,
    maxUses: 1,
    createdVia: opts.createdVia ?? "KLAVIYO_FLOW",
  });
}

/**
 * `{ restart_url }` for a template's vars / a Klaviyo event's properties, or
 * `{}` when no link should exist: another app's contract, the demo fixture,
 * a MERGED (internal consolidation) cancel — or any minting failure. Never
 * throws: a missing link degrades the email to portal_url, it must never
 * block the send.
 */
export async function restartLinkVars(
  contract: Pick<
    SubscriptionContract,
    "id" | "customerId" | "email" | "shopId" | "ownership" | "isDemo" | "cancelReason"
  >,
  opts: { createdVia?: string; settings?: WinbackSettings } = {},
): Promise<Record<string, string>> {
  try {
    if (!isBillableOwnership(contract.ownership)) return {};
    if (contract.isDemo) return {};
    if (contract.cancelReason === "MERGED") return {};
    return { restart_url: await buildRestartUrl(contract, opts) };
  } catch (err) {
    console.error("[winback] restart link mint failed", contract.id, err);
    return {};
  }
}

