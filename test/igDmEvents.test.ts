import { describe, expect, it } from 'vitest';
import { validateIgDmEvent } from '~/lib/igDmEvents';

describe('validateIgDmEvent', () => {
  it('accepts a visit and each conversion', () => {
    for (const kind of ['visit', 'calc', 'book', 'signup']) {
      expect(validateIgDmEvent({ kind, campaign: 'calculator', content: 'rm05v2-h1l1a-en' })).toEqual({
        kind,
        campaign: 'calculator',
        content: 'rm05v2-h1l1a-en',
      });
    }
  });

  it('drops unknown fields', () => {
    expect(validateIgDmEvent({ kind: 'book', campaign: 'guide', content: 'race2', email: 'a@b.c' })).toEqual({
      kind: 'book',
      campaign: 'guide',
      content: 'race2',
    });
  });

  it('refuses anything outside the closed lists or the reel format', () => {
    expect(validateIgDmEvent({ kind: 'buy', campaign: 'guide', content: 'race2' })).toBeNull();
    expect(validateIgDmEvent({ kind: 'visit', campaign: 'webinar', content: 'race2' })).toBeNull();
    expect(validateIgDmEvent({ kind: 'visit', campaign: 'guide', content: 'Race2' })).toBeNull();
    expect(validateIgDmEvent({ kind: 'visit', campaign: 'guide', content: '<script>' })).toBeNull();
    expect(validateIgDmEvent({ kind: 'visit', campaign: 'guide', content: 'a'.repeat(64) })).toBeNull();
    expect(validateIgDmEvent({ kind: 'visit', campaign: 'guide' })).toBeNull();
    expect(validateIgDmEvent(null)).toBeNull();
    expect(validateIgDmEvent([])).toBeNull();
  });
});
