import { describe, it, expect } from 'vitest';
import { cdaCategory, estimateCdA } from '../src/lib/cda';

describe('estimateCdA', () => {
  it('200 W à 30 km/h sur le plat, 80 kg : position relevée (~0,47 m²)', () => {
    // roulement 0,005·80·9,81·8,33 ≈ 32,7 W ; aéro ≈ 167,3 W ; ½ρv³ ≈ 354,4
    expect(estimateCdA({ power: 200, speedKmh: 30, massKg: 80, slopePct: 0 })).toBeCloseTo(0.472, 2);
  });
  it('250 W à 40 km/h, 75 kg : position contre-la-montre (~0,23 m²)', () => {
    const cda = estimateCdA({ power: 250, speedKmh: 40, massKg: 75, slopePct: 0 })!;
    expect(cda).toBeGreaterThan(0.2);
    expect(cda).toBeLessThan(0.25);
  });
  it('la pente consomme de la puissance', () => {
    const flat = estimateCdA({ power: 250, speedKmh: 30, massKg: 80, slopePct: 0 })!;
    const up = estimateCdA({ power: 250, speedKmh: 30, massKg: 80, slopePct: 1 })!;
    expect(up).toBeLessThan(flat);
  });
  it('null si la puissance ne couvre pas le roulement et la pente, ou valeurs absurdes', () => {
    expect(estimateCdA({ power: 100, speedKmh: 30, massKg: 80, slopePct: 5 })).toBeNull();
    expect(estimateCdA({ power: 200, speedKmh: 0, massKg: 80, slopePct: 0 })).toBeNull();
    expect(estimateCdA({ power: NaN, speedKmh: 30, massKg: 80, slopePct: 0 })).toBeNull();
  });
});

describe('cdaCategory', () => {
  it('suit le tableau des valeurs typiques', () => {
    expect(cdaCategory(0.45)).toBe('city');
    expect(cdaCategory(0.33)).toBe('road_hoods');
    expect(cdaCategory(0.29)).toBe('road_drops');
    expect(cdaCategory(0.23)).toBe('tt');
    expect(cdaCategory(0.19)).toBe('pro_tt');
    expect(cdaCategory(0.17)).toBe('track');
  });
});
