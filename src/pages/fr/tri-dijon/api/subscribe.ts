export const prerender = false;
import type { APIRoute } from 'astro';

export const POST: APIRoute = async ({ request }) => {
  const { email, name, phone, betaTester } = await request.json();

  if (!email) {
    return new Response(JSON.stringify({ error: 'Email requis' }), { status: 400 });
  }

  // IDs de groupes MailerLite (compte olivier.demichel@gmail.com)
  const GROUP_GLOBAL_FR = '180112371932464856';
  const GROUP_TRI_DIJON = '188730540069750057';
  const GROUP_BETA = '188730540648564346';

  const groups = [GROUP_GLOBAL_FR, GROUP_TRI_DIJON, ...(betaTester ? [GROUP_BETA] : [])];

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
