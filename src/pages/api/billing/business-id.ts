// src/pages/api/billing/business-id.ts
//
// « Tester AeroX maintenant » : le bike fitter renseigne l'identifiant de son
// entreprise (SIREN / SIRET, n° de TVA intracommunautaire, ou identifiant
// d'un autre pays). Vérifié par le registre officiel quand il en existe un
// (voir src/lib/billing/businessId.ts) : les 2 analyses offertes s'ouvrent
// aussitôt. Sinon, vérification manuelle par l'admin (notification).
//
// Un identifiant ne sert qu'à un compte (unicité en base). L'utilisateur vient
// du jeton, jamais du corps.
export const prerender = false;

import type { APIRoute } from 'astro';
import { authenticatedUser } from '~/lib/serverAuth';
import { parseBusinessId, verifyBusinessId } from '~/lib/billing/businessId';
import { json, loadBilling, loadRole, supabaseAdmin } from '~/lib/billing/server';

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = (await request.json().catch(() => ({}))) as { id?: unknown };

    const user = await authenticatedUser(request, 'billing/business-id');
    if (!user) return json({ error: 'E_AUTH' }, 401);

    const db = supabaseAdmin();
    const role = await loadRole(db, user.id);
    if (role !== 'bike-fitter' && role !== 'admin') return json({ error: 'E_ROLE' }, 403);

    const billing = await loadBilling(db, user.id);
    if (!billing || billing.plan !== 'trial' || billing.trial_state === 'granted') {
      return json({ error: 'E_TRIAL_UNAVAILABLE' }, 409);
    }

    const id = parseBusinessId(body.id);
    if (id.kind === 'invalid') return json({ result: 'invalid' });

    const check = await verifyBusinessId(id);
    if (check.status === 'not_found') return json({ result: 'not_found' });
    if (check.status === 'inactive') return json({ result: 'inactive', name: check.name });
    if (check.status === 'registry_down') return json({ result: 'registry_down' });

    const verified = check.status === 'verified';
    const { data, error } = await db.rpc('bf_register_business_id', {
      p_user: user.id,
      p_key: id.key,
      p_kind: id.kind,
      p_country: id.kind === 'other' ? null : id.country,
      p_name: verified ? check.name : '',
      p_verified: verified,
    });
    if (error) throw new Error(`bf_register_business_id: ${error.message}`);
    return json({ result: data as string, name: verified ? check.name : undefined });
  } catch (err) {
    console.error('billing/business-id', err instanceof Error ? err.message : err);
    return json({ error: 'E_SERVER' }, 500);
  }
};
