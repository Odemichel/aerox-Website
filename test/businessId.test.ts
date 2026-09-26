import { describe, it, expect } from 'vitest';
import { frVatKey, luhnValid, parseBusinessId } from '../src/lib/billing/businessId';

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

  it('hors UE : vérification manuelle, sauf saisie sans chiffres suffisants', () => {
    expect(parseBusinessId('12-3456789')).toEqual({ kind: 'other', key: 'OTHER:US123456789', raw: 'US123456789' });
    expect(parseBusinessId('CHE-123.456.789')).toMatchObject({ kind: 'other', key: 'OTHER:CHE123456789' });
    expect(parseBusinessId('hello').kind).toBe('invalid');
    expect(parseBusinessId(undefined).kind).toBe('invalid');
    expect(parseBusinessId('<script>1234567</script>').kind).toBe('invalid');
  });
});
