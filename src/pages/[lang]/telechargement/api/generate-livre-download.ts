// /src/pages/api/generate-livre-download.ts
import { createClient } from '@supabase/supabase-js';
import type { APIRoute } from 'astro';
import Stripe from 'stripe';

const stripe = new Stripe(import.meta.env.STRIPE_SECRET_KEY as string);

const supabase = createClient(
    import.meta.env.SUPABASE_URL,
    import.meta.env.SUPABASE_SERVICE_ROLE_KEY // ⚠️ SERVICE ROLE, pas public
);

export const GET: APIRoute = async ({ request }) => {
    try {
        const { searchParams } = new URL(request.url);
        const sessionId = searchParams.get('session_id');

        if (!sessionId) {
            return new Response(JSON.stringify({ error: 'Missing session_id' }), { status: 400 });
        }

        // 🔐 Vérifie la session Stripe
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        console.log('Stripe session:', session);
        console.log('Payment status:', session.payment_status);

        if (session.payment_status !== 'paid') {
            return new Response(JSON.stringify({ error: 'Payment not completed' }), { status: 403 });
        }
        const lineItems = await stripe.checkout.sessions.listLineItems(sessionId);
        const PRICE_ID = import.meta.env.STRIPE_PRICE_LIVRE_ID as string;

        const hasCorrectProduct = lineItems.data.some(
            item => item.price?.id === PRICE_ID
        );
        console.log('produit correct:', hasCorrectProduct);

        if (!hasCorrectProduct) {
            return new Response(JSON.stringify({ error: 'Invalid product' }), { status: 403 });
        }


        // 📦 Génère URL signée Supabase
        const { data, error } = await supabase.storage
            .from('ebooks')
            .createSignedUrl('AeroX-entrainer_Aerodynamisme.pdf', 600);

        if (error || !data?.signedUrl) {
            return new Response(JSON.stringify({ error: 'File error' }), { status: 500 });
        }

        // 🔁 Télécharge le fichier côté serveur
        const fileRes = await fetch(data.signedUrl);
        const fileBuffer = await fileRes.arrayBuffer();

        // 📤 Renvoie le PDF en attachment
        return new Response(fileBuffer, {
            status: 200,
            headers: {
                'Content-Type': 'application/pdf',
                'Content-Disposition': 'attachment; filename="AeroX-entrainer-aerodynamisme.pdf"',
            },
        });

    } catch (err) {
        console.error(err);

        return new Response(JSON.stringify({ error: 'Server error' }), { status: 500 });
    }
};
