import { describe, expect, it } from 'vitest';
import { isBotUserAgent, validateIgDmEvent } from '~/lib/igDmEvents';

describe('validateIgDmEvent', () => {
  it('accepts a visit and each conversion', () => {
    for (const kind of ['visit', 'calc', 'book', 'signup']) {
      expect(validateIgDmEvent({ kind, campaign: 'calculator', content: 'rm05v2-h1l1a-en' })).toEqual({
        medium: 'dm',
        kind,
        campaign: 'calculator',
        content: 'rm05v2-h1l1a-en',
      });
    }
  });

  it('drops unknown fields', () => {
    expect(validateIgDmEvent({ kind: 'book', campaign: 'guide', content: 'race2', email: 'a@b.c' })).toEqual({
      medium: 'dm',
      kind: 'book',
      campaign: 'guide',
      content: 'race2',
    });
  });

  it('accepts the bio link', () => {
    expect(validateIgDmEvent({ medium: 'bio', kind: 'visit', campaign: 'bio', content: 'bio' })).toEqual({
      medium: 'bio',
      kind: 'visit',
      campaign: 'bio',
      content: 'bio',
    });
    expect(validateIgDmEvent({ medium: 'story', kind: 'visit', campaign: 'bio', content: 'bio' })).toBeNull();
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

describe('isBotUserAgent', () => {
  it('keeps real browsers, including the Instagram in-app browser', () => {
    expect(
      isBotUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.0'
      )
    ).toBe(false);
    expect(
      isBotUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36')
    ).toBe(false);
  });

  it('drops link checkers, previews and headless browsers', () => {
    expect(isBotUserAgent('facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)')).toBe(true);
    expect(isBotUserAgent('meta-externalagent/1.1')).toBe(true);
    expect(
      isBotUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/130.0 Safari/537.36')
    ).toBe(true);
    expect(isBotUserAgent('')).toBe(true);
    expect(isBotUserAgent(null)).toBe(true);
  });
});
