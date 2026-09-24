export const prerender = false;

import type { APIRoute } from 'astro';
import { validateLead, type Lead } from '~/lib/leadValidation';
import { leadRateLimiter } from '~/lib/rateLimit';
import { emailDigest, isJsonRequest, rateLimitKey } from '~/lib/requestGuards';

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

export const POST: APIRoute = async (context) => {
  // `clientAddress` n'est volontairement pas déstructuré ici : voir rateLimitKey (~/lib/requestGuards).
  const { request, params } = context;

  // Content-Type JSON exigé : voir isJsonRequest.
  if (!isJsonRequest(request)) return json({ error: 'invalid_type' }, 415);

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

  // Le contrôle de quota passe *avant* la branche honeypot : celle-ci écrit
  // désormais dans les journaux, et une branche à effet de bord placée devant
  // le limiteur laisserait n'importe qui provoquer un volume illimité
  // d'écritures en postant `hp: 1`, sans jamais croiser un 429.
  const ip = rateLimitKey(context);
  if (!leadRateLimiter.check(ip)) return json({ error: 'rate_limited' }, 429);

  // Honeypot : on répond comme si tout s'était bien passé, sans rien faire.
  // Le bot ne peut pas distinguer un succès d'un rejet. La trace serveur est
  // le seul moyen de repérer un faux positif (gestionnaire de mots de passe
  // qui remplit le champ invisible) : sans elle, le lead disparaîtrait
  // silencieusement. L'email y figure haché, pas en clair : ces journaux sont
  // conservés par la plateforme, et un identifiant stable suffit à corréler.
  if (result.honeypot) {
    console.error('honeypot déclenché, lead ignoré', emailDigest(result.lead.email));
    return json({ success: true }, 200);
  }

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
  if (lead.phone) fields.phone = lead.phone;
  // Champs de qualification bike-fitter : `bf_intent` dit ce qu'il demande
  // (démo, devis, ou simple création de compte), `bf_status` et `bf_signup`
  // alignent la fiche MailerLite sur ce que porte déjà Supabase. Un compte
  // créé est actif tout de suite, en essai ; une demande de démo ou de devis
  // reste un lead. Le webhook Stripe fait ensuite évoluer `bf_status` et
  // `bf_plan` à chaque changement d'offre.
  if (lead.topic === 'bike-fitter') {
    fields.company = 'bike-fitter';
    fields.bf_intent = lead.intent;
    fields.bf_status = lead.intent === 'inscription' ? 'trial' : 'lead';
    if (lead.intent === 'inscription') fields.bf_plan = 'trial';
    fields.bf_signup = new Date().toISOString().slice(0, 10);
  }

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
    // Ce `text()` est hors du `try` ci-dessus, et `AbortSignal.timeout` couvre
    // aussi la lecture du corps : un amont qui rend un statut non-2xx puis
    // s'enlise sur son corps ferait rejeter cette lecture à 8 s, sans personne
    // pour la capter — 500 du framework au lieu de la réponse opaque prévue.
    // La lecture est donc rendue infaillible : le corps n'est qu'un détail de
    // journalisation, il ne doit jamais décider du code de retour.
    const detail = await mlRes.text().catch(() => '<corps illisible>');
    console.error('MailerLite error', mlRes.status, detail);
    return json({ error: 'subscribe_failed' }, 502);
  }

  // La notification ne doit jamais faire échouer l'inscription du lead :
  // le contact est déjà enregistré chez MailerLite à ce stade.
  try {
    // Secret absent au build : l'en-tête part avec la chaîne "undefined",
    // l'Edge Function rejette en 403 et la notification est perdue. L'échec
    // fermé est le bon sens, mais il serait muet — on l'annonce donc au
    // journal, sinon la seule trace visible serait un 403 sans explication.
    if (!import.meta.env.LEAD_HOOK_SECRET) {
      console.error(
        "LEAD_HOOK_SECRET absent de l'environnement de build : notify-admin-lead va rejeter en 403, la notification sera perdue"
      );
    }
    const notifyRes = await fetch(NOTIFY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // `verify_jwt` reste activé côté Supabase : la passerelle exige un
        // `Authorization` pour laisser passer l'appel. La clé anon le satisfait
        // et n'a aucun privilège — c'est tout ce qu'on lui demande ici. Elle
        // n'authentifie rien : servie publiquement dans le bundle du site
        // (`_astro/supabaseClient.*.js`), n'importe qui peut la produire.
        // L'authentification est assurée par `x-lead-hook-secret` ci-dessous,
        // connu du seul serveur. Ne pas remplacer ce porteur par la clé
        // service-role : elle contourne RLS, et rien ici n'en a besoin.
        Authorization: `Bearer ${import.meta.env.PUBLIC_SUPABASE_ANON_KEY}`,
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
