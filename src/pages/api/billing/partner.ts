// src/pages/api/billing/partner.ts
//
// Lien privé de l'offre partenaire (59 €/mois ou 590 €/an pendant 12 mois) :
// l'espace bike fitter, ouvert avec `?partenaire=<jeton>`, envoie le jeton
// ici. Jeton valide : l'offre partenaire est ouverte sur le compte
// (`bf_billing.partner_offer`), durablement — elle reste proposée même si le
// bike fitter revient plus tard sans le lien.
//
// Le jeton est un secret partagé (variable `PARTNER_OFFER_TOKEN`) : le
// changer ferme le lien pour les nouveaux venus, sans retirer l'offre aux
// comptes qui l'ont déjà ouverte.
export const prerender = false;

import { timingSafeEqual } from 'node:crypto';
import type { APIRoute } from 'astro';
import { authenticatedUser } from '~/lib/serverAuth';
import { json, loadRole, supabaseAdmin } from '~/lib/billing/server';

function tokenMatches(given: unknown): boolean {
  const expected = (import.meta.env.PARTNER_OFFER_TOKEN as string | undefined) ?? '';
  if (expected.length < 16 || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = (await request.json().catch(() => ({}))) as { token?: unknown };

    const user = await authenticatedUser(request, 'billing/partner');
    if (!user) return json({ error: 'E_AUTH' }, 401);

    const db = supabaseAdmin();
    const role = await loadRole(db, user.id);
    if (role !== 'bike-fitter' && role !== 'admin') return json({ error: 'E_ROLE' }, 403);

    if (!tokenMatches(body.token)) return json({ error: 'E_PARTNER_TOKEN' }, 403);

    const { error } = await db
      .from('bf_billing')
      .upsert({ user_id: user.id, partner_offer: true }, { onConflict: 'user_id' });
    if (error) throw new Error(`bf_billing (partenaire): ${error.message}`);
    return json({ ok: true });
  } catch (err) {
    console.error('billing/partner', err instanceof Error ? err.message : err);
    return json({ error: 'E_SERVER' }, 500);
  }
};
