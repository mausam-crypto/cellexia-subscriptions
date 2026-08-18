import { getSetting } from "~/lib/settings/settings.server";

/**
 * Whether the app will actually send the "pause ending" reminder before an
 * auto-resume charge — the fact customer-facing copy needs before it may
 * promise "we'll remind you first" (v1.28.0 review fix, copy truth).
 *
 * The resume_reminder template is not critical, so two merchant switches
 * silence it: the email channel toggle (settings.notifications.channels.email)
 * and the per-template `enabled:false` override (settings.emails.templates).
 * Both are read here exactly as send.server.ts applies them. Anything that
 * fails to load resolves to `false` — copy must never promise what a broken
 * settings read cannot guarantee.
 */
export async function resumeReminderPromised(shopId: string): Promise<boolean> {
  try {
    const [notif, emails] = await Promise.all([
      getSetting(shopId, "notifications"),
      getSetting(shopId, "emails"),
    ]);
    if (!notif.channels.email) return false;
    const override = (emails.templates as Record<string, { enabled?: boolean } | undefined>)[
      "resume_reminder"
    ];
    return override?.enabled !== false;
  } catch (err) {
    console.error("[notifications] resumeReminderPromised failed", shopId, err);
    return false;
  }
}
