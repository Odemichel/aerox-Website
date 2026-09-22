// /src/pages/api/stripe-webhook.ts
//
// Seul pont entre l'encaissement Stripe et le produit ouvert : sans cette
// route, rien dans AeroX n'apprend jamais qu'un paiement a eu lieu.
//
// Déploiement : l'endpoint déclaré chez Stripe doit se terminer par une barre
// (`https://aeroxbefaster.com/api/stripe-webhook/`). `astro.config.ts` impose
// `trailingSlash: 'always'` ; sans le slash final Astro répond une redirection
// que Stripe compte comme un échec de livraison.
export const prerender = false;

import { createClient } from '@supabase/supabase-js';
import type { APIRoute } from 'astro';
import Stripe from 'stripe';

const stripe = new Stripe(import.meta.env.STRIPE_SECRET_KEY as string);

export const POST: APIRoute = async ({ request }) => {
  const signature = request.headers.get('stripe-signature');
  const secret = import.meta.env.STRIPE_WEBHOOK_SECRET as string | undefined;

  // Un corps sans en-tête de signature est du bruit hostile : on refuse avant
  // de lire quoi que ce soit.
  if (!signature) {
    console.error('stripe-webhook: en-tête stripe-signature manquant');
    return new Response('Missing signature', { status: 400 });
  }

  // Secret absent = mauvaise configuration serveur, pas une requête invalide.
  // 500 : Stripe rejouera l'événement une fois la variable posée, au lieu de
  // le classer définitivement comme rejeté.
  if (!secret) {
    console.error('stripe-webhook: STRIPE_WEBHOOK_SECRET absent de l’environnement');
    return new Response('Server misconfigured', { status: 500 });
  }

  // Le corps brut est indispensable : la signature Stripe est calculée sur les
  // octets exacts reçus, toute désérialisation préalable l'invaliderait.
  const raw = await request.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, signature, secret);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('stripe-webhook: signature invalide', message);
    return new Response('Invalid signature', { status: 400 });
  }

  // À partir d'ici, et seulement à partir d'ici, le contenu est digne de foi.
  // Tout ce qui n'est pas l'événement attendu repart en 200 : Stripe traite
  // un non-200 comme un échec de livraison et rejoue l'événement.
  if (event.type !== 'checkout.session.completed') {
    return new Response('ignored', { status: 200 });
  }

  const session = event.data.object as Stripe.Checkout.Session;

  if (session.payment_status !== 'paid') {
    return new Response('not paid', { status: 200 });
  }

  // Seules les métadonnées signées par Stripe font foi. Rien n'est lu d'un
  // en-tête, d'un paramètre d'URL ni du corps déserialisé séparément : c'est
  // ce qui empêche n'importe qui de débloquer le compte de son choix.
  const userId = session.metadata?.userId;
  const product = session.metadata?.product;

  // `product` est vérifié, et pas seulement `userId` : la route du livre
  // (`create-api-livre-checkout.ts`) pose `metadata.userId` sans jamais poser
  // `metadata.product`. Sans ce filtre, l'achat du livre débloquerait le
  // diagnostic. Le filtre est donc une condition de sécurité commerciale, pas
  // une précaution cosmétique.
  if (!userId || product !== 'diagnostic') {
    return new Response('nothing to unlock', { status: 200 });
  }

  const supabase = createClient(
    import.meta.env.SUPABASE_URL as string,
    import.meta.env.SUPABASE_SERVICE_ROLE_KEY as string, // ⚠️ SERVICE ROLE, jamais exposé au client
    { auth: { persistSession: false } }
  );

  // Écriture idempotente : un rejeu réécrit les mêmes valeurs, seul
  // `diagnostic_basic_paid_at` est rafraîchi. Rien ne casse.
  const { data, error } = await supabase
    .from('users')
    .update({ diagnostic_basic_paid: true, diagnostic_basic_paid_at: new Date().toISOString() })
    .eq('id', userId)
    .select('id');

  // Les deux échecs ci-dessous rendent le même code — 500 — mais se
  // journalisent distinctement : ils appellent des actions opposées et il ne
  // faut pas les confondre en lisant les journaux. Le corps rendu à Stripe
  // reste court et sans détail technique : leur interface l'affiche, ce n'est
  // pas un canal de diagnostic.

  // Cas 1 — la base a refusé l'écriture. Panne passagère ou déploiement en
  // cours : le rejeu de Stripe (intervalle croissant, ~3 jours) l'absorbe sans
  // intervention. Un 200 ici sortirait l'événement de la file et le perdrait
  // définitivement : client débité, produit fermé, plus rien à rejouer.
  if (error) {
    console.error('stripe-webhook: ERREUR_BASE — écriture refusée pour', userId, '—', error.message);
    return new Response('unlock failed', { status: 500 });
  }

  // Cas 2 — aucune ligne touchée : l'identifiant signé ne correspond à aucun
  // utilisateur. PostgREST ne le signale pas comme une erreur, mais le dégât
  // est le même. Échec permanent : le rejeu ne réparera jamais rien. On rend
  // quand même 500, parce que les livraisons en échec sont visibles dans le
  // tableau de bord Stripe et que c'est la seule alerte disponible.
  if (!data || data.length === 0) {
    console.error('stripe-webhook: UTILISATEUR_INCONNU — aucune ligne mise à jour pour', userId);
    return new Response('unlock failed', { status: 500 });
  }

  console.log('stripe-webhook: diagnostic débloqué pour', userId);
  return new Response('ok', { status: 200 });
};
