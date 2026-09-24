// src/lib/billing/logic.ts
//
// Règles de facturation bike fitter sans effet de bord : ce que vaut une
// offre en prix Stripe, quel plan déduire d'un abonnement, quel accès donner
// selon son statut. Les routes et le webhook n'y ajoutent que les appels
// réseau ; tout ce qui décide est ici, et testé (test/billingLogic.test.ts).

import { BF_AVAILABLE_AT, LAUNCH_OFFER, LOOKUP } from './catalog';

// `pack` : plan historique (crédits prépayés), plus vendu ; conservé pour les
// comptes et les crédits existants.
export type Plan = 'trial' | 'pack' | 'payg' | 'studio' | 'unlimited' | 'unlimited_launch' | 'legacy';
export type Offer = 'payg' | 'studio' | 'unlimited' | 'unlimited_annual' | 'unlimited_launch';
export type BillingStatus = 'active' | 'past_due' | 'read_only';

export const OFFERS: readonly Offer[] = ['payg', 'studio', 'unlimited', 'unlimited_annual', 'unlimited_launch'];

export const isOffer = (raw: unknown): raw is Offer => typeof raw === 'string' && OFFERS.includes(raw as Offer);

/** Prix Stripe (lookup_key) de chaque offre, dans l'ordre des lignes Checkout. */
export const OFFER_LOOKUP_KEYS: Record<Offer, string[]> = {
  // Prix mesuré seul : 0 € fixe, 20 € par analyse, facturé en fin de mois.
  payg: [LOOKUP.payg],
  // Deux lignes : le forfait et le prix mesuré (5 analyses à 0 €, puis 10 €).
  studio: [LOOKUP.studioBase, LOOKUP.studioUsage],
  unlimited: [LOOKUP.unlimited],
  unlimited_annual: [LOOKUP.unlimitedYear],
  unlimited_launch: [LOOKUP.unlimitedLaunch],
};

/** Prix mesurés : pas de quantité dans Checkout ni dans un changement d'offre. */
export const METERED_LOOKUP_KEYS: readonly string[] = [LOOKUP.payg, LOOKUP.studioUsage];

/**
 * Rang d'une offre, du moins au plus engageant. Monter est immédiat (au
 * prorata) ; descendre prend effet à la fin de la période déjà payée, pour
 * qu'un passage en Illimité le temps d'un mois chargé ne se rembourse pas.
 */
export const OFFER_RANK: Record<Offer, number> = {
  payg: 0,
  studio: 1,
  unlimited_launch: 2,
  unlimited: 3,
  unlimited_annual: 4,
};

export const isDowngrade = (from: Offer, to: Offer) => OFFER_RANK[to] < OFFER_RANK[from];

export const GRACE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Premier prélèvement au plus tôt à la mise à disposition (1er novembre
 * 2026) : un abonnement souscrit avant démarre en période d'essai Stripe
 * jusqu'à cette date (carte enregistrée, rien de débité). Stripe exige une
 * fin d'essai à au moins 48 h : à moins de 3 jours de la date, on facture
 * normalement. Renvoie des secondes (format Stripe) ou `undefined`.
 */
export function subscriptionStartTrialEnd(nowMs: number): number | undefined {
  return BF_AVAILABLE_AT - nowMs > 3 * DAY_MS ? Math.floor(BF_AVAILABLE_AT / 1000) : undefined;
}

/** L'offre de lancement est-elle encore ouverte à la souscription ? */
export function launchOfferOpen(nowMs: number, seatsRemaining: number): boolean {
  return nowMs < LAUNCH_OFFER.switchAt && seatsRemaining > 0;
}

/**
 * Plan porté par un abonnement, d'après les lookup_key de ses prix. Le prix
 * d'après-lancement (99 €) reste « unlimited_launch » : ce sont les mêmes
 * abonnés, seul le montant a basculé. `null` : abonnement étranger aux
 * offres bike fitter (ex. Founding Partner), à ne jamais toucher.
 */
export function planFromLookupKeys(keys: (string | null | undefined)[]): Plan | null {
  const set = new Set(keys.filter(Boolean));
  if (set.has(LOOKUP.studioBase)) return 'studio';
  if (set.has(LOOKUP.unlimitedLaunch) || set.has(LOOKUP.unlimitedLaunchAfter)) return 'unlimited_launch';
  if (set.has(LOOKUP.unlimited) || set.has(LOOKUP.unlimitedYear)) return 'unlimited';
  if (set.has(LOOKUP.payg)) return 'payg';
  return null;
}

/** Offre correspondant aux prix d'un abonnement (pour comparer les rangs). */
export function offerFromLookupKeys(keys: (string | null | undefined)[]): Offer | null {
  const set = new Set(keys.filter(Boolean));
  if (set.has(LOOKUP.unlimitedYear)) return 'unlimited_annual';
  if (set.has(LOOKUP.unlimitedLaunch) || set.has(LOOKUP.unlimitedLaunchAfter)) return 'unlimited_launch';
  if (set.has(LOOKUP.unlimited)) return 'unlimited';
  if (set.has(LOOKUP.studioBase)) return 'studio';
  if (set.has(LOOKUP.payg)) return 'payg';
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
 * Montant HT estimé (centimes) de la prochaine facture, pour l'espace bike
 * fitter. `periodDays` distingue l'Illimité annuel du mensuel.
 */
export function estimatedNextInvoiceCents(
  plan: Plan | null,
  analysesInPeriod: number,
  nowMs: number,
  periodDays = 30
): number | null {
  switch (plan) {
    case 'payg':
      return analysesInPeriod * 2000;
    case 'studio':
      return 7900 + Math.max(0, analysesInPeriod - 5) * 1000;
    case 'unlimited':
      return periodDays > 40 ? 119000 : 11900;
    case 'unlimited_launch':
      return nowMs < LAUNCH_OFFER.switchAt ? 6900 : 9900;
    default:
      return null;
  }
}

/** Valeur MailerLite `bf_status` correspondant à l'état de facturation. */
export function crmStatus(plan: Plan, status: BillingStatus): 'trial' | 'active' | 'past_due' | 'read_only' {
  if (status === 'past_due' || status === 'read_only') return status;
  return plan === 'trial' ? 'trial' : 'active';
}
