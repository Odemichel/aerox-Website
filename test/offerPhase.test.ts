import { describe, it, expect } from 'vitest';
import { offerPhase, phased } from '../src/lib/offerPhase';

const at = (iso: string) => Date.parse(iso);

describe('offerPhase', () => {
  it('pré-réservation avant le 1er novembre (heure de Paris)', () => {
    expect(offerPhase(at('2026-10-31T22:59:59Z'))).toBe('pre');
  });
  it('disponible, offre de lancement en cours, du 1er au 15 novembre inclus', () => {
    expect(offerPhase(at('2026-10-31T23:00:00Z'))).toBe('live');
    expect(offerPhase(at('2026-11-15T22:59:59Z'))).toBe('live');
  });
  it('prix plein à partir du 16 novembre 0 h (Paris)', () => {
    expect(offerPhase(at('2026-11-15T23:00:00Z'))).toBe('full');
  });
});

describe('phased', () => {
  it('porte les trois versions, échappées dans les attributs', () => {
    const html = phased('Pré-réserve', 'Débloque <b>ici</b>', '');
    expect(html).toContain('data-live="Débloque &lt;b&gt;ici&lt;/b&gt;"');
    expect(html).toContain('data-full=""');
    expect(html).toContain('data-pre="Pré-réserve"');
  });
});
