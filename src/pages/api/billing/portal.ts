// src/pages/api/billing/portal.ts
//
// Ouvre le portail client Stripe du bike fitter : factures, moyen de paiement,
// numéro de TVA, résiliation. Le changement d'offre n'y est pas proposé : le
// portail ne sait pas modifier un abonnement Studio (usage mesuré) ni un
// abonnement de lancement (schedule) — voir /api/billing/manage/.
export const prerender = false;

import type { APIRoute } from 'astro';
import { authenticatedUser } from '~/lib/serverAuth';
import {
  accountUrl,
  json,
  loadBilling,
  portalConfiguration,
  safeLang,
  siteBase,
  stripe,
  supabaseAdmin,
} from '~/lib/billing/server';

export const POST: APIRoute = async ({ request, site }) => {
  try {
    const body = (await request.json().catch(() => ({}))) as { lang?: unknown };
    const lang = safeLang(body.lang);

    const user = await authenticatedUser(request, 'billing/portal');
    if (!user) return json({ error: 'E_AUTH' }, 401);

    const billing = await loadBilling(supabaseAdmin(), user.id);
    // Pas de client Stripe = aucun achat : rien à gérer dans le portail.
    if (!billing?.stripe_customer_id) return json({ error: 'E_NO_CUSTOMER' }, 404);

    const session = await stripe().billingPortal.sessions.create({
      customer: billing.stripe_customer_id,
      return_url: accountUrl(siteBase(request, site), lang),
      configuration: await portalConfiguration(),
    });
    return json({ url: session.url });
  } catch (err) {
    console.error('billing/portal', err instanceof Error ? err.message : err);
    return json({ error: 'E_SERVER' }, 500);
  }
};
