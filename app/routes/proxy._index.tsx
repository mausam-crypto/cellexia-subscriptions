import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import type { ContractStatus } from "@prisma/client";
import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import { requireShop } from "~/lib/shop/install.server";
import { getSetting } from "~/lib/settings/settings.server";
import { t } from "~/lib/i18n/i18n.server";
import { formatMoney } from "~/lib/money";
import { formatShopDate } from "~/lib/dates.server";
import { isSetupMode } from "~/lib/launch/launch.server";
import {
  escapeHtml,
  localeFromRequest,
  portalPage,
  resolveToast,
  setupGatePage,
  withLocale,
  type PortalToast,
} from "~/lib/portal/layout.server";
import {
  PORTAL_BASE_PATH,
  exchangeLoginHandoff,
  getPortalSession,
  type PortalSessionContext,
} from "~/lib/portal/session.server";
import type { LocalContractWithLines } from "~/lib/contracts/shared.server";
import { OURS_ONLY } from "~/lib/ownership/ownership.server";

/**
 * Portal home: every subscription the signed-in customer has, with one-tap
 * quick actions, a rewards strip (days subscribed, milestone progress,
 * rewards unlock) and a contextual "push it back" prompt for subscribers who
 * are predicted to still have product when the next order would bill.
 *
 * Also the landing point of the magic-link LOGIN hand-off: ?handoff= carries
 * a single-use ~60s code that is exchanged server-side for the HttpOnly
 * cx_portal session cookie, then redirected away to a clean URL.
 */

const STATUS_ORDER: Record<ContractStatus, number> = {
  ACTIVE: 0,
  PAUSED: 1,
  FAILED: 2,
  CANCELLED: 3,
  EXPIRED: 4,
};

const STATUS_CHIP_CLASS: Record<ContractStatus, string> = {
  ACTIVE: "cx-chip--active",
  PAUSED: "cx-chip--paused",
  FAILED: "cx-chip--failed",
  CANCELLED: "cx-chip--cancelled",
  EXPIRED: "cx-chip--expired",
};

function contractTotalCents(contract: LocalContractWithLines): number {
  const items = contract.lines.reduce(
    (sum, line) => sum + line.currentPriceCents * line.quantity,
    0,
  );
  return items + contract.deliveryPriceCents;
}

function apiPath(locale: string, action: string): string {
  return withLocale(`${PORTAL_BASE_PATH}/api/${action}`, locale);
}

interface FormField {
  name: string;
  value: string;
}

function postForm(
  locale: string,
  action: string,
  fields: FormField[],
  buttonLabel: string,
  buttonClass = "cx-btn cx-btn--ghost cx-btn--small",
): string {
  const hidden = fields
    .map(
      (f) =>
        `<input type="hidden" name="${escapeHtml(f.name)}" value="${escapeHtml(f.value)}">`,
    )
    .join("");
  return `<form method="post" action="${apiPath(locale, action)}">${hidden}<button type="submit" class="${buttonClass}">${escapeHtml(buttonLabel)}</button></form>`;
}

function itemsHtml(contract: LocalContractWithLines, locale: string): string {
  return contract.lines
    .map((line) => {
      const thumb = line.imageUrl
        ? `<img class="cx-thumb" src="${escapeHtml(line.imageUrl)}" alt="" loading="lazy">`
        : `<div class="cx-thumb cx-thumb--placeholder">C</div>`;
      const badges: string[] = [];
      if (line.isGift) badges.push(t(locale, "portal.item.gift"));
      if (line.isOneTimeAddon) badges.push(t(locale, "portal.item.one_time"));
      const meta = [
        line.variantTitle && line.variantTitle !== "Default Title"
          ? line.variantTitle
          : null,
        t(locale, "portal.item.quantity", { quantity: line.quantity }),
        ...badges,
      ]
        .filter(Boolean)
        .join(" · ");
      const price = line.isGift
        ? escapeHtml(t(locale, "portal.item.free"))
        : escapeHtml(
            formatMoney(
              line.currentPriceCents * line.quantity,
              contract.currencyCode,
              locale,
            ),
          );
      return `<div class="cx-item">${thumb}<div class="cx-item__body"><p class="cx-item__title">${escapeHtml(line.title)}</p><p class="cx-item__meta">${escapeHtml(meta)}</p></div><span class="cx-price">${price}</span></div>`;
    })
    .join("");
}

