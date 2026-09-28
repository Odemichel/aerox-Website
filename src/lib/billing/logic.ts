// src/lib/billing/logic.ts
//
// Règles de facturation bike fitter sans effet de bord : ce que vaut une
// offre en prix Stripe, quel plan déduire d'un abonnement, quel accès donner
// selon son statut. Les routes et le webhook n'y ajoutent que les appels
// réseau ; tout ce qui décide est ici, et testé (test/billingLogic.test.ts).

import { BF_AVAILABLE_AT, LAUNCH_OFFER, LOOKUP, TRIAL_DAYS, UPGRADE_HINT_AT } from './catalog';
import { NEXT_RELEASE } from '../../config/downloads';

// `pack` : plan historique (crédits prépayés), plus vendu ; conservé pour les
// comptes et les crédits existants. `payg` et `studio` (grille du 24/09/2026,
// jamais vendue) restent reconnus par la base, plus par le site.
export type Plan = 'trial' | 'pack' | 'essential' | 'unlimited' | 'unlimited_launch' | 'legacy';
export type Offer = 'essential' | 'unlimited' | 'unlimited_annual' | 'unlimited_launch' | 'unlimited_launch_annual';
export type BillingStatus = 'active' | 'past_due' | 'read_only';

export const OFFERS: readonly Offer[] = [
  'essential',
  'unlimited',
  'unlimited_annual',
  'unlimited_launch',
  'unlimited_launch_annual',
];

/** Offre proposée par défaut au démarrage de l'essai. */
export const DEFAULT_OFFER: Offer = 'essential';

/** Offres de lancement : 20 places partagées, souscription jusqu'au 31/12/2026. */
export const LAUNCH_OFFERS: readonly Offer[] = ['unlimited_launch', 'unlimited_launch_annual'];

/** Offres facturées à l'année. */
export const ANNUAL_OFFERS: readonly Offer[] = ['unlimited_annual', 'unlimited_launch_annual'];

export const isOffer = (raw: unknown): raw is Offer => typeof raw === 'string' && OFFERS.includes(raw as Offer);

/** Prix Stripe (lookup_key) de chaque offre, dans l'ordre des lignes Checkout. */
export const OFFER_LOOKUP_KEYS: Record<Offer, string[]> = {
  // Deux lignes : le forfait (20 €/mois) et le prix mesuré (15 € l'analyse).
  essential: [LOOKUP.essentialBase, LOOKUP.essentialUsage],
  unlimited: [LOOKUP.unlimited],
  unlimited_annual: [LOOKUP.unlimitedYear],
  unlimited_launch: [LOOKUP.unlimitedLaunch],
  unlimited_launch_annual: [LOOKUP.unlimitedLaunchYear],
};

/** Prix mesurés : pas de quantité dans Checkout ni dans un changement d'offre. */
export const METERED_LOOKUP_KEYS: readonly string[] = [LOOKUP.essentialUsage];

/**
 * Rang d'une offre, du moins au plus engageant. Monter est immédiat (au
 * prorata) ; descendre prend effet à la fin de la période déjà payée, pour
 * qu'un passage en Illimité le temps d'un mois chargé ne se rembourse pas.
 */
export const OFFER_RANK: Record<Offer, number> = {
  essential: 0,
  unlimited_launch: 1,
  unlimited: 2,
  // Annuel : engagement le plus long. Le quitter pour un mensuel prend
  // effet à la fin de l'année déjà payée.
  unlimited_launch_annual: 3,
  unlimited_annual: 4,
};

export const isDowngrade = (from: Offer, to: Offer) => OFFER_RANK[to] < OFFER_RANK[from];

export const GRACE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Paramètres de démarrage d'un abonnement (Checkout `subscription_data`). */
export type SubscriptionStart =
  | { billing_cycle_anchor: number; proration_behavior: 'none' }
  | { trial_end: number }
  | Record<string, never>;

/** Même instant, un mois calendaire plus tard (UTC). */
function oneMonthLater(ms: number): number {
  const d = new Date(ms);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.getTime();
}

