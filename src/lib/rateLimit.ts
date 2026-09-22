type Options = { limit: number; windowMs: number };

/**
 * Fenêtre glissante en mémoire.
 *
 * Portée : l'instance serverless courante. Plusieurs instances Vercel ⇒
 * plusieurs compteurs indépendants, et un démarrage à froid remet à zéro.
 * C'est délibéré : ce limiteur empêche un client de boucler sur la route,
 * il ne constitue pas une protection anti-spam distribuée.
 */
export function createRateLimiter({ limit, windowMs }: Options) {
  const hits = new Map<string, number[]>();
  let lastFullPruneTime = 0;

  /**
   * Purge les horodatages expirés de la clé donnée.
   * Coût : O(T) où T ≤ limit.
   */
  function pruneKey(key: string, now: number) {
    const stamps = hits.get(key);
    if (!stamps) return;
    const kept = stamps.filter((s) => now - s < windowMs);
    if (kept.length === 0) hits.delete(key);
    else hits.set(key, kept);
  }

  /**
   * Balayage complet : purge toutes les clés.
   * Déclenché seulement si windowMs s'est écoulé depuis le dernier balayage.
   * Coût amorti : O(K × T) réparti sur windowMs ms.
   */
  function fullPrune(now: number) {
    if (now - lastFullPruneTime < windowMs) return;
    for (const [key] of hits) {
      pruneKey(key, now);
    }
    lastFullPruneTime = now;
  }

  return {
    check(key: string, now: number = Date.now()): boolean {
      pruneKey(key, now);
      fullPrune(now);
      const stamps = hits.get(key) ?? [];
      if (stamps.length >= limit) return false;
      stamps.push(now);
      hits.set(key, stamps);
      return true;
    },
    /**
     * Rend la taille brute du Map. Destinée aux tests et au diagnostic.
     * Se lit juste après un `check()` pour une cohérence maximale.
     */
    size(): number {
      return hits.size;
    },
  };
}

export const leadRateLimiter = createRateLimiter({ limit: 5, windowMs: 10 * 60 * 1000 });
