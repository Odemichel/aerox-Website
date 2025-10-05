export function localizedHref(lang: string, path: string) {
  if (!path) return '/';
  if (path.startsWith(`/${lang}/`)) return path;
  return `/${lang}${path.startsWith('/') ? path : '/' + path}`;
}
