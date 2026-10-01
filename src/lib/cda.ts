// src/lib/cda.ts
//
// Estimation de la CdA à partir d'une sortie : la formule affichée sur /cda,
// P = ½ρ·CdA·v³ + Crr·m·g·v + m·g·sin(θ)·v, résolue pour CdA. Sans vent,
// pertes de transmission ignorées, vitesse stable.

export const RHO = 1.225; // kg/m³, air au niveau de la mer
export const G = 9.81; // m/s²
export const CRR = 0.005; // bon revêtement

export type CdaInput = { power: number; speedKmh: number; massKg: number; slopePct: number };

/** CdA estimée en m², ou `null` si les valeurs n'ont pas de sens physique. */
export function estimateCdA({ power, speedKmh, massKg, slopePct }: CdaInput): number | null {
  const v = speedKmh / 3.6;
  if (![power, v, massKg, slopePct].every(Number.isFinite) || v <= 0 || massKg <= 0 || power <= 0) return null;
  const theta = Math.atan(slopePct / 100);
  const aeroPower = power - CRR * massKg * G * v - massKg * G * Math.sin(theta) * v;
  if (aeroPower <= 0) return null;
  return aeroPower / (0.5 * RHO * v ** 3);
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
