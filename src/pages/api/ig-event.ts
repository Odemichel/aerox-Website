// src/pages/api/ig-event.ts
//
// Attribution des DM Instagram (voir src/lib/igDmEvents.ts et la migration
// 20261115133121_ig_dm_events.sql). Route publique : le corps ne porte qu'un
// type d'événement, une ressource et un identifiant de reel, en liste fermée ou
// au format contrôlé. Aucune donnée personnelle. Réponse 204 dans tous les cas acceptés.
export const prerender = false;

import type { APIRoute } from 'astro';
import { supabaseAdmin } from '~/lib/billing/server';
import { isBotUserAgent, validateIgDmEvent } from '~/lib/igDmEvents';
import { igEventRateLimiter } from '~/lib/rateLimit';
import { isJsonRequest, rateLimitKey } from '~/lib/requestGuards';

const empty = (status: number) => new Response(null, { status });

export const POST: APIRoute = async (context) => {
  const { request } = context;
  if (!isJsonRequest(request)) return empty(415);

  const event = validateIgDmEvent(await request.json().catch(() => null));
  if (!event) return empty(400);

  // Robot (contrôle de lien, aperçu) : accepté sans être compté.
  if (isBotUserAgent(request.headers.get('user-agent'))) return empty(204);
  if (!igEventRateLimiter.check(rateLimitKey(context))) return empty(204);

  const { error } = await supabaseAdmin().from('ig_dm_events').insert(event);
  if (error) console.error('ig-event: insertion refusée', error.message);
  return empty(204);
};
