// src/pages/api/billing/start-trial.ts
//
// Bouton admin « Installation faite » (app desktop, webapp mycompanion) :
// crée le premier abonnement du bike fitter visé, avec 14 jours d'essai à
// partir de maintenant (voir src/lib/billing/install.ts).
//
// Réservé au rôle admin (jeton vérifié, rôle relu en base). Le corps ne
// porte que le bike fitter visé. Appelé aussi depuis la webapp
// (mycompanion.aeroxbefaster.com) : réponse CORS pour cette seule origine.
export const prerender = false;

import type { APIRoute } from 'astro';
import { authenticatedUser } from '~/lib/serverAuth';
import { startSubscriptionAtInstall } from '~/lib/billing/install';
import { json, loadRole, supabaseAdmin } from '~/lib/billing/server';

const ALLOWED_ORIGINS = new Set(['https://mycompanion.aeroxbefaster.com']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cors(request: Request): Record<string, string> {
  const origin = request.headers.get('origin') ?? '';
  if (!ALLOWED_ORIGINS.has(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '600',
    vary: 'origin',
  };
}

function withCors(request: Request, response: Response): Response {
  for (const [k, v] of Object.entries(cors(request))) response.headers.set(k, v);
  return response;
}

export const OPTIONS: APIRoute = ({ request }) => new Response(null, { status: 204, headers: cors(request) });

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = (await request.json().catch(() => ({}))) as { userId?: unknown };
    if (typeof body.userId !== 'string' || !UUID.test(body.userId)) {
      return withCors(request, json({ error: 'E_USER' }, 400));
    }

    const caller = await authenticatedUser(request, 'billing/start-trial');
    if (!caller) return withCors(request, json({ error: 'E_AUTH' }, 401));

    const db = supabaseAdmin();
    if ((await loadRole(db, caller.id)) !== 'admin') return withCors(request, json({ error: 'E_ROLE' }, 403));

    const result = await startSubscriptionAtInstall(db, body.userId);
    if ('error' in result) {
      console.error('billing/start-trial:', body.userId, result.error);
      return withCors(request, json({ error: result.error }, 409));
    }
    return withCors(request, json({ ok: true, trial_ends_at: result.trialEndsAt }));
  } catch (err) {
    console.error('billing/start-trial', err instanceof Error ? err.message : err);
    return withCors(request, json({ error: 'E_SERVER' }, 500));
  }
};
