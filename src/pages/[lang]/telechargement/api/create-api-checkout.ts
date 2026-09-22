// /src/pages/[lang]/telechargement/api/create-api-checkout.ts
//
// Route publique : elle n'est protégée par aucun middleware. Tout ce qu'elle
// lit dans le corps de la requête est donc sous le contrôle total de
// l'appelant, y compris d'un appelant hostile qui n'a jamais ouvert le site.
// Deux valeurs ne doivent par conséquent JAMAIS venir du corps sur un chemin
// qui débloque un produit :
//
//  - le prix. Un `priceId` accepté tel quel permettait de payer le livre
//    (29 €) en repartant avec une session étiquetée `product: "diagnostic"`.
//    Stripe signe fidèlement ce qu'on lui a demandé, le webhook croit — à
//    juste titre — ses propres métadonnées signées, et ouvre le diagnostic à
//    79 €. Le `priceId` n'est pas un secret : Stripe l'expose dans le payload
//    de sa page de paiement ; une lookup_key est encore plus devinable.
//  - l'identifiant utilisateur. Un `userId` recopié du corps laissait choisir
//    le compte à créditer, donc débloquer le diagnostic chez quelqu'un
//    d'autre.
//
// Le prix vient maintenant d'une table serveur `product -> lookup_key`, et
// l'identifiant du jeton d'authentification vérifié auprès de Supabase.
export const prerender = false;

import { createClient } from '@supabase/supabase-js';
import type { APIRoute } from 'astro';
import Stripe from 'stripe';

const stripe = new Stripe(import.meta.env.STRIPE_SECRET_KEY as string);

// Seule source de vérité du couple (produit vendu, prix facturé). Ajouter un
// produit = ajouter une ligne ici, jamais un champ de plus dans le corps.
// Les `lookup_key` sont des étiquettes Stripe, pas des identifiants de prix :
// aucun `price_…` n'est écrit en dur, le montant reste piloté depuis le
// tableau de bord Stripe.
const PRODUCT_PRICE_LOOKUP_KEYS: Record<string, string> = {
  diagnostic: 'diagnostic_basic',
};

type Body = {
  customerEmail?: string;
  product?: string;
  lang?: string;
};

// Réponses d'erreur volontairement courtes et opaques : elles sortent vers un
// appelant non authentifié, elles n'ont pas à dire quels produits existent ni
// pourquoi un jeton est refusé. Le détail part dans les journaux serveur.
const fail = (status: number, code: string) =>
  new Response(JSON.stringify({ error: code }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/**
 * Identifiant de l'utilisateur derrière la requête, ou `null`.
 *
 * Le jeton est lu dans l'en-tête `Authorization` et vérifié par Supabase :
 * `auth.getUser(jwt)` valide la signature et l'expiration côté serveur
 * d'authentification. La session du site vit dans `localStorage` (voir
 * `src/config/supabaseClient.ts`) et non dans un cookie : il n'y a rien à
 * lire d'autre que cet en-tête, que le client doit poser explicitement.
 */
async function authenticatedUser(request: Request) {
  const header = request.headers.get('authorization') ?? '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!token || token === header.trim()) return null;

  const url = (import.meta.env.PUBLIC_SUPABASE_URL || import.meta.env.SUPABASE_URL) as string | undefined;
  const anonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY as string | undefined;
  if (!url || !anonKey) {
    console.error('create-api-checkout: configuration Supabase absente, authentification impossible');
    return null;
  }

  // Clé anon, jamais la clé service_role : on veut vérifier un jeton, pas
  // obtenir un pouvoir d'administration dans une route publique.
  const supabase = createClient(url, anonKey, { auth: { persistSession: false } });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    console.error('create-api-checkout: jeton refusé —', error?.message ?? 'aucun utilisateur');
    return null;
  }
  return data.user;
}

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

    const metadata: Record<string, string> = {};
    let priceId = '';
    let customerEmail = body.customerEmail;

    if (body.product) {
      // --- Chemin « vente d'un produit » : tout est décidé ici, côté serveur.
      const lookupKey = PRODUCT_PRICE_LOOKUP_KEYS[body.product];
      if (!lookupKey) {
        console.error('create-api-checkout: produit inconnu —', body.product);
        return fail(400, 'E_PRODUCT');
      }

      const user = await authenticatedUser(request);
      if (!user) return fail(401, 'E_AUTH');

      const prices = await stripe.prices.list({ lookup_keys: [lookupKey], active: true });
      if (!prices.data.length) {
        console.error('create-api-checkout: aucun prix actif pour la lookup_key', lookupKey);
        return fail(500, 'E_PRICE');
      }
      priceId = prices.data[0].id;

      // Métadonnées : les deux valeurs que le webhook croira sur parole.
      // Elles viennent de la table serveur et du jeton vérifié, jamais du corps.
      metadata.product = body.product;
      metadata.userId = user.id;
      customerEmail = user.email ?? customerEmail;
    } else {
      // --- Chemin historique sans produit : repli sur `STRIPE_PRICE_ID`,
      // --- exactement comme avant. Ce chemin ne pose aucune métadonnée, donc
      // --- le webhook ne débloque rien : il n'y a rien à protéger ici.
      // ---
      // --- `body.priceId` et `body.lookupKey` ont été retirés du contrat.
      // --- Les conserver hors du chemin produit aurait gardé, dans cette même
      // --- fonction, une branche vivante où le prix vient encore du client :
      // --- le jour où quelqu'un ajoute un produit ou factorise les deux
      // --- branches, la faille revient sans que rien ne la signale. Aucun
      // --- appelant du dépôt ne s'en sert (le seul est `PricingSection.astro`,
      // --- qui envoie `product`), et le repli demandé — corps vide vers
      // --- `STRIPE_PRICE_ID` — n'en a pas besoin. La souplesse perdue est
      // --- théorique, la branche supprimée était réelle.
      // ---
      // --- Volontairement pas de repli sur une variable d'environnement type
      // --- `STRIPE_LOOKUP_KEY` : ce serait un interrupteur global qui ferait
      // --- basculer d'un coup tous les appels sans corps sur un autre prix.
      priceId = (import.meta.env.STRIPE_PRICE_ID ?? '').trim();
      if (!priceId) throw new Error('Missing priceId');
    }

    // --- Base site ---
    const reqOrigin = new URL(request.url).origin; // http://localhost:4321
    const envBase = (import.meta.env.PUBLIC_SITE_URL || '').split('#')[0];
    const base = envBase || reqOrigin;

    // --- Routes localisées (trailingSlash: 'always') ---
    const successPath = `/${lang}/telechargement/success/`;
    const cancelPath = `/${lang}/telechargement/cancel/`;

    const successUrl = new URL(successPath, base);
    if (metadata.product) successUrl.searchParams.set('product', metadata.product);
    const cancelUrl = new URL(cancelPath, base);

    const looksHttp = (u: string) => /^https?:\/\//i.test(u);
    if (!looksHttp(successUrl.toString()) || !looksHttp(cancelUrl.toString())) {
      throw new Error(`Invalid success/cancel URL (${successUrl} | ${cancelUrl})`);
    }

    // --- Création session Stripe ---
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl.toString(),
      cancel_url: cancelUrl.toString(),
      allow_promotion_codes: false,
      billing_address_collection: 'auto',
      automatic_tax: { enabled: true },
      customer_email: customerEmail,
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
