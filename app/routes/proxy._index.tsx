import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import type { ContractStatus } from "@prisma/client";
import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import { requireShop } from "~/lib/shop/install.server";
import { getSetting } from "~/lib/settings/settings.server";
import { t } from "~/lib/i18n/i18n.server";
import { formatMoney } from "~/lib/money";
import { formatShopDate, shopDayStartUtc } from "~/lib/dates.server";
import { isSetupMode } from "~/lib/launch/launch.server";
import { logEvent } from "~/lib/events/log.server";
import {
  escapeHtml,
  localeFromRequest,
  portalPage,
  resolveToast,
  closedPortalPage,
  withLocale,
  type PortalToast,
} from "~/lib/portal/layout.server";
import {
  PORTAL_BASE_PATH,
  exchangeLoginHandoff,
  getPortalSession,
  loginRedirectUrl,
  type PortalSessionContext,
} from "~/lib/portal/session.server";
import type { LocalContractWithLines } from "~/lib/contracts/shared.server";
import { contractFrequency, formatFrequency } from "~/lib/frequency";
import { OURS_ONLY } from "~/lib/ownership/ownership.server";
import { getLockRules, lockStateFor } from "~/lib/contracts/lock.server";
import {
  memberSavingsCents,
  milestoneRemaining,
} from "~/lib/portal/growth.server";

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
  ACTIVE: "cxs-chip--active",
  PAUSED: "cxs-chip--paused",
  FAILED: "cxs-chip--failed",
  CANCELLED: "cxs-chip--cancelled",
  EXPIRED: "cxs-chip--expired",
};

function contractTotalCents(contract: LocalContractWithLines): number {
  const items = contract.lines.reduce(
    (sum, line) => sum + line.currentPriceCents * line.quantity,
    0,
  );
  return items + contract.deliveryPriceCents;
}

function apiPath(
  locale: string,
  action: string,
  preview: string | null,
): string {
  return withLocale(`${PORTAL_BASE_PATH}/api/${action}`, locale, preview);
}

interface FormField {
  name: string;
  value: string;
}

function postForm(
  actionUrl: string,
  fields: FormField[],
  buttonLabel: string,
  buttonClass = "cxs-btn cxs-btn--ghost cxs-btn--small",
): string {
  const hidden = fields
    .map(
      (f) =>
        `<input type="hidden" name="${escapeHtml(f.name)}" value="${escapeHtml(f.value)}">`,
    )
    .join("");
  return `<form method="post" action="${escapeHtml(actionUrl)}">${hidden}<button type="submit" class="${buttonClass}">${escapeHtml(buttonLabel)}</button></form>`;
}

function itemsHtml(contract: LocalContractWithLines, locale: string): string {
  return contract.lines
    .map((line) => {
      const thumb = line.imageUrl
        ? `<img class="cxs-thumb" src="${escapeHtml(line.imageUrl)}" alt="" loading="lazy">`
        : `<div class="cxs-thumb cxs-thumb--placeholder">C</div>`;
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
      return `<div class="cxs-item">${thumb}<div class="cxs-item__body"><p class="cxs-item__title">${escapeHtml(line.title)}</p><p class="cxs-item__meta">${escapeHtml(meta)}</p></div><span class="cxs-price">${price}</span></div>`;
    })
    .join("");
}