function contractCardHtml(params: {
  contract: LocalContractWithLines;
  locale: string;
  tz: string;
  csrf: string;
  contextualPrompts: boolean;
  /** Prompt only when predicted-empty is this many days past the next bill. */
  promptBufferDays: number;
  /** Weeks the contextual one-tap delay pushes the next order back. */
  promptDelayWeeks: number;
}): string {
  const { contract, locale, tz, csrf } = params;
  // Server-side double-submit dedupe: one-tap forms carry the cycle date they
  // target, so a duplicate POST for an already-advanced cycle is a no-op.
  const expectedNext = contract.nextBillingDate?.toISOString() ?? "";
  const manageHref = withLocale(
    `${PORTAL_BASE_PATH}/subscription/${contract.id}`,
    locale,
  );
  const baseFields: FormField[] = [
    { name: "contractId", value: contract.id },
    { name: "_csrf", value: csrf },
    { name: "return_to", value: "/" },
  ];

  const statusLabel = t(
    locale,
    `portal.status.${contract.status.toLowerCase()}`,
  );

  let scheduleHtml = "";
  if (contract.status === "ACTIVE" && contract.nextBillingDate) {
    scheduleHtml = `<div><span class="cx-label">${escapeHtml(t(locale, "portal.index.next_order"))}</span><strong>${escapeHtml(formatShopDate(contract.nextBillingDate, tz, locale))}</strong></div>`;
  } else if (contract.status === "PAUSED" && contract.resumeAt) {
    scheduleHtml = `<div><span class="cx-label">${escapeHtml(t(locale, "portal.index.resumes"))}</span><strong>${escapeHtml(formatShopDate(contract.resumeAt, tz, locale))}</strong></div>`;
  } else {
    scheduleHtml = `<div><span class="cx-label">${escapeHtml(t(locale, "portal.index.status_label"))}</span><strong>${escapeHtml(statusLabel)}</strong></div>`;
  }

  let promptHtml = "";
  if (
    params.contextualPrompts &&
    contract.status === "ACTIVE" &&
    contract.nextBillingDate &&
    contract.predictedEmptyDate &&
    contract.predictedEmptyDate.getTime() >
      contract.nextBillingDate.getTime() +
        params.promptBufferDays * 24 * 3600_000
  ) {
    promptHtml = `<div class="cx-banner"><p>${escapeHtml(t(locale, "portal.index.contextual_prompt"))}</p>${postForm(
      locale,
      "delay",
      [
        ...baseFields,
        { name: "weeks", value: String(params.promptDelayWeeks) },
        { name: "expected_next", value: expectedNext },
      ],
      t(locale, "portal.index.contextual_prompt_cta"),
    )}</div>`;
  }

  const actions: string[] = [];
  if (contract.status === "ACTIVE") {
    actions.push(
      postForm(
        locale,
        "skip",
        [...baseFields, { name: "expected_next", value: expectedNext }],
        t(locale, "portal.actions.skip"),
      ),
    );
    actions.push(
      postForm(
        locale,
        "delay",
        [
          ...baseFields,
          { name: "weeks", value: "1" },
          { name: "expected_next", value: expectedNext },
        ],
        t(locale, "portal.actions.delay_1w"),
      ),
    );
  }
  if (contract.status === "PAUSED") {
    actions.push(
      postForm(
        locale,
        "resume",
        baseFields,
        t(locale, "portal.actions.resume"),
        "cx-btn cx-btn--small",
      ),
    );
  }
  if (contract.status === "CANCELLED") {
    // A cancelled subscription must never be a dead end: one tap restarts it
    // through the win-back reactivation service (no discount unless a
    // win-back grant already exists).
    actions.push(
      postForm(
        locale,
        "reactivate",
        baseFields,
        t(locale, "portal.actions.restart"),
        "cx-btn cx-btn--small",
      ),
    );
  }
  actions.push(
    `<a class="cx-btn cx-btn--quiet cx-btn--small" href="${manageHref}">${escapeHtml(t(locale, "portal.actions.manage"))}</a>`,
  );

  const frequency = t(locale, "portal.index.every_weeks", {
    weeks: contract.intervalWeeks,
  });
  const total = formatMoney(
    contractTotalCents(contract),
    contract.currencyCode,
    locale,
  );

  return `<section class="cx-card">
  <div class="cx-row cx-row--between" style="margin-bottom:14px">
    <p class="cx-muted cx-small" style="margin:0">${escapeHtml(frequency)}</p>
    <span class="cx-chip ${STATUS_CHIP_CLASS[contract.status]}">${escapeHtml(statusLabel)}</span>
  </div>
  ${itemsHtml(contract, locale)}
  <hr class="cx-divider">
  <div class="cx-row cx-row--between cx-row--wrap">
    ${scheduleHtml}
    <div><span class="cx-label">${escapeHtml(t(locale, "portal.index.order_total"))}</span><strong class="cx-price">${escapeHtml(total)}</strong></div>
  </div>
  ${promptHtml}
  <div class="cx-actions">${actions.join("")}</div>
</section>`;
}

