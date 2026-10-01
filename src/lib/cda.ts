// src/lib/cda.ts
//
// Estimation du CdA à partir d'une sortie : la formule affichée sur /cda,
// η·P = ½ρ·CdA·v³ + Crr·m·g·v + m·g·sin(θ)·v, résolue pour CdA. Sans vent,
// vitesse stable ; ρ dépend de l'altitude et de la température.

export const G = 9.81; // m/s²
export const CRR = 0.005; // bon revêtement
export const ETA = 0.97; // rendement de transmission (pertes chaîne, roulements)
export const RHO_SEA_LEVEL = 1.225; // kg/m³, 0 m et 15 °C

/**
 * Masse volumique de l'air (kg/m³) : pression de l'atmosphère standard à
 * l'altitude donnée, loi des gaz parfaits à la température donnée.
 */
export function airDensity(altitudeM = 0, temperatureC = 15): number {
  const pressure = 101325 * Math.pow(1 - 2.25577e-5 * altitudeM, 5.25588); // Pa
  return pressure / (287.05 * (temperatureC + 273.15));
}

export type CdaInput = {
  power: number;
  speedKmh: number;
  massKg: number;
  slopePct: number;
  altitudeM?: number;
  temperatureC?: number;
};

/** CdA estimé en m², ou `null` si les valeurs n'ont pas de sens physique. */
export function estimateCdA({
  power,
  speedKmh,
  massKg,
  slopePct,
  altitudeM = 0,
  temperatureC = 15,
}: CdaInput): number | null {
  const v = speedKmh / 3.6;
  const values = [power, v, massKg, slopePct, altitudeM, temperatureC];
  if (!values.every(Number.isFinite) || v <= 0 || massKg <= 0 || power <= 0) return null;
  if (altitudeM < -500 || altitudeM > 5000 || temperatureC < -30 || temperatureC > 50) return null;
  const theta = Math.atan(slopePct / 100);
  const aeroPower = ETA * power - CRR * massKg * G * v - massKg * G * Math.sin(theta) * v;
  if (aeroPower <= 0) return null;
  return aeroPower / (0.5 * airDensity(altitudeM, temperatureC) * v ** 3);
}

/** Ligne du tableau « valeurs typiques » de /cda la plus proche (clés cda.values.*). */
export function cdaCategory(cda: number): string {
  if (cda >= 0.36) return 'city';
  if (cda >= 0.32) return 'road_hoods';
  if (cda >= 0.26) return 'road_drops';
  if (cda >= 0.21) return 'tt';
  if (cda >= 0.18) return 'pro_tt';
  return 'track';
}
