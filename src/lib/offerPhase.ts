// src/lib/offerPhase.ts
//
// Textes du Diagnostic qui changent avec le calendrier, sans redéploiement :
//  - `pre`  : avant la sortie (DIAGNOSTIC_AVAILABLE_AT) — pré-réservation ;
//  - `live` : diagnostic disponible, offre de lancement en cours ;
//  - `full` : offre terminée (LAUNCH_OFFER_END) — prix plein.
// Au rendu, la phase du moment est écrite directement (pages statiques
// comprises, figées au build) ; dans le navigateur, OfferPhases.astro remplace
// le contenu des éléments `data-phase` quand une date est passée depuis le build.

import { DIAGNOSTIC_AVAILABLE_AT } from '~/config/diagnostic';
import { LAUNCH_OFFER_END } from '~/config/offer';

export type OfferPhase = 'pre' | 'live' | 'full';

export function offerPhase(now: number = Date.now()): OfferPhase {
  if (now >= Date.parse(LAUNCH_OFFER_END)) return 'full';
  if (now >= DIAGNOSTIC_AVAILABLE_AT.getTime()) return 'live';
  return 'pre';
}

const attr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * HTML d'un texte à trois phases (`full` vaut `live` par défaut). Les valeurs
 * sont du HTML de nos dictionnaires, jamais une saisie utilisateur.
 */
export function phased(pre: string, live: string, full: string = live): string {
  const now = { pre, live, full }[offerPhase()];
  return `<span data-phase data-pre="${attr(pre)}" data-live="${attr(live)}" data-full="${attr(full)}">${now}</span>`;
}
