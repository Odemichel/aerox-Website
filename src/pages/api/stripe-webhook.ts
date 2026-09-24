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
import { handleBillingEvent, isBillingObject } from '~/lib/billing/webhook';
import { isDiagnosticAvailable } from '~/config/diagnostic';
import {
  DIAGNOSTIC_PREORDER_GROUPS,
  DIAGNOSTIC_PRODUCT,
  diagnosticPreorderGroup,
  purchaseFromSession,
  refundFromCharge,
} from '~/lib/diagnostic/purchase';
import { addToMailerLiteGroup, removeFromMailerLiteGroups, upsertMailerLiteFields } from '~/lib/mailerlite';

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

  // Offres bike fitter : traitées à part, avec idempotence par identifiant
  // d'événement (table `stripe_events`). Le diagnostic cycliste, plus bas,
  // n'est pas concerné : ses écritures sont idempotentes par nature (une
  // ligne par session Checkout, remboursement réécrit à l'identique).
  if (isBillingObject(event)) {
    return handleBillingWithIdempotence(event);
  }

  // À partir d'ici, et seulement à partir d'ici, le contenu est digne de foi.
  // Tout ce qui n'est pas l'événement attendu repart en 200 : Stripe traite
  // un non-200 comme un échec de livraison et rejoue l'événement.

  // Remboursement : fait dans le tableau de bord Stripe, il retire l'accès et
  // laisse une trace (`diagnostic_purchases.refunded_at`).
  if (event.type === 'charge.refunded') {
    return handleDiagnosticRefund(event.data.object as Stripe.Charge);
  }

  // Deux événements, pas un seul. Les moyens de paiement à notification
  // différée actifs sur le compte (klarna, bancontact) envoient d'abord
  // `checkout.session.completed` avec `payment_status: 'unpaid'` — les fonds
  // ne sont pas encore confirmés — puis `checkout.session.async_payment_succeeded`
  // une fois le paiement abouti. N'écouter que le premier revenait à acquitter
  // en 200 la seule notification jamais reçue pour ces paiements : client
  // débité, diagnostic fermé, et aucune trace — un 200 sort l'événement de la
  // file, il n'apparaît même pas dans les livraisons en échec du tableau de
  // bord.
  //
  // Les deux événements portent le même `data.object` — une
  // `Stripe.Checkout.Session` (types Stripe, `EventTypes.d.ts`) — donc tout ce
  // qui suit s'applique sans changement. Le cas d'un compte qui recevrait les
  // deux événements pour un même paiement est couvert par l'idempotence de
  // l'écriture plus bas.
  const HANDLED = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];
  if (!HANDLED.includes(event.type)) {
    return new Response('ignored', { status: 200 });
  }

  // Seules les métadonnées signées par Stripe font foi (voir
  // `purchaseFromSession`) : c'est ce qui empêche n'importe qui de débloquer
  // le compte de son choix, et l'achat du livre de débloquer le diagnostic.
  const session = event.data.object as Stripe.Checkout.Session;
  const purchase = purchaseFromSession(session, new Date());
  if (!purchase) {
    return new Response('nothing to unlock', { status: 200 });
  }

  // Un achat = une ligne, clé = la session Checkout. Un rejeu ou le second
  // des deux événements ne crée rien de plus : un rider qui paie une fois
  // n'obtient qu'un diagnostic.
  const { data: inserted, error } = await serviceClient()
    .from('diagnostic_purchases')
    .upsert(purchase, { onConflict: 'stripe_checkout_session_id', ignoreDuplicates: true })
    .select('id');

  // Les deux échecs ci-dessous rendent le même code — 500 — mais se
  // journalisent distinctement : ils appellent des actions opposées et il ne
  // faut pas les confondre en lisant les journaux. Le corps rendu à Stripe
  // reste court et sans détail technique : leur interface l'affiche, ce n'est
  // pas un canal de diagnostic.
  if (error) {
    // Cas 1 — l'identifiant signé ne correspond à aucun compte (clé
    // étrangère). Échec permanent : le rejeu ne réparera rien. On rend quand
    // même 500, parce que les livraisons en échec sont visibles dans le
    // tableau de bord Stripe et que c'est la seule alerte disponible.
    if (error.code === '23503') {
      console.error('stripe-webhook: UTILISATEUR_INCONNU — achat non rattachable pour', purchase.user_id);
      return new Response('unlock failed', { status: 500 });
    }
    // Cas 2 — la base a refusé l'écriture. Panne passagère ou déploiement en
    // cours : le rejeu de Stripe (intervalle croissant, ~3 jours) l'absorbe
    // sans intervention. Un 200 ici sortirait l'événement de la file et le
    // perdrait définitivement : client débité, produit fermé.
    console.error('stripe-webhook: ERREUR_BASE — achat non enregistré pour', purchase.user_id, '—', error.message);
    return new Response('unlock failed', { status: 500 });
  }

  // Emails MailerLite, seulement au premier enregistrement (un rejeu ne
  // renvoie pas la confirmation). Jamais bloquant : l'achat est acquis, un CRM
  // indisponible ne doit pas faire rejouer le paiement.
  const email = session.customer_details?.email ?? session.customer_email;
  if (inserted?.length && email) {
    if (isDiagnosticAvailable()) {
      await upsertMailerLiteFields(email, { diag_status: 'purchased' });
    } else {
      // Pré-réservation : le groupe déclenche l'email de confirmation et
      // recevra celui de livraison, 7 jours avant.
      await addToMailerLiteGroup(email, diagnosticPreorderGroup(session.metadata?.lang), {
        diag_status: 'preorder',
      });
    }
  }

  console.log('stripe-webhook: achat du diagnostic enregistré pour', purchase.user_id);
  return new Response('ok', { status: 200 });
};

