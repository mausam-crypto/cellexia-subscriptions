# Locale catalogs

Flat key/value JSON catalogs consumed by `t(locale, key, vars)` in
`app/lib/i18n/i18n.server.ts`. **`en.json` is the master**: it defines the
complete key set, and every other catalog must contain exactly the same keys —
no more, no fewer.

## Shipped languages

`en`, `fr`, `de`, `es`, `it`, `nl`, `pt-PT`, `pt-BR`, `sv`, `da`, `nb`, `fi`,
`pl`, `cs`, `el`, `hu`, `ro`, `ja`, `zh-CN`, `ko`, `ar`, `tr`.

File names are the locale codes exactly as they appear in the `locales` record
in `index.ts` (bare language codes, except `pt-PT`, `pt-BR` and `zh-CN` where
the region matters).

## Trimming to the store's exact languages

The store enables a specific set of Shopify shop locales; ship only those:

1. Delete the unwanted `<locale>.json` file(s).
2. Remove the matching `import` line **and** the entry in the `locales` record
   in `index.ts`.
3. Done — `SUPPORTED_LOCALES` in `i18n.server.ts` is derived from the record,
   so nothing else needs to change.

Never delete `en.json`: it is the master catalog and the final fallback for
every missing key and unknown locale.

## How locale fallback works (`normalizeLocale`)

`normalizeLocale` in `i18n.server.ts` resolves any incoming locale string
(contract locale, `?locale=` param, Shopify shop locale) to a shipped catalog:

1. Exact match wins: `"pt-PT"` → `pt-PT`, `"fr"` → `fr`.
2. Otherwise the base language is tried: `"fr-CA"` → `fr`, `"de-AT"` → `de`.
3. Otherwise any shipped regional variant of the base language is used:
   `"pt"` → `pt-PT` (first `pt-*` in the record — keep `pt-PT` before `pt-BR`
   if plain `pt` should mean European Portuguese), `"zh"`/`"zh-TW"` → `zh-CN`.
4. Anything else falls back to `"en"`.

Per-key fallback is separate: if a key is missing from a catalog at runtime,
`t()` falls back to the `en` value, then to the key itself. The parity test
exists so this never actually happens in production.

## Keeping catalogs in sync (the parity checklist)

When you add or change copy:

- [ ] Add/rename the key in `en.json` first — it is the source of truth.
- [ ] Mirror the exact same key in **every** other catalog (translated, never
      copied English unless the value is intentionally identical, e.g. URLs).
- [ ] Keep `{placeholders}` byte-identical to the call site and to `en.json`
      — same names, same count. Substitution is literal `{name}` replacement;
      a renamed placeholder silently prints raw braces to the customer.
- [ ] `email.{template}.subject` / `email.{template}.body` must exist for every
      template in `app/lib/notifications/templates.server.ts` (plus
      `sms.payment_failed_sms.*` for the SMS template). Adding a template to
      the registry means adding two keys to all catalogs.
- [ ] Run the parity test (`tests/i18n-parity.test.ts`): it asserts every
      catalog has exactly the `en.json` key set and matching placeholder sets.
      Until that test exists, this one-liner does the same job:

      python3 - <<'EOF'
      import json, re, glob
      en = json.load(open('app/lib/i18n/locales/en.json')); v = re.compile(r'\{[a-zA-Z_0-9]+\}')
      for f in glob.glob('app/lib/i18n/locales/*.json'):
          cat = json.load(open(f))
          assert set(cat) == set(en), (f, set(cat) ^ set(en))
          for k in en: assert set(v.findall(cat[k])) == set(v.findall(en[k])), (f, k)
      print("parity OK")
      EOF

## Translation conventions (read before editing)

- **Brand**: "Cellexia" stays in Latin script everywhere. In Czech, Polish and
  Hungarian the name is inflected (`s Cellexií`, `z Cellexią`, `Cellexiával`)
  — that is intentional and required for the copy to read natively.
- **SMS keywords**: `SKIP` and `DELAY` in `magic.sms.*` are machine-parsed
  reply keywords (`app/routes/api.sms.inbound.tsx` matches them uppercased in
  English). They must remain literal `SKIP` / `DELAY` in every language.
- **URLs**: `cancel.saves.*_url` values are locale-independent and must stay
  identical across catalogs.
- **`{cta}`** in email bodies marks where `renderEmail` injects the button
  built from `vars.cta_url`; leave it on its own line. If no `cta_url` is
  passed, the marker is removed cleanly.
- **Tone**: premium-but-warm skincare brand. Formal address in fr, pt-PT, cs,
  el, hu, ja, zh-CN, ko, ar, tr; informal in de, es, it, nl, pt-BR, sv, da,
  nb, fi, pl, ro. Keep dunning copy helpful, never accusatory; keep the
  upcoming-order email's one-tap skip/delay links.
- **`cancel.common.friend`** is the fallback that replaces `{firstName}` in
  cancel-flow headlines when the name is unknown — it must read naturally in
  the sentence frames of `cancel.intro.headline.a/b` for that language (the
  European catalogs use a "one moment" style interjection; CJK/ar/tr use an
  honorific like お客様 / 고객님 / 您 / عزيزنا / değerli üyemiz).
- **Plurals**: the framework has no plural rules. English uses "(s)" hacks;
  translations phrase around plurals (abbreviations like `tyg.`/`týd.`/`měs.`
  in pl/cs, invariant counters in CJK). Do not introduce copy that requires
  real plural logic.
- **RTL**: `ar` renders right-to-left; strings need no markup, but any new
  copy mixing Latin brand names into Arabic sentences should be sanity-checked
  in the portal UI.
