export const prerender = false;

import type { APIRoute } from 'astro';
import { validateLead, type Lead } from '~/lib/leadValidation';
import { leadRateLimiter } from '~/lib/rateLimit';

const GROUP_GLOBAL_EN = '180113595562985140';
const GROUP_GLOBAL_FR = '180112371932464856';
const GROUP_TEST_PERIOD = '199304591375861616';
const GROUP_BIKE_FITTER = '199304591996618152';

const TOPIC_GROUPS: Record<Lead['topic'], string> = {
  'test-period': GROUP_TEST_PERIOD,
  'bike-fitter': GROUP_BIKE_FITTER,
};

const NOTIFY_URL = 'https://agvksgrjqskpetokudda.supabase.co/functions/v1/notify-admin-lead';

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ request, params, clientAddress }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const result = validateLead(body as Record<string, unknown>);
  // `result.ok === false` (et non `!result.ok`) : le tsconfig du repo n'active pas
  // `strictNullChecks`, et sans lui TS ne narrowe pas correctement une union
  // discriminée sur un discriminant booléen via la négation logique.
  if (result.ok === false) return json({ error: result.error }, 400);

  // Honeypot : on répond comme si tout s'était bien passé, sans rien faire.
  // Le bot ne peut pas distinguer un succès d'un rejet.
  if (result.honeypot) return json({ success: true }, 200);

  // `x-forwarded-for` peut porter une liste `client, proxy1, proxy2` ; on ne garde
  // que la première entrée pour rester cohérent avec l'IP unique de `clientAddress`.
  const forwardedFor = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const ip = clientAddress ?? forwardedFor ?? 'inconnue';
  if (!leadRateLimiter.check(ip)) return json({ error: 'rate_limited' }, 429);

  const { lead } = result;
  const lang = params.lang ?? 'fr';

  const groups = [TOPIC_GROUPS[lead.topic], lang === 'en' ? GROUP_GLOBAL_EN : GROUP_GLOBAL_FR];

  const fields: Record<string, string> = { name: lead.name };
  if (lead.message) fields.message = lead.message;
  if (lead.availability) fields.dispos = lead.availability;
  if (lead.trainer) fields.home_trainer = lead.trainer;
  if (lead.webcam) fields.webcam = lead.webcam;
  if (lead.topic === 'bike-fitter') fields.company = 'bike-fitter';

  // Un incident réseau (DNS, timeout, connexion refusée) lève avant tout statut
  // HTTP : sans ce try/catch, l'exception sortirait du chemin de réponse contrôlé.
  // Elle doit produire exactement la même réponse opaque qu'un statut non-2xx.
  let mlRes: Response;
  try {
    mlRes = await fetch('https://connect.mailerlite.com/api/subscribers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${import.meta.env.MAILERLITE_API_KEY}`,
      },
      body: JSON.stringify({ email: lead.email, fields, groups }),
    });
  } catch (err) {
    console.error('MailerLite unreachable', err);
    return json({ error: 'subscribe_failed' }, 502);
  }

  if (!mlRes.ok) {
    console.error('MailerLite error', mlRes.status, await mlRes.text());
    return json({ error: 'subscribe_failed' }, 502);
  }

  // La notification ne doit jamais faire échouer l'inscription du lead :
  // le contact est déjà enregistré chez MailerLite à ce stade.
  try {
    const notifyRes = await fetch(NOTIFY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${import.meta.env.PUBLIC_SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        topic: lead.topic,
        fields: {
          name: lead.name,
          email: lead.email,
          lang,
          availability: lead.availability,
          trainer: lead.trainer,
          webcam: lead.webcam,
          message: lead.message,
        },
      }),
    });
    if (!notifyRes.ok) console.error('notify-admin-lead', notifyRes.status, await notifyRes.text());
  } catch (err) {
    console.error('notify-admin-lead unreachable', err);
  }

  return json({ success: true }, 200);
};
