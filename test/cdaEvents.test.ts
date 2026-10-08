import { describe, it, expect } from 'vitest';
import { validateCdaEvent } from '../src/lib/cdaEvents';

describe('validateCdaEvent', () => {
  it('accepte un calcul et une analyse', () => {
    expect(validateCdaEvent({ kind: 'calc', lang: 'fr' })).toEqual({ kind: 'calc', lang: 'fr', bike: null });
    expect(validateCdaEvent({ kind: 'analyze', lang: 'de', bike: 'tt' })).toEqual({
      kind: 'analyze',
      lang: 'de',
      bike: 'tt',
    });
  });
  it('accepte une demande de résultats par email, sans vélo', () => {
    expect(validateCdaEvent({ kind: 'email', lang: 'fr', bike: 'tt' })).toEqual({
      kind: 'email',
      lang: 'fr',
      bike: null,
    });
  });
  it('ignore le vélo pour un calcul', () => {
    expect(validateCdaEvent({ kind: 'calc', lang: 'fr', bike: 'tt' })?.bike).toBeNull();
  });
  it('refuse un type, une langue ou un vélo inconnus', () => {
    expect(validateCdaEvent({ kind: 'hack', lang: 'fr' })).toBeNull();
    expect(validateCdaEvent({ kind: 'calc', lang: 'xx' })).toBeNull();
    expect(validateCdaEvent({ kind: 'analyze', lang: 'fr', bike: 'gravel' })).toBeNull();
    expect(validateCdaEvent({ kind: 'analyze', lang: 'fr' })).toBeNull();
    expect(validateCdaEvent(null)).toBeNull();
    expect(validateCdaEvent(['calc'])).toBeNull();
  });
});
