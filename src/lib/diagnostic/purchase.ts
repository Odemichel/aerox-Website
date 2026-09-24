// src/lib/diagnostic/purchase.ts
//
// Achat et remboursement du Diagnostic AeroX (rider), vus depuis le webhook
// Stripe. Fonctions pures : elles traduisent un objet Stripe déjà vérifié
// (signature contrôlée par la route) en ligne de la table
// `diagnostic_purchases`, sans rien lire d'autre que cet objet.
//
// Le droit d'accès vit en base (migration veloaero
// `20260924_diagnostic_purchases.sql`) : un achat = un diagnostic, consommé
// au démarrage, retiré au remboursement total.

import type Stripe from 'stripe';

/** Produit posé en métadonnée par `create-api-checkout` pour le diagnostic. */
export const DIAGNOSTIC_PRODUCT = 'diagnostic';

export type DiagnosticPurchaseRow = {
  user_id: string;
  stripe_checkout_session_id: string;
  stripe_payment_intent_id: string | null;
  amount_total: number;
  currency: string;
  paid_at: string;
  withdrawal_waiver_at: string | null;
};

export type DiagnosticRefund = {
  paymentIntentId: string;
  amountRefunded: number;
  fullyRefunded: boolean;
};

const idOf = (v: string | { id: string } | null | undefined) => (typeof v === 'string' ? v : (v?.id ?? null));

/**
 * Ligne d'achat à enregistrer pour une session Checkout payée du diagnostic,
 * ou `null` si la session n'en est pas une (autre produit, livre, paiement
 * pas encore abouti).
 *
 * `userId` et `product` viennent des métadonnées signées par Stripe, posées
 * côté serveur par `create-api-checkout` : jamais du corps d'une requête.
 * `product` est vérifié en plus de `userId` : la route du livre pose un
 * `userId` sans `product`, et ne doit rien débloquer.
 */
export function purchaseFromSession(session: Stripe.Checkout.Session, now: Date): DiagnosticPurchaseRow | null {
  if (session.payment_status !== 'paid') return null;
  const userId = session.metadata?.userId;
  if (!userId || session.metadata?.product !== DIAGNOSTIC_PRODUCT) return null;

  return {
    user_id: userId,
    stripe_checkout_session_id: session.id,
    stripe_payment_intent_id: idOf(session.payment_intent),
    amount_total: session.amount_total ?? 0,
    currency: session.currency ?? 'eur',
    paid_at: now.toISOString(),
    // Case « je renonce à mon droit de rétractation dès la première séance »
    // (consent_collection.terms_of_service, obligatoire au checkout).
    withdrawal_waiver_at: session.consent?.terms_of_service === 'accepted' ? now.toISOString() : null,
  };
}

/**
 * Remboursement porté par un `charge.refunded`, rattaché à son PaymentIntent.
 * `null` pour une charge sans PaymentIntent (hors Checkout) : aucun achat de
 * diagnostic ne peut y correspondre. Que la charge concerne bien un
 * diagnostic, c'est la base qui le dit (`record_diagnostic_refund` renvoie
 * `null` pour un PaymentIntent inconnu).
 */
export function refundFromCharge(charge: Stripe.Charge): DiagnosticRefund | null {
  const paymentIntentId = idOf(charge.payment_intent);
  if (!paymentIntentId) return null;
  return {
    paymentIntentId,
    amountRefunded: charge.amount_refunded,
    fullyRefunded: charge.refunded,
  };
}
