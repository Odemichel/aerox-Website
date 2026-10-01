import { describe, it, expect } from 'vitest';
import {
  airDensity,
  cdaCategory,
  cdForPosture,
  estimateCdA,
  optimalCda,
  optimizedGain,
  powerForSpeed,
  speedForPower,
  uprightArea,
} from '../src/lib/cda';

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

describe('modèle morphologique (app AeroX)', () => {
  it('surface relevée du cycliste du livre (1,78 m, 72 kg) ≈ 0,53 m² (livre : 0,52)', () => {
    expect(uprightArea(72, 178)).toBeCloseTo(0.528, 2);
  });
  it('Cd interpolé selon la posture (area_Cd_data.json)', () => {
    expect(cdForPosture(1)).toBeCloseTo(0.8, 6);
    expect(cdForPosture(0.85)).toBeCloseTo(0.76, 6);
    expect(cdForPosture(0.5)).toBeCloseTo(0.64, 6);
    expect(cdForPosture(0.68)).toBeCloseTo(0.67, 6);
  });
  it('CdA optimal : route ≈ 0,38 m², contre-la-montre ≈ 0,27 m²', () => {
    expect(optimalCda('road', 72, 178)).toBeCloseTo(0.376, 2);
    expect(optimalCda('tt', 72, 178)).toBeCloseTo(0.269, 2);
  });
});

describe('optimizedGain', () => {
  const ride = { power: 200, speedKmh: 30, massKg: 80, slopePct: 0 };
  const cda = estimateCdA(ride)!;

  it('powerForSpeed et speedForPower sont réciproques, et retrouvent la sortie saisie', () => {
    expect(powerForSpeed(cda, 30, ride)).toBeCloseTo(200, 6);
    expect(speedForPower(cda, 200, ride)).toBeCloseTo(30, 4);
  });
  it('position relevée (CdA ≈ 0,455) : gain vers la cible route, plus grand vers la cible CLM', () => {
    const road = optimizedGain(cda, ride, 'road', 72, 178);
    const tt = optimizedGain(cda, ride, 'tt', 72, 178);
    expect(road.alreadyOptimal).toBe(false);
    expect(road.gainKmh).toBeGreaterThan(1);
    expect(road.wattsSaved).toBeGreaterThan(20);
    expect(tt.gainKmh).toBeGreaterThan(road.gainKmh);
  });
  it('déjà au niveau de la cible : pas de gain annoncé', () => {
    const fast = { power: 250, speedKmh: 42, massKg: 80, slopePct: 0 };
    const g = optimizedGain(estimateCdA(fast)!, fast, 'road', 72, 178);
    expect(g.alreadyOptimal).toBe(true);
    expect(g.gainKmh).toBe(0);
  });
});
