
export const prerender = false;
import type { APIRoute } from 'astro';

export const POST: APIRoute = async ({ request, params }) => {
  const { email, name, phone } = await request.json();

  if (!email) {
    return new Response(JSON.stringify({ error: 'Email requis' }), { status: 400 });
  }

  const lang = params.lang ?? 'fr';

  const groups = lang === 'en'
    ? ['180112344157783367', '180113595562985140'] // livre-en + global-en
    : ['180094076021900759', '180112371932464856']; // livre-fr + global-fr

  const apiKey = import.meta.env.MAILERLITE_API_KEY;

  const mlRes = await fetch('https://connect.mailerlite.com/api/subscribers', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      email,
      fields: { name, phone },
      groups,
    }),
  });

  if (!mlRes.ok) {
    const err = await mlRes.text();
    return new Response(JSON.stringify({ error: err }), { status: mlRes.status });
  }

  return new Response(JSON.stringify({ success: true }), { status: 200 });
};