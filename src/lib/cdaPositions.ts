// Positions de référence des tableaux de /cda (clés cda.values.*, mêmes clés que
// cdaCategory dans src/lib/cda.ts : ne pas les renommer sans lui).
//
// - cda : fourchette courante, alignée sur les libellés cda.values.*.value.
// - area : surface frontale A mesurée avec AeroX sur un même cycliste
//   (1,78 m, 72 kg), O. Demichel, « S'entraîner à l'aérodynamisme » (2026),
//   tableau 2.1. Ligne 6 : position de la ligne 5, le gain vient du Cd.
export const CDA_POSITIONS = [
  { n: 1, key: 'city', area: 0.52, cda: [0.4, 0.5] },
  { n: 2, key: 'road_hoods', area: 0.44, cda: [0.3, 0.35] },
  { n: 3, key: 'road_drops', area: 0.42, cda: [0.27, 0.32] },
  { n: 4, key: 'tt', area: 0.36, cda: [0.2, 0.25] },
  { n: 5, key: 'pro_tt', area: 0.33, cda: [0.18, 0.22] },
  { n: 6, key: 'track', area: 0.33, cda: [0.17, 0.2], approx: true },
] as const;

/** Puissance absorbée par l'air : P = ½ ρ CdA v³ (air à 1,225 kg/m³, sans vent). */
export const aeroWatts = (cda: number, kmh: number, rho = 1.225) => Math.round(0.5 * rho * cda * (kmh / 3.6) ** 3);
