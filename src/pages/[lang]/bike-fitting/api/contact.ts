export const prerender = false;
import type { APIRoute } from 'astro';

export const POST: APIRoute = async ({ request, params }) => {
  const { email, name, message } = await request.json();

  if (!email) {
    return new Response(JSON.stringify({ error: 'Email requis' }), { status: 400 });
  }

  const lang = params.lang ?? 'fr';

  // Groupe MailerLite dédié bike-fitters (à créer dans MailerLite)
  // Pour l'instant on utilise le groupe global
  const groups = lang === 'en'
    ? ['180113595562985140'] // global-en
    : ['180112371932464856']; // global-fr

  const apiKey = import.meta.env.MAILERLITE_API_KEY;

  const mlRes = await fetch('https://connect.mailerlite.com/api/subscribers', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      email,
      fields: { name, company: 'bike-fitter', last_name: message ?? '' },
      groups,
    }),
  });

  if (!mlRes.ok) {
    const err = await mlRes.text();
    return new Response(JSON.stringify({ error: err }), { status: mlRes.status });
  }

  return new Response(JSON.stringify({ success: true }), { status: 200 });
};
