// src/pages/api/rider-signup.ts
//
// Création de compte cycliste (/inscription/) : la fiche rejoint MailerLite,
// dans le groupe global de sa langue et dans « Inscrits Diagnostic » (le
// compte cycliste sert à réserver le diagnostic). Appelé par le formulaire
// juste après `supabase.auth.signUp` ; jamais bloquant pour l'inscription.
//
// Mêmes gardes que /api/release-notify/ : JSON seulement, adresse validée,
// quota par client, honeypot (succès simulé).
export const prerender = false;

import type { APIRoute } from 'astro';
import { validateBookSubscriber } from '~/lib/leadValidation';
import { addToMailerLiteGroup } from '~/lib/mailerlite';
import { riderSignupRateLimiter } from '~/lib/rateLimit';
import { emailDigest, isJsonRequest, rateLimitKey } from '~/lib/requestGuards';
import { SUPPORTED_LOCALES } from '~/lib/i18n';

const GROUP_GLOBAL_FR = '180112371932464856';
const GROUP_GLOBAL_EN = '180113595562985140';
const GROUP_RIDER_DIAGNOSTIC = '203202556221981739';

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const POST: APIRoute = async (context) => {
  const { request } = context;
  if (!isJsonRequest(request)) return json({ error: 'invalid_type' }, 415);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const result = validateBookSubscriber({ email: body.email, hp: body.hp });
  if (result.ok === false) return json({ error: result.error }, 400);
  if (!riderSignupRateLimiter.check(rateLimitKey(context))) return json({ error: 'rate_limited' }, 429);
  if (result.honeypot) {
    console.error('honeypot déclenché, inscription cycliste ignorée', emailDigest(result.subscriber.email));
    return json({ success: true }, 200);
  }

  const lang = (SUPPORTED_LOCALES as readonly string[]).includes(String(body.lang)) ? String(body.lang) : 'en';
  // Deux groupes globaux seulement : français d'un côté, toutes les autres langues de l'autre.
  const groups = [lang === 'fr' ? GROUP_GLOBAL_FR : GROUP_GLOBAL_EN, GROUP_RIDER_DIAGNOSTIC];
  const ok = await addToMailerLiteGroup(result.subscriber.email, groups, {
    lang,
    rider_signup: new Date().toISOString().slice(0, 10),
  });
  return ok ? json({ success: true }, 200) : json({ error: 'subscribe_failed' }, 502);
};
