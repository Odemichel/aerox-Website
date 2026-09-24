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

import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { SUPPORTED_LOCALES } from '~/lib/i18n';
import { authenticatedUser } from '~/lib/serverAuth';

const stripe = new Stripe(import.meta.env.STRIPE_SECRET_KEY as string);

// Seule source de vérité du couple (produit vendu, prix facturé). Ajouter un
// produit = ajouter une ligne ici, jamais un champ de plus dans le corps.
// Les `lookup_key` sont des étiquettes Stripe, pas des identifiants de prix :
// aucun `price_…` n'est écrit en dur, le montant reste piloté depuis le
// tableau de bord Stripe.
const PRODUCT_PRICE_LOOKUP_KEYS: Record<string, string> = {
  // Offre de lancement à 49 € (−38 %) jusqu'au 31/10/2026, livraison le 01/11.
  // Le prix plein (`diagnostic_basic`, 79 €) reste actif chez Stripe : il
  // suffira de revenir dessus le 1er novembre, sans rien créer.
  diagnostic: 'diagnostic_preorder',
};

type Body = {
  customerEmail?: string;
  product?: string;
  lang?: string;
};

// La langue ne décore pas une URL de retour : passée à `new URL(path, base)`,
// elle en choisit l'HÔTE. Non validée, `lang = "//evil.com"` donnait
// `http://evil.com/telechargement/success/`, et `"/\evil.com"` la même chose.
// La session Stripe restait parfaitement légitime — vrai compte, vrai montant,
// vraie page checkout.stripe.com — mais le retour après paiement atterrissait
// chez l'attaquant : de l'hameçonnage qui emprunte la crédibilité du site et
// celle de Stripe. Le contrôle `looksHttp` plus bas ne regarde que le schéma,
// il laissait passer les deux.
const LANG_FALLBACK = 'fr';
const isSupportedLang = (raw: unknown): raw is string =>
  typeof raw === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(raw);

