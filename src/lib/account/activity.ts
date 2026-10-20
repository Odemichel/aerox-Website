// src/lib/account/activity.ts
//
// Onglet Activité des espaces bike fitter et cycliste : totaux et comptes par
// mois calculés par la base (RPC `my_activity`, migration
// 20261020090000_my_activity.sql). Le découpage en mois suit l'heure locale
// du navigateur : le client envoie les débuts de mois, la base compte.

export type MonthCount = { year: number; month: number; count: number };

/** Une série renvoyée par `my_activity` : `months[i]` = intervalle [bornes[i], bornes[i + 1]). */
export type ActivitySeries = { total: number; first_at: string | null; months: number[] };

export type MyActivity = Record<
  'training' | 'fittings_received' | 'fittings_done' | 'clients' | 'diagnostics',
  ActivitySeries
>;

/** Débuts des `months` derniers mois (heure locale) + début du mois suivant, en ISO. */
export function monthBounds(now: Date, months = 12): string[] {
  const out: string[] = [];
  for (let i = months - 1; i >= -1; i--) {
    out.push(new Date(now.getFullYear(), now.getMonth() - i, 1).toISOString());
  }
  return out;
}

/** Comptes de la base rattachés à leur mois, du plus ancien au mois en cours. */
export function toMonthCounts(counts: number[], now: Date, months = 12): MonthCount[] {
  const out: MonthCount[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({ year: d.getFullYear(), month: d.getMonth(), count: counts[months - 1 - i] ?? 0 });
  }
  return out;
}
