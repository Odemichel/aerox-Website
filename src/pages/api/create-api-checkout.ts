// /src/pages/api/create-api-checkout.ts  (assure le nom EXACT du fichier/route)
import type { APIRoute } from 'astro';
import Stripe from 'stripe';

const stripe = new Stripe(import.meta.env.STRIPE_SECRET_KEY as string);

type Body = { priceId?: string; lookupKey?: string; customerEmail?: string; userId?: string };

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = (await request.json().catch(() => ({}))) as Body;

    // --- Prix ---
    let priceId = (body.priceId ?? import.meta.env.STRIPE_PRICE_ID ?? '').trim();
    if (!priceId && (body.lookupKey || import.meta.env.STRIPE_LOOKUP_KEY)) {
      const key = body.lookupKey ?? import.meta.env.STRIPE_LOOKUP_KEY!;
      const prices = await stripe.prices.list({ lookup_keys: [key], expand: ['data.product'] });
      if (!prices.data.length) throw new Error('No price found for lookupKey');
      priceId = prices.data[0].id;
    }
    if (!priceId) throw new Error('Missing priceId');

    // --- Base site (sans hash) ---
    const reqOrigin = new URL(request.url).origin; // ex http://localhost:4321 en dev
    const envBase = (import.meta.env.PUBLIC_SITE_URL || '').split('#')[0];
    const base = envBase || reqOrigin;

    // --- Compose URLs absolues à partir des chemins env ---
    const successPath = import.meta.env.SUCCESS_URL || 'telechargement/success';
    const cancelPath  = import.meta.env.CANCEL_URL  || 'telechargement/cancel';

    const successUrl = new URL(successPath, base).toString();
    const cancelUrl  = new URL(cancelPath, base).toString();

    // mini validation
    const looksHttp = (u: string) => /^https?:\/\//i.test(u);
    if (!looksHttp(successUrl) || !looksHttp(cancelUrl)) {
      throw new Error(`Invalid success/cancel URL (${successUrl} | ${cancelUrl})`);
    }

    const metadata: Record<string, string> = {};
    if (body.userId) metadata.userId = body.userId;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: false,
      billing_address_collection: 'auto',
      automatic_tax: { enabled: true },
      customer_email: body.customerEmail,
      customer_creation: 'if_required',
      metadata,
      subscription_data: { metadata },
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
