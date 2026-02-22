export const prerender = false;

import type { APIRoute } from 'astro';

export const POST: APIRoute = async ({ request }) => {
  const { email, name, phone, whatsapp } = await request.json();

  if (!email) {
    return new Response(JSON.stringify({ error: 'Email requis' }), { status: 400 });
  }

  const apiKey = import.meta.env.MAILERLITE_API_KEY;
  console.log('API KEY présente:', !!apiKey);

  const mlRes = await fetch('https://connect.mailerlite.com/api/subscribers', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      email,
      fields: { name, phone, whatsapp: whatsapp ? 'oui' : 'non' },
      groups: ['180094076021900759'],
    }),
  });

  const responseText = await mlRes.text();
  console.log('Mailerlite status:', mlRes.status);
  console.log('Mailerlite body:', responseText);

  if (!mlRes.ok) {
    return new Response(JSON.stringify({ error: responseText }), { status: mlRes.status });
  }

  return new Response(JSON.stringify({ success: true }), { status: 200 });
  const res = await fetch('https://connect.mailerlite.com/api/subscribers', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      email,
      fields: { name, phone, whatsapp: whatsapp ? 'oui' : 'non' },
      groups: ['180094076021900759'],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    return new Response(JSON.stringify({ error: err }), { status: res.status });
  }

  return new Response(JSON.stringify({ success: true }), { status: 200 });
};
