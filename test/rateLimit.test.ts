import { describe, it, expect } from 'vitest';
import { createRateLimiter } from '../src/lib/rateLimit';

describe('createRateLimiter', () => {
  it('laisse passer jusqu\'à la limite', () => {
    const rl = createRateLimiter({ limit: 3, windowMs: 1000 });
    expect(rl.check('ip1', 0)).toBe(true);
    expect(rl.check('ip1', 1)).toBe(true);
    expect(rl.check('ip1', 2)).toBe(true);
  });

  it('bloque au-delà de la limite dans la fenêtre', () => {
    const rl = createRateLimiter({ limit: 2, windowMs: 1000 });
    rl.check('ip1', 0);
    rl.check('ip1', 10);
    expect(rl.check('ip1', 20)).toBe(false);
  });

  it('rouvre après la fenêtre', () => {
    const rl = createRateLimiter({ limit: 2, windowMs: 1000 });
    rl.check('ip1', 0);
    rl.check('ip1', 10);
    expect(rl.check('ip1', 20)).toBe(false);
    expect(rl.check('ip1', 1001)).toBe(true);
  });

  it('compte chaque clé séparément', () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 1000 });
    expect(rl.check('ip1', 0)).toBe(true);
    expect(rl.check('ip2', 0)).toBe(true);
    expect(rl.check('ip1', 1)).toBe(false);
  });

  it('purge les clés expirées au lieu de croître sans fin', () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 100 });
    for (let i = 0; i < 500; i++) rl.check(`ip${i}`, i);
    // après une fenêtre entière, tout est purgé au prochain appel
    expect(rl.check('nouvelle-ip', 100_000)).toBe(true);
    expect(rl.size()).toBe(1);
  });

  it('balayage complet déclenché après expiration de la fenêtre', () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 100 });
    // Insérer plusieurs clés distinctes dans la même fenêtre
    rl.check('ip1', 0);
    rl.check('ip2', 50);
    rl.check('ip3', 75);
    expect(rl.size()).toBe(3);
    // Avancer bien au-delà de la fenêtre pour que toutes les clés expirent
    rl.check('ip4', 200);
    // Les clés anciennes doivent être purgées
    expect(rl.size()).toBe(1); // seulement ip4
  });

  it('comportement fonctionnel inchangé sur une clé : limite, rejet, réouverture', () => {
    const rl = createRateLimiter({ limit: 2, windowMs: 1000 });
    expect(rl.check('test-key', 0)).toBe(true);
    expect(rl.check('test-key', 100)).toBe(true);
    expect(rl.check('test-key', 200)).toBe(false); // dépassement de limite
    expect(rl.check('test-key', 1001)).toBe(true); // fenêtre expiré, réouverture
  });
});
