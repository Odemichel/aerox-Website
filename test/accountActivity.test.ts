import { describe, it, expect } from 'vitest';
import { monthBounds, toMonthCounts } from '../src/lib/account/activity';

describe('activité par mois', () => {
  const now = new Date(2026, 8, 26); // 26 septembre 2026

  it('monthBounds : 13 débuts de mois locaux, du plus ancien au mois suivant', () => {
    const b = monthBounds(now);
    expect(b).toHaveLength(13);
    expect(b[0]).toBe(new Date(2025, 9, 1).toISOString());
    expect(b[11]).toBe(new Date(2026, 8, 1).toISOString());
    expect(b[12]).toBe(new Date(2026, 9, 1).toISOString());
  });

  it('toMonthCounts : 12 mois, du plus ancien au mois en cours', () => {
    const counts = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 2];
    const m = toMonthCounts(counts, now);
    expect(m).toHaveLength(12);
    expect(m[0]).toEqual({ year: 2025, month: 9, count: 1 });
    expect(m[10]).toEqual({ year: 2026, month: 7, count: 3 });
    expect(m[11]).toEqual({ year: 2026, month: 8, count: 2 });
  });

  it('toMonthCounts : comptes manquants à 0', () => {
    expect(toMonthCounts([], now).every((m) => m.count === 0)).toBe(true);
  });
});
