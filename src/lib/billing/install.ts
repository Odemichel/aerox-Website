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
import { METERED_LOOKUP_KEYS, OFFER_LOOKUP_KEYS, offerAtInstall, trialEnd } from './logic';
import { loadBilling, priceIdsFor, stripe } from './server';
import { syncSubscription } from './webhook';

export type InstallError =
  | 'E_NO_PENDING' // aucune offre en attente (pas de carte enregistrée)
  | 'E_HAS_SUBSCRIPTION' // installation déjà faite (abonnement existant)
  | 'E_TRIAL_USED' // essai déjà utilisé sur ce compte (un seul essai)
  | 'E_NO_CARD' // carte absente du client Stripe
  | 'E_NO_ADDRESS' // adresse de facturation absente (Stripe Tax en a besoin)
  | 'E_IN_PROGRESS'; // création déjà en cours (double clic simultané)

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
  if (billing.trial_ends_at) return { error: 'E_TRIAL_USED' };

  const s = stripe();
  const customer = await s.customers.retrieve(billing.stripe_customer_id);
  if ('deleted' in customer) return { error: 'E_NO_CARD' };
  const card = customer.invoice_settings?.default_payment_method;
  if (!card) return { error: 'E_NO_CARD' };
  // Stripe Tax calcule la TVA sur l'adresse saisie avec la carte ; sans elle,
  // la création échouerait sur une erreur peu lisible.
  if (!customer.address?.country) return { error: 'E_NO_ADDRESS' };

  // Paramètres figés à la minute : un second clic dans la même minute rejoue
  // exactement la même requête (Stripe renvoie le même abonnement), et un
  // nouvel essai après un échec n'est bloqué que jusqu'à la minute suivante.
  const minuteMs = Math.floor(nowMs / 60_000) * 60_000;
  const offer = offerAtInstall(billing.pending_offer, minuteMs);
  const priceIds = await priceIdsFor(offer);
  const installedAt = new Date(minuteMs).toISOString();
  let sub: Stripe.Subscription;
  try {
    sub = await s.subscriptions.create(
      {
        customer: billing.stripe_customer_id,
        items: OFFER_LOOKUP_KEYS[offer].map((key, i) =>
          METERED_LOOKUP_KEYS.includes(key) ? { price: priceIds[i] } : { price: priceIds[i], quantity: 1 }
        ),
        default_payment_method: typeof card === 'string' ? card : card.id,
        trial_end: trialEnd(minuteMs),
        automatic_tax: { enabled: true },
        // Mode flexible : comme les abonnements créés par Checkout.
        billing_mode: { type: 'flexible' },
        metadata: { userId, aerox_offer: offer, aerox_installed_at: installedAt },
      },
      // Un double clic (ou deux admins) ne crée qu'un abonnement : même clé
      // et mêmes paramètres pour la même offre en attente et la même minute.
      { idempotencyKey: `aerox-install-${userId}-${billing.pending_since}-${offer}-${minuteMs}` }
    );
  } catch (err) {
    const e = err as { type?: string; code?: string };
    if (e.type === 'StripeIdempotencyError' || e.code === 'idempotency_key_in_use') return { error: 'E_IN_PROGRESS' };
    throw err;
  }

  // Même écriture que le webhook (offre, essai, installation, attente levée).
  // L'abonnement existe : un échec ici (schedule, CRM) ne doit pas faire
  // croire à l'admin que l'installation a échoué ; le webhook refera la
  // synchronisation.
  try {
    await syncSubscription(db, sub.id);
  } catch (err) {
    console.error(
      'billing/install: synchronisation différée au webhook',
      sub.id,
      err instanceof Error ? err.message : err
    );
  }
  return { trialEndsAt: new Date((sub.trial_end ?? trialEnd(minuteMs)) * 1000).toISOString() };
}
