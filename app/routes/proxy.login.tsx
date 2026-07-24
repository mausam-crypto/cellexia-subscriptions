import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { z } from "zod";
import { t } from "~/lib/i18n/i18n.server";
import { authenticate } from "~/shopify.server";
import { requireShop } from "~/lib/shop/install.server";
import { isSetupMode } from "~/lib/launch/launch.server";
import {
  escapeHtml,
  localeFromRequest,
  portalPage,
  setupGatePage,
  withLocale,
} from "~/lib/portal/layout.server";
import {
  PORTAL_BASE_PATH,
  clearPendingLoginCookie,
  createPendingLoginCookie,
  getPortalSession,
  readPendingLogin,
} from "~/lib/portal/session.server";
import { requestOtp, verifyOtp } from "~/lib/portal/otp.server";

/**
 * Portal login: email → 6-digit OTP → session cookie.
 *
 * The email between the two steps travels in a short-lived signed cookie
 * (never a URL parameter). A honeypot field silently swallows bots, and every
 * failure path shows the same neutral copy so the form cannot be used to
 * probe which emails have subscriptions.
 */

const emailSchema = z.string().trim().toLowerCase().email().max(320);

function loginPath(locale: string, step?: string): string {
  const path = `${PORTAL_BASE_PATH}/login${step ? `?step=${step}` : ""}`;
  return withLocale(path, locale);
}

function emailFormHtml(locale: string, errorKey?: string): string {
  const error = errorKey
    ? `<p class="cx-error" role="alert">${escapeHtml(t(locale, errorKey))}</p>`
    : "";
  return `
<div class="cx-card">
  ${error}
  <p class="cx-muted" style="margin:0 0 18px">${escapeHtml(t(locale, "portal.login.intro"))}</p>
  <form method="post" action="${loginPath(locale)}">
    <input type="hidden" name="_step" value="request">
    <div class="cx-hp" aria-hidden="true">
      <label>Website<input type="text" name="website" tabindex="-1" autocomplete="off"></label>
    </div>
    <div class="cx-field">
      <label class="cx-label" for="cx-email">${escapeHtml(t(locale, "portal.login.email_label"))}</label>
      <input class="cx-input" id="cx-email" type="email" name="email" required autocomplete="email" inputmode="email" maxlength="320">
    </div>
    <button class="cx-btn cx-btn--full" type="submit">${escapeHtml(t(locale, "portal.login.send_code"))}</button>
  </form>
</div>
<p class="cx-small cx-muted" style="text-align:center">${escapeHtml(t(locale, "portal.login.help"))}</p>`;
}

function codeFormHtml(
  locale: string,
  email: string,
  ttlMinutes: number,
  errorKey?: string,
): string {
  const error = errorKey
    ? `<p class="cx-error" role="alert">${escapeHtml(t(locale, errorKey))}</p>`
    : "";
  return `
<div class="cx-card">
  ${error}
  <p style="margin:0 0 6px">${escapeHtml(t(locale, "portal.login.code_sent_to", { email }))}</p>
  <p class="cx-muted cx-small" style="margin:0 0 18px">${escapeHtml(t(locale, "portal.login.code_sent", { minutes: ttlMinutes }))}</p>
  <form method="post" action="${loginPath(locale)}">
    <input type="hidden" name="_step" value="verify">
    <div class="cx-field">
      <label class="cx-label" for="cx-code">${escapeHtml(t(locale, "portal.login.code_label"))}</label>
      <input class="cx-input" id="cx-code" type="text" name="code" required inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" style="letter-spacing:0.35em;font-size:22px;text-align:center" autofocus>
    </div>
    <button class="cx-btn cx-btn--full" type="submit">${escapeHtml(t(locale, "portal.login.verify"))}</button>
  </form>
  <p class="cx-small" style="margin:16px 0 0;text-align:center"><a href="${loginPath(locale)}" style="color:var(--cx-accent)">${escapeHtml(t(locale, "portal.login.resend"))}</a></p>
</div>`;
}

function page(locale: string, body: string) {
  return portalPage({
    locale,
    title: t(locale, "portal.login.title"),
    body,
    hideNav: true,
  });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { liquid, session: proxySession } = await authenticate.public.appProxy(request);
  if (!proxySession) throw new Response("Unauthorized", { status: 401 });
  const locale = localeFromRequest(request);

  // Already signed in → straight to the subscriptions list. (Preview sessions
  // land on the home page, which bypasses the launch gate below.)
  const session = await getPortalSession(request);
  if (session) throw redirect(withLocale(`${PORTAL_BASE_PATH}/`, locale));

  // Launch gate: while in setup mode the portal is closed to the public.
  const shop = await requireShop(proxySession.shop);
  if (await isSetupMode(shop.id)) {
    return liquid(setupGatePage(locale), {
      headers: { "X-Robots-Tag": "noindex" },
    });
  }

  const step = new URL(request.url).searchParams.get("step");
  if (step === "code") {
    const pending = readPendingLogin(request);
    if (pending) {
      return liquid(
        page(locale, codeFormHtml(locale, pending.email, pending.ttlMinutes)),
      );
    }
  }
  return liquid(page(locale, emailFormHtml(locale)));
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { liquid, session: proxySession } = await authenticate.public.appProxy(request);
  if (!proxySession) throw new Response("Unauthorized", { status: 401 });
  const locale = localeFromRequest(request);

  // Launch gate: no OTP requests (and no OTP emails) from a closed portal.
  const shop = await requireShop(proxySession.shop);
  if (await isSetupMode(shop.id)) {
    return liquid(setupGatePage(locale), {
      headers: { "X-Robots-Tag": "noindex" },
    });
  }

  const form = await request.formData();
  const step = String(form.get("_step") ?? "");

  if (step === "request") {
    const honeypot = String(form.get("website") ?? "");
    const parsed = emailSchema.safeParse(String(form.get("email") ?? ""));
    if (!parsed.success) {
      return liquid(
        page(locale, emailFormHtml(locale, "portal.login.invalid_email")),
        400,
      );
    }
    const email = parsed.data;

    // Bots that fill the honeypot get the identical flow — minus the email.
    let ttlMinutes = 10;
    if (!honeypot) {
      const result = await requestOtp(email, locale);
      ttlMinutes = result.ttlMinutes;
    }

    return redirect(loginPath(locale, "code"), {
      headers: { "Set-Cookie": createPendingLoginCookie(email, ttlMinutes) },
    });
  }

  if (step === "verify") {
    const pending = readPendingLogin(request);
    if (!pending) throw redirect(loginPath(locale));

    const code = String(form.get("code") ?? "");
    const result = await verifyOtp(pending.email, code);
    if (!result.ok) {
      return liquid(
        page(
          locale,
          codeFormHtml(
            locale,
            pending.email,
            pending.ttlMinutes,
            "portal.login.invalid_code",
          ),
        ),
        400,
      );
    }

    const headers = new Headers();
    headers.append("Set-Cookie", result.cookie);
    headers.append("Set-Cookie", clearPendingLoginCookie());
    return redirect(withLocale(`${PORTAL_BASE_PATH}/`, locale), { headers });
  }

  throw redirect(loginPath(locale));
};
