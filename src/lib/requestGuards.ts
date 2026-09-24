import { createHash } from 'node:crypto';
import type { APIContext } from 'astro';

/**
 * Identifiant de journal dérivé de l'email, pour ne pas écrire d'adresse en
 * clair dans des journaux conservés par la plateforme. Stable d'un appel à
 * l'autre : deux rejets de la même adresse portent le même identifiant, ce qui
 * suffit à corréler un faux positif.
 */
export function emailDigest(email: string): string {
  return createHash('sha256').update(email).digest('hex').slice(0, 12);
}

/**
 * Adresse à utiliser comme clé du limiteur.
 *
 * `clientAddress` est un *getter* : l'adaptateur Vercel lui passe la valeur
 * brute de `x-forwarded-for`, qui peut porter une liste `client, proxy1, …`,
 * et le getter lève si aucun adaptateur ne fournit d'adresse. Il est donc lu
 * ici, dans un `try`, et non déstructuré dans la signature du handler — où il
 * serait évalué avant tout gestionnaire d'erreur.
 */
export function rateLimitKey(context: APIContext): string {
  let raw: string | undefined;
  try {
    raw = context.clientAddress;
  } catch {
    // Pas d'adresse exploitable : tous ces appels partagent alors le même
    // quota, ce qui est le comportement sûr côté limiteur.
    raw = undefined;
  }
  return raw?.split(',')[0]?.trim() || 'inconnue';
}

/**
 * `request.json()` parse quel que soit le type déclaré. Un formulaire HTML
 * tiers en `enctype="text/plain"` produit un corps JSON valide sans déclencher
 * de préflight CORS : chaque visiteur d'une page piégée soumettrait depuis sa
 * propre IP, rendant le quota par adresse inopérant. On exige donc un
 * `Content-Type` JSON, que ce formulaire-là ne peut pas poser.
 */
export function isJsonRequest(request: Request): boolean {
  const mediaType = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  return mediaType === 'application/json';
}
