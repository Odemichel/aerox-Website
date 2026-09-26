// src/pages/api/billing/checkout.ts
//
// Crée la session Stripe Checkout d'une offre bike fitter.
//
// Même contrat de sécurité que `create-api-checkout.ts` : le corps ne choisit
// que l'offre (liste blanche) et la langue (liste blanche). Le prix vient du
// catalogue serveur, l'utilisateur du jeton vérifié. Le webhook croit les
// métadonnées signées `userId` / `aerox_offer` posées ici, et rien d'autre.
export const prerender = false;

import type { APIRoute } from 'astro';
import type Stripe from 'stripe';
import { authenticatedUser } from '~/lib/serverAuth';
import {
  isOffer,
  LAUNCH_OFFERS,
  launchOfferOpen,
  METERED_LOOKUP_KEYS,
  OFFER_LOOKUP_KEYS,
  subscriptionStart,
  ANNUAL_OFFERS,
} from '~/lib/billing/logic';
import {
  accountUrl,
  ensureCustomer,
  json,
  launchSeatsRemaining,
  loadBilling,
  loadRole,
  priceIdsFor,
  safeLang,
  siteBase,
  stripe,
  supabaseAdmin,
} from '~/lib/billing/server';

// Langues du site proposées telles quelles à Checkout (toutes gérées par Stripe).
const CHECKOUT_LOCALES: Record<string, Stripe.Checkout.SessionCreateParams.Locale> = {
  fr: 'fr',
  en: 'en',
  pt: 'pt',
  es: 'es',
  it: 'it',
  de: 'de',
  nl: 'nl',
  ja: 'ja',
  tr: 'tr',
};

// Texte sous le bouton de paiement quand Checkout parle de « jours
// gratuits » (voir plus bas). Anglais par défaut pour les autres langues.
const PREORDER_NOTE: Record<string, string> = {
  fr: 'Offres disponibles le 1er novembre 2026 : vous êtes abonné dès aujourd’hui, sans aucun prélèvement avant cette date. Ce n’est pas un essai gratuit.',
  en: 'Plans start on 1 November 2026: you subscribe today and nothing is charged before that date. This is not a free trial.',
};

export const POST: APIRoute = async ({ request, site }) => {
  try {
    const body = (await request.json().catch(() => ({}))) as { offer?: unknown; lang?: unknown };
    if (!isOffer(body.offer)) return json({ error: 'E_OFFER' }, 400);
    const offer = body.offer;
    const lang = safeLang(body.lang);

    const user = await authenticatedUser(request, 'billing/checkout');
    if (!user) return json({ error: 'E_AUTH' }, 401);

    const db = supabaseAdmin();
    const role = await loadRole(db, user.id);
    if (role !== 'bike-fitter' && role !== 'admin') return json({ error: 'E_ROLE' }, 403);

    const billing = await loadBilling(db, user.id);

    // Un seul abonnement par bike fitter : changer d'offre passe par
    // /api/billing/manage/, qui modifie l'abonnement existant au lieu d'en
    // empiler un second (double prélèvement).
    if (billing?.stripe_subscription_id) return json({ error: 'E_HAS_SUBSCRIPTION' }, 409);

    if (LAUNCH_OFFERS.includes(offer) && !launchOfferOpen(Date.now(), await launchSeatsRemaining(db))) {
      return json(
        { error: 'E_LAUNCH_CLOSED', fallback: offer === 'unlimited_launch_annual' ? 'unlimited_annual' : 'unlimited' },
        409
      );
    }

    const [customer, priceIds] = await Promise.all([ensureCustomer(db, user, billing, lang), priceIdsFor(offer)]);

    // Une seule page de paiement d'abonnement ouverte à la fois : une session
    // restée ouverte dans un autre onglet (offre choisie puis abandonnée)
    // pourrait sinon être payée en plus de celle-ci. Le webhook rattrape le
    // cas restant (deux paiements quasi simultanés).
    for await (const open of stripe().checkout.sessions.list({ customer, status: 'open', limit: 20 })) {
      if (open.mode === 'subscription' && open.metadata?.aerox_offer) {
        await stripe()
          .checkout.sessions.expire(open.id)
          .catch((err) => console.error('billing/checkout: session non expirée', open.id, err?.message));
      }
    }
    const metadata = { userId: user.id, aerox_offer: offer };
    const base = siteBase(request, site);

    const start = subscriptionStart(Date.now(), ANNUAL_OFFERS.includes(offer));
    const params: Stripe.Checkout.SessionCreateParams = {
      mode: 'subscription',
      customer,
      // Adresse et raison sociale saisies au paiement enregistrées sur le
      // client : Stripe Tax en a besoin pour les factures suivantes, et le
      // numéro de TVA collecté y est rattaché (autoliquidation B2B UE).
      customer_update: { name: 'auto', address: 'auto' },
      billing_address_collection: 'required',
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
      locale: CHECKOUT_LOCALES[lang] ?? 'auto',
      allow_promotion_codes: false,
      // Période d'essai Stripe (offre mensuelle souscrite plus d'un mois avant
      // le 1er novembre) : Checkout l'annonce en « jours gratuits ». Ce n'en
      // sont pas : on précise sous le bouton de paiement.
      ...('trial_end' in start
        ? { custom_text: { submit: { message: PREORDER_NOTE[lang] ?? PREORDER_NOTE.en } } }
        : {}),
      success_url: accountUrl(base, lang, 'success'),
      cancel_url: accountUrl(base, lang, 'cancel'),
      metadata,
      // Les prix mesurés (À l'usage, Studio) n'ont pas de quantité : elle
      // vient du meter.
      line_items: OFFER_LOOKUP_KEYS[offer].map((key, i) =>
        METERED_LOOKUP_KEYS.includes(key) ? { price: priceIds[i] } : { price: priceIds[i], quantity: 1 }
      ),
      subscription_data: {
        metadata,
        // Souscrit avant le 1er novembre 2026 : abonné tout de suite, premier
        // prélèvement à la mise à disposition (voir subscriptionStart).
        ...start,
        // Mode flexible : l'usage non facturé est facturé si l'on retire une
        // ligne mesurée (passage de Studio à Illimité en cours de mois).
        billing_mode: { type: 'flexible' },
      },
    };

    const session = await stripe().checkout.sessions.create(params);
    return json({ url: session.url });
  } catch (err) {
    console.error('billing/checkout', err instanceof Error ? err.message : err);
    return json({ error: 'E_SERVER' }, 500);
  }
};