// Client service_role, créé à la demande : il contourne la RLS, il ne sort
// jamais de ce fichier.
function serviceClient() {
  return createClient(
    import.meta.env.SUPABASE_URL as string,
    import.meta.env.SUPABASE_SERVICE_ROLE_KEY as string, // ⚠️ SERVICE ROLE, jamais exposé au client
    { auth: { persistSession: false } }
  );
}

async function handleDiagnosticRefund(charge: Stripe.Charge): Promise<Response> {
  const refund = refundFromCharge(charge);
  if (!refund) return new Response('ignored', { status: 200 });

  // La base décide si la charge est un achat de diagnostic (PaymentIntent
  // connu) et, au remboursement total, révoque le diagnostic en cours.
  // Idempotent : un rejeu réécrit les mêmes valeurs.
  const { data: purchaseId, error } = await serviceClient().rpc('record_diagnostic_refund', {
    p_payment_intent_id: refund.paymentIntentId,
    p_amount_refunded: refund.amountRefunded,
    p_fully_refunded: refund.fullyRefunded,
  });
  if (error) {
    // 500 : Stripe rejoue. Un 200 laisserait l'accès ouvert après remboursement.
    console.error(
      'stripe-webhook: ERREUR_BASE — remboursement non tracé pour',
      refund.paymentIntentId,
      '—',
      error.message
    );
    return new Response('refund failed', { status: 500 });
  }
  if (!purchaseId) {
    // PaymentIntent inconnu de la table. Soit la charge n'est pas un
    // diagnostic (livre, offre bike fitter) : rien à faire. Soit l'achat
    // n'est pas encore enregistré (son webhook a échoué et attend un rejeu) :
    // acquitter ici perdrait le remboursement, et l'achat enregistré plus
    // tard ouvrirait l'accès à un rider remboursé. Stripe tranche : le
    // PaymentIntent porte le produit posé au checkout.
    const intent = await stripe.paymentIntents.retrieve(refund.paymentIntentId);
    if (intent.metadata?.product === DIAGNOSTIC_PRODUCT) {
      console.error('stripe-webhook: ACHAT_ABSENT — remboursement reçu avant l’achat pour', refund.paymentIntentId);
      return new Response('refund failed', { status: 500 });
    }
    return new Response('not a diagnostic', { status: 200 });
  }

  // Remboursé : plus d'email de livraison. Jamais bloquant.
  if (refund.fullyRefunded) await forgetRefundedBuyer(purchaseId as string);

  console.log(
    'stripe-webhook: remboursement du diagnostic',
    refund.fullyRefunded ? 'total, accès retiré' : 'partiel',
    '—',
    refund.paymentIntentId
  );
  return new Response('ok', { status: 200 });
}

// Sort l'acheteur remboursé des groupes de pré-réservation et le marque
// `refunded`, à partir de l'e-mail de son compte AeroX.
async function forgetRefundedBuyer(purchaseId: string): Promise<void> {
  const db = serviceClient();
  const { data: purchase } = await db.from('diagnostic_purchases').select('user_id').eq('id', purchaseId).maybeSingle();
  const { data: user } = purchase
    ? await db.from('users').select('email').eq('id', purchase.user_id).maybeSingle()
    : { data: null };
  const email = user?.email as string | undefined;
  if (!email) {
    console.error('stripe-webhook: e-mail introuvable, MailerLite non mis à jour pour l’achat', purchaseId);
    return;
  }
  await removeFromMailerLiteGroups(email, Object.values(DIAGNOSTIC_PREORDER_GROUPS));
  await upsertMailerLiteFields(email, { diag_status: 'refunded' });
}

async function handleBillingWithIdempotence(event: Stripe.Event): Promise<Response> {
  const db = createClient(
    import.meta.env.SUPABASE_URL as string,
    import.meta.env.SUPABASE_SERVICE_ROLE_KEY as string, // ⚠️ SERVICE ROLE, jamais exposé au client
    { auth: { persistSession: false } }
  );

  const { data: seen, error: readError } = await db
    .from('stripe_events')
    .select('processed_at')
    .eq('id', event.id)
    .maybeSingle();
  if (readError) {
    console.error('stripe-webhook: ERREUR_BASE — stripe_events illisible —', readError.message);
    return new Response('billing failed', { status: 500 });
  }
  if (seen?.processed_at) return new Response('already processed', { status: 200 });

  try {
    await handleBillingEvent(db, event);
  } catch (err) {
    // 500 : Stripe rejoue. L'événement n'est pas marqué traité.
    console.error(
      'stripe-webhook: facturation BF —',
      event.type,
      event.id,
      '—',
      err instanceof Error ? err.message : err
    );
    return new Response('billing failed', { status: 500 });
  }

  // Marqué traité seulement après succès. Si cette écriture échoue, le rejeu
  // retraite l'événement : sans danger, chaque traitement est idempotent.
  const { error: writeError } = await db
    .from('stripe_events')
    .upsert({ id: event.id, type: event.type, processed_at: new Date().toISOString() });
  if (writeError) console.error('stripe-webhook: stripe_events non marqué —', event.id, writeError.message);

  return new Response('ok', { status: 200 });
}