/**
 * Fin de l'essai gratuit : 14 jours comptés à partir du moment où
 * l'application est téléchargeable (sortie de la nouvelle version,
 * `NEXT_RELEASE.opensAt`), et jamais avant la mise à disposition des offres.
 * Souscrire avant la sortie ne consomme donc aucun jour d'essai.
 */
export function trialEnd(nowMs: number): number {
  const start = Math.max(nowMs, NEXT_RELEASE.opensAt);
  return Math.floor(Math.max(start + TRIAL_DAYS * DAY_MS, BF_AVAILABLE_AT) / 1000);
}

/**
 * Démarrage d'un abonnement.
 *
 *  - Premier abonnement (essai jamais utilisé) : 14 jours d'essai gratuit
 *    (`trial_end`), carte enregistrée, premier prélèvement à la fin de
 *    l'essai sauf résiliation avant. Souscrit avant le 1er novembre 2026,
 *    l'essai court au moins jusqu'à cette date.
 *  - Essai déjà utilisé : pas de nouvel essai. Avant le 1er novembre, la
 *    facturation est ancrée à cette date sans prorata
 *    (`billing_cycle_anchor` + `proration_behavior: none`) ; Stripe refuse
 *    un ancrage au-delà de la première échéance naturelle (un mois pour un
 *    prix mensuel), d'où le repli sur `trial_end` plus d'un mois avant.
 */
export function subscriptionStart(nowMs: number, annual: boolean, withTrial: boolean): SubscriptionStart {
  if (withTrial) return { trial_end: trialEnd(nowMs) };
  if (BF_AVAILABLE_AT - nowMs <= 60 * 60 * 1000) return {};
  const anchor = Math.floor(BF_AVAILABLE_AT / 1000);
  if (annual || oneMonthLater(nowMs) - 60 * 60 * 1000 >= BF_AVAILABLE_AT) {
    return { billing_cycle_anchor: anchor, proration_behavior: 'none' };
  }
  return BF_AVAILABLE_AT - nowMs > 3 * DAY_MS ? { trial_end: anchor } : {};
}

/** L'offre de lancement est-elle encore ouverte à la souscription ? */
export function launchOfferOpen(nowMs: number, seatsRemaining: number): boolean {
  return nowMs < LAUNCH_OFFER.switchAt && seatsRemaining > 0;
}

/**
 * Plan porté par un abonnement, d'après les lookup_key de ses prix.
 * `null` : abonnement étranger aux offres bike fitter (ex. Founding
 * Partner), à ne jamais toucher.
 */
export function planFromLookupKeys(keys: (string | null | undefined)[]): Plan | null {
  const set = new Set(keys.filter(Boolean));
  if (set.has(LOOKUP.essentialBase)) return 'essential';
  if (set.has(LOOKUP.unlimitedLaunch) || set.has(LOOKUP.unlimitedLaunchYear)) return 'unlimited_launch';
  if (set.has(LOOKUP.unlimited) || set.has(LOOKUP.unlimitedYear)) return 'unlimited';
  return null;
}

/** Offre correspondant aux prix d'un abonnement (pour comparer les rangs). */
export function offerFromLookupKeys(keys: (string | null | undefined)[]): Offer | null {
  const set = new Set(keys.filter(Boolean));
  if (set.has(LOOKUP.unlimitedLaunchYear)) return 'unlimited_launch_annual';
  if (set.has(LOOKUP.unlimitedYear)) return 'unlimited_annual';
  if (set.has(LOOKUP.unlimitedLaunch)) return 'unlimited_launch';
  if (set.has(LOOKUP.unlimited)) return 'unlimited';
  if (set.has(LOOKUP.essentialBase)) return 'essential';
  return null;
}

export type SubscriptionOutcome =
  | { kind: 'ignore' } // pas encore payé (incomplete) : on n'ouvre rien
  | { kind: 'ended' } // résilié, expiré : retour aux crédits éventuels
  | { kind: 'access'; status: BillingStatus; grace_until: string | null };

