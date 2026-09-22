const MAX_LENGTH = 512;

/**
 * N'autorise qu'un chemin interne. Toute valeur qui pourrait désigner un
 * autre hôte — URL absolue, protocol-relative, backslash, double slash même
 * encodé — est rejetée au profit du fallback.
 */
export function safeRedirect(raw: string | null | undefined, fallback: string): string {
  if (typeof raw !== 'string') return fallback;

  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_LENGTH) return fallback;

  // Caractères de contrôle : jamais légitimes dans un chemin.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(value)) return fallback;

  if (!value.startsWith('/')) return fallback;

  // '//host' et '/\host' désignent un autre hôte.
  if (value.startsWith('//') || value.startsWith('/\\')) return fallback;

  // Un double slash n'importe où, y compris après décodage, sort du site.
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return fallback;
  }
  if (decoded.includes('//') || decoded.includes('\\')) return fallback;

  return value;
}
