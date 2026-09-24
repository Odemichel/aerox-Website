import { describe, it, expect } from 'vitest';
import { validateBookSubscriber } from '../src/lib/leadValidation';

describe('validateBookSubscriber', () => {
  it('accepte un email seul (formulaire de la homepage)', () => {
    expect(validateBookSubscriber({ email: 'o@example.com' })).toEqual({
      ok: true,
      honeypot: false,
      subscriber: { email: 'o@example.com', name: '', phone: '' },
    });
  });

  it('garde nom et téléphone quand ils sont fournis', () => {
    const r = validateBookSubscriber({ email: ' O@Example.COM ', name: ' Olivier ', phone: '0600000000' });
    expect(r).toEqual({
      ok: true,
      honeypot: false,
      subscriber: { email: 'o@example.com', name: 'Olivier', phone: '0600000000' },
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
});
