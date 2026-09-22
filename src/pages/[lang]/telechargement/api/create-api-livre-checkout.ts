// /src/pages/api/create-livre-checkout.ts
import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { SUPPORTED_LOCALES } from '~/lib/i18n';

const stripe = new Stripe(import.meta.env.STRIPE_SECRET_KEY as string);

// Même défaut, même chemin d'argent que `create-api-checkout.ts` : la langue
// sert à construire les URL de retour, donc `new URL(path, base)` en tire
// l'hôte. `lang = "//evil.com"` renvoyait l'acheteur sur le domaine de
// l'attaquant après un paiement bien réel. Le garde-fou est dupliqué plutôt
// que factorisé : ce correctif se limite aux deux routes, il n'ajoute pas de
// fichier partagé. (Le reste du contrat de cette route — `priceId`,
// `lookupKey` et `userId` lus dans le corps — reste inchangé ici, il est
// traité séparément.)
const LANG_FALLBACK = 'fr';
const isSupportedLang = (raw: unknown): raw is string =>
    typeof raw === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(raw);

type Body = {
    priceId?: string;
    lookupKey?: string;
    customerEmail?: string;
    userId?: string;
    lang?: string; // 👈 ajouté
};

export const POST: APIRoute = async ({ request }) => {
    try {
        const body = (await request.json().catch(() => ({}))) as Body;

        // --- Détection de la langue ---
        // Le corps d'abord, puis le chemin (ex: /fr/telechargement/api/...),
        // et seulement si la valeur est une langue du site.
        const pathLang = new URL(request.url).pathname.match(/^\/([a-z]{2})(\/|$)/)?.[1];
        const lang = [body.lang, pathLang].find(isSupportedLang) ?? LANG_FALLBACK;

        // --- Prix ---
        let priceId = (body.priceId ?? import.meta.env.STRIPE_PRICE_LIVRE_ID ?? '').trim();
        if (!priceId && (body.lookupKey || import.meta.env.STRIPE_LOOKUP_KEY)) {
            const key = body.lookupKey ?? import.meta.env.STRIPE_LOOKUP_KEY!;
            const prices = await stripe.prices.list({ lookup_keys: [key], expand: ['data.product'] });
            if (!prices.data.length) throw new Error('No price found for lookupKey');
            priceId = prices.data[0].id;
        }
        if (!priceId) throw new Error('Missing priceId');

        // --- Base site ---
        const reqOrigin = new URL(request.url).origin; // http://localhost:4321
        const envBase = (import.meta.env.PUBLIC_SITE_URL || '').split('#')[0];
        const base = envBase || reqOrigin;

        // --- Routes localisées ---
        const successPath = `/${lang}/telechargement/success_livre/?session_id={CHECKOUT_SESSION_ID}`;
        const cancelPath = `/${lang}/telechargement/cancel_livre`;

        const successUrl = new URL(successPath, base).toString();
        const cancelUrl = new URL(cancelPath, base).toString();

        const looksHttp = (u: string) => /^https?:\/\//i.test(u);
        if (!looksHttp(successUrl) || !looksHttp(cancelUrl)) {
            throw new Error(`Invalid success/cancel URL (${successUrl} | ${cancelUrl})`);
        }

        const metadata: Record<string, string> = {};
        if (body.userId) metadata.userId = body.userId;

        // --- Création session Stripe ---
        const session = await stripe.checkout.sessions.create({
            mode: 'payment',
            line_items: [{ price: priceId, quantity: 1 }],
            success_url: successUrl,
            cancel_url: cancelUrl,
            allow_promotion_codes: true,
            billing_address_collection: 'auto',
            automatic_tax: { enabled: true },
            customer_email: body.customerEmail,
            customer_creation: 'if_required',
            metadata,
        });

        return new Response(JSON.stringify({ url: session.url }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return new Response(JSON.stringify({ error: message }), { status: 500 });
    }
};
