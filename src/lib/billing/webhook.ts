// src/lib/billing/webhook.ts
//
// Traitement des événements Stripe des offres bike fitter, appelé par
// `src/pages/api/stripe-webhook.ts` une fois la signature vérifiée.
//
// Règles :
//  - Seuls les objets portant la métadonnée `aerox_offer` (posée par
//    /api/billing/checkout/) sont traités. Un abonnement sans elle — le
//    Founding Partner, créé par lien de paiement — n'est JAMAIS touché.
//  - Pour un abonnement, on relit toujours l'état courant chez Stripe au lieu
//    de faire confiance à l'objet de l'événement : les événements arrivent
//    dans le désordre, l'état relu est le seul à jour.
//  - Toute erreur remonte : la route rend 500 et Stripe rejoue l'événement.

import type { SupabaseClient } from '@supabase/supabase-js';
import type Stripe from 'stripe';
import { LAUNCH_OFFER, LOOKUP } from './catalog';
import { upsertMailerLiteFields, type BfStatus } from '~/lib/mailerlite';
import { crmStatus, planAfterSubscriptionEnds, planFromLookupKeys, subscriptionOutcome } from './logic';
import { loadBilling, priceIdForLookup, stripe } from './server';

export const BILLING_EVENTS = new Set<string>([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
]);

const idOf = (v: string | { id: string } | null | undefined) => (typeof v === 'string' ? v : (v?.id ?? null));
const toIso = (seconds: number | null | undefined) => (seconds ? new Date(seconds * 1000).toISOString() : null);

/** L'événement concerne-t-il une offre bike fitter ? (sinon : rien à faire ici) */
export function isBillingObject(event: Stripe.Event): boolean {
  if (!BILLING_EVENTS.has(event.type)) return false;
  const obj = event.data.object as { metadata?: Record<string, string> | null; parent?: Stripe.Invoice['parent'] };
  if (event.type.startsWith('invoice.')) {
    return Boolean(obj.parent?.subscription_details?.metadata?.aerox_offer);
  }
  return Boolean(obj.metadata?.aerox_offer);
}

/** Reporte l'offre sur la fiche MailerLite (bf_plan, bf_status). Jamais bloquant. */
async function syncCrm(db: SupabaseClient, userId: string, plan: string, bfStatus: BfStatus) {
  const { data } = await db.from('users').select('email').eq('id', userId).maybeSingle();
  if (data?.email) await upsertMailerLiteFields(data.email as string, { bf_plan: plan, bf_status: bfStatus });
}

async function writeBilling(db: SupabaseClient, row: Record<string, unknown>) {
  const { error } = await db.from('bf_billing').upsert(row, { onConflict: 'user_id' });
  if (error) throw new Error(`bf_billing: ${error.message}`);
}

/**
 * Offre de lancement : pose le schedule qui bascule le prix de 69 € à 99 € au
 * 01/01/2027 00:00 (Paris). `proration_behavior: 'create_prorations'` : 99 €
 * s'applique dès le 01/01 ; le reste de la période en cours, payé à 69 €,
 * est régularisé au prorata sur l'échéance suivante (crédit 69 €, débit 99 €).
 *
 * Convergent plutôt que « une seule fois » : plusieurs événements du même
 * abonnement arrivent en même temps, et un traitement peut s'interrompre entre
 * la création du schedule et sa configuration. Chaque passage termine donc le
 * travail : il crée le schedule s'il manque, et le configure tant que la phase
 * à 99 € n'y figure pas.
 */
async function ensureLaunchSchedule(sub: Stripe.Subscription) {
  if (Date.now() >= LAUNCH_OFFER.switchAt) return;
  const onLaunchPrice = sub.items.data.some((i) => i.price.lookup_key === LOOKUP.unlimitedLaunch);
  if (!onLaunchPrice) return;

  const s = stripe();
  const afterPrice = await priceIdForLookup(LOOKUP.unlimitedLaunchAfter);

  let scheduleId = idOf(sub.schedule);
  if (!scheduleId) {
    try {
      scheduleId = (await s.subscriptionSchedules.create({ from_subscription: sub.id })).id;
    } catch (err) {
      // Un traitement concurrent vient de le créer : on reprend le sien.
      scheduleId = idOf((await s.subscriptions.retrieve(sub.id)).schedule);
      if (!scheduleId) throw err;
    }
  }

  const schedule = await s.subscriptionSchedules.retrieve(scheduleId);
  // Une descente d'offre programmée (fin de période) a priorité : on n'y
  // réécrit pas la bascule de lancement.
  if (schedule.metadata?.aerox_schedule === 'downgrade') return;
  const configured = schedule.phases.some((p) => p.items.some((i) => idOf(i.price) === afterPrice));
  if (configured || schedule.status !== 'active') return;

  const current = schedule.phases[0];
  await s.subscriptionSchedules.update(schedule.id, {
    end_behavior: 'release',
    metadata: { aerox_schedule: 'launch' },
    phases: [
      {
        start_date: current.start_date,
        end_date: Math.floor(LAUNCH_OFFER.switchAt / 1000),
        items: current.items.map((i) => ({ price: idOf(i.price)!, quantity: i.quantity ?? 1 })),
        metadata: sub.metadata,
      },
      {
        items: [{ price: afterPrice, quantity: 1 }],
        duration: { interval: 'month', interval_count: 1 },
        proration_behavior: 'create_prorations',
        metadata: sub.metadata,
      },
    ],
  });
}

