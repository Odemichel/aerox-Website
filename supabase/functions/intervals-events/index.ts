// supabase/functions/intervals-events/index.ts
//
// Séances planifiées du calendrier Intervals.icu (feat-intervals-sync,
// étape 2) : événements `WORKOUT` entre deux dates locales de l'athlète,
// chacun avec son fichier Zwift (.zwo) que l'app convertit en blocs AeroX.
//
// Corps : { oldest: 'yyyy-MM-dd', newest: 'yyyy-MM-dd' } (14 jours max).
// Réponse : { status: 'ok', events: [{ id, name, start_date_local,
//             description, zwo }] } | { status: 'not_connected' } |
//           { status: 'error', error }
// `zwo` vaut null pour une séance non convertible (autre sport, texte seul).
//
//   supabase functions deploy intervals-events
import { adminClient, callerId, json } from '../_shared/strava.ts';
import {
  dropIntegration,
  grantedScopes,
  hasScope,
  intervalsFetch,
  IntervalsRateLimited,
  IntervalsUnauthorized,
  isIntervalsId,
  loadIntegration,
} from '../_shared/intervals.ts';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 14;
/** Fichiers téléchargés par appel (quota de 100 appels / jour). */
const MAX_EVENTS = 10;
const MAX_ZWO_CHARS = 200_000;

interface IntervalsEvent {
  id?: number | string;
  category?: string;
  type?: string;
  name?: string;
  start_date_local?: string;
  description?: string;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const db = adminClient();
  const userId = await callerId(req, db);
  if (!userId) return json({ error: 'unauthorized' }, 401);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  const { oldest, newest } = body;
  if (typeof oldest !== 'string' || typeof newest !== 'string' || !DATE.test(oldest) || !DATE.test(newest)) {
    return json({ error: 'bad_request' }, 400);
  }
  const days = (Date.parse(newest) - Date.parse(oldest)) / 86_400_000;
  if (!(days >= 0 && days <= MAX_DAYS)) return json({ error: 'bad_request' }, 400);

  const integration = await loadIntegration(db, userId);
  if (!integration || !hasScope(grantedScopes(integration.scope), 'CALENDAR:READ')) {
    return json({ status: 'not_connected' });
  }

  try {
    const query = new URLSearchParams({ oldest, newest });
    const res = await intervalsFetch(integration.access_token, `/athlete/0/events?${query}`);
    if (!res.ok) {
      console.warn('intervals events HTTP', res.status);
      return json({ status: 'error', error: 'events_failed' });
    }
    const all: IntervalsEvent[] = await res.json().catch(() => []);
    const workouts = (Array.isArray(all) ? all : [])
      .filter((e) => e.category === 'WORKOUT' && isIntervalsId(String(e.id ?? '')))
      .sort((a, b) => (a.start_date_local ?? '').localeCompare(b.start_date_local ?? ''))
      .slice(0, MAX_EVENTS);

    const events = [];
    for (const e of workouts) {
      let zwo: string | null = null;
      // Vélo seulement : AeroX joue les séances sur home trainer.
      if (!e.type || /ride/i.test(e.type)) {
        const file = await intervalsFetch(integration.access_token, `/athlete/0/events/${e.id}/download.zwo`);
        if (file.ok) {
          const text = await file.text();
          zwo = text.length <= MAX_ZWO_CHARS && text.includes('<workout') ? text : null;
        }
      }
      events.push({
        id: String(e.id),
        name: e.name ?? '',
        start_date_local: e.start_date_local ?? null,
        description: e.description ?? '',
        zwo,
      });
    }
    return json({ status: 'ok', events });
  } catch (e) {
    if (e instanceof IntervalsUnauthorized) {
      await dropIntegration(db, integration);
      return json({ status: 'error', error: 'unauthorized' });
    }
    if (e instanceof IntervalsRateLimited) return json({ status: 'error', error: 'rate_limited' });
    console.error('intervals events', (e as Error).message);
    return json({ status: 'error', error: 'internal' });
  }
});
