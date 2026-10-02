// src/lib/cdaEvents.ts
//
// Compteur d'usage du calculateur de CdA : un événement par calcul (`calc`)
// et par analyse d'efficacité (`analyze`), sans aucune donnée personnelle
// (ni IP, ni identifiant). Lu dans Supabase par les vues
// cda_tool_activity_daily / _weekly / _monthly.

import { SUPPORTED_LOCALES } from '~/lib/i18n';

export const CDA_EVENT_KINDS = ['calc', 'analyze'] as const;
export type CdaEventKind = (typeof CDA_EVENT_KINDS)[number];

export type CdaEvent = { kind: CdaEventKind; lang: string; bike: 'road' | 'tt' | null };

/** Événement valide, ou `null` (corps refusé sans détail). */
export function validateCdaEvent(input: unknown): CdaEvent | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const { kind, lang, bike } = input as Record<string, unknown>;
  if (!(CDA_EVENT_KINDS as readonly unknown[]).includes(kind)) return null;
  if (!(SUPPORTED_LOCALES as readonly unknown[]).includes(lang)) return null;
  // Le vélo n'a de sens que pour une analyse.
  const b = kind === 'analyze' && (bike === 'road' || bike === 'tt') ? bike : null;
  if (kind === 'analyze' && b === null) return null;
  return { kind: kind as CdaEventKind, lang: lang as string, bike: b };
}
