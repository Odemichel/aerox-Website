// src/lib/billing/install.ts
//
// Installation du setup chez le bike fitter : création de son premier
// abonnement, avec 14 jours d'essai comptés à partir de maintenant.
//
// Avant l'installation, le bike fitter a choisi son offre et enregistré sa
// carte (Checkout en mode `setup`, `bf_billing.pending_offer`), sans
// abonnement : rien ne peut être prélevé. Appelé par
// /api/billing/start-trial/ (bouton admin « Installation faite », app desktop
// et webapp mycompanion).

import type { SupabaseClient } from '@supabase/supabase-js';
import type Stripe from 'stripe';
import { LAUNCH_OFFER } from './catalog';
import { METERED_LOOKUP_KEYS, OFFER_LOOKUP_KEYS, trialEnd, type Offer } from './logic';
import { loadBilling, priceIdsFor, stripe } from './server';
import { syncSubscription } from './webhook';

export type InstallError =
  | 'E_NO_PENDING' // aucune offre en attente (pas de carte enregistrée)
  | 'E_HAS_SUBSCRIPTION' // installation déjà faite (abonnement existant)
  | 'E_NO_CARD' // carte absente du client Stripe
  | 'E_IN_PROGRESS'; // création déjà demandée à l'instant (double clic)

/**
 * Offre facturée à l'installation. Lancement mensuel choisi avant le
 * 01/01/2027 mais installé après : le tarif de lancement est terminé, c'est
 * l'Illimité au tarif normal (même règle que la bascule du lancement). Le
 * lancement annuel garde sa première année : il a été souscrit à temps.
 */
export function offerAtInstall(offer: Offer, nowMs: number): Offer {
  return offer === 'unlimited_launch' && nowMs >= LAUNCH_OFFER.switchAt ? 'unlimited' : offer;
}

/** Crée l'abonnement du bike fitter `userId`. Rejouable sans doublon. */
export async function startSubscriptionAtInstall(
  db: SupabaseClient,
  userId: string,
  nowMs = Date.now()
): Promise<{ trialEndsAt: string } | { error: InstallError }> {
  const billing = await loadBilling(db, userId);
  if (billing?.stripe_subscription_id) return { error: 'E_HAS_SUBSCRIPTION' };
  if (!billing?.pending_offer || !billing.stripe_customer_id || !billing.pending_since)
    return { error: 'E_NO_PENDING' };

  const s = stripe();
  const customer = await s.customers.retrieve(billing.stripe_customer_id);
  const card = 'deleted' in customer ? null : customer.invoice_settings?.default_payment_method;
  if (!card) return { error: 'E_NO_CARD' };

  const offer = offerAtInstall(billing.pending_offer, nowMs);
  const priceIds = await priceIdsFor(offer);
  const installedAt = new Date(nowMs).toISOString();
  let sub: Stripe.Subscription;
  try {
    sub = await s.subscriptions.create(
      {
        customer: billing.stripe_customer_id,
        items: OFFER_LOOKUP_KEYS[offer].map((key, i) =>
          METERED_LOOKUP_KEYS.includes(key) ? { price: priceIds[i] } : { price: priceIds[i], quantity: 1 }
        ),
        default_payment_method: typeof card === 'string' ? card : card.id,
        trial_end: trialEnd(nowMs),
        automatic_tax: { enabled: true },
        // Mode flexible : comme les abonnements créés par Checkout.
        billing_mode: { type: 'flexible' },
        metadata: { userId, aerox_offer: offer, aerox_installed_at: installedAt },
      },
      // Un double clic (ou deux admins) ne crée qu'un abonnement : même clé
      // pour la même offre en attente. Le second appel, aux paramètres
      // différents (date d'installation), est refusé par Stripe.
      { idempotencyKey: `aerox-install-${userId}-${billing.pending_since}-${offer}` }
    );
  } catch (err) {
    if ((err as { type?: string }).type === 'StripeIdempotencyError') return { error: 'E_IN_PROGRESS' };
    throw err;
  }

  // Même écriture que le webhook (offre, essai, installation, attente levée).
  await syncSubscription(db, sub.id);
  return { trialEndsAt: new Date((sub.trial_end ?? trialEnd(nowMs)) * 1000).toISOString() };
}
