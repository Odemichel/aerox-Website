import { describe, it, expect } from 'vitest';
import { airDensity, cdaCategory, estimateCdA, optimizedGain, powerForSpeed, speedForPower } from '../src/lib/cda';

describe('estimateCdA', () => {
  it('200 W à 30 km/h sur le plat, 80 kg : position relevée (~0,46 m²)', () => {
    // 0,97·200 = 194 W ; roulement 0,005·80·9,81·8,33 ≈ 32,7 W ; aéro ≈ 161,3 W ; ½ρv³ ≈ 354,4
    expect(estimateCdA({ power: 200, speedKmh: 30, massKg: 80, slopePct: 0 })).toBeCloseTo(0.455, 2);
  });
  it("l'air plus léger en altitude ou par temps chaud donne un CdA plus élevé", () => {
    const base = { power: 200, speedKmh: 30, massKg: 80, slopePct: 0 };
    const sea = estimateCdA(base)!;
    expect(estimateCdA({ ...base, altitudeM: 1500 })!).toBeGreaterThan(sea);
    expect(estimateCdA({ ...base, temperatureC: 30 })!).toBeGreaterThan(sea);
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

describe('airDensity', () => {
  it('1,225 kg/m³ au niveau de la mer à 15 °C ; atmosphère standard à 1 500 m', () => {
    expect(airDensity(0, 15)).toBeCloseTo(1.225, 3);
    // Atmosphère standard à 1 500 m : 84 556 Pa et 5,25 °C → 1,058 kg/m³.
    expect(airDensity(1500, 5.25)).toBeCloseTo(1.058, 2);
    // Même altitude à 15 °C : 84 556 / (287,05 × 288,15) ≈ 1,022 kg/m³.
    expect(airDensity(1500, 15)).toBeCloseTo(1.022, 2);
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

describe('optimizedGain', () => {
  const ride = { power: 200, speedKmh: 30, massKg: 80, slopePct: 0 };
  const cda = estimateCdA(ride)!;

  it('powerForSpeed et speedForPower sont réciproques, et retrouvent la sortie saisie', () => {
    expect(powerForSpeed(cda, 30, ride)).toBeCloseTo(200, 6);
    expect(speedForPower(cda, 200, ride)).toBeCloseTo(30, 4);
  });
  it('−15 % de CdA : ~+1,4 km/h à 200 W et ~25 W économisés à 30 km/h', () => {
    // ½ρv³ ≈ 354,4 ; ΔCdA = 0,15 × 0,455 ≈ 0,068 → 24,2 W à la roue, /0,97 ≈ 24,9 W.
    const g = optimizedGain(cda, ride);
    expect(g.targetCda).toBeCloseTo(cda * 0.85, 6);
    expect(g.wattsSaved).toBeCloseTo(24.9, 0);
    expect(g.gainKmh).toBeGreaterThan(1.2);
    expect(g.gainKmh).toBeLessThan(1.7);
  });
  it('contre-la-montre : référence −8 %, gain plus faible que sur route', () => {
    const tt = optimizedGain(cda, ride, 'tt');
    expect(tt.targetCda).toBeCloseTo(cda * 0.92, 6);
    expect(tt.wattsSaved).toBeLessThan(optimizedGain(cda, ride, 'road').wattsSaved);
  });
});
