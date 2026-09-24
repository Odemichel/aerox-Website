import { describe, it, expect } from 'vitest';
import { safeRedirect } from '../src/lib/safeRedirect';

const FALLBACK = '/fr/inscription/dashboard/';

describe('safeRedirect', () => {
  it('accepte un chemin relatif simple', () => {
    expect(safeRedirect('/fr/#pricing', FALLBACK)).toBe('/fr/#pricing');
  });

  it('accepte un chemin avec query', () => {
    expect(safeRedirect('/fr/telechargement/success/?product=diagnostic', FALLBACK)).toBe(
      '/fr/telechargement/success/?product=diagnostic'
    );
  });

  it('retombe sur le fallback si absent', () => {
    expect(safeRedirect(null, FALLBACK)).toBe(FALLBACK);
    expect(safeRedirect(undefined, FALLBACK)).toBe(FALLBACK);
    expect(safeRedirect('', FALLBACK)).toBe(FALLBACK);
  });

  it('refuse une URL absolue', () => {
    expect(safeRedirect('https://evil.example/phish', FALLBACK)).toBe(FALLBACK);
    expect(safeRedirect('http://evil.example', FALLBACK)).toBe(FALLBACK);
  });

  it('refuse une URL protocol-relative', () => {
    expect(safeRedirect('//evil.example/phish', FALLBACK)).toBe(FALLBACK);
  });

  it('refuse les doubles slashs même encodés ou échappés', () => {
    expect(safeRedirect('/\\evil.example', FALLBACK)).toBe(FALLBACK);
    expect(safeRedirect('/%2F%2Fevil.example', FALLBACK)).toBe(FALLBACK);
    expect(safeRedirect('/a//b', FALLBACK)).toBe(FALLBACK);
  });

  it('refuse un chemin qui ne commence pas par /', () => {
    expect(safeRedirect('fr/#pricing', FALLBACK)).toBe(FALLBACK);
    expect(safeRedirect('../admin', FALLBACK)).toBe(FALLBACK);
  });

  it('refuse les schémas exotiques', () => {
    expect(safeRedirect('javascript:alert(1)', FALLBACK)).toBe(FALLBACK);
    expect(safeRedirect('data:text/html,<script>', FALLBACK)).toBe(FALLBACK);
  });

  it('refuse les caractères de contrôle et les retours à la ligne', () => {
    expect(safeRedirect('/fr/\nSet-Cookie: x=1', FALLBACK)).toBe(FALLBACK);
    expect(safeRedirect('/fr/\tadmin', FALLBACK)).toBe(FALLBACK);
  });

  it('refuse un chemin trop long', () => {
    expect(safeRedirect('/' + 'a'.repeat(2048), FALLBACK)).toBe(FALLBACK);
  });

  it('refuse les caractères de contrôle encodés, révélés seulement après décodage', () => {
    expect(safeRedirect('/%00javascript:alert(1)', FALLBACK)).toBe(FALLBACK);
    expect(safeRedirect('/fr/%0ASet-Cookie: x=1', FALLBACK)).toBe(FALLBACK);
  });
});
