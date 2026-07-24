import { locales } from "./locales";

/**
 * Server-side i18n for portal pages, magic-link pages and notifications.
 * `en` is the master catalog; missing keys fall back to en, then to the key.
 *
 * Locale codes follow Shopify shop locales (e.g. "fr", "pt-PT", "zh-CN").
 */

export const SUPPORTED_LOCALES = Object.keys(locales);

export function normalizeLocale(locale?: string | null): string {
  if (!locale) return "en";
  if (locales[locale]) return locale;
  const base = locale.split("-")[0];
  if (locales[base]) return base;
  // Try any regional variant of the base language.
  const variant = SUPPORTED_LOCALES.find((l) => l.startsWith(`${base}-`));
  return variant ?? "en";
}

export function t(
  locale: string | null | undefined,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const loc = normalizeLocale(locale);
  const catalog = locales[loc] ?? locales.en;
  let str = catalog[key] ?? locales.en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      str = str.replaceAll(`{${k}}`, String(v));
    }
  }
  return str;
}
