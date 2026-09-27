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

// Essai gratuit : ce qui se passe à la fin, dit sous le bouton de paiement
// ({date} : fin de l'essai). Anglais par défaut.
const TRIAL_NOTE: Record<string, string> = {
  fr: 'Essai gratuit jusqu’au {date} : rien n’est prélevé avant. Sans résiliation depuis votre espace AeroX avant cette date, l’abonnement démarre et le premier paiement est prélevé ce jour-là.',
  en: 'Free trial until {date}: nothing is charged before then. Unless you cancel from your AeroX account before that date, the subscription starts and the first payment is taken that day.',
  de: 'Kostenloser Test bis {date}: Vorher wird nichts abgebucht. Ohne Kündigung in Ihrem AeroX-Bereich vor diesem Datum beginnt das Abonnement und die erste Zahlung wird an diesem Tag eingezogen.',
  es: 'Prueba gratuita hasta el {date}: no se cobra nada antes. Si no cancelas desde tu espacio AeroX antes de esa fecha, la suscripción empieza y el primer pago se cobra ese día.',
  it: 'Prova gratuita fino al {date}: nulla viene addebitato prima. Senza disdetta dal tuo spazio AeroX prima di questa data, l’abbonamento inizia e il primo pagamento viene addebitato quel giorno.',
  nl: 'Gratis proefperiode tot {date}: daarvoor wordt niets afgeschreven. Zonder opzegging in je AeroX-ruimte vóór die datum start het abonnement en wordt de eerste betaling die dag afgeschreven.',
  pt: 'Teste gratuito até {date}: nada é cobrado antes. Sem cancelamento no seu espaço AeroX antes dessa data, a assinatura começa e o primeiro pagamento é cobrado nesse dia.',
  ja: '{date}まで無料トライアル：それまでは請求されません。この日までにAeroXのアカウントから解約しない場合、サブスクリプションが開始され、当日に初回の支払いが行われます。',
  tr: '{date} tarihine kadar ücretsiz deneme: öncesinde hiçbir ücret alınmaz. Bu tarihten önce AeroX alanınızdan iptal etmezseniz abonelik başlar ve ilk ödeme o gün alınır.',
};

// Case à cocher obligatoire : acceptation des CGV, dont l'article sur
// l'essai gratuit (résiliation avant la fin de l'essai).
const TERMS_NOTE: Record<string, string> = {
  fr: 'J’accepte les [conditions générales]({url}), notamment l’article sur l’essai gratuit et sa résiliation.',
  en: 'I accept the [terms and conditions]({url}), including the section on the free trial and how to cancel it.',
  de: 'Ich akzeptiere die [AGB]({url}), insbesondere den Abschnitt zum kostenlosen Test und seiner Kündigung.',
  es: 'Acepto las [condiciones generales]({url}), en particular el apartado sobre la prueba gratuita y su cancelación.',
  it: 'Accetto le [condizioni generali]({url}), in particolare la sezione sulla prova gratuita e la sua disdetta.',
  nl: 'Ik ga akkoord met de [algemene voorwaarden]({url}), in het bijzonder het artikel over de gratis proefperiode en de opzegging ervan.',
  pt: 'Aceito as [condições gerais]({url}), em particular a secção sobre o teste gratuito e o seu cancelamento.',
  ja: '[利用規約]({url})（無料トライアルとその解約に関する条項を含む）に同意します。',
  tr: 'Ücretsiz deneme ve iptaline ilişkin madde dahil [genel koşulları]({url}) kabul ediyorum.',
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

    // Premier abonnement : essai de 14 jours, ouvert seulement une fois
    // l'entreprise vérifiée (SIRET, TVA ou site validé) — un essai par
    // entreprise. Essai déjà utilisé : l'abonnement démarre sans essai.
    const withTrial = !billing?.trial_ends_at;
    if (withTrial && billing?.trial_state !== 'granted') return json({ error: 'E_NEEDS_BUSINESS_ID' }, 409);

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

    const start = subscriptionStart(Date.now(), ANNUAL_OFFERS.includes(offer), withTrial);
    const locale = lang === 'en' ? 'en-GB' : lang;
    const trialDate =
      'trial_end' in start
        ? new Intl.DateTimeFormat(locale, {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
            timeZone: 'Europe/Paris',
          }).format(new Date(start.trial_end * 1000))
        : '';
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
      // Acceptation des CGV obligatoire (dont l'essai et sa résiliation).
      // Prérequis Stripe : l'URL des conditions générales est renseignée dans
      // les réglages publics du compte (déjà requise par le Diagnostic).
      consent_collection: { terms_of_service: 'required' },
      custom_text: {
        terms_of_service_acceptance: {
          message: (TERMS_NOTE[lang] ?? TERMS_NOTE.en).replace('{url}', `${base}/${lang}/terms/`),
        },
        // Essai : la date de fin et ce qui se passe ensuite, sous le bouton.
        // (Pas pour un réabonnement sans essai démarrant au 1er novembre.)
        ...(withTrial && trialDate
          ? {
              submit: {
                message: (TRIAL_NOTE[lang] ?? TRIAL_NOTE.en).replace(
                  '{date}',
                  // En français, le premier du mois s'écrit « 1er ».
                  lang === 'fr' ? trialDate.replace(/^1 /, '1er ') : trialDate
                ),
              },
            }
          : {}),
      },
      success_url: accountUrl(base, lang, 'success'),
      cancel_url: accountUrl(base, lang, 'cancel'),
      metadata,
      // Le prix mesuré (analyses Essentiel) n'a pas de quantité : elle vient
      // du meter.
      line_items: OFFER_LOOKUP_KEYS[offer].map((key, i) =>
        METERED_LOOKUP_KEYS.includes(key) ? { price: priceIds[i] } : { price: priceIds[i], quantity: 1 }
      ),
      subscription_data: {
        metadata,
        // Essai de 14 jours (ou démarrage au 1er novembre 2026) : voir
        // subscriptionStart.
        ...start,
        // Mode flexible : l'usage non facturé est facturé si l'on retire une
        // ligne mesurée (passage d'Essentiel à Illimité en cours de mois).
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
