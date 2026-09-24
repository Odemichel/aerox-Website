import { describe, it, expect } from 'vitest';
import { validateLead, isHoneypotFilled, LEAD_TOPICS, LEAD_INTENTS } from '../src/lib/leadValidation';

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

  it.each(['pasunemail', 'a@', '@b.fr', 'a b@c.fr', 'a@b', ''])("refuse l'email invalide %s", (email) => {
    expect(validateLead({ ...base, email })).toEqual({ ok: false, error: 'invalid_email' });
  });

  it("normalise l'email en minuscules et sans espaces", () => {
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

  it.each([1, -1, 3.5, true, ['x'], { a: 1 }, 'x'])('déclenche le honeypot sur la valeur non vide %s', (hp) => {
    const r = validateLead({ ...base, hp });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.honeypot).toBe(true);
  });

  it.each([undefined, null, '', '   ', false, 0, [], {}])(
    'ne déclenche pas le honeypot sur la valeur vide %s',
    (hp) => {
      const r = validateLead({ ...base, hp });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.honeypot).toBe(false);
    }
  );

  it('ne déclenche pas le honeypot sur un tableau de valeurs vides', () => {
    const r = validateLead({ ...base, hp: ['', '  ', null] });
    expect(r.ok && r.honeypot).toBe(false);
  });

  it('normalise webcam en oui/non et ignore le reste', () => {
    expect(validateLead({ ...base, webcam: 'oui' }).ok && validateLead({ ...base, webcam: 'oui' }).lead.webcam).toBe(
      'oui'
    );
    expect(validateLead({ ...base, webcam: 'non' }).ok && validateLead({ ...base, webcam: 'non' }).lead.webcam).toBe(
      'non'
    );
    const r = validateLead({ ...base, webcam: 'peut-être' });
    expect(r.ok && r.lead.webcam).toBe('');
  });

  it('joint un tableau de disponibilités en une chaîne', () => {
    const r = validateLead({ ...base, availability: ['semaine-matin', 'weekend-soir'] });
    expect(r.ok && r.lead.availability).toBe('semaine-matin, weekend-soir');
  });

  it("ignore les entrées non-textuelles d'un tableau de disponibilités", () => {
    const r = validateLead({ ...base, availability: ['semaine-matin', 42, null, 'weekend-soir'] });
    expect(r.ok && r.lead.availability).toBe('semaine-matin, weekend-soir');
  });

  it('refuse des disponibilités dont le total dépasse 2000 caractères', () => {
    const r = validateLead({ ...base, availability: ['a'.repeat(1500), 'b'.repeat(600)] });
    expect(r).toEqual({ ok: false, error: 'field_too_long' });
  });

  it('refuse un type inattendu sur un champ texte', () => {
    expect(validateLead({ ...base, name: 42 })).toEqual({ ok: false, error: 'invalid_name' });
    expect(validateLead({ ...base, trainer: { a: 1 } })).toEqual({ ok: false, error: 'invalid_field' });
  });

  it('expose la liste blanche des topics', () => {
    expect(LEAD_TOPICS).toEqual(['test-period', 'bike-fitter']);
  });

  it('refuse un email de plus de 2000 caractères', () => {
    const r = validateLead({ ...base, email: 'a'.repeat(2001) + '@b.com' });
    expect(r).toEqual({ ok: false, error: 'field_too_long' });
  });

  it('accepte un email de 2000 caractères ou moins', () => {
    const longEmail = 'a'.repeat(1990) + '@b.com';
    const r = validateLead({ ...base, email: longEmail });
    expect(r.ok).toBe(true);
  });

  it('refuse validateLead(null) sans exception', () => {
    const r = validateLead(null as never);
    expect(r).toEqual({ ok: false, error: 'invalid_topic' });
  });

  it('refuse validateLead(42) sans exception', () => {
    const r = validateLead(42 as never);
    expect(r).toEqual({ ok: false, error: 'invalid_topic' });
  });

  it('refuse validateLead([]) sans exception', () => {
    const r = validateLead([] as never);
    expect(r).toEqual({ ok: false, error: 'invalid_topic' });
  });

  it("refuse validateLead('x') sans exception", () => {
    const r = validateLead('x' as never);
    expect(r).toEqual({ ok: false, error: 'invalid_topic' });
  });
});