function rewardsStripHtml(params: {
  locale: string;
  daysSubscribed: number;
  maxOrders: number;
  milestoneCycle: number;
  rewardsUnlockDay: number;
  rewardsUnlocked: boolean;
  milestoneReached: boolean;
}): string {
  const {
    locale,
    daysSubscribed,
    maxOrders,
    milestoneCycle,
    rewardsUnlockDay,
    rewardsUnlocked,
    milestoneReached,
  } = params;

  const milestonePct = Math.min(
    100,
    Math.round((maxOrders / milestoneCycle) * 100),
  );
  // Concrete next-perk copy: "N more order(s) until your milestone gift".
  // Guards: milestoneReached uses >= so the cell flips to "earned" exactly AT
  // the milestone order (and remaining is only rendered when >= 1).
  const ordersRemaining = Math.max(1, milestoneCycle - maxOrders);
  const milestoneCell = milestoneReached
    ? `<div class="cx-rewards__num">&#10003;</div><div class="cx-muted cx-small">${escapeHtml(t(locale, "portal.rewards.milestone_reached", { orders: milestoneCycle }))}</div>`
    : `<div class="cx-rewards__num">${maxOrders}&thinsp;/&thinsp;${milestoneCycle}</div><div class="cx-muted cx-small">${escapeHtml(t(locale, "portal.rewards.milestone_next", { count: ordersRemaining }))}</div><div class="cx-progress"><span style="width:${milestonePct}%"></span></div>`;

  const unlockPct = Math.min(
    100,
    Math.round((daysSubscribed / rewardsUnlockDay) * 100),
  );
  // rewardsUnlocked uses >= so day 90 exactly reads as unlocked, never "0 more days".
  const daysRemaining = Math.max(1, rewardsUnlockDay - daysSubscribed);
  const rewardsCell = rewardsUnlocked
    ? `<div class="cx-rewards__num">&#10003;</div><div class="cx-muted cx-small">${escapeHtml(t(locale, "portal.rewards.unlocked"))}</div>`
    : `<div class="cx-rewards__num">${daysSubscribed}&thinsp;/&thinsp;${rewardsUnlockDay}</div><div class="cx-muted cx-small">${escapeHtml(t(locale, "portal.rewards.unlock_next", { days: daysRemaining }))}</div><div class="cx-progress"><span style="width:${unlockPct}%"></span></div>`;

  return `<section class="cx-rewards">
  <h2>${escapeHtml(t(locale, "portal.rewards.title"))}</h2>
  <div class="cx-rewards__grid">
    <div class="cx-rewards__cell"><div class="cx-rewards__num">${daysSubscribed}</div><div class="cx-muted cx-small">${escapeHtml(t(locale, "portal.rewards.days_subscribed"))}</div></div>
    <div class="cx-rewards__cell">${milestoneCell}</div>
    <div class="cx-rewards__cell">${rewardsCell}</div>
  </div>
</section>`;
}

