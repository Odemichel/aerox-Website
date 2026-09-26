// src/lib/account/activity.ts
//
// Onglet Activité de l'espace bike fitter : comptes par mois des fittings lus
// dans Supabase (table `sessions`, session_type = 'fitting') et des cyclistes.

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
