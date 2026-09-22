import { describe, it, expect } from 'vitest';
import { validateLead, LEAD_TOPICS } from '../src/lib/leadValidation';

const base = { topic: 'test-period', name: 'Olivier', email: 'o@example.com' };

describe('validateLead', () => {
  it('accepte un lead minimal valide', () => {
    const r = validateLead(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.honeypot).toBe(false);
      expect(r.lead.email).toBe('o@example.com');
      expect(r.lead.topic).toBe('test-period');
      expect(r.lead.message).toBe('');
    }
  });

  it('refuse un topic hors liste blanche', () => {
    const r = validateLead({ ...base, topic: 'spam-topic' });
    expect(r).toEqual({ ok: false, error: 'invalid_topic' });
  });

  it('refuse un topic absent', () => {
    expect(validateLead({ name: 'x', email: 'a@b.fr' })).toEqual({ ok: false, error: 'invalid_topic' });
  });

  it('refuse un email absent', () => {
    expect(validateLead({ ...base, email: undefined })).toEqual({ ok: false, error: 'invalid_email' });
  });

  it.each(['pasunemail', 'a@', '@b.fr', 'a b@c.fr', 'a@b', ''])('refuse l\'email invalide %s', (email) => {
    expect(validateLead({ ...base, email })).toEqual({ ok: false, error: 'invalid_email' });
  });

  it('normalise l\'email en minuscules et sans espaces', () => {
    const r = validateLead({ ...base, email: '  Olivier@Example.COM ' });
    expect(r.ok && r.lead.email).toBe('olivier@example.com');
  });

  it('refuse un nom vide', () => {
    expect(validateLead({ ...base, name: '   ' })).toEqual({ ok: false, error: 'invalid_name' });
  });

  it('refuse un champ texte de plus de 2000 caractères', () => {
    const r = validateLead({ ...base, message: 'a'.repeat(2001) });
    expect(r).toEqual({ ok: false, error: 'field_too_long' });
  });

  it('accepte un champ texte de 2000 caractères exactement', () => {
    expect(validateLead({ ...base, message: 'a'.repeat(2000) }).ok).toBe(true);
  });

  it('signale le honeypot sans rejeter', () => {
    const r = validateLead({ ...base, hp: 'rempli par un bot' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.honeypot).toBe(true);
  });

  it('normalise webcam en oui/non et ignore le reste', () => {
    expect(validateLead({ ...base, webcam: 'oui' }).ok && validateLead({ ...base, webcam: 'oui' }).lead.webcam).toBe('oui');
    expect(validateLead({ ...base, webcam: 'non' }).ok && validateLead({ ...base, webcam: 'non' }).lead.webcam).toBe('non');
    const r = validateLead({ ...base, webcam: 'peut-être' });
    expect(r.ok && r.lead.webcam).toBe('');
  });

  it('joint un tableau de disponibilités en une chaîne', () => {
    const r = validateLead({ ...base, availability: ['semaine-matin', 'weekend-soir'] });
    expect(r.ok && r.lead.availability).toBe('semaine-matin, weekend-soir');
  });

  it('ignore les entrées non-textuelles d\'un tableau de disponibilités', () => {
    const r = validateLead({ ...base, availability: ['semaine-matin', 42, null, 'weekend-soir'] });
    expect(r.ok && r.lead.availability).toBe('semaine-matin, weekend-soir');
  });

  it('refuse des disponibilités dont le total dépasse 2000 caractères', () => {
    const r = validateLead({ ...base, availability: [ 'a'.repeat(1500), 'b'.repeat(600) ] });
    expect(r).toEqual({ ok: false, error: 'field_too_long' });
  });

  it('refuse un type inattendu sur un champ texte', () => {
    expect(validateLead({ ...base, name: 42 })).toEqual({ ok: false, error: 'invalid_name' });
    expect(validateLead({ ...base, trainer: { a: 1 } })).toEqual({ ok: false, error: 'invalid_field' });
  });

  it('expose la liste blanche des topics', () => {
    expect(LEAD_TOPICS).toEqual(['test-period', 'bike-fitter']);
  });
});