async function buildToast(
  request: Request,
  locale: string,
  session: PortalSessionContext,
  contractIds: Set<string>,
): Promise<PortalToast | null> {
  const resolved = resolveToast(request, locale);
  if (!resolved) return null;

  // "Order skipped" carries a one-tap undo for the affected contract.
  if (resolved.key === "skipped") {
    const cid = new URL(request.url).searchParams.get("cid");
    if (cid && contractIds.has(cid)) {
      resolved.toast.html = `<form method="post" action="${apiPath(locale, "unskip")}"><input type="hidden" name="contractId" value="${escapeHtml(cid)}"><input type="hidden" name="_csrf" value="${escapeHtml(session.csrfToken)}"><input type="hidden" name="return_to" value="/"><button type="submit">${escapeHtml(t(locale, "portal.toast.undo"))}</button></form>`;
    }
  }
  return resolved.toast;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { liquid, session } = await authenticate.public.appProxy(request);
  if (!session) throw new Response("Unauthorized", { status: 401 });
  const locale = localeFromRequest(request);
  const shop = await requireShop(session.shop);

  // ── Magic-link LOGIN hand-off ──────────────────────────────────────────────
  // ?handoff= is a single-use ~60s code minted by the magic LOGIN executor.
  // Exchange it server-side for the HttpOnly cx_portal cookie, then redirect
  // to a clean URL either way so the code never lingers in the address bar.
  // The long-lived session token itself never appears in any URL.
  const handoffCode = new URL(request.url).searchParams.get("handoff");
  if (handoffCode) {
    const cleanUrl = withLocale(`${PORTAL_BASE_PATH}/`, locale);
    const handoff = await exchangeLoginHandoff(handoffCode, shop.id);
    throw redirect(
      cleanUrl,
      handoff ? { headers: { "Set-Cookie": handoff.cookie } } : undefined,
    );
  }

  const portalSession = await getPortalSession(request);
  if (!portalSession) {
    throw redirect(withLocale(`${PORTAL_BASE_PATH}/login`, locale));
  }
  if (portalSession.shopId !== shop.id) {
    throw redirect(withLocale(`${PORTAL_BASE_PATH}/login`, locale));
  }

  // Launch gate: while in setup mode the portal is closed to the public —
  // only admin preview sessions pass through.
  if (!portalSession.isPreview && (await isSetupMode(shop.id))) {
    return liquid(setupGatePage(locale), {
      headers: { "X-Robots-Tag": "noindex" },
    });
  }

  const [contracts, portalSettings, lifecycle] = await Promise.all([
    prisma.subscriptionContract.findMany({
      // OURS_ONLY: a customer who also subscribes through the store's other
      // subscription app must never see (let alone manage) that contract here.
      where: {
        shopId: shop.id,
        customerId: portalSession.customerId,
        ...OURS_ONLY,
      },
      include: { lines: true },
      orderBy: { createdAt: "desc" },
    }),
    getSetting(shop.id, "portal"),
    getSetting(shop.id, "lifecycle"),
  ]);
  contracts.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);

  const toast = await buildToast(
    request,
    locale,
    portalSession,
    new Set(contracts.map((c) => c.id)),
  );

  let body = "";
  if (contracts.length === 0) {
    body = `<div class="cx-card"><p style="margin:0 0 8px">${escapeHtml(t(locale, "portal.index.empty_title"))}</p><p class="cx-muted cx-small" style="margin:0">${escapeHtml(t(locale, "portal.index.empty_body"))}</p></div>`;
  } else {
    // ── Rewards strip: days subscribed, milestone + rewards unlock ─────────
    const startTimes = contracts.map((c) =>
      (c.firstChargeAt ?? c.createdAt).getTime(),
    );
    const daysSubscribed = Math.max(
      0,
      Math.floor((Date.now() - Math.min(...startTimes)) / 86_400_000),
    );
    const maxOrders = Math.max(...contracts.map((c) => c.ordersCount), 0);

    const [rewardsEvent, milestoneGrant] = await Promise.all([
      prisma.subscriberEvent.findFirst({
        where: {
          shopId: shop.id,
          customerId: portalSession.customerId,
          type: "lifecycle.rewards_unlocked",
        },
        select: { id: true },
      }),
      prisma.giftGrant.findFirst({
        where: {
          contractId: { in: contracts.map((c) => c.id) },
          status: { in: ["ADDED", "SHIPPED"] },
          rule: {
            is: {
              trigger: "ORDER_INDEX",
              orderIndex: lifecycle.milestoneGiftCycle,
            },
          },
        },
        select: { id: true },
      }),
    ]);

    body += rewardsStripHtml({
      locale,
      daysSubscribed,
      maxOrders,
      milestoneCycle: lifecycle.milestoneGiftCycle,
      rewardsUnlockDay: lifecycle.rewardsUnlockDay,
      rewardsUnlocked:
        rewardsEvent !== null || daysSubscribed >= lifecycle.rewardsUnlockDay,
      milestoneReached:
        milestoneGrant !== null || maxOrders >= lifecycle.milestoneGiftCycle,
    });

    for (const contract of contracts) {
      body += contractCardHtml({
        contract,
        locale,
        tz: shop.ianaTimezone,
        csrf: portalSession.csrfToken,
        contextualPrompts: portalSettings.contextualPrompts,
        promptBufferDays: portalSettings.contextualPromptBufferDays,
        promptDelayWeeks: portalSettings.contextualPromptDelayWeeks,
      });
    }
  }

  return liquid(
    portalPage({
      locale,
      title: t(locale, "portal.index.title"),
      body,
      activeNav: "subscriptions",
      toast,
      isPreview: portalSession.isPreview,
    }),
  );
};
