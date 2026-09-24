export const prerender = false;

import type { APIRoute } from 'astro';
import { validateBookSubscriber } from '~/lib/leadValidation';
import { bookRateLimiter } from '~/lib/rateLimit';
import { emailDigest, isJsonRequest, rateLimitKey } from '~/lib/requestGuards';

const GROUP_LIVRE_FR = '180094076021900759';
const GROUP_GLOBAL_FR = '180112371932464856';
const GROUP_LIVRE_EN = '180112344157783367';
const GROUP_GLOBAL_EN = '180113595562985140';

// Même budget que /api/lead : sans lui, un MailerLite qui s'enlise fait tuer
// l'invocation par la plateforme et le visiteur voit une erreur non contrôlée.
const MAILERLITE_TIMEOUT_MS = 8000;

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export const POST: APIRoute = async (context) => {
  // `clientAddress` n'est volontairement pas déstructuré ici : voir rateLimitKey.
  const { request, params } = context;

  if (!isJsonRequest(request)) return json({ error: 'invalid_type' }, 415);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const result = validateBookSubscriber(body as Record<string, unknown>);
  // `=== false` et non `!result.ok` : pas de `strictNullChecks` dans ce repo (voir /api/lead).
  if (result.ok === false) return json({ error: result.error }, 400);

  // Quota avant honeypot, pour la même raison que /api/lead : la branche
  // honeypot journalise, elle ne doit pas être atteignable sans limite.
  if (!bookRateLimiter.check(rateLimitKey(context))) return json({ error: 'rate_limited' }, 429);

  // Succès simulé : le bot ne distingue pas un rejet d'une inscription.
  if (result.honeypot) {
    console.error('honeypot déclenché, inscription livre ignorée', emailDigest(result.subscriber.email));
    return json({ success: true }, 200);
  }

  const { email, name, phone } = result.subscriber;

  // `[lang]` accepte n'importe quel segment (route SSR). Seul `fr` va vers les
  // listes françaises ; toute autre langue reçoit le livre et les emails en
  // anglais plutôt qu'en français.
  const groups = params.lang === 'fr' ? [GROUP_LIVRE_FR, GROUP_GLOBAL_FR] : [GROUP_LIVRE_EN, GROUP_GLOBAL_EN];

  // Champs vides omis : l'appel met à jour un abonné existant, et un `name: ''`
  // risquerait d'effacer le nom d'un abonné qui se réinscrit depuis le
  // formulaire email seul de la homepage.
  const fields: Record<string, string> = {};
  if (name) fields.name = name;
  if (phone) fields.phone = phone;

  let mlRes: Response;
  try {
    mlRes = await fetch('https://connect.mailerlite.com/api/subscribers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${import.meta.env.MAILERLITE_API_KEY}`,
      },
      body: JSON.stringify({ email, fields, groups }),
      signal: AbortSignal.timeout(MAILERLITE_TIMEOUT_MS),
    });
  } catch (err) {
    console.error('MailerLite unreachable', err);
    return json({ error: 'subscribe_failed' }, 502);
  }

  if (!mlRes.ok) {
    // Le détail reste au journal : le renvoyer au client exposait la réponse
    // brute de MailerLite. Lecture infaillible, voir /api/lead.
    const detail = await mlRes.text().catch(() => '<corps illisible>');
    console.error('MailerLite error', mlRes.status, detail);
    return json({ error: 'subscribe_failed' }, 502);
  }

  return json({ success: true }, 200);
};