// Réponses d'erreur volontairement courtes et opaques : elles sortent vers un
// appelant non authentifié, elles n'ont pas à dire quels produits existent ni
// pourquoi un jeton est refusé. Le détail part dans les journaux serveur.
const fail = (status: number, code: string) =>
  new Response(JSON.stringify({ error: code }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

// Texte de la case de renonciation, affiché par Stripe au-dessus du bouton de
// paiement. Markdown : le lien mène aux conditions du site dans la langue du
// rider. Anglais par défaut pour les autres langues.
const WITHDRAWAL_WAIVER: Record<string, string> = {
  fr: "J'accepte les [conditions générales](%URL%) et je demande l'accès immédiat au diagnostic. Je reconnais perdre mon droit de rétractation dès ma première séance.",
  en: 'I accept the [terms and conditions](%URL%) and request immediate access to the diagnostic. I acknowledge that I lose my right of withdrawal as soon as I complete my first session.',
};
const withdrawalWaiverMessage = (lang: string, base: string) =>
  (WITHDRAWAL_WAIVER[lang] ?? WITHDRAWAL_WAIVER.en).replace('%URL%', new URL(`/${lang}/terms/`, base).toString());

export const POST: APIRoute = async ({ request, site }) => {
  try {
    const body = (await request.json().catch(() => ({}))) as Body;

    // --- Détection de la langue ---
    // Le corps d'abord, puis le chemin (ex: /fr/telechargement/api/...), et
    // dans les deux cas seulement si la valeur est une langue du site. Une
    // langue non reconnue retombe sur le repli au lieu d'être rejetée : le
    // visiteur n'y est pour rien, et ce chemin acceptait déjà n'importe quoi.
    const pathLang = new URL(request.url).pathname.match(/^\/([a-z]{2})(\/|$)/)?.[1];
    const lang = [body.lang, pathLang].find(isSupportedLang) ?? LANG_FALLBACK;

    const metadata: Record<string, string> = {};
    let priceId = '';
    let customerEmail = body.customerEmail;

    if (body.product) {
      // --- Chemin « vente d'un produit » : tout est décidé ici, côté serveur.
      //
      // `Object.hasOwn` et non la véracité de la valeur trouvée : la table est
      // un objet littéral, elle hérite donc de `Object.prototype`. Une garde
      // `if (!lookupKey)` laissait passer `__proto__` (un objet) et
      // `constructor` (une fonction), tous deux « truthy ». La valeur
      // non-textuelle ne faisait pas échouer l'appel Stripe : le sérialiseur
      // du SDK la supprimait silencieusement, l'appel devenait
      // `prices.list({ active: true })` — tous les prix actifs du compte — et
      // le code retenait `data[0].id`. Le prix facturé redevenait une
      // conséquence d'une valeur du corps. Seul le webhook, qui exige
      // `product === 'diagnostic'`, empêchait le déblocage : une sûreté
      // située dans un autre fichier, donc circonstancielle.
      //
      // On teste l'appartenance plutôt que le type de la valeur (`typeof
      // lookupKey !== 'string'`) : les deux ferment la faille aujourd'hui,
      // mais l'appartenance dit exactement l'invariant voulu — « ce produit
      // est-il au catalogue ? » — sans dépendre de la forme de ce que
      // `Object.prototype` expose.
      if (!Object.hasOwn(PRODUCT_PRICE_LOOKUP_KEYS, body.product)) {
        console.error('create-api-checkout: produit inconnu —', body.product);
        return fail(400, 'E_PRODUCT');
      }
      const lookupKey = PRODUCT_PRICE_LOOKUP_KEYS[body.product];

      const user = await authenticatedUser(request, 'create-api-checkout');
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
      // Langue validée plus haut (liste fermée) : le webhook en déduit la
      // langue des emails de pré-réservation.
      metadata.lang = lang;
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
    // Base des URL de retour. `reqOrigin` vient de l'en-tête `Host` de la
    // requête, donc de l'appelant : s'en servir en premier laisserait un
    // attaquant faire pointer le retour après paiement sur son domaine, sur
    // une session pourtant légitime. On préfère la configuration — la variable
    // d'environnement, puis le `site` déclaré dans astro.config.ts — et on ne
    // retombe sur l'origine de la requête qu'en dernier recours, en local où
    // aucune des deux n'est définie.
    const reqOrigin = new URL(request.url).origin; // http://localhost:4321
    const envBase = (import.meta.env.PUBLIC_SITE_URL || '').split('#')[0];
    const base = envBase || site?.origin || reqOrigin;

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
      // Carte seule sur la vente d'un produit : sans liste explicite, Stripe
      // affiche tous les moyens actifs du compte (Link, Amazon Pay, Klarna…)
      // et la carte n'arrive pas en tête. Apple Pay reste proposé, c'est un
      // portefeuille de carte. Retirer Klarna et Bancontact supprime aussi
      // les paiements à confirmation différée : le déblocage est immédiat.
      ...(metadata.product ? { payment_method_types: ['card' as const] } : {}),
      // Diagnostic : case obligatoire par laquelle le rider accepte les CGV,
      // demande l'accès immédiat et renonce à son droit de rétractation dès
      // sa première séance (Code de la consommation, art. L221-28 13°). Sans
      // elle, les 14 jours de rétractation restent dus même après usage. Le
      // webhook trace l'acceptation (`session.consent.terms_of_service`) dans
      // `diagnostic_purchases.withdrawal_waiver_at`.
      // Prérequis Stripe : une URL de conditions générales doit être
      // renseignée dans les réglages publics du compte, sinon la création de
      // session échoue.
      ...(metadata.product === 'diagnostic'
        ? {
            consent_collection: { terms_of_service: 'required' as const },
            custom_text: { terms_of_service_acceptance: { message: withdrawalWaiverMessage(lang, base) } },
          }
        : {}),
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
