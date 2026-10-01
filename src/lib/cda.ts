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

/**
 * CdA d'une position optimisée pour la morphologie du cycliste, calculé comme
 * dans l'app AeroX (aerox_rust_full/src/core/aero_core/aero_model/
 * surface_model.rs et assets/area_Cd_data.json) :
 *  - surface frontale debout = 0,31 × BSA de Du Bois (poids en kg, taille en
 *    cm), surface relevée = 0,9 × surface debout ;
 *  - Cd interpolé selon le rapport surface / surface relevée ;
 *  - CdA = Cd × surface + 0,035 m² (vélo).
 * Postures cibles :
 *  - vélo de route : surface relevée −15 % (S'entraîner à l'aérodynamisme) ;
 *  - vélo de contre-la-montre : position 6 du livre (prolongateurs, tête
 *    rentrée, tableau 2.1) : 0,33 m² pour un cycliste dont la surface debout
 *    du modèle vaut 0,587 m² (1,78 m, 72 kg), soit ≈ 0,56 de la surface
 *    debout. Le 0,6 de l'app (coef_optimal_vs_bsa) est moins aéro que cette
 *    position mesurée : ce n'est pas un plancher.
 */
export type Bike = 'road' | 'tt';
// Rapports à la surface relevée (= 0,9 × surface debout).
export const TARGET_POSTURE: Record<Bike, number> = { road: 0.85, tt: 0.56 / 0.9 };
const POSTURE_COEFS = [0.61, 0.75, 0.85, 1.0];
const CDS = [0.64, 0.7, 0.76, 0.8];
const CDA_BIKE = 0.035;

/** Surface frontale en position relevée (m²), modèle de l'app AeroX. */
export function uprightArea(riderWeightKg: number, heightCm: number): number {
  const bsa = 0.007184 * Math.pow(riderWeightKg, 0.425) * Math.pow(heightCm, 0.725);
  return 0.31 * bsa * 0.9;
}

/** Cd selon la posture (surface / surface relevée), interpolation linéaire de l'app. */
export function cdForPosture(ratio: number): number {
  if (ratio <= POSTURE_COEFS[0]) return CDS[0];
  if (ratio >= POSTURE_COEFS[POSTURE_COEFS.length - 1]) return CDS[CDS.length - 1];
  for (let i = 1; i < POSTURE_COEFS.length; i++) {
    if (ratio <= POSTURE_COEFS[i]) {
      const f = (ratio - POSTURE_COEFS[i - 1]) / (POSTURE_COEFS[i] - POSTURE_COEFS[i - 1]);
      return CDS[i - 1] + f * (CDS[i] - CDS[i - 1]);
    }
  }
  return CDS[CDS.length - 1];
}

/** CdA (m²) d'une position optimisée sur ce type de vélo, pour cette morphologie. */
export function optimalCda(bike: Bike, riderWeightKg: number, heightCm: number): number {
  const ratio = TARGET_POSTURE[bike];
  return cdForPosture(ratio) * uprightArea(riderWeightKg, heightCm) * ratio + CDA_BIKE;
}

type Ride = { massKg: number; slopePct: number; altitudeM?: number; temperatureC?: number };

/** Puissance aux pédales (W) nécessaire pour rouler à `speedKmh` avec `cda`. */
export function powerForSpeed(cda: number, speedKmh: number, ride: Ride): number {
  const v = speedKmh / 3.6;
  const theta = Math.atan(ride.slopePct / 100);
  const rho = airDensity(ride.altitudeM ?? 0, ride.temperatureC ?? 15);
  const wheel = 0.5 * rho * cda * v ** 3 + CRR * ride.massKg * G * v + ride.massKg * G * Math.sin(theta) * v;
  return wheel / ETA;
}

/** Vitesse (km/h) atteinte avec `power` et `cda` : la puissance croît avec la vitesse, dichotomie. */
export function speedForPower(cda: number, power: number, ride: Ride): number {
  let lo = 0.1;
  let hi = 150;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (powerForSpeed(cda, mid, ride) > power) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Ce que coûte la position actuelle face à une position optimisée sur ce type
 * de vélo, pour cette morphologie : km/h gagnés à la même puissance, watts
 * économisés à la même vitesse. `alreadyOptimal` si le CdA estimé est déjà au
 * niveau de la cible.
 */
export function optimizedGain(cda: number, input: CdaInput, bike: Bike, riderWeightKg: number, heightCm: number) {
  const target = optimalCda(bike, riderWeightKg, heightCm);
  if (target >= cda)
    return { targetCda: target, alreadyOptimal: true, speedKmh: input.speedKmh, gainKmh: 0, wattsSaved: 0 };
  const speed = speedForPower(target, input.power, input);
  const watts = input.power - powerForSpeed(target, input.speedKmh, input);
  return {
    targetCda: target,
    alreadyOptimal: false,
    speedKmh: speed,
    gainKmh: speed - input.speedKmh,
    wattsSaved: watts,
  };
}
