// src/lib/account/activity.ts
//
// Onglet Activité de l'espace bike fitter : calculs sur les fittings lus dans
// Supabase (table `sessions`, session_type = 'fitting'). Mêmes conventions que
// l'application desktop (fitting_session_view.dart) : la première position
// sert de référence, la meilleure est celle de plus petit CdA, seuils de
// stabilité 90 / 80 / 70.

export type MonthCount = { year: number; month: number; count: number };

/** Nombre de fittings par mois calendaire (heure locale), du plus ancien au mois en cours. */
export function monthlyCounts(dates: string[], now: Date, months = 12): MonthCount[] {
  const out: MonthCount[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({ year: d.getFullYear(), month: d.getMonth(), count: 0 });
  }
  for (const iso of dates) {
    const d = new Date(iso);
    const slot = out.find((m) => m.year === d.getFullYear() && m.month === d.getMonth());
    if (slot) slot.count += 1;
  }
  return out;
}

/** Nombre de dates tombant dans le mois de `ref` (heure locale). */
export function countInMonth(dates: string[], ref: Date): number {
  return dates.filter((iso) => {
    const d = new Date(iso);
    return d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth();
  }).length;
}

export type PositionGap = {
  /** Écart de CdA en % par rapport à la première position ; null pour la référence. */
  gapPct: number | null;
  isRef: boolean;
  isBest: boolean;
};

/** Écarts de CdA des positions d'un fitting, dans l'ordre où elles ont été enregistrées. */
export function positionGaps(positions: { cda: number | null }[]): PositionGap[] {
  const ref = positions[0]?.cda ?? null;
  let bestIdx = -1;
  positions.forEach((p, i) => {
    if (p.cda != null && p.cda > 0 && (bestIdx < 0 || p.cda < positions[bestIdx].cda!)) bestIdx = i;
  });
  return positions.map((p, i) => ({
    gapPct: i === 0 || ref == null || ref <= 0 || p.cda == null ? null : ((p.cda - ref) / ref) * 100,
    isRef: i === 0,
    // « Meilleure » n'a de sens qu'avec au moins deux positions.
    isBest: positions.length > 1 && i === bestIdx,
  }));
}

export type StabilityLevel = 'excellent' | 'good' | 'average' | 'poor';

export function stabilityLevel(score: number): StabilityLevel {
  if (score > 90) return 'excellent';
  if (score >= 80) return 'good';
  if (score >= 70) return 'average';
  return 'poor';
}

/** Durée en « m:ss » ou « h:mm:ss ». */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