/** Aligne `bf_billing` sur l'état actuel d'un abonnement bike fitter. */
async function syncSubscription(db: SupabaseClient, subscriptionId: string, paymentFailed = false) {
  const sub = await stripe().subscriptions.retrieve(subscriptionId);
  const userId = sub.metadata?.userId;
  if (!userId || !sub.metadata?.aerox_offer) return;

  const plan = planFromLookupKeys(sub.items.data.map((i) => i.price.lookup_key));
  if (!plan) {
    console.error('stripe-webhook: abonnement', sub.id, 'sans prix du catalogue BF — ignoré');
    return;
  }

  const billing = await loadBilling(db, userId);
  // Un ancien abonnement (remplacé) qui se termine ne doit pas écraser le nouveau.
  if (billing?.stripe_subscription_id && billing.stripe_subscription_id !== sub.id && sub.status === 'canceled') {
    return;
  }

  // Un échec de paiement peut précéder le passage de l'abonnement en
  // `past_due` : l'événement de facture fait foi pour ouvrir la grâce.
  const status = paymentFailed && sub.status === 'active' ? 'past_due' : sub.status;
  const outcome = subscriptionOutcome(status, billing?.grace_until ?? null, Date.now());
  const customer = idOf(sub.customer);

  if (outcome.kind === 'ignore') return;

  if (outcome.kind === 'ended') {
    const nextPlan = planAfterSubscriptionEnds();
    await writeBilling(db, {
      user_id: userId,
      stripe_customer_id: customer,
      stripe_subscription_id: null,
      plan: nextPlan,
      status: 'active',
      grace_until: null,
      current_period_start: null,
      current_period_end: null,
    });
    await syncCrm(db, userId, nextPlan, 'churned');
    return;
  }

  // API basil : la période est portée par les lignes, pas par l'abonnement.
  const item = sub.items.data[0];
  await writeBilling(db, {
    user_id: userId,
    stripe_customer_id: customer,
    stripe_subscription_id: sub.id,
    plan,
    status: outcome.status,
    grace_until: outcome.grace_until,
    current_period_start: toIso(item?.current_period_start),
    current_period_end: toIso(item?.current_period_end),
  });
  // Seulement si quelque chose change pour le CRM : les renouvellements
  // mensuels ne réécrivent pas la fiche.
  if (billing?.plan !== plan || billing?.status !== outcome.status) {
    await syncCrm(db, userId, plan, crmStatus(plan, outcome.status));
  }

  if (plan === 'unlimited_launch' && outcome.status === 'active') await ensureLaunchSchedule(sub);
}

/**
 * Essai : la carte enregistrée (Checkout « setup », 0 € débité) débloque les
 * 2 analyses offertes, une seule fois par carte. L'empreinte de la carte est
 * lue chez Stripe, jamais reçue du navigateur.
 */
async function handleTrialCard(db: SupabaseClient, userId: string, session: Stripe.Checkout.Session) {
  const setupIntentId = idOf(session.setup_intent);
  if (!setupIntentId) return;
  const intent = await stripe().setupIntents.retrieve(setupIntentId, { expand: ['payment_method'] });
  if (intent.status !== 'succeeded') return;
  const method = intent.payment_method as Stripe.PaymentMethod | null;
  const fingerprint = method?.card?.fingerprint;
  if (!fingerprint) {
    console.error('stripe-webhook: carte d’essai sans empreinte —', setupIntentId);
    return;
  }
  const { data, error } = await db.rpc('bf_grant_trial', { p_user: userId, p_fingerprint: fingerprint });
  if (error) throw new Error(`bf_grant_trial: ${error.message}`);
  if (data === 'card_already_used') console.warn('stripe-webhook: carte déjà utilisée pour un essai —', userId);
}

async function handleCheckout(db: SupabaseClient, session: Stripe.Checkout.Session) {
  const userId = session.metadata?.userId;
  if (!userId) return;

  if (session.mode === 'setup') {
    if (session.metadata?.aerox_offer === 'trial_card') await handleTrialCard(db, userId, session);
    return;
  }

  if (session.mode === 'subscription') {
    const subId = idOf(session.subscription);
    if (subId) await syncSubscription(db, subId);
    return;
  }
}

/** Traite un événement bike fitter. Lève en cas d'échec (→ 500, rejeu Stripe). */
export async function handleBillingEvent(db: SupabaseClient, event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      return handleCheckout(db, event.data.object);

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return syncSubscription(db, event.data.object.id);

    case 'invoice.paid':
    case 'invoice.payment_failed': {
      // Le statut de l'abonnement (active / past_due) reflète déjà la facture :
      // relire l'abonnement suffit et reste juste si les deux événements se
      // croisent.
      const subId = idOf(event.data.object.parent?.subscription_details?.subscription);
      if (subId) await syncSubscription(db, subId, event.type === 'invoice.payment_failed');
      return;
    }
  }
}
