export const prerender = false;

import type { APIContext, APIRoute } from 'astro';
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

// Budgets d'attente des appels sortants. Sans eux, un amont qui s'enlise fait
// tuer l'invocation par la plateforme : l'abonné est créé chez MailerLite, la
// notification ne part jamais et le visiteur voit une erreur — exactement la
// perte de lead que cette route existe pour éviter.
const MAILERLITE_TIMEOUT_MS = 8000;
const NOTIFY_TIMEOUT_MS = 5000;

/**
 * Adresse à utiliser comme clé du limiteur.
 *
 * `clientAddress` est un *getter* : l'adaptateur Vercel lui passe la valeur
 * brute de `x-forwarded-for`, qui peut porter une liste `client, proxy1, …`,
 * et le getter lève si aucun adaptateur ne fournit d'adresse. Il est donc lu
 * ici, dans un `try`, et non déstructuré dans la signature du handler — où il
 * serait évalué avant tout gestionnaire d'erreur.
 */
function rateLimitKey(context: APIContext): string {
  let raw: string | undefined;
  try {
    raw = context.clientAddress;
  } catch {
    // Pas d'adresse exploitable : tous ces appels partagent alors le même
    // quota, ce qui est le comportement sûr côté limiteur.
    raw = undefined;
  }
  return raw?.split(',')[0]?.trim() || 'inconnue';
}

export const POST: APIRoute = async (context) => {
  // `clientAddress` n'est volontairement pas déstructuré ici : voir rateLimitKey.
  const { request, params } = context;

  // `request.json()` parse quel que soit le type déclaré. Un formulaire HTML
  // tiers en `enctype="text/plain"` produit un corps JSON valide sans déclencher
  // de préflight CORS : chaque visiteur d'une page piégée soumettrait un lead
  // depuis sa propre IP, rendant le quota par adresse inopérant. On exige donc
  // un `Content-Type` JSON, que ce formulaire-là ne peut pas poser.
  const mediaType = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (mediaType !== 'application/json') return json({ error: 'invalid_type' }, 415);

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
  // Le bot ne peut pas distinguer un succès d'un rejet. La trace serveur est
  // le seul moyen de repérer un faux positif (gestionnaire de mots de passe
  // qui remplit le champ invisible) : sans elle, le lead disparaîtrait
  // silencieusement.
  if (result.honeypot) {
    console.error('honeypot déclenché, lead ignoré', result.lead.email);
    return json({ success: true }, 200);
  }

  const ip = rateLimitKey(context);
  if (!leadRateLimiter.check(ip)) return json({ error: 'rate_limited' }, 429);

  const { lead } = result;
  const lang = params.lang ?? 'fr';

  // Seuls deux groupes globaux existent : `fr` d'un côté, toutes les autres
  // langues de l'autre. Router un abonné japonais ou brésilien vers la liste
  // française serait pire que de l'envoyer dans la liste anglophone.
  const groups = [TOPIC_GROUPS[lead.topic], lang === 'fr' ? GROUP_GLOBAL_FR : GROUP_GLOBAL_EN];

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
      // Le rejet du timeout est levé par `fetch` lui-même, donc capté par ce
      // `catch` et rendu au visiteur sous la même réponse opaque qu'un incident
      // réseau.
      signal: AbortSignal.timeout(MAILERLITE_TIMEOUT_MS),
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
        // `verify_jwt` reste activé côté Supabase : la passerelle exige encore
        // un `Authorization`. On n'y met plus la clé anon, servie publiquement
        // dans le bundle du site (`_astro/supabaseClient.*.js`) et donc sans
        // valeur de preuve ; la clé service-role ne quitte jamais le serveur.
        // Le contrôle d'accès réel reste le secret partagé ci-dessous.
        Authorization: `Bearer ${import.meta.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'x-lead-hook-secret': import.meta.env.LEAD_HOOK_SECRET,
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
      // Comme pour MailerLite, le rejet du timeout vient de `fetch` : il est
      // absorbé par le `catch` ci-dessous, qui ne fait déjà que journaliser.
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
    if (!notifyRes.ok) console.error('notify-admin-lead', notifyRes.status, await notifyRes.text());
  } catch (err) {
    console.error('notify-admin-lead unreachable', err);
  }

  return json({ success: true }, 200);
};
