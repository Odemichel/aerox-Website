import en from "../locales/en.json";
import fr from "../locales/fr.json";

export const SUPPORTED_LOCALES = ["fr", "en"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "fr";

// ✅ plus d'union {} | Record<string,string>
const dictionaries: Record<Locale, Record<string, string>> = {
  fr: fr as Record<string, string>,
  en: en as Record<string, string>,
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
