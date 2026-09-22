import { describe, it, expect } from 'vitest';
import enDict from '../src/locales/en.json';
import { mergeDicts, getDict, t, SUPPORTED_LOCALES } from '../src/lib/i18n';

describe('mergeDicts', () => {
  it('complète la locale avec les clés absentes du socle', () => {
    expect(mergeDicts({ a: 'A', b: 'B' }, { a: 'A-fr' })).toEqual({ a: 'A-fr', b: 'B' });
  });

  it('laisse la traduction locale gagner sur le socle', () => {
    expect(mergeDicts({ a: 'base' }, { a: 'locale' }).a).toBe('locale');
  });

  it('conserve les clés que seule la locale possède', () => {
    expect(mergeDicts({ a: 'A' }, { z: 'Z' })).toEqual({ a: 'A', z: 'Z' });
  });

  it('ne modifie aucun des deux dictionnaires d\'entrée', () => {
    const base = { a: 'A' };
    const loc = { a: 'A-fr' };
    mergeDicts(base, loc);
    expect(base).toEqual({ a: 'A' });
    expect(loc).toEqual({ a: 'A-fr' });
  });

  it('rend le socle intégralement quand la locale est vide', () => {
    expect(mergeDicts({ a: 'A', b: 'B' }, {})).toEqual({ a: 'A', b: 'B' });
  });
});

describe('getDict', () => {
  it('privilégie la traduction locale sur l\'anglais', () => {
    expect(getDict('fr')['nav.home']).not.toBe(getDict('en')['nav.home']);
  });

  it('retombe sur l\'anglais pour une locale inconnue', () => {
    expect(getDict('xx')['nav.home']).toBe(getDict('en')['nav.home']);
  });

  it('garantit que chaque locale rend toutes les clés anglaises', () => {
    const enKeys = Object.keys(enDict);
    for (const loc of SUPPORTED_LOCALES) {
      const d = getDict(loc);
      expect(enKeys.filter((k) => d[k] === undefined), `locale ${loc}`).toEqual([]);
    }
  });

  it('t() ne renvoie la clé brute que si elle manque partout', () => {
    expect(t(getDict('fr'), 'cle.qui.nexiste.nulle.part')).toBe('cle.qui.nexiste.nulle.part');
  });
});
