import { describe, it, expect } from 'vitest';
import { emailMatchesHost, frVatKey, luhnValid, parseBusinessId } from '../src/lib/billing/businessId';

// Danone SA : SIREN 552 032 534, TVA FR27552032534 (vérifiés sur les registres).
describe('parseBusinessId', () => {
  it('SIREN valide (clé de Luhn), espaces et points tolérés', () => {
    expect(parseBusinessId('552 032 534')).toEqual({
      kind: 'siren',
      key: 'FR:552032534',
      siren: '552032534',
      country: 'FR',
    });
    expect(parseBusinessId('552.032.534').kind).toBe('siren');
  });

  it('SIREN à la clé fausse : refusé sans appel au registre', () => {
    expect(parseBusinessId('552032535').kind).toBe('invalid');
  });

  it('SIRET, SIREN et TVA française de la même entreprise : même clé', () => {
    const vat = parseBusinessId('FR27552032534');
    expect(vat).toMatchObject({ kind: 'eu_vat', key: 'FR:552032534' });
    expect(frVatKey('552032534')).toBe('27');
    expect(parseBusinessId('FR28552032534').kind).toBe('invalid');
  });

  it('SIRET : Luhn sur 14 chiffres', () => {
    const siret = '55203253400000';
    const valid = luhnValid(siret);
    expect(parseBusinessId(siret).kind).toBe(valid ? 'siren' : 'invalid');
  });

  it('TVA d’un autre État membre : vérification VIES', () => {
    expect(parseBusinessId('de 123 456 789')).toEqual({
      kind: 'eu_vat',
      key: 'DE:123456789',
      country: 'DE',
      number: '123456789',
    });
    expect(parseBusinessId('EL123456789').kind).toBe('eu_vat');
  });

  it('site internet du studio : domaine normalisé (sans www), une clé par domaine', () => {
    expect(parseBusinessId('monstudio.ch')).toEqual({
      kind: 'website',
      key: 'WEB:monstudio.ch',
      host: 'monstudio.ch',
      url: 'https://monstudio.ch',
    });
    expect(parseBusinessId('https://www.MonStudio.ch/contact')).toMatchObject({
      kind: 'website',
      key: 'WEB:monstudio.ch',
    });
    expect(parseBusinessId('http://bike-fit.co.uk')).toMatchObject({ kind: 'website', key: 'WEB:bike-fit.co.uk' });
  });

  it('messageries, réseaux sociaux et pages de liens refusés', () => {
    expect(parseBusinessId('instagram.com/monstudio').kind).toBe('invalid');
    expect(parseBusinessId('https://www.facebook.com/monstudio').kind).toBe('invalid');
    expect(parseBusinessId('linktr.ee/monstudio').kind).toBe('invalid');
    expect(parseBusinessId('paul@gmail.com').kind).toBe('invalid');
  });

  it('ni numéro ni site : refusé', () => {
    expect(parseBusinessId('12-3456789').kind).toBe('invalid');
    expect(parseBusinessId('CHE-123.456.789').kind).toBe('invalid');
    expect(parseBusinessId('hello').kind).toBe('invalid');
    expect(parseBusinessId('mon studio.fr').kind).toBe('invalid');
    expect(parseBusinessId(undefined).kind).toBe('invalid');
    expect(parseBusinessId('<script>1234567</script>').kind).toBe('invalid');
  });
});

describe('emailMatchesHost', () => {
  it('domaine de l’e-mail = site (sous-domaine compris), jamais pour une messagerie', () => {
    expect(emailMatchesHost('paul@monstudio.ch', 'monstudio.ch')).toBe(true);
    expect(emailMatchesHost('paul@monstudio.ch', 'shop.monstudio.ch')).toBe(true);
    expect(emailMatchesHost('paul@autre.ch', 'monstudio.ch')).toBe(false);
    expect(emailMatchesHost('paul@gmail.com', 'gmail.com')).toBe(false);
    expect(emailMatchesHost(null, 'monstudio.ch')).toBe(false);
  });
});
