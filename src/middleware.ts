import type { MiddlewareHandler } from "astro";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type Locale } from "./lib/i18n";

function detect(req: Request): Locale {
  const cookie = req.headers.get("cookie") ?? "";
  const re = /(?:^|;\s*)lang=(fr|en)/i;
  const m = re.exec(cookie);
  if (m) return m[1].toLowerCase() as Locale;

  const header = req.headers.get("accept-language") ?? "";
  const cand = header.split(",").map((s) => s.trim().slice(0, 2).toLowerCase());
  for (const c of cand) {
    if (SUPPORTED_LOCALES.includes(c as Locale)) return c as Locale;
  }

  return DEFAULT_LOCALE;
}
export const onRequest: MiddlewareHandler = async (context, next) => {
  const { request, redirect, url, locals, rewrite } = context;
  const pathname = url.pathname;

  if (
    pathname.startsWith("/_astro") ||
    pathname.startsWith("/_image") ||
    pathname.startsWith("/favicon") ||
    pathname.startsWith("/assets")
  ) {
    return next();
  }

  const segments = pathname.split("/").filter(Boolean);
  const hasLang = segments.length > 0 && SUPPORTED_LOCALES.includes(segments[0] as Locale);

  if (!hasLang) {
    const lang = detect(request);

    // 🔹 Avec trailingSlash: "always" => on force le slash final
    let path = url.pathname;
    if (!path.endsWith("/")) {
      path = path + "/";
    }

    // Rewrite interne pour la racine (pas de redirect 302 = pas de latence)
    if (path === "/") {
      locals.lang = lang;
      return rewrite(`/${lang}/${url.search}`);
    }

    return redirect(`/${lang}${path}${url.search}`, 302);
  }

  locals.lang = segments[0] as Locale;
  return next();
};
