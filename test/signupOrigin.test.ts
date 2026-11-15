import { describe, expect, it } from 'vitest';
import { origineField, signupOrigin } from '~/lib/signupOrigin';

const req = (v?: string) =>
  new Request('https://aeroxbefaster.com/api/rider-signup/', v ? { headers: { 'X-Aerox-Origin': v } } : {});

describe('signupOrigin', () => {
  it('keeps the origin computed by the page', () => {
    expect(signupOrigin(req('instagram-dm/rm04v2-h5l5a-en'))).toBe('instagram-dm/rm04v2-h5l5a-en');
    expect(signupOrigin(req('google'))).toBe('google');
    expect(origineField(req('instagram-bio/home'))).toEqual({ origine: 'instagram-bio/home' });
  });

  it('refuses anything else', () => {
    expect(signupOrigin(req())).toBeNull();
    expect(signupOrigin(req('https://evil.example/?q=1'))).toBeNull();
    expect(signupOrigin(req('<script>'))).toBeNull();
    expect(signupOrigin(req('a'.repeat(65)))).toBeNull();
    expect(origineField(req())).toEqual({});
  });
});
