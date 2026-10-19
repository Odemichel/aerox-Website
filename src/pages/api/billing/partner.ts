// src/pages/api/billing/partner.ts
//
// Lien privé de l'offre partenaire (59 €/mois ou 590 €/an pendant 12 mois) :
// l'espace bike fitter, ouvert avec `?partenaire=<jeton>`, envoie le jeton
// ici. Jeton valide : l'offre partenaire est ouverte sur le compte
// (`bf_billing.partner_offer`) pour 24 heures, comptées à partir de la
// première ouverture (`partner_offer_expires_at`) : rouvrir le lien ne les
// repousse pas, et passé ce délai la route répond `E_PARTNER_EXPIRED`.
//
// Le jeton est un secret partagé (variable `PARTNER_OFFER_TOKEN`) : le
// changer ferme le lien pour les nouveaux venus, sans retirer l'offre aux
// comptes qui l'ont déjà ouverte.
export const prerender = false;

import { timingSafeEqual } from 'node:crypto';
import type { APIRoute } from 'astro';
import { authenticatedUser } from '~/lib/serverAuth';
import { PARTNER_OFFER_WINDOW_MS, partnerOfferOpen } from '~/lib/billing/logic';
import { json, loadBilling, loadRole, supabaseAdmin } from '~/lib/billing/server';

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

    // Ligne créée si besoin, puis délai posé une seule fois (la condition
    // `is null` évite qu'une ouverture concurrente le repousse).
    const created = await db
      .from('bf_billing')
      .upsert({ user_id: user.id }, { onConflict: 'user_id', ignoreDuplicates: true });
    if (created.error) throw new Error(`bf_billing (partenaire): ${created.error.message}`);
    const opened = await db
      .from('bf_billing')
      .update({
        partner_offer: true,
        partner_offer_expires_at: new Date(Date.now() + PARTNER_OFFER_WINDOW_MS).toISOString(),
      })
      .eq('user_id', user.id)
      .is('partner_offer_expires_at', null);
    if (opened.error) throw new Error(`bf_billing (partenaire): ${opened.error.message}`);

    const billing = await loadBilling(db, user.id);
    if (!partnerOfferOpen(billing, Date.now())) return json({ error: 'E_PARTNER_EXPIRED' }, 403);
    return json({ ok: true, expires_at: billing!.partner_offer_expires_at });
  } catch (err) {
    console.error('billing/partner', err instanceof Error ? err.message : err);
    return json({ error: 'E_SERVER' }, 500);
  }
};
