// /src/pages/[lang]/telechargement/api/create-api-checkout.ts
export const prerender = false;

import type { APIRoute } from 'astro';
import Stripe from 'stripe';

const stripe = new Stripe(import.meta.env.STRIPE_SECRET_KEY as string);

type Body = {
  priceId?: string;
  lookupKey?: string;
  customerEmail?: string;
  userId?: string;
  product?: string;
  lang?: string;
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = (await request.json().catch(() => ({}))) as Body;

    // --- Détection de la langue ---
    let lang = body.lang;
    if (!lang) {
      const url = new URL(request.url);
      // essaie d'extraire la langue du chemin (ex: /fr/telechargement/api/...)
      const match = url.pathname.match(/^\/([a-z]{2})(\/|$)/);
      lang = match?.[1] || 'fr'; // fallback fr
    }

    // --- Prix : résolution par lookup_key uniquement si l'appelant la
    // --- demande explicitement (body.lookupKey). Volontairement PAS de
    // --- repli sur une variable d'environnement type STRIPE_LOOKUP_KEY :
    // --- ce serait un interrupteur global — si elle existait un jour dans
    // --- l'environnement, tous les appelants (y compris ceux qui n'envoient
    // --- aucun corps et attendent STRIPE_PRICE_ID) basculeraient d'un coup
    // --- sur un autre prix, en dépendant en plus d'un stripe.prices.list()
    // --- réussi là où aucun appel réseau n'était fait avant. Même défaut
    // --- de forme que le subscription_data retiré plus haut : inoffensif
    // --- tant que personne ne l'arme, fatal le jour où quelqu'un le fait
    // --- sans le savoir. Sans lookupKey dans le corps, on retombe
    // --- directement sur body.priceId ?? STRIPE_PRICE_ID, exactement comme
    // --- avant ce chantier.
    let priceId = '';
    const key = body.lookupKey;
    if (key) {
      const prices = await stripe.prices.list({ lookup_keys: [key], active: true, expand: ['data.product'] });
      if (!prices.data.length) throw new Error(`No active price for lookupKey "${key}"`);
      priceId = prices.data[0].id;
    }
    if (!priceId) priceId = (body.priceId ?? import.meta.env.STRIPE_PRICE_ID ?? '').trim();
    if (!priceId) throw new Error('Missing priceId');

    // --- Base site ---
    const reqOrigin = new URL(request.url).origin; // http://localhost:4321
    const envBase = (import.meta.env.PUBLIC_SITE_URL || '').split('#')[0];
    const base = envBase || reqOrigin;

    // --- Routes localisées (trailingSlash: 'always') ---
    const successPath = `/${lang}/telechargement/success/`;
    const cancelPath = `/${lang}/telechargement/cancel/`;

    const successUrl = new URL(successPath, base);
    if (body.product) successUrl.searchParams.set('product', body.product);
    const cancelUrl = new URL(cancelPath, base);

    const looksHttp = (u: string) => /^https?:\/\//i.test(u);
    if (!looksHttp(successUrl.toString()) || !looksHttp(cancelUrl.toString())) {
      throw new Error(`Invalid success/cancel URL (${successUrl} | ${cancelUrl})`);
    }

    const metadata: Record<string, string> = {};
    if (body.userId) metadata.userId = body.userId;
    if (body.product) metadata.product = body.product;

    // --- Création session Stripe ---
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl.toString(),
      cancel_url: cancelUrl.toString(),
      allow_promotion_codes: false,
      billing_address_collection: 'auto',
      automatic_tax: { enabled: true },
      customer_email: body.customerEmail,
      customer_creation: 'if_required',
      metadata,
      // Pas de `subscription_data` ici : l'API Stripe le refuse en mode
      // 'payment' (« You can not pass `subscription_data` in `payment`
      // mode. »). L'équivalent légal pour conserver les métadonnées côté
      // Stripe est `payment_intent_data`.
      payment_intent_data: { metadata },
    });

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('create-api-checkout', message);
    return new Response(JSON.stringify({ error: message }), { status: 500 });
  }
};
