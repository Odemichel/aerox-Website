// src/pages/api/billing/approve-business.ts
//
// Validation manuelle d'un identifiant d'entreprise sans registre public
// (hors UE), depuis le lien de l'e-mail admin « identifiant à vérifier ».
//
// Le lien porte le compte et une signature HMAC-SHA256 du compte, calculée
// en base avec le secret partagé `billing_hook_secret` (= BILLING_HOOK_SECRET
// ici) : personne d'autre ne peut fabriquer un lien valide.
//
// GET n'écrit rien : il affiche une page de confirmation. Les antivirus de
// messagerie ouvrent les liens des e-mails ; seul le bouton (POST) valide.
export const prerender = false;

import type { APIRoute } from 'astro';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { supabaseAdmin } from '~/lib/billing/server';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function validSignature(user: string, token: string): boolean {
  const secret = import.meta.env.BILLING_HOOK_SECRET as string | undefined;
  if (!secret || !UUID.test(user) || !/^[0-9a-f]{64}$/.test(token)) return false;
  const expected = createHmac('sha256', secret).update(user).digest();
  return timingSafeEqual(expected, Buffer.from(token, 'hex'));
}

const page = (title: string, body: string, status = 200) =>
  new Response(
    `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="robots" content="noindex">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 48px auto; padding: 0 16px; color: #1a1a2e;">
<h1 style="font-size: 20px;">${title}</h1>${body}</body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }
  );

const escapeHtml = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );

async function pending(user: string) {
  const db = supabaseAdmin();
  const [{ data: id }, { data: profile }] = await Promise.all([
    db.from('bf_business_ids').select('id_key, status').eq('user_id', user).maybeSingle(),
    db.from('users').select('email, studio_name').eq('id', user).maybeSingle(),
  ]);
  return { id, profile };
}

export const GET: APIRoute = async ({ url }) => {
  const user = url.searchParams.get('u') ?? '';
  const token = url.searchParams.get('t') ?? '';
  if (!validSignature(user, token)) return page('Lien invalide', '<p>Ce lien de validation n’est pas valide.</p>', 403);

  const { id, profile } = await pending(user);
  if (!id || id.status !== 'pending_review') {
    return page('Rien à valider', '<p>Aucun identifiant en attente pour ce compte (déjà validé ?).</p>');
  }
  return page(
    'Valider cet identifiant d’entreprise ?',
    `<p><strong>${escapeHtml(profile?.studio_name ?? '')}</strong><br>${escapeHtml(profile?.email ?? '')}</p>
<p>Identifiant saisi : <strong>${escapeHtml(String(id.id_key).replace(/^OTHER:/, ''))}</strong></p>
<p>Valider ouvre les 2 analyses offertes de ce compte.</p>
<form method="post"><input type="hidden" name="u" value="${escapeHtml(user)}"><input type="hidden" name="t" value="${escapeHtml(token)}">
<button type="submit" style="background: #f59e0b; border: 0; padding: 12px 22px; border-radius: 8px; font-weight: 600; cursor: pointer;">Valider</button></form>`
  );
};

export const POST: APIRoute = async ({ request }) => {
  const form = await request.formData().catch(() => null);
  const user = String(form?.get('u') ?? '');
  const token = String(form?.get('t') ?? '');
  if (!validSignature(user, token)) return page('Lien invalide', '<p>Ce lien de validation n’est pas valide.</p>', 403);

  const { data, error } = await supabaseAdmin().rpc('bf_approve_business_id', { p_user: user });
  if (error) {
    console.error('billing/approve-business', error.message);
    return page('Erreur', '<p>La validation a échoué. Réessayez dans un instant.</p>', 500);
  }
  return data === 'granted'
    ? page('Identifiant validé', '<p>Les 2 analyses offertes de ce compte sont ouvertes.</p>')
    : page('Rien à valider', '<p>Aucun identifiant en attente pour ce compte (déjà validé ?).</p>');
};
