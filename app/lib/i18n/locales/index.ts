import en from "./en.json";
import fr from "./fr.json";
import de from "./de.json";
import es from "./es.json";
import it from "./it.json";
import nl from "./nl.json";
import ptPT from "./pt-PT.json";
import ptBR from "./pt-BR.json";
import sv from "./sv.json";
import da from "./da.json";
import nb from "./nb.json";
import fi from "./fi.json";
import pl from "./pl.json";
import cs from "./cs.json";
import el from "./el.json";
import hu from "./hu.json";
import ro from "./ro.json";
import ja from "./ja.json";
import zhCN from "./zh-CN.json";
import ko from "./ko.json";
import ar from "./ar.json";
import tr from "./tr.json";

/**
 * Locale catalogs. `en` is the master — every other file must contain exactly
 * the same keys (tests/i18n-parity.test.ts enforces this).
 * See ./README.md for how to add or trim languages.
 *
 * Keys follow Shopify shop-locale codes: bare language codes ("fr", "ja")
 * except where a regional variant is meaningful ("pt-PT", "pt-BR", "zh-CN").
 * `normalizeLocale` in ../i18n.server.ts maps "pt" → "pt-PT", "zh" → "zh-CN",
 * "fr-CA" → "fr", etc.
 *
 * Built on a null prototype and frozen: lookups are keyed by the
 * shopper-controlled ?locale= param, so Object.prototype names ("__proto__",
 * "constructor", "toLocaleString", …) must never resolve to anything.
 */
export const locales: Record<string, Record<string, string>> = Object.freeze(
  Object.assign(Object.create(null), {
  en,
  fr,
  de,
  es,
  it,
  nl,
  "pt-PT": ptPT,
  "pt-BR": ptBR,
  sv,
  da,
  nb,
  fi,
  pl,
  cs,
  el,
  hu,
  ro,
  ja,
  "zh-CN": zhCN,
  ko,
  ar,
  tr,
  }),
);
