import { describe, it, expect } from 'vitest';
import { countInMonth, formatDuration, monthlyCounts, positionGaps, stabilityLevel } from '../src/lib/account/activity';

describe('monthlyCounts', () => {
  const now = new Date(2026, 8, 26); // 26 septembre 2026

  it('12 mois, du plus ancien au mois en cours', () => {
    const m = monthlyCounts([], now);
    expect(m).toHaveLength(12);
    expect(m[0]).toEqual({ year: 2025, month: 9, count: 0 });
    expect(m[11]).toEqual({ year: 2026, month: 8, count: 0 });
  });

  it('compte par mois et ignore les dates hors fenêtre', () => {
    const iso = (y: number, mo: number, d: number) => new Date(y, mo, d, 12).toISOString();
    const m = monthlyCounts([iso(2026, 8, 1), iso(2026, 8, 20), iso(2026, 7, 31), iso(2024, 0, 1)], now);
    expect(m[11].count).toBe(2);
    expect(m[10].count).toBe(1);
    expect(m.reduce((a, x) => a + x.count, 0)).toBe(3);
  });

  it('countInMonth', () => {
    const d = new Date(2026, 7, 10, 12).toISOString();
    expect(countInMonth([d, d], new Date(2026, 7, 1))).toBe(2);
    expect(countInMonth([d], now)).toBe(0);
  });
});

describe('positionGaps', () => {
  it('première = référence, meilleure = plus petit CdA', () => {
    const g = positionGaps([{ cda: 0.3 }, { cda: 0.27 }, { cda: 0.33 }]);
    expect(g[0]).toEqual({ gapPct: null, isRef: true, isBest: false });
    expect(g[1].isBest).toBe(true);
    expect(g[1].gapPct).toBeCloseTo(-10);
    expect(g[2].gapPct).toBeCloseTo(10);
  });

  it('la référence peut être la meilleure ; une seule position : pas de badge', () => {
    expect(positionGaps([{ cda: 0.25 }, { cda: 0.3 }])[0].isBest).toBe(true);
    expect(positionGaps([{ cda: 0.25 }])[0].isBest).toBe(false);
  });

  it('CdA manquant : pas d’écart', () => {
    const g = positionGaps([{ cda: null }, { cda: 0.3 }]);
    expect(g[1].gapPct).toBeNull();
    expect(g[1].isBest).toBe(true);
  });
});

describe('stabilityLevel / formatDuration', () => {
  it('seuils de l’application desktop', () => {
    expect(stabilityLevel(95)).toBe('excellent');
    expect(stabilityLevel(90)).toBe('good');
    expect(stabilityLevel(80)).toBe('good');
    expect(stabilityLevel(70)).toBe('average');
    expect(stabilityLevel(69.9)).toBe('poor');
  });

  it('durées', () => {
    expect(formatDuration(472)).toBe('7:52');
    expect(formatDuration(5)).toBe('0:05');
    expect(formatDuration(3725)).toBe('1:02:05');
  });
});
