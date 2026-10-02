// src/pages/api/cda-event.ts
//
// Compteur d'usage du calculateur de CdA (voir src/lib/cdaEvents.ts et la
// migration 20261002100000_cda_tool_events.sql). Route publique : le corps ne
// porte qu'un type d'événement, une langue et un vélo, tous en liste fermée.
// Aucune donnée personnelle n'est enregistrée. Réponse 204 dans tous les cas
// acceptés : le navigateur n'a rien à afficher.
export const prerender = false;

import type { APIRoute } from 'astro';
import { supabaseAdmin } from '~/lib/billing/server';
import { validateCdaEvent } from '~/lib/cdaEvents';
import { cdaEventRateLimiter } from '~/lib/rateLimit';
import { isJsonRequest, rateLimitKey } from '~/lib/requestGuards';

const empty = (status: number) => new Response(null, { status });

export const POST: APIRoute = async (context) => {
  const { request } = context;
  if (!isJsonRequest(request)) return empty(415);

  const event = validateCdaEvent(await request.json().catch(() => null));
  if (!event) return empty(400);

  // Quota dépassé : on ignore l'événement sans erreur visible.
  if (!cdaEventRateLimiter.check(rateLimitKey(context))) return empty(204);

  const { error } = await supabaseAdmin().from('cda_tool_events').insert(event);
  if (error) console.error('cda-event: insertion refusée', error.message);
  return empty(204);
};
