// src/pages/api/billing/manage.ts
//
// Changement d'offre et résiliation d'un abonnement bike fitter existant.
//
// Le portail Stripe ne peut pas le faire lui-même : il refuse de modifier un
// abonnement à plusieurs produits ou à usage mesuré (Studio), et de modifier
// ou résilier un abonnement piloté par un subscription schedule (offre de
// lancement). Cette route couvre ces cas pour toutes les offres, avec la même
// règle : l'abonnement et l'utilisateur viennent du serveur, jamais du corps.
//
// La base n'est pas écrite ici : le webhook `customer.subscription.updated`
// qui suit la modification met `bf_billing` à jour, comme pour tout le reste.
export const prerender = false;

import type { APIRoute } from 'astro';
import type Stripe from 'stripe';
import { authenticatedUser } from '~/lib/serverAuth';
import { isOffer, launchOfferOpen, SUBSCRIPTION_OFFERS } from '~/lib/billing/logic';
import { json, launchSeatsRemaining, loadBilling, priceIdsFor, stripe, supabaseAdmin } from '~/lib/billing/server';

/** Détache le schedule (offre de lancement) pour rendre l'abonnement modifiable. */
async function releaseSchedule(sub: Stripe.Subscription) {
  const scheduleId = typeof sub.schedule === 'string' ? sub.schedule : sub.schedule?.id;
  if (scheduleId) await stripe().subscriptionSchedules.release(scheduleId);
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = (await request.json().catch(() => ({}))) as { action?: unknown; offer?: unknown };

    const user = await authenticatedUser(request, 'billing/manage');
    if (!user) return json({ error: 'E_AUTH' }, 401);

    const db = supabaseAdmin();
    const billing = await loadBilling(db, user.id);
    if (!billing?.stripe_subscription_id) return json({ error: 'E_NO_SUBSCRIPTION' }, 404);

    const sub = await stripe().subscriptions.retrieve(billing.stripe_subscription_id);
    // Défense en profondeur : l'abonnement doit être celui de cet utilisateur.
    if (sub.metadata?.userId !== user.id) {
      console.error('billing/manage: abonnement', sub.id, 'non rattaché à', user.id);
      return json({ error: 'E_NO_SUBSCRIPTION' }, 404);
    }

    if (body.action === 'cancel') {
      // Fin de période : l'accès reste ouvert jusqu'à l'échéance déjà payée.
      await releaseSchedule(sub);
      await stripe().subscriptions.update(sub.id, { cancel_at_period_end: true });
      return json({ ok: true });
    }

    if (body.action === 'resume') {
      await stripe().subscriptions.update(sub.id, { cancel_at_period_end: false });
      return json({ ok: true });
    }

    if (body.action !== 'change' || !isOffer(body.offer) || !SUBSCRIPTION_OFFERS.includes(body.offer)) {
      return json({ error: 'E_ACTION' }, 400);
    }
    const offer = body.offer;
    if (sub.metadata?.aerox_offer === offer) return json({ error: 'E_SAME_OFFER' }, 400);
    if (offer === 'unlimited_launch' && !launchOfferOpen(Date.now(), await launchSeatsRemaining(db))) {
      return json({ error: 'E_LAUNCH_CLOSED', fallback: 'unlimited' }, 409);
    }

    const priceIds = await priceIdsFor(offer);
    await releaseSchedule(sub);
    await stripe().subscriptions.update(sub.id, {
      // Remplace toutes les lignes : sans `deleted`, Stripe AJOUTERAIT les
      // nouveaux prix aux anciens et facturerait les deux.
      items: [
        ...sub.items.data.map((item) => ({ id: item.id, deleted: true })),
        ...priceIds.map((price, i) => (offer === 'studio' && i === 1 ? { price } : { price, quantity: 1 })),
      ],
      proration_behavior: 'create_prorations',
      cancel_at_period_end: false,
      metadata: { userId: user.id, aerox_offer: offer },
    });
    return json({ ok: true });
  } catch (err) {
    console.error('billing/manage', err instanceof Error ? err.message : err);
    return json({ error: 'E_SERVER' }, 500);
  }
};
