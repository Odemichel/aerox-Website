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
import {
  crmStatus,
  graceAfterPaymentFailureEnd,
  isOffer,
  offerFromLookupKeys,
  planAfterSubscriptionEnds,
  planFromLookupKeys,
  subscriptionOutcome,
} from './logic';
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

/** Premier anniversaire de facturation (fin de la première année payée). */
function firstYearEnd(sub: Stripe.Subscription): number {
  const d = new Date(sub.billing_cycle_anchor * 1000);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return Math.floor(d.getTime() / 1000);
}

/**
 * Offres de lancement : pose le schedule qui bascule le prix.
 *  - Mensuel : 69 € → 99 € au 01/01/2027 00:00 (Paris), avec
 *    `proration_behavior: 'create_prorations'` : 99 € s'applique dès le 01/01 ;
 *    le reste de la période en cours, payé à 69 €, est régularisé au prorata
 *    sur l'échéance suivante (crédit 69 €, débit 99 €).
 *  - Annuel : 690 € la première année, 990 € par an ensuite, à la date
 *    anniversaire (échéance : pas de prorata).
 *
 * Convergent plutôt que « une seule fois » : plusieurs événements du même
 * abonnement arrivent en même temps, et un traitement peut s'interrompre entre
 * la création du schedule et sa configuration. Chaque passage termine donc le
 * travail : il crée le schedule s'il manque, et le configure tant que la phase
 * au prix suivant n'y figure pas.
 */
async function ensureLaunchSchedule(sub: Stripe.Subscription) {
  // Résiliation programmée : ne rien reposer. Un schedule gère lui-même la
  // date de fin de l'abonnement, et y ajouter la phase suivante effacerait la
  // résiliation demandée par le bike fitter.
  if (sub.cancel_at_period_end || sub.cancel_at) return;
  const keys = sub.items.data.map((i) => i.price.lookup_key);
  const yearly = keys.includes(LOOKUP.unlimitedLaunchYear);
  const monthly = keys.includes(LOOKUP.unlimitedLaunch);
  if (!yearly && !monthly) return;
  if (monthly && Date.now() >= LAUNCH_OFFER.switchAt) return;

  const s = stripe();
  const afterPrice = await priceIdForLookup(yearly ? LOOKUP.unlimitedLaunchYearAfter : LOOKUP.unlimitedLaunchAfter);

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
  // Course avec une résiliation : l'abonnement a été relu avant qu'elle soit
  // posée, mais le schedule créé après la porte (`end_behavior: cancel`). Le
  // configurer effacerait la résiliation ; on rend l'abonnement à lui-même en
  // gardant la date de fin (le cas s'est produit en test, voir S11).
  if (schedule.end_behavior === 'cancel') {
    if (schedule.status === 'active')
      await s.subscriptionSchedules.release(schedule.id, { preserve_cancel_date: true });
    return;
  }
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
        end_date: yearly ? firstYearEnd(sub) : Math.floor(LAUNCH_OFFER.switchAt / 1000),
        items: current.items.map((i) => ({ price: idOf(i.price)!, quantity: i.quantity ?? 1 })),
        // Sans elle, la mise à jour effacerait la période d'essai (premier
        // prélèvement le 1er novembre) et Stripe facturerait tout de suite.
        trial_end: current.trial_end ?? undefined,
        metadata: sub.metadata,
      },
      {
        items: [{ price: afterPrice, quantity: 1 }],
        duration: { interval: yearly ? 'year' : 'month', interval_count: 1 },
        proration_behavior: yearly ? 'none' : 'create_prorations',
        metadata: sub.metadata,
      },
    ],
  });
}

/** Statuts Stripe d'un abonnement encore en vie (facturé ou relancé). */
const LIVE_STATUSES = new Set<string>(['active', 'trialing', 'past_due', 'unpaid']);

/**
 * Second abonnement BF pour un même compte (deux Checkout ouverts puis payés
 * l'un après l'autre) : celui déjà enregistré est conservé, le nouveau est
 * résilié immédiatement et ses factures payées sont remboursées. Renvoie
 * `true` si l'abonnement était un doublon.
 */
