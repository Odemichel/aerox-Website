// src/pages/api/billing/trial-card.ts
//
// Essai bike fitter : Checkout en mode « setup » pour enregistrer une carte
// (0 € débité). Le webhook débloque ensuite les 2 analyses offertes si la
// carte n'a jamais servi à un essai (voir bf_grant_trial).
export const prerender = false;

import type { APIRoute } from 'astro';
import { authenticatedUser } from '~/lib/serverAuth';
import {
  accountUrl,
  ensureCustomer,
  json,
  loadBilling,
  loadRole,
  safeLang,
  siteBase,
  stripe,
  supabaseAdmin,
} from '~/lib/billing/server';

export const POST: APIRoute = async ({ request, site }) => {
  try {
    const body = (await request.json().catch(() => ({}))) as { lang?: unknown };
    const lang = safeLang(body.lang);

    const user = await authenticatedUser(request, 'billing/trial-card');
    if (!user) return json({ error: 'E_AUTH' }, 401);

    const db = supabaseAdmin();
    const role = await loadRole(db, user.id);
    if (role !== 'bike-fitter' && role !== 'admin') return json({ error: 'E_ROLE' }, 403);

    const billing = await loadBilling(db, user.id);
    if (!billing || billing.plan !== 'trial' || billing.trial_state !== 'needs_card') {
      return json({ error: 'E_TRIAL_UNAVAILABLE' }, 409);
    }

    const customer = await ensureCustomer(db, user, billing);
    const metadata = { userId: user.id, aerox_offer: 'trial_card' };
    const base = siteBase(request, site);
    const session = await stripe().checkout.sessions.create({
      mode: 'setup',
      customer,
      payment_method_types: ['card'],
      metadata,
      setup_intent_data: { metadata },
      locale: 'auto',
      success_url: accountUrl(base, lang, 'card'),
      cancel_url: accountUrl(base, lang),
    });
    return json({ url: session.url });
  } catch (err) {
    console.error('billing/trial-card', err instanceof Error ? err.message : err);
    return json({ error: 'E_SERVER' }, 500);
  }
};