describe('isHoneypotFilled', () => {
  it('imbrique la détection dans les tableaux', () => {
    expect(isHoneypotFilled([[''], [0], [false]])).toBe(false);
    expect(isHoneypotFilled([[''], ['rempli']])).toBe(true);
  });

  it('traite un objet non vide comme rempli', () => {
    expect(isHoneypotFilled({})).toBe(false);
    expect(isHoneypotFilled({ a: undefined })).toBe(true);
  });
});

describe('isHoneypotFilled — profondeur bornée', () => {
  function nest(depth: number, leaf: unknown): unknown {
    let v: unknown = leaf;
    for (let i = 0; i < depth; i++) v = [v];
    return v;
  }

  it('ne lève pas sur une imbrication très profonde', () => {
    const deep = nest(50000, 'x');
    expect(() => isHoneypotFilled(deep)).not.toThrow();
    expect(isHoneypotFilled(deep)).toBe(true);
  });

  it('ne lève pas via validateLead sur un hp très profond', () => {
    const deep = nest(50000, '');
    expect(() => validateLead({ ...base, hp: deep })).not.toThrow();
    expect(validateLead({ ...base, hp: deep }).ok).toBe(true);
  });

  it('considère le honeypot déclenché au-delà de la borne, même vide', () => {
    expect(isHoneypotFilled(nest(20, ''))).toBe(true);
  });

  it('explore normalement en deçà de la borne', () => {
    expect(isHoneypotFilled(nest(3, ''))).toBe(false);
    expect(isHoneypotFilled(nest(3, 'rempli'))).toBe(true);
  });

  it("ne confond pas l'indice de tableau avec la profondeur", () => {
    // Un tableau plat de chaînes ne discrimine rien : la profondeur n'est
    // lue que dans la branche tableau, jamais pour un élément scalaire.
    // Il faut des éléments eux-mêmes tableaux, à un indice >= la borne, pour
    // que `some(isHoneypotFilled)` passerait l'indice en 2e argument et le
    // ferait prendre pour la profondeur : le 9e élément (indice 8) serait
    // alors vu à une profondeur de 8 et déclencherait le honeypot à tort,
    // alors qu'un sous-tableau vide ne devrait rien déclencher.
    const wide = [[], [], [], [], [], [], [], [], []];
    expect(isHoneypotFilled(wide)).toBe(false);
    expect(wide.length).toBeGreaterThanOrEqual(9);
  });
});

describe('intent', () => {
  it('vaut demo par défaut quand rien n’est envoyé', () => {
    const r = validateLead(base);
    expect(r.ok && r.lead.intent).toBe('demo');
  });

  it('accepte chacune des valeurs de la liste', () => {
    for (const intent of LEAD_INTENTS) {
      const r = validateLead({ ...base, intent });
      expect(r.ok && r.lead.intent).toBe(intent);
    }
  });

  it('normalise la casse et les espaces', () => {
    const r = validateLead({ ...base, intent: '  DEVIS ' });
    expect(r.ok && r.lead.intent).toBe('devis');
  });

  it('retombe sur demo plutôt que de rejeter une valeur inconnue', () => {
    for (const v of ['spam', '', 42, null, {}, ['devis']]) {
      const r = validateLead({ ...base, intent: v });
      expect(r.ok && r.lead.intent).toBe('demo');
    }
  });
});

describe('phone', () => {
  it('est vide quand absent', () => {
    expect(validateLead(base).ok && validateLead(base).lead.phone).toBe('');
  });

  it('conserve un numéro dans n’importe quel format, espaces rognés', () => {
    const r = validateLead({ ...base, phone: '  +33 6 12 34 56 78 ' });
    expect(r.ok && r.lead.phone).toBe('+33 6 12 34 56 78');
  });

  it('refuse un type non textuel', () => {
    expect(validateLead({ ...base, phone: 42 })).toEqual({ ok: false, error: 'invalid_field' });
  });

  it('refuse un numéro au-delà de la borne commune', () => {
    expect(validateLead({ ...base, phone: '0'.repeat(2001) })).toEqual({ ok: false, error: 'field_too_long' });
  });
});
