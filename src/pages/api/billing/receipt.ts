// src/pages/api/billing/receipt.ts
//
// Reçu Stripe d'un achat du Diagnostic, pour l'onglet Facturation du cycliste.
// Le Diagnostic est payé par Checkout en mode `payment`, sans facture : le
// justificatif est le reçu du paiement (`charge.receipt_url`), une page
// Stripe qui le montre à jour (remboursement compris).
//
// L'utilisateur vient du jeton ; l'achat doit lui appartenir.
export const prerender = false;

import type { APIRoute } from 'astro';
import type Stripe from 'stripe';
import { authenticatedUser } from '~/lib/serverAuth';
import { json, stripe, supabaseAdmin } from '~/lib/billing/server';

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = (await request.json().catch(() => ({}))) as { purchase?: unknown };
    const id = typeof body.purchase === 'string' ? body.purchase : '';
    if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: 'E_NOT_FOUND' }, 404);

    const user = await authenticatedUser(request, 'billing/receipt');
    if (!user) return json({ error: 'E_AUTH' }, 401);

    const { data: purchase } = await supabaseAdmin()
      .from('diagnostic_purchases')
      .select('stripe_payment_intent_id')
      .eq('id', id)
      .eq('user_id', user.id)
      .maybeSingle();
    if (!purchase?.stripe_payment_intent_id) return json({ error: 'E_NOT_FOUND' }, 404);

    const intent = await stripe().paymentIntents.retrieve(purchase.stripe_payment_intent_id, {
      expand: ['latest_charge'],
    });
    const url = (intent.latest_charge as Stripe.Charge | null)?.receipt_url;
    if (!url) return json({ error: 'E_NOT_FOUND' }, 404);
    return json({ url });
  } catch (err) {
    console.error('billing/receipt', err instanceof Error ? err.message : err);
    return json({ error: 'E_SERVER' }, 500);
  }
};
