// supabase/functions/intervals-disconnect/index.ts
//
// Déconnexion Intervals.icu (feat-intervals-sync) : supprime la connexion
// (jeton, identifiant de l'athlète) et l'état des envois, puis retire
// l'autorisation chez Intervals (au mieux, `DELETE /api/v1/disconnect-app`).
//
//   supabase functions deploy intervals-disconnect
import { adminClient, callerId, json } from '../_shared/strava.ts';
import { disconnectApp, loadIntegration } from '../_shared/intervals.ts';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const db = adminClient();
  const userId = await callerId(req, db);
  if (!userId) return json({ error: 'unauthorized' }, 401);

  const row = await loadIntegration(db, userId);
  const { error } = await db.from('user_integrations').delete().eq('user_id', userId).eq('provider', 'intervals');
  if (error) return json({ error: 'internal' }, 500);
  const purge = await db.from('session_exports').delete().eq('user_id', userId).eq('provider', 'intervals');
  if (purge.error) console.error('intervals disconnect purge', purge.error.message);

  if (row) {
    try {
      const res = await disconnectApp(row.access_token);
      if (!res.ok) console.warn('intervals disconnect-app HTTP', res.status);
    } catch (e) {
      console.warn('intervals disconnect-app', (e as Error).message);
    }
  }
  return json({ disconnected: true });
});
