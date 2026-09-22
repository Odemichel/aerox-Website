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

  function prune(now: number) {
    for (const [key, stamps] of hits) {
      const kept = stamps.filter((s) => now - s < windowMs);
      if (kept.length === 0) hits.delete(key);
      else hits.set(key, kept);
    }
  }

  return {
    check(key: string, now: number = Date.now()): boolean {
      prune(now);
      const stamps = hits.get(key) ?? [];
      if (stamps.length >= limit) return false;
      stamps.push(now);
      hits.set(key, stamps);
      return true;
    },
    size(): number {
      return hits.size;
    },
  };
}

export const leadRateLimiter = createRateLimiter({ limit: 5, windowMs: 10 * 60 * 1000 });
