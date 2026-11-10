import { describe, it, expect } from 'vitest';
import { compareVersions, downloadsOpen, DOWNLOADS, NEXT_RELEASE, releaseLinksReady } from '../src/config/downloads';

describe('téléchargements suspendus jusqu’à la nouvelle version', () => {
  it('compareVersions', () => {
    expect(compareVersions('1.4.0', '1.4.0')).toBe(0);
    expect(compareVersions('1.10.0', '1.4.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.4.0')).toBeLessThan(0);
    expect(compareVersions('2.0', '1.9.9')).toBeGreaterThan(0);
  });

  it('ouverture le 7 novembre 2026 à 00:00, heure de Paris', () => {
    expect(new Date(NEXT_RELEASE.opensAt).toISOString()).toBe('2026-11-06T23:00:00.000Z');
  });

  it('liens en 2.0.0 (= min_required) : fermé avant la date, ouvert après', () => {
    expect(compareVersions(DOWNLOADS.version, NEXT_RELEASE.minVersion)).toBeGreaterThanOrEqual(0);
    expect(releaseLinksReady()).toBe(true);
    expect(downloadsOpen(NEXT_RELEASE.opensAt - 1)).toBe(false);
    expect(downloadsOpen(NEXT_RELEASE.opensAt + 86_400_000)).toBe(true);
  });
});
