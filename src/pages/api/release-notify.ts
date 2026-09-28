// src/pages/api/release-notify.ts
//
// « Prévenez-moi » : inscrit une adresse dans le groupe MailerLite des
// personnes à prévenir de la sortie de la nouvelle version (téléchargements
// suspendus d'ici là, voir src/config/downloads.ts). Le message est une
// campagne MailerLite envoyée à ces groupes le jour de la sortie.
//
// Mêmes gardes que l'inscription au livre : JSON seulement, adresse validée,
// quota par client, honeypot (succès simulé).
export const prerender = false;

import type { APIRoute } from 'astro';
import { RELEASE_NOTIFY_GROUPS } from '~/config/downloads';
import { validateBookSubscriber } from '~/lib/leadValidation';
import { addToMailerLiteGroup } from '~/lib/mailerlite';
import { releaseNotifyRateLimiter } from '~/lib/rateLimit';
import { emailDigest, isJsonRequest, rateLimitKey } from '~/lib/requestGuards';
import { SUPPORTED_LOCALES } from '~/lib/i18n';

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
  if (!releaseNotifyRateLimiter.check(rateLimitKey(context))) return json({ error: 'rate_limited' }, 429);
  if (result.honeypot) {
    console.error('honeypot déclenché, inscription à la sortie ignorée', emailDigest(result.subscriber.email));
    return json({ success: true }, 200);
  }

  const lang = (SUPPORTED_LOCALES as readonly string[]).includes(String(body.lang)) ? String(body.lang) : 'en';
  // Français vers le groupe FR ; toute autre langue reçoit le message en anglais.
  const group = lang === 'fr' ? RELEASE_NOTIFY_GROUPS.fr : RELEASE_NOTIFY_GROUPS.en;
  const ok = await addToMailerLiteGroup(result.subscriber.email, group, { lang });
  return ok ? json({ success: true }, 200) : json({ error: 'subscribe_failed' }, 502);
};
