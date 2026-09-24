// src/pages/api/billing/manage.ts
//
// Changement d'offre et résiliation d'un abonnement bike fitter existant.
//
// Le portail Stripe ne peut pas le faire lui-même : il refuse de modifier un
// abonnement à usage mesuré (À l'usage, Studio), et de modifier ou résilier
// un abonnement piloté par un subscription schedule (offre de lancement).
// Cette route couvre ces cas pour toutes les offres, avec la même règle :
// l'abonnement et l'utilisateur viennent du serveur, jamais du corps.
//
// Monter d'offre est immédiat (au prorata). Descendre prend effet à la fin
// de la période déjà payée, par un schedule : un passage en Illimité le temps
// d'un mois chargé ne se rembourse pas.
//
// La base n'est pas écrite ici : le webhook `customer.subscription.updated`
// qui suit la modification met `bf_billing` à jour, comme pour tout le reste.
export const prerender = false;

import type { APIRoute } from 'astro';
import type Stripe from 'stripe';
import { authenticatedUser } from '~/lib/serverAuth';
import {
  isDowngrade,
  isOffer,
  launchOfferOpen,
  METERED_LOOKUP_KEYS,
  offerFromLookupKeys,
  OFFER_LOOKUP_KEYS,
} from '~/lib/billing/logic';
import { json, launchSeatsRemaining, loadBilling, priceIdsFor, stripe, supabaseAdmin } from '~/lib/billing/server';

const idOf = (v: string | { id: string } | null | undefined) => (typeof v === 'string' ? v : (v?.id ?? null));

/** Détache le schedule (lancement, descente programmée) pour rendre l'abonnement modifiable. */
async function releaseSchedule(sub: Stripe.Subscription) {
  const scheduleId = idOf(sub.schedule);
  if (scheduleId) await stripe().subscriptionSchedules.release(scheduleId);
}

/** Lignes d'un prix pour un abonnement ou une phase : pas de quantité sur un prix mesuré. */
function itemsFor(offer: keyof typeof OFFER_LOOKUP_KEYS, priceIds: string[]) {
  return OFFER_LOOKUP_KEYS[offer].map((key, i) =>
    METERED_LOOKUP_KEYS.includes(key) ? { price: priceIds[i] } : { price: priceIds[i], quantity: 1 }
  );
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = (await request.json().catch(() => ({}))) as { action?: unknown; offer?: unknown };

    const user = await authenticatedUser(request, 'billing/manage');
    if (!user) return json({ error: 'E_AUTH' }, 401);

    const db = supabaseAdmin();
    const billing = await loadBilling(db, user.id);
    if (!billing?.stripe_subscription_id) return json({ error: 'E_NO_SUBSCRIPTION' }, 404);

    const s = stripe();
    const sub = await s.subscriptions.retrieve(billing.stripe_subscription_id);
    // Défense en profondeur : l'abonnement doit être celui de cet utilisateur.
    if (sub.metadata?.userId !== user.id) {
      console.error('billing/manage: abonnement', sub.id, 'non rattaché à', user.id);
      return json({ error: 'E_NO_SUBSCRIPTION' }, 404);
    }

    if (body.action === 'cancel') {
      // Fin de période : l'accès reste ouvert jusqu'à l'échéance déjà payée.
      await releaseSchedule(sub);
      await s.subscriptions.update(sub.id, { cancel_at_period_end: true });
      return json({ ok: true });
    }

    if (body.action === 'resume') {
      await s.subscriptions.update(sub.id, { cancel_at_period_end: false });
      return json({ ok: true });
    }

    if (body.action !== 'change' || !isOffer(body.offer)) return json({ error: 'E_ACTION' }, 400);
    const offer = body.offer;
    const current = offerFromLookupKeys(sub.items.data.map((i) => i.price.lookup_key));
    if (current === offer) return json({ error: 'E_SAME_OFFER' }, 400);
    if (offer === 'unlimited_launch' && !launchOfferOpen(Date.now(), await launchSeatsRemaining(db))) {
      return json({ error: 'E_LAUNCH_CLOSED', fallback: 'unlimited' }, 409);
    }

    const priceIds = await priceIdsFor(offer);
    const metadata = { userId: user.id, aerox_offer: offer };

    if (current && isDowngrade(current, offer)) {
      // Descente : phase actuelle jusqu'à la fin de la période payée, puis la
      // nouvelle offre. Le schedule est ensuite relâché.
      const scheduleId = idOf(sub.schedule) ?? (await s.subscriptionSchedules.create({ from_subscription: sub.id })).id;
      const schedule = await s.subscriptionSchedules.retrieve(scheduleId);
      const phase = schedule.phases[0];
      await s.subscriptionSchedules.update(scheduleId, {
        end_behavior: 'release',
        metadata: { aerox_schedule: 'downgrade', aerox_offer: offer },
        phases: [
          {
            start_date: phase.start_date,
            end_date: sub.items.data[0].current_period_end,
            // Conserve une éventuelle période d'essai (démarrage au 1er novembre).
            trial_end: phase.trial_end ?? undefined,
            items: sub.items.data.map((i) =>
              METERED_LOOKUP_KEYS.includes(i.price.lookup_key ?? '')
                ? { price: i.price.id }
                : { price: i.price.id, quantity: i.quantity ?? 1 }
            ),
            metadata: sub.metadata,
          },
          {
            items: itemsFor(offer, priceIds),
            duration: { interval: offer === 'unlimited_annual' ? 'year' : 'month', interval_count: 1 },
            proration_behavior: 'none',
            metadata,
          },
        ],
      });
      return json({ ok: true, effective: 'period_end', at: sub.items.data[0].current_period_end });
    }

    // Montée : immédiate, au prorata.
    await releaseSchedule(sub);
    await s.subscriptions.update(sub.id, {
      // Remplace toutes les lignes : sans `deleted`, Stripe AJOUTERAIT les
      // nouveaux prix aux anciens et facturerait les deux.
      items: [...sub.items.data.map((item) => ({ id: item.id, deleted: true })), ...itemsFor(offer, priceIds)],
      proration_behavior: 'create_prorations',
      cancel_at_period_end: false,
      metadata,
    });
    return json({ ok: true, effective: 'now' });
  } catch (err) {
    console.error('billing/manage', err instanceof Error ? err.message : err);
    return json({ error: 'E_SERVER' }, 500);
  }
};