async function cancelDuplicate(sub: Stripe.Subscription, keptId: string): Promise<boolean> {
  const s = stripe();
  const kept = await s.subscriptions.retrieve(keptId).catch(() => null);
  if (!kept || !LIVE_STATUSES.has(kept.status)) return false;

  console.error('stripe-webhook: abonnement en double', sub.id, '— conservé :', keptId);
  // Idempotent : un autre événement du même doublon a pu le résilier déjà.
  if (sub.status !== 'canceled') {
    await s.subscriptions.cancel(sub.id, { prorate: false, invoice_now: false }).catch(async (err) => {
      if ((await s.subscriptions.retrieve(sub.id)).status !== 'canceled') throw err;
    });
  }
  for await (const invoice of s.invoices.list({ subscription: sub.id, status: 'paid', limit: 10 })) {
    if (!invoice.amount_paid) continue;
    for await (const payment of s.invoicePayments.list({ invoice: invoice.id!, limit: 10 })) {
      const intent = idOf(payment.payment?.payment_intent);
      if (payment.status !== 'paid' || !intent) continue;
      await s.refunds.create(
        { payment_intent: intent, metadata: { aerox_reason: 'duplicate_subscription', subscription: sub.id } },
        { idempotencyKey: `aerox-dup-refund-${intent}` }
      );
    }
  }
  return true;
}

/**
 * Descente d'offre programmée (schedule `aerox_schedule=downgrade` posé par
 * /api/billing/manage/) : offre visée et date d'effet.
 */
async function scheduledChange(sub: Stripe.Subscription): Promise<{ offer: string; at: string } | null> {
  const scheduleId = idOf(sub.schedule);
  if (!scheduleId) return null;
  const schedule = await stripe().subscriptionSchedules.retrieve(scheduleId);
  const offer = schedule.metadata?.aerox_offer;
  if (schedule.metadata?.aerox_schedule !== 'downgrade' || !isOffer(offer)) return null;
  const at = toIso(schedule.current_phase?.end_date);
  return at ? { offer, at } : null;
}

/**
 * Facture restée ouverte à la fin d'un abonnement (résilié pendant un
 * impayé) : Stripe ne la relance plus, et ne sait pas l'envoyer par e-mail
 * (réservé aux factures `send_invoice`). Elle est conservée comme créance.
 */
async function openDebt(subscriptionId: string): Promise<{ id: string; amount: number; url: string | null } | null> {
  const open = await stripe().invoices.list({ subscription: subscriptionId, status: 'open', limit: 10 });
  const due = open.data.filter((i) => i.amount_remaining > 0);
  if (!due.length) return null;
  return {
    id: due[0].id!,
    amount: due.reduce((sum, i) => sum + i.amount_remaining, 0),
    url: due[0].hosted_invoice_url ?? null,
  };
}

/** Facture réglée : la créance correspondante est effacée. */
async function clearPaidDebt(db: SupabaseClient, invoice: Stripe.Invoice) {
  const userId = invoice.parent?.subscription_details?.metadata?.userId;
  if (!userId || !invoice.id) return;
  const { error } = await db
    .from('bf_billing')
    .update({ unpaid_invoice_id: null, unpaid_amount: null, unpaid_invoice_url: null })
    .eq('user_id', userId)
    .eq('unpaid_invoice_id', invoice.id);
  if (error) throw new Error(`bf_billing (créance): ${error.message}`);
}

/**
 * Aligne `bf_billing` sur l'état actuel d'un abonnement bike fitter. Appelée
 * par le webhook et, juste après une action, par /api/billing/manage/ :
 * l'espace BF affiche le nouvel état sans attendre l'événement.
 */
