import en from "../locales/en.json";
import fr from "../locales/fr.json";
import pt from "../locales/pt.json";
import es from "../locales/es.json";
import it from "../locales/it.json";
import de from "../locales/de.json";
import nl from "../locales/nl.json";
import ja from "../locales/ja.json";
import tr from "../locales/tr.json";

export const SUPPORTED_LOCALES = ["fr", "en", "pt", "es", "it", "de", "nl", "ja", "tr"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

const dictionaries: Record<Locale, Record<string, string>> = {
  fr: fr as Record<string, string>,
  en: en as Record<string, string>,
  pt: pt as Record<string, string>,
  es: es as Record<string, string>,
  it: it as Record<string, string>,
  de: de as Record<string, string>,
  nl: nl as Record<string, string>,
  ja: ja as Record<string, string>,
  tr: tr as Record<string, string>,
};

export function getDict(lang: string): Record<string, string> {
  const l = (SUPPORTED_LOCALES as readonly string[]).includes(lang)
    ? (lang as Locale)
    : DEFAULT_LOCALE;
  return dictionaries[l];
}

export function t(
  dict: Record<string, string>,
  key: string,
  vars?: Record<string, string | number>
) {
  let s = dict[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(new RegExp(`{${k}}`, "g"), String(v));
  return s;
}
