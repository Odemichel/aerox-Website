const MAX_LENGTH = 512;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/**
 * N'autorise qu'un chemin interne. Toute valeur qui pourrait désigner un
 * autre hôte — URL absolue, protocol-relative, backslash, double slash même
 * encodé — est rejetée au profit du fallback.
 */
export function safeRedirect(raw: string | null | undefined, fallback: string): string {
  if (typeof raw !== 'string') return fallback;

  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_LENGTH) return fallback;

  // Caractères de contrôle : jamais légitimes dans un chemin. Vérifié ici sur
  // la valeur brute, et rejoué plus bas sur la valeur décodée — un caractère
  // de contrôle encodé (ex. '%00') doit être refusé au même titre que sa
  // forme littérale, sous peine d'incohérence entre deux entrées équivalentes.
  if (CONTROL_CHARS.test(value)) return fallback;

  if (!value.startsWith('/')) return fallback;

  // '//host' et '/\host' désignent un autre hôte.
  if (value.startsWith('//') || value.startsWith('/\\')) return fallback;

  // Un double slash ou un caractère de contrôle n'importe où, y compris
  // après décodage, sort du site ou reste dangereux pour un consommateur
  // qui déciderait de redécoder cette valeur (voir note sur le retour).
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return fallback;
  }
  if (decoded.includes('//') || decoded.includes('\\') || CONTROL_CHARS.test(decoded)) return fallback;

  // Important : on retourne la valeur BRUTE (non décodée), jamais `decoded`.
  // La sûreté de cette fonction en dépend : `decoded` n'a servi qu'à la
  // détection ci-dessus. Un appelant qui redécoderait cette sortie avant de
  // s'en servir (ex. avant de construire un en-tête `Location` côté serveur)
  // réintroduirait le risque que les contrôles ci-dessus visent à éliminer —
  // par exemple une séquence doublement encodée qui ne révèle un `//` ou un
  // caractère de contrôle qu'après un second décodage.
  return value;
}
