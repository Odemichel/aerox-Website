// src/pages/api/billing/checkout.ts
//
// Crée la session Stripe Checkout d'une offre bike fitter.
//
// Premier abonnement (essai jamais utilisé) : Checkout en mode `setup`. Le
// bike fitter enregistre sa carte, son adresse de facturation et accepte les
// CGV ; rien n'est prélevé et aucun abonnement n'est créé. Le webhook garde
// l'offre choisie (`bf_billing.pending_offer`), l'abonnement naît à
// l'installation du setup (/api/billing/start-trial/, bouton admin) avec 14
// jours d'essai. Essai déjà utilisé : abonnement payant tout de suite.
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
  PARTNER_OFFERS,
  partnerOfferOpen,
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

// Premier abonnement : ce qui se passe après l'enregistrement de la carte,
// dit sous le bouton. Anglais par défaut.
const SETUP_NOTE: Record<string, string> = {
  fr: 'Aucun paiement aujourd’hui : vous enregistrez votre carte. L’abonnement démarre le jour de l’installation de votre setup AeroX, avec 14 jours d’essai gratuit. Sans résiliation depuis votre espace AeroX avant la fin de l’essai, le premier paiement est prélevé ce jour-là.',
  en: 'No payment today: you are saving your card. The subscription starts on the day your AeroX setup is installed, with a 14-day free trial. Unless you cancel from your AeroX account before the trial ends, the first payment is taken that day.',
  de: 'Heute keine Zahlung: Sie hinterlegen Ihre Karte. Das Abonnement beginnt am Tag der Installation Ihres AeroX-Setups mit einem 14-tägigen kostenlosen Test. Ohne Kündigung in Ihrem AeroX-Bereich vor Testende wird die erste Zahlung an diesem Tag eingezogen.',
  es: 'Ningún pago hoy: registras tu tarjeta. La suscripción empieza el día de la instalación de tu setup AeroX, con 14 días de prueba gratuita. Si no cancelas desde tu espacio AeroX antes del final de la prueba, el primer pago se cobra ese día.',
  it: 'Nessun pagamento oggi: registri la tua carta. L’abbonamento inizia il giorno dell’installazione del tuo setup AeroX, con 14 giorni di prova gratuita. Senza disdetta dal tuo spazio AeroX prima della fine della prova, il primo pagamento viene addebitato quel giorno.',
  nl: 'Vandaag geen betaling: je registreert je kaart. Het abonnement start op de dag dat je AeroX-setup wordt geïnstalleerd, met een gratis proefperiode van 14 dagen. Zonder opzegging in je AeroX-ruimte vóór het einde van de proefperiode wordt de eerste betaling die dag afgeschreven.',
  pt: 'Nenhum pagamento hoje: regista o seu cartão. A assinatura começa no dia da instalação do seu setup AeroX, com 14 dias de teste gratuito. Sem cancelamento no seu espaço AeroX antes do fim do teste, o primeiro pagamento é cobrado nesse dia.',
  ja: '本日のお支払いはありません：カードを登録します。サブスクリプションはAeroXセットアップの設置日に14日間の無料トライアル付きで開始します。トライアル終了前にAeroXのアカウントから解約しない場合、その日に初回の支払いが行われます。',
  tr: 'Bugün ödeme yok: kartınızı kaydediyorsunuz. Abonelik, AeroX kurulumunuzun yapıldığı gün 14 günlük ücretsiz denemeyle başlar. Deneme bitmeden AeroX alanınızdan iptal etmezseniz ilk ödeme o gün alınır.',
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

    // Premier abonnement : essai de 14 jours à l'installation, un par compte
    // (décision du 2026-10-18 : plus de vérification d'entreprise préalable,
    // le studio est vu à l'installation). Essai déjà utilisé : l'abonnement
    // démarre sans essai.
    const withTrial = !billing?.trial_ends_at;

    // Offre partenaire : dans les 24 h qui suivent l'ouverture du lien privé,
    // et pour un premier abonnement (un réabonnement repartirait pour 12 mois
    // à 59 €).
    if (PARTNER_OFFERS.includes(offer) && (!partnerOfferOpen(billing, Date.now()) || !withTrial)) {
      return json({ error: 'E_PARTNER' }, 403);
    }

    // Un seul abonnement par bike fitter : changer d'offre passe par
    // /api/billing/manage/, qui modifie l'abonnement existant au lieu d'en
    // empiler un second (double prélèvement).
    if (billing?.stripe_subscription_id) return json({ error: 'E_HAS_SUBSCRIPTION' }, 409);
    // Carte déjà enregistrée, en attente de l'installation : changer d'offre
    // ou annuler passe par /api/billing/manage/.
    if (billing?.pending_offer) return json({ error: 'E_HAS_PENDING' }, 409);

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
      if (open.metadata?.aerox_offer) {
        await stripe()
          .checkout.sessions.expire(open.id)
          .catch((err) => console.error('billing/checkout: session non expirée', open.id, err?.message));
      }
    }
    const metadata = { userId: user.id, aerox_offer: offer };
    const base = siteBase(request, site);

    // Commun aux deux modes : adresse et raison sociale saisies enregistrées
    // sur le client (Stripe Tax en a besoin pour les factures), numéro de TVA
    // rattaché (autoliquidation B2B UE), acceptation des CGV obligatoire
    // (dont l'essai et sa résiliation). Prérequis Stripe : l'URL des
    // conditions générales est renseignée dans les réglages publics du compte.
    const common = {
      customer,
      customer_update: { name: 'auto', address: 'auto' },
      billing_address_collection: 'required',
      tax_id_collection: { enabled: true },
      locale: CHECKOUT_LOCALES[lang] ?? 'auto',
      consent_collection: { terms_of_service: 'required' },
      success_url: accountUrl(base, lang, 'success'),
      cancel_url: accountUrl(base, lang, 'cancel'),
      metadata,
    } satisfies Partial<Stripe.Checkout.SessionCreateParams>;
    const termsMessage = (TERMS_NOTE[lang] ?? TERMS_NOTE.en).replace('{url}', `${base}/${lang}/terms/`);

    const params: Stripe.Checkout.SessionCreateParams = withTrial
      ? {
          ...common,
          mode: 'setup',
          currency: 'eur',
          setup_intent_data: { metadata },
          custom_text: {
            terms_of_service_acceptance: { message: termsMessage },
            submit: { message: SETUP_NOTE[lang] ?? SETUP_NOTE.en },
          },
        }
      : {
          ...common,
          mode: 'subscription',
          automatic_tax: { enabled: true },
          allow_promotion_codes: false,
          custom_text: { terms_of_service_acceptance: { message: termsMessage } },
          // Le prix mesuré (analyses Essentiel) n'a pas de quantité : elle
          // vient du meter.
          line_items: OFFER_LOOKUP_KEYS[offer].map((key, i) =>
            METERED_LOOKUP_KEYS.includes(key) ? { price: priceIds[i] } : { price: priceIds[i], quantity: 1 }
          ),
          subscription_data: {
            metadata,
            // Réabonnement : démarrage au 1er novembre 2026 si l'on souscrit
            // avant, sinon tout de suite (voir subscriptionStart).
            ...subscriptionStart(Date.now(), ANNUAL_OFFERS.includes(offer), false),
            // Mode flexible : l'usage non facturé est facturé si l'on retire
            // une ligne mesurée (passage d'Essentiel à Illimité en cours de mois).
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