export async function syncSubscription(db: SupabaseClient, subscriptionId: string, paymentFailed = false) {
  const sub = await stripe().subscriptions.retrieve(subscriptionId);
  const userId = sub.metadata?.userId;
  if (!userId || !sub.metadata?.aerox_offer) return;

  const keys = sub.items.data.map((i) => i.price.lookup_key);
  const plan = planFromLookupKeys(keys);
  if (!plan) {
    console.error('stripe-webhook: abonnement', sub.id, 'sans prix du catalogue BF — ignoré');
    return;
  }

  const billing = await loadBilling(db, userId);
  const otherSub = billing?.stripe_subscription_id && billing.stripe_subscription_id !== sub.id;
  // Un ancien abonnement (remplacé) qui se termine ne doit pas écraser le nouveau.
  if (otherSub && sub.status === 'canceled') return;

  // Un échec de paiement peut précéder le passage de l'abonnement en
  // `past_due` : l'événement de facture fait foi pour ouvrir la grâce.
  const status = paymentFailed && sub.status === 'active' ? 'past_due' : sub.status;
  const outcome = subscriptionOutcome(status, billing?.grace_until ?? null, Date.now());
  const customer = idOf(sub.customer);

  if (outcome.kind === 'ignore') return;

  // Un seul abonnement par bike fitter : un second, payé en parallèle, est
  // annulé et remboursé au lieu de remplacer le premier en base.
  if (otherSub && outcome.kind === 'access' && (await cancelDuplicate(sub, billing!.stripe_subscription_id!))) return;

  if (outcome.kind === 'ended') {
    // Premier paiement jamais abouti (carte refusée, Checkout abandonné) :
    // rien n'avait été ouvert, rien à fermer — et surtout pas de « churned »
    // dans le CRM pour quelqu'un qui n'a jamais été abonné.
    if (sub.status === 'incomplete_expired' && billing?.stripe_subscription_id !== sub.id) return;
    // Résilié par Stripe pour impayé avant la fin de la grâce : l'offre et
    // l'accès restent jusqu'à `grace_until`, puis `bf_access_level` passe
    // le compte en lecture seule. Le bike fitter peut se réabonner.
    const keepUntil = graceAfterPaymentFailureEnd(
      sub.cancellation_details?.reason,
      billing?.grace_until ?? null,
      Date.now()
    );
    // Créance : facture impayée conservée. Les relances par e-mail partent
    // de la base (bf_send_unpaid_reminders → fonction Edge notify-bf-unpaid).
    const debt = await openDebt(sub.id);
    const cleared = {
      stripe_subscription_id: null,
      cancel_at: null,
      scheduled_offer: null,
      scheduled_at: null,
      unpaid_invoice_id: debt?.id ?? null,
      unpaid_amount: debt?.amount ?? null,
      unpaid_invoice_url: debt?.url ?? null,
    };
    // Premier traitement de cette fin d'abonnement (les rejeux et les
    // factures réglées plus tard ne réécrivent pas le CRM).
    const firstEnd = billing?.stripe_subscription_id === sub.id;
    if (keepUntil) {
      await writeBilling(db, {
        user_id: userId,
        stripe_customer_id: customer,
        ...cleared,
        status: 'past_due',
        grace_until: keepUntil,
      });
      if (billing?.status !== 'past_due') await syncCrm(db, userId, billing?.plan ?? plan, 'past_due');
      return;
    }
    const nextPlan = planAfterSubscriptionEnds();
    await writeBilling(db, {
      user_id: userId,
      stripe_customer_id: customer,
      ...cleared,
      plan: nextPlan,
      offer: null,
      status: 'active',
      grace_until: null,
      current_period_start: null,
      current_period_end: null,
    });
    if (firstEnd) await syncCrm(db, userId, nextPlan, 'churned');
    return;
  }

  // API basil : la période est portée par les lignes, pas par l'abonnement.
  const item = sub.items.data[0];
  const periodEnd = item?.current_period_end;
  const change = await scheduledChange(sub);
  await writeBilling(db, {
    user_id: userId,
    stripe_customer_id: customer,
    stripe_subscription_id: sub.id,
    plan,
    offer: offerFromLookupKeys(keys),
    status: outcome.status,
    grace_until: outcome.grace_until,
    current_period_start: toIso(item?.current_period_start),
    current_period_end: toIso(periodEnd),
    cancel_at: toIso(sub.cancel_at ?? (sub.cancel_at_period_end ? periodEnd : null)),
    scheduled_offer: change?.offer ?? null,
    scheduled_at: change?.at ?? null,
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
      if (event.type === 'invoice.paid') await clearPaidDebt(db, event.data.object);
      const subId = idOf(event.data.object.parent?.subscription_details?.subscription);
      if (subId) await syncSubscription(db, subId, event.type === 'invoice.payment_failed');
      return;
    }
  }
}
