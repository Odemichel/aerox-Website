// src/lib/billing/logic.ts
//
// Règles de facturation bike fitter sans effet de bord : ce que vaut une
// offre en prix Stripe, quel plan déduire d'un abonnement, quel accès donner
// selon son statut. Les routes et le webhook n'y ajoutent que les appels
// réseau ; tout ce qui décide est ici, et testé (test/billingLogic.test.ts).

import { LAUNCH_OFFER, LOOKUP } from './catalog';

export type Plan = 'trial' | 'pack' | 'studio' | 'unlimited' | 'unlimited_launch' | 'legacy';
export type Offer = 'pack' | 'studio' | 'unlimited' | 'unlimited_launch';
export type BillingStatus = 'active' | 'past_due' | 'read_only';

export const OFFERS: readonly Offer[] = ['pack', 'studio', 'unlimited', 'unlimited_launch'];
export const SUBSCRIPTION_OFFERS: readonly Offer[] = ['studio', 'unlimited', 'unlimited_launch'];

export const isOffer = (raw: unknown): raw is Offer => typeof raw === 'string' && OFFERS.includes(raw as Offer);

/** Prix Stripe (lookup_key) de chaque offre, dans l'ordre des lignes Checkout. */
export const OFFER_LOOKUP_KEYS: Record<Offer, string[]> = {
  pack: [LOOKUP.pack10],
  // Deux lignes : le forfait et le prix mesuré (10 analyses à 0 €, puis 8 €).
  studio: [LOOKUP.studioBase, LOOKUP.studioUsage],
  unlimited: [LOOKUP.unlimited],
  unlimited_launch: [LOOKUP.unlimitedLaunch],
};

export const PACK_CREDITS = 10;
export const PACK_VALIDITY_MONTHS = 12;
export const GRACE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Date d'expiration d'un pack acheté à `fromMs`. */
export function packExpiry(fromMs: number): Date {
  const d = new Date(fromMs);
  d.setUTCMonth(d.getUTCMonth() + PACK_VALIDITY_MONTHS);
  return d;
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
  if (set.has(LOOKUP.unlimited)) return 'unlimited';
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

/** Plan après la fin d'un abonnement : les crédits de pack restants reprennent la main. */
export function planAfterSubscriptionEnds(hasValidCredits: boolean): Plan {
  return hasValidCredits ? 'pack' : 'trial';
}

/** Plan après l'achat d'un pack : un abonné garde son abonnement. */
export function planAfterPackPurchase(current: Plan | null): Plan {
  return current === null || current === 'trial' || current === 'pack' ? 'pack' : current;
}

/**
 * Montant HT estimé (centimes) de la prochaine facture, pour l'espace bike
 * fitter. Studio : forfait + analyses au-delà de 10.
 */
export function estimatedNextInvoiceCents(plan: Plan | null, analysesInPeriod: number, nowMs: number): number | null {
  switch (plan) {
    case 'studio':
      return 6900 + Math.max(0, analysesInPeriod - 10) * 800;
    case 'unlimited':
      return 12900;
    case 'unlimited_launch':
      return nowMs < LAUNCH_OFFER.switchAt ? 6900 : 9900;
    default:
      return null;
  }
}