/**
 * Traduit le statut Stripe d'un abonnement en accès AeroX.
 * Paiement en échec : accès complet pendant 7 jours à compter du premier
 * échec (la date est conservée d'un événement à l'autre), puis lecture seule
 * — calculée en base par `bf_access_level`, sans attendre un job.
 */
export function subscriptionOutcome(
  stripeStatus: string,
  existingGraceUntil: string | null,
  nowMs: number
): SubscriptionOutcome {
  switch (stripeStatus) {
    case 'active':
    case 'trialing':
      return { kind: 'access', status: 'active', grace_until: null };
    case 'past_due':
    case 'unpaid':
      return {
        kind: 'access',
        status: 'past_due',
        grace_until: existingGraceUntil ?? new Date(nowMs + GRACE_DAYS * DAY_MS).toISOString(),
      };
    case 'paused':
      return { kind: 'access', status: 'read_only', grace_until: null };
    case 'canceled':
    case 'incomplete_expired':
      return { kind: 'ended' };
    default:
      return { kind: 'ignore' };
  }
}

/**
 * Fin d'abonnement pour impayé : la grâce de 7 jours promise au client est
 * tenue même si Stripe résilie plus tôt (réglage des relances dans le
 * tableau de bord). Renvoie la date jusqu'à laquelle garder l'accès, ou
 * `null` pour une fin normale (résiliation demandée, etc.).
 */
export function graceAfterPaymentFailureEnd(
  cancellationReason: string | null | undefined,
  existingGraceUntil: string | null,
  nowMs: number
): string | null {
  if (cancellationReason !== 'payment_failed') return null;
  const grace = existingGraceUntil ?? new Date(nowMs + GRACE_DAYS * DAY_MS).toISOString();
  return new Date(grace).getTime() > nowMs ? grace : null;
}

/**
 * Plan après la fin d'un abonnement : retour à l'essai (les crédits d'essai
 * restants, s'il y en a, restent utilisables ; sinon les analyses sont
 * refusées jusqu'à une nouvelle offre).
 */
export function planAfterSubscriptionEnds(): Plan {
  return 'trial';
}

/**
 * Montant HT estimé (centimes) de la prochaine facture d'une offre, pour
 * l'espace bike fitter. `periodEndMs` : fin de la période en cours (date de
 * la prochaine facture). `analysesInPeriod` : analyses facturables de la
 * période. `inTrial` : la prochaine facture est la première, à la fin de
 * l'essai (analyses de l'essai gratuites).
 */
export function nextInvoiceCentsForOffer(
  offer: Offer,
  analysesInPeriod: number,
  nowMs: number,
  periodEndMs: number | null,
  inTrial = false
): number {
  switch (offer) {
    case 'essential':
      // Forfait du mois qui commence + analyses du mois écoulé.
      return 2000 + (inTrial ? 0 : analysesInPeriod) * 1500;
    case 'unlimited':
      return 9900;
    case 'unlimited_annual':
      return 99000;
    case 'unlimited_launch':
      // Le prix normal s'applique dès le 01/01/2027 (schedule du webhook).
      return (periodEndMs ?? nowMs) < LAUNCH_OFFER.switchAt ? 6900 : 9900;
    case 'unlimited_launch_annual':
      // Première année à 690 € (facturée à la fin de l'essai), renouvellement
      // au tarif normal (schedule du webhook).
      return inTrial ? 69000 : 99000;
  }
}

/**
 * Essentiel : faut-il proposer l'Illimité pour la période suivante ?
 * Au-delà de 7 analyses sur la période, Essentiel coûte plus que l'Illimité.
 */
export function suggestUpgrade(offer: Offer | null, analysesInPeriod: number): boolean {
  return offer === 'essential' && analysesInPeriod >= UPGRADE_HINT_AT;
}

/** Valeur MailerLite `bf_status` correspondant à l'état de facturation. */
export function crmStatus(plan: Plan, status: BillingStatus): 'trial' | 'active' | 'past_due' | 'read_only' {
  if (status === 'past_due' || status === 'read_only') return status;
  return plan === 'trial' ? 'trial' : 'active';
}
