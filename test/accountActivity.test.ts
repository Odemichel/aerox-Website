import { describe, it, expect } from 'vitest';
import { countInMonth, monthlyCounts } from '../src/lib/account/activity';

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
