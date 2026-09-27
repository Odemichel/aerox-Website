// src/pages/api/billing/manage.ts
//
// Changement d'offre et résiliation d'un abonnement bike fitter existant.
//
// Le portail Stripe ne peut pas le faire lui-même : il refuse de modifier un
// abonnement à usage mesuré (Essentiel), et de modifier ou résilier
// un abonnement piloté par un subscription schedule (offre de lancement).
// Cette route couvre ces cas pour toutes les offres, avec la même règle :
// l'abonnement et l'utilisateur viennent du serveur, jamais du corps.
//
// Monter d'offre est immédiat (au prorata), ou programmé pour la période
// suivante (`when: 'next_period'`, proposé à un abonné Essentiel qui dépasse
// 7 analyses). Descendre prend effet à la fin de la période déjà payée, par
// un schedule : un passage en Illimité le temps d'un mois chargé ne se
// rembourse pas.
//
// Après chaque action, `bf_billing` est réaligné sur Stripe par la même
// fonction que le webhook (`syncSubscription`) : l'espace BF affiche tout de
// suite la résiliation ou le changement programmé. Le webhook qui suit
// réécrit les mêmes valeurs.
export const prerender = false;

import type { APIRoute } from 'astro';
import type Stripe from 'stripe';
import { authenticatedUser } from '~/lib/serverAuth';
import {
  ANNUAL_OFFERS,
  isDowngrade,
  LAUNCH_OFFERS,
  isOffer,
  launchOfferOpen,
  METERED_LOOKUP_KEYS,
  offerFromLookupKeys,
  OFFER_LOOKUP_KEYS,
} from '~/lib/billing/logic';
import { json, launchSeatsRemaining, loadBilling, priceIdsFor, stripe, supabaseAdmin } from '~/lib/billing/server';
import { SCHEDULED_CHANGES, syncSubscription } from '~/lib/billing/webhook';

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
    const body = (await request.json().catch(() => ({}))) as { action?: unknown; offer?: unknown; when?: unknown };

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

    const done = async (extra: Record<string, unknown> = {}) => {
      await syncSubscription(db, sub.id);
      return json({ ok: true, ...extra });
    };

    if (body.action === 'cancel') {
      // Fin de période : l'accès reste ouvert jusqu'à l'échéance déjà payée.
      // Le schedule (lancement, descente) est détaché : il piloterait sinon
      // la fin de l'abonnement à la place de la résiliation.
      await releaseSchedule(sub);
      await s.subscriptions.update(sub.id, { cancel_at_period_end: true });
      return done();
    }

    if (body.action === 'resume') {
      // Une résiliation peut aussi être portée par un schedule : il est
      // détaché sans garder la date de fin. Le webhook repose ensuite la
      // bascule à 99 € d'une offre de lancement.
      const scheduleId = idOf(sub.schedule);
      if (scheduleId) await s.subscriptionSchedules.release(scheduleId, { preserve_cancel_date: false });
      const fresh = scheduleId ? await s.subscriptions.retrieve(sub.id) : sub;
      // Date de fin explicite (`cancel_at`) ou fin de période : Stripe
      // n'accepte qu'un des deux paramètres à la fois.
      if (fresh.cancel_at_period_end) await s.subscriptions.update(sub.id, { cancel_at_period_end: false });
      else if (fresh.cancel_at) await s.subscriptions.update(sub.id, { cancel_at: '' });
      return done();
    }

    if (body.action === 'keep') {
      // Annule un changement programmé : l'offre actuelle continue.
      const scheduleId = idOf(sub.schedule);
      if (scheduleId) {
        const schedule = await s.subscriptionSchedules.retrieve(scheduleId);
        if (SCHEDULED_CHANGES.has(schedule.metadata?.aerox_schedule ?? '')) {
          await s.subscriptionSchedules.release(scheduleId);
        }
      }
      return done();
    }

    if (body.action !== 'change' || !isOffer(body.offer)) return json({ error: 'E_ACTION' }, 400);
    const offer = body.offer;
    const current = offerFromLookupKeys(sub.items.data.map((i) => i.price.lookup_key));
    if (current === offer) return json({ error: 'E_SAME_OFFER' }, 400);
    if (LAUNCH_OFFERS.includes(offer) && !launchOfferOpen(Date.now(), await launchSeatsRemaining(db))) {
      return json(
        { error: 'E_LAUNCH_CLOSED', fallback: offer === 'unlimited_launch_annual' ? 'unlimited_annual' : 'unlimited' },
        409
      );
    }

    const priceIds = await priceIdsFor(offer);
    const metadata = { userId: user.id, aerox_offer: offer };

    const downgrade = Boolean(current && isDowngrade(current, offer));
    if (downgrade || body.when === 'next_period') {
      // Descente, ou montée pour la période suivante : phase actuelle jusqu'à
      // la fin de la période payée, puis la nouvelle offre. Le schedule est
      // ensuite relâché.
      // Changer d'offre, c'est continuer : une résiliation programmée est
      // levée d'abord (un schedule ne se crée pas proprement dessus).
      if (sub.cancel_at_period_end || sub.cancel_at) {
        await s.subscriptions.update(sub.id, { cancel_at_period_end: false });
      }
      const scheduleId = idOf(sub.schedule) ?? (await s.subscriptionSchedules.create({ from_subscription: sub.id })).id;
      const schedule = await s.subscriptionSchedules.retrieve(scheduleId);
      // Phase en cours (un schedule garde ses phases passées dans la liste).
      const phase =
        schedule.phases.find((p) => p.start_date === schedule.current_phase?.start_date) ?? schedule.phases[0];
      await s.subscriptionSchedules.update(scheduleId, {
        end_behavior: 'release',
        metadata: { aerox_schedule: downgrade ? 'downgrade' : 'upgrade', aerox_offer: offer },
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
            duration: { interval: ANNUAL_OFFERS.includes(offer) ? 'year' : 'month', interval_count: 1 },
            proration_behavior: 'none',
            metadata,
          },
        ],
      });
      return done({ effective: 'period_end', at: sub.items.data[0].current_period_end });
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
    return done({ effective: 'now' });
  } catch (err) {
    console.error('billing/manage', err instanceof Error ? err.message : err);
    return json({ error: 'E_SERVER' }, 500);
  }
};
