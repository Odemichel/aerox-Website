import { describe, it, expect } from 'vitest';
import { validateBookSubscriber, validateCdaResults } from '../src/lib/leadValidation';

describe('validateBookSubscriber', () => {
  it('accepte un email seul (formulaire de la homepage)', () => {
    expect(validateBookSubscriber({ email: 'o@example.com' })).toEqual({
      ok: true,
      honeypot: false,
      subscriber: { email: 'o@example.com', name: '', phone: '', source: '', results: null },
    });
  });

  it('garde nom et téléphone quand ils sont fournis', () => {
    const r = validateBookSubscriber({ email: ' O@Example.COM ', name: ' Olivier ', phone: '0600000000' });
    expect(r).toEqual({
      ok: true,
      honeypot: false,
      subscriber: { email: 'o@example.com', name: 'Olivier', phone: '0600000000', source: '', results: null },
    });
  });

  it.each([undefined, '', 'pasunemail', 'a@b', 42])("refuse l'email %s", (email) => {
    expect(validateBookSubscriber({ email })).toEqual({ ok: false, error: 'invalid_email' });
  });

  it.each([null, 'texte', ['a@b.fr']])('refuse un corps non objet %s', (input) => {
    expect(validateBookSubscriber(input as never)).toEqual({ ok: false, error: 'invalid_email' });
  });

  it('refuse un nom ou un téléphone non texte', () => {
    expect(validateBookSubscriber({ email: 'a@b.fr', name: { x: 1 } })).toEqual({ ok: false, error: 'invalid_field' });
    expect(validateBookSubscriber({ email: 'a@b.fr', phone: 33600 })).toEqual({ ok: false, error: 'invalid_field' });
  });

  it('refuse un champ trop long', () => {
    expect(validateBookSubscriber({ email: 'a@b.fr', name: 'x'.repeat(2001) })).toEqual({
      ok: false,
      error: 'field_too_long',
    });
  });

  it('signale le honeypot rempli sans rejeter la requête', () => {
    const r = validateBookSubscriber({ email: 'a@b.fr', hp: 'bot' });
    expect(r.ok && r.honeypot).toBe(true);
  });

  it('ignore un honeypot vide', () => {
    const r = validateBookSubscriber({ email: 'a@b.fr', hp: '' });
    expect(r.ok && r.honeypot).toBe(false);
  });
  it("garde l'origine du formulaire si elle est connue, l'ignore sinon", () => {
    const ok = validateBookSubscriber({ email: 'a@b.fr', source: 'sidebar' });
    expect(ok.ok && ok.subscriber.source).toBe('sidebar');
    const unknown = validateBookSubscriber({ email: 'a@b.fr', source: 'hack<script>' });
    expect(unknown.ok && unknown.subscriber.source).toBe('');
    const absent = validateBookSubscriber({ email: 'a@b.fr' });
    expect(absent.ok && absent.subscriber.source).toBe('');
  });
});

describe('validateCdaResults', () => {
  const ok = { cda: 0.32, targetCda: 0.27, gainKmh: 1.8, wattsSaved: 31, speedKmh: 34.5, bike: 'road' };

  it('accepte des résultats plausibles', () => {
    expect(validateCdaResults(ok)).toEqual(ok);
  });

  it.each([
    ['vélo inconnu', { ...ok, bike: 'gravel' }],
    ['CdA hors bornes', { ...ok, cda: 5 }],
    ['gain négatif', { ...ok, gainKmh: -1 }],
    ['nombre en texte', { ...ok, wattsSaved: '31' }],
    ['valeur manquante', { ...ok, speedKmh: undefined }],
    ['NaN', { ...ok, targetCda: Number.NaN }],
  ])('refuse : %s', (_, input) => {
    expect(validateCdaResults(input)).toBeNull();
  });

  it("n'empêche jamais l'inscription", () => {
    const r = validateBookSubscriber({ email: 'a@b.fr', source: 'calculator_result', results: { cda: 'x' } });
    expect(r.ok && r.subscriber.results).toBeNull();
    const r2 = validateBookSubscriber({ email: 'a@b.fr', source: 'calculator_result', results: ok });
    expect(r2.ok && r2.subscriber.results).toEqual(ok);
  });
});
