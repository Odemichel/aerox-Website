// src/pages/api/account/newsletter.ts
//
// Cycliste : inscription au groupe MailerLite « AeroX Global » de sa langue
// (FR, ou EN pour toute autre langue), qui déclenche l'e-mail de bienvenue.
// Appelée par l'espace compte à la première visite, donc avec un compte dont
// l'adresse est confirmée. Les bike fitters passent par /api/lead/ à
// l'inscription.
//
// L'utilisateur vient du jeton, jamais du corps. Idempotent : MailerLite
// fait un upsert par e-mail et l'automatisation ne se déclenche qu'à
// l'entrée dans le groupe.
export const prerender = false;

import type { APIRoute } from 'astro';
import { authenticatedUser } from '~/lib/serverAuth';
import { addToMailerLiteGroup } from '~/lib/mailerlite';
import { json, loadRole, supabaseAdmin } from '~/lib/billing/server';
import { SUPPORTED_LOCALES } from '~/lib/i18n';

const GROUP_GLOBAL_FR = '180112371932464856';
const GROUP_GLOBAL_EN = '180113595562985140';

export const POST: APIRoute = async ({ request }) => {
  const user = await authenticatedUser(request, 'account/newsletter');
  if (!user?.email) return json({ error: 'E_AUTH' }, 401);

  const role = await loadRole(supabaseAdmin(), user.id);
  if (role !== 'rider') return json({ skipped: true });

  const body = (await request.json().catch(() => ({}))) as { lang?: unknown };
  const lang = (SUPPORTED_LOCALES as readonly string[]).includes(String(body.lang)) ? String(body.lang) : 'en';
  const ok = await addToMailerLiteGroup(user.email, lang === 'fr' ? GROUP_GLOBAL_FR : GROUP_GLOBAL_EN, { lang });
  return ok ? json({ success: true }) : json({ error: 'E_MAILERLITE' }, 502);
};
