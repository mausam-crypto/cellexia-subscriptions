import { locales } from "./locales";

/**
 * Server-side i18n for portal pages, magic-link pages and notifications.
 * `en` is the master catalog; missing keys fall back to en, then to the key.
 *
 * Locale codes follow Shopify shop locales (e.g. "fr", "pt-PT", "zh-CN").
 */

// Frozen: normalizeLocale's variant preference ("pt" → "pt-PT") rides on this
// array's catalog insertion order, so an in-place sort() anywhere (a test file
// once did exactly that) would silently repoint bare base languages at a
// different regional catalog. Mutation now throws instead.
export const SUPPORTED_LOCALES: readonly string[] = Object.freeze(
  Object.keys(locales),
);

export function normalizeLocale(locale?: string | null): string {
  if (!locale) return "en";
  // Own-property lookups ONLY. This function is fed straight from the
  // shopper-controlled ?locale= app-proxy param, and a bare truthiness test
  // (`if (locales[locale])`) accepts Object.prototype keys — "__proto__",
  // "constructor", "toLocaleString", … — returning them verbatim; Intl then
  // throws RangeError and 500s every portal page that formats money/dates.
  // The catalog map itself is also built with a null prototype
  // (./locales/index.ts) — keep both layers of defense.
  if (Object.hasOwn(locales, locale)) return locale;
  const base = locale.split("-")[0];
  if (Object.hasOwn(locales, base)) return base;
  // Try any regional variant of the base language. SUPPORTED_LOCALES holds
  // own keys only, so this branch can never resurrect a prototype name.
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