function contractCardHtml(params: {
  contract: LocalContractWithLines;
  locale: string;
  tz: string;
  csrf: string;
  /** Preview session's raw cx_pp token — carried on every link/form URL. */
  preview: string | null;
  contextualPrompts: boolean;
  /** Prompt only when predicted-empty is this many days past the next bill. */
  promptBufferDays: number;
  /** Weeks the contextual one-tap delay pushes the next order back. */
  promptDelayWeeks: number;
  /** Plan lock window — hides the one-tap skip/delay while it runs. */
  locked: boolean;
  /** portalGrowth.homeValueCard — value-first card (v1.20.0). */
  valueCard: boolean;
  /** Money-true captured member savings for this contract (0 = hide tile). */
  savedCents: number;
  /** Deliveries to the milestone gift; null = off/reached. */
  milestoneAway: number | null;
}): string {
  const { contract, locale, tz, csrf, preview } = params;
  const api = (action: string) => apiPath(locale, action, preview);
  // Server-side double-submit dedupe: one-tap forms carry the cycle date they
  // target, so a duplicate POST for an already-advanced cycle is a no-op.
  const expectedNext = contract.nextBillingDate?.toISOString() ?? "";
  const manageHref = withLocale(
    `${PORTAL_BASE_PATH}/subscription/${contract.id}`,
    locale,
    preview,
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
    scheduleHtml = `<div><span class="cxs-label">${escapeHtml(t(locale, "portal.index.next_order"))}</span><strong>${escapeHtml(formatShopDate(contract.nextBillingDate, tz, locale))}</strong></div>`;
  } else if (contract.status === "PAUSED" && contract.resumeAt) {
    scheduleHtml = `<div><span class="cxs-label">${escapeHtml(t(locale, "portal.index.resumes"))}</span><strong>${escapeHtml(formatShopDate(contract.resumeAt, tz, locale))}</strong></div>`;
  } else {
    scheduleHtml = `<div><span class="cxs-label">${escapeHtml(t(locale, "portal.index.status_label"))}</span><strong>${escapeHtml(statusLabel)}</strong></div>`;
  }

  let promptHtml = "";
  if (
    params.contextualPrompts &&
    !params.locked &&
    contract.status === "ACTIVE" &&
    contract.nextBillingDate &&
    contract.predictedEmptyDate &&
    contract.predictedEmptyDate.getTime() >
      contract.nextBillingDate.getTime() +
        params.promptBufferDays * 24 * 3600_000
  ) {
    promptHtml = `<div class="cxs-banner"><p>${escapeHtml(t(locale, "portal.index.contextual_prompt"))}</p>${postForm(
      api("delay"),
      [
        ...baseFields,
        { name: "weeks", value: String(params.promptDelayWeeks) },
        { name: "expected_next", value: expectedNext },
      ],
      t(locale, "portal.index.contextual_prompt_cta"),
    )}</div>`;
  }

  // Value-first card (portalGrowth.homeValueCard, v1.20.0): the list card
  // leads with what the membership has EARNED — money-true captured savings
  // (endowment) and milestone proximity (goal gradient) — and its actions
  // are add-products + manage. One-tap skip/delay disappear from here (a
  // button on every visit is an advertisement for skipping — availability
  // priming), but both remain two calm taps away on the Manage page: the
  // salience changes, the capability never does.
  const valueCard = params.valueCard && contract.status === "ACTIVE";
  let valueHtml = "";
  if (valueCard) {
    const cells: string[] = [];
    if (params.savedCents > 0) {
      cells.push(
        `<div class="cxs-rewards__cell"><div class="cxs-rewards__num">${escapeHtml(formatMoney(params.savedCents, contract.currencyCode, locale))}</div><div class="cxs-muted cxs-small">${escapeHtml(t(locale, "portal.value.saved"))}</div></div>`,
      );
    }
    cells.push(
      `<div class="cxs-rewards__cell"><div class="cxs-rewards__num">${escapeHtml(formatShopDate(contract.firstChargeAt ?? contract.createdAt, tz, locale))}</div><div class="cxs-muted cxs-small">${escapeHtml(t(locale, "portal.value.member_since"))}</div></div>`,
    );
    if (params.milestoneAway != null) {
      cells.push(
        `<div class="cxs-rewards__cell"><div class="cxs-rewards__num">${params.milestoneAway}</div><div class="cxs-muted cxs-small">${escapeHtml(t(locale, "portal.value.milestone_away"))}</div></div>`,
      );
    }
    valueHtml = `<div class="cxs-rewards__grid" style="margin-top:12px">${cells.join("")}</div>`;
  }

  const actions: string[] = [];
  // Lock window: the one-tap skip/delay are hidden while it runs (the api
  // action refuses them server-side regardless) — the manage link below
  // stays, and the detail page explains the window with its unlock date.
  if (contract.status === "ACTIVE" && valueCard) {
    actions.push(
      `<a class="cxs-btn cxs-btn--small" href="${manageHref}#cxs-add">${escapeHtml(t(locale, "portal.actions.add_products"))}</a>`,
    );
  } else if (contract.status === "ACTIVE" && !params.locked) {
    actions.push(
      postForm(
        api("skip"),
        [...baseFields, { name: "expected_next", value: expectedNext }],
        t(locale, "portal.actions.skip"),
      ),
    );
    actions.push(
      postForm(
        api("delay"),
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
        api("resume"),
        baseFields,
        t(locale, "portal.actions.resume"),
        "cxs-btn cxs-btn--small",
      ),
    );
  }
  if (contract.status === "CANCELLED") {
    // A cancelled subscription must never be a dead end: one tap restarts it
    // through the win-back reactivation service (no discount unless a
    // win-back grant already exists).
    actions.push(
      postForm(
        api("reactivate"),
        baseFields,
        t(locale, "portal.actions.restart"),
        "cxs-btn cxs-btn--small",
      ),
    );
  }
  actions.push(
    `<a class="cxs-btn cxs-btn--quiet cxs-btn--small" href="${manageHref}">${escapeHtml(t(locale, "portal.actions.manage"))}</a>`,
  );

  // contractFrequency: exact unit/count mirror when present, else the
  // intervalWeeks approximation as a WEEK cadence.
  const frequency = t(locale, "portal.index.every_weeks", {
    frequency: formatFrequency(
      (key, vars) => t(locale, key, vars),
      "every",
      contractFrequency(contract),
    ),
  });
  const total = formatMoney(
    contractTotalCents(contract),
    contract.currencyCode,
    locale,
  );

  return `<section class="cxs-card">
  <div class="cxs-row cxs-row--between" style="margin-bottom:14px">
    <p class="cxs-muted cxs-small" style="margin:0">${escapeHtml(frequency)}</p>
    <span class="cxs-chip ${STATUS_CHIP_CLASS[contract.status]}">${escapeHtml(statusLabel)}</span>
  </div>
  ${itemsHtml(contract, locale)}
  <hr class="cxs-divider">
  <div class="cxs-row cxs-row--between cxs-row--wrap">
    ${scheduleHtml}
    <div><span class="cxs-label">${escapeHtml(t(locale, "portal.index.order_total"))}</span><strong class="cxs-price">${escapeHtml(total)}</strong></div>
  </div>
  ${valueHtml}
  ${promptHtml}
  <div class="cxs-actions">${actions.join("")}</div>
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
    ? `<div class="cxs-rewards__num">&#10003;</div><div class="cxs-muted cxs-small">${escapeHtml(t(locale, "portal.rewards.milestone_reached", { orders: milestoneCycle }))}</div>`
    : `<div class="cxs-rewards__num">${maxOrders}&thinsp;/&thinsp;${milestoneCycle}</div><div class="cxs-muted cxs-small">${escapeHtml(t(locale, "portal.rewards.milestone_next", { count: ordersRemaining }))}</div><div class="cxs-progress"><span style="width:${milestonePct}%"></span></div>`;

  const unlockPct = Math.min(
    100,
    Math.round((daysSubscribed / rewardsUnlockDay) * 100),
  );
  // rewardsUnlocked uses >= so day 90 exactly reads as unlocked, never "0 more days".
  const daysRemaining = Math.max(1, rewardsUnlockDay - daysSubscribed);
  const rewardsCell = rewardsUnlocked
    ? `<div class="cxs-rewards__num">&#10003;</div><div class="cxs-muted cxs-small">${escapeHtml(t(locale, "portal.rewards.unlocked"))}</div>`
    : `<div class="cxs-rewards__num">${daysSubscribed}&thinsp;/&thinsp;${rewardsUnlockDay}</div><div class="cxs-muted cxs-small">${escapeHtml(t(locale, "portal.rewards.unlock_next", { days: daysRemaining }))}</div><div class="cxs-progress"><span style="width:${unlockPct}%"></span></div>`;

  return `<section class="cxs-rewards">
  <h2>${escapeHtml(t(locale, "portal.rewards.title"))}</h2>
  <div class="cxs-rewards__grid">
    <div class="cxs-rewards__cell"><div class="cxs-rewards__num">${daysSubscribed}</div><div class="cxs-muted cxs-small">${escapeHtml(t(locale, "portal.rewards.days_subscribed"))}</div></div>
    <div class="cxs-rewards__cell">${milestoneCell}</div>
    <div class="cxs-rewards__cell">${rewardsCell}</div>
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
      resolved.toast.html = `<form method="post" action="${apiPath(locale, "unskip", session.previewToken)}"><input type="hidden" name="contractId" value="${escapeHtml(cid)}"><input type="hidden" name="_csrf" value="${escapeHtml(session.csrfToken)}"><input type="hidden" name="return_to" value="/"><button type="submit">${escapeHtml(t(locale, "portal.toast.undo"))}</button></form>`;
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
  // to a clean URL so the code never lingers in the address bar. The
  // long-lived session token itself never appears in any URL. A ?cx_pp=
  // preview token riding alongside (pre-1.7.0 preview links) survives the
  // clean-up — on a live store the proxy strips the Set-Cookie, so that
  // token is the only identity that reaches the next request. A failed
  // exchange without one lands on the login page with a named reason
  // (?signin=expired) instead of silently gating.
  const requestUrl = new URL(request.url);
  const handoffCode = requestUrl.searchParams.get("handoff");
  if (handoffCode) {
    const previewToken = requestUrl.searchParams.get("cx_pp");
    const cleanUrl = withLocale(`${PORTAL_BASE_PATH}/`, locale, previewToken);
    const handoff = await exchangeLoginHandoff(handoffCode, shop.id);
    if (!handoff && !previewToken) {
      throw redirect(
        withLocale(`${PORTAL_BASE_PATH}/login?signin=expired`, locale),
      );
    }
    throw redirect(
      cleanUrl,
      handoff ? { headers: { "Set-Cookie": handoff.cookie } } : undefined,
    );
  }

  // Sessionless (or wrong-shop) → login via loginRedirectUrl, which carries
  // the request's ?cx_pp= along. The portal home is the EXACT URL the admin
  // preview mints, so an expired preview token lands here first — dropping
  // it would show the generic setup gate instead of "this preview link has
  // expired" (the dead-end this release removes).
  const portalSession = await getPortalSession(request);
  if (!portalSession) {
    throw redirect(loginRedirectUrl(request));
  }
  if (portalSession.shopId !== shop.id) {
    throw redirect(loginRedirectUrl(request));
  }

  // Launch gate: while in setup mode the portal is closed to the public —
  // only admin preview sessions pass through. closedPortalPage names an
  // expired ?cx_pp= instead of gating it silently.
  if (!portalSession.isPreview && (await isSetupMode(shop.id))) {
    return liquid(closedPortalPage(request, locale), {
      headers: { "X-Robots-Tag": "noindex" },
    });
  }

  // portal.visit — the portal's own reach datum (actions were logged, plain
  // visits were not, so "how many subscribers even open the portal" was
  // unanswerable). Once per session per shop-day; server-side only, no PII
  // beyond the session's own identity; no contractId so contract timelines
  // stay action-only. Admin previews are not customers. Contained: a failed
  // throttle read must never break the page.
  if (!portalSession.isPreview) {
    try {
      const dayStart = shopDayStartUtc(new Date(), shop.ianaTimezone);
      const already = await prisma.subscriberEvent.findFirst({
        where: {
          shopId: shop.id,
          type: "portal.visit",
          createdAt: { gte: dayStart },
          payload: { path: ["sessionId"], equals: portalSession.id },
        },
        select: { id: true },
      });
      if (!already) {
        await logEvent({
          shopId: shop.id,
          customerId: portalSession.customerId,
          email: portalSession.email,
          type: "portal.visit",
          source: "CUSTOMER_PORTAL",
          actor: "customer",
          payload: { sessionId: portalSession.id },
        });
      }
    } catch (err) {
      console.error("[portal] visit event failed", err);
    }
  }

  const [contracts, portalSettings, lifecycle, growth, lockRules] =
    await Promise.all([
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
    getSetting(shop.id, "portalGrowth"),
    // Plan lock window rules, fetched once and applied per contract card.
    getLockRules(shop.id),
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
    body = `<div class="cxs-card"><p style="margin:0 0 8px">${escapeHtml(t(locale, "portal.index.empty_title"))}</p><p class="cxs-muted cxs-small" style="margin:0">${escapeHtml(t(locale, "portal.index.empty_body"))}</p></div>`;
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

    // Value-first cards (portalGrowth.homeValueCard, v1.20.0): the card
    // leads with captured member savings + milestone proximity instead of
    // one-tap skip/delay. Savings are money-true captured discounts — one
    // batched query for the whole page, contained (a value tile is never
    // worth failing the portal home for).
    let savingsByContract = new Map<string, number>();
    if (growth.homeValueCard) {
      try {
        savingsByContract = await memberSavingsCents(contracts.map((c) => c.id));
      } catch (err) {
        console.error("[portal] member savings scan failed", err);
      }
    }

    for (const contract of contracts) {
      body += contractCardHtml({
        contract,
        locale,
        tz: shop.ianaTimezone,
        csrf: portalSession.csrfToken,
        preview: portalSession.previewToken,
        contextualPrompts: portalSettings.contextualPrompts,
        promptBufferDays: portalSettings.contextualPromptBufferDays,
        promptDelayWeeks: portalSettings.contextualPromptDelayWeeks,
        locked: lockStateFor(lockRules, contract, shop.ianaTimezone).locked,
        valueCard: growth.homeValueCard,
        savedCents: savingsByContract.get(contract.id) ?? 0,
        milestoneAway: milestoneRemaining(
          contract.ordersCount,
          lifecycle.milestoneGiftCycle,
        ),
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
      previewToken: portalSession.previewToken,
    }),
  );
};
