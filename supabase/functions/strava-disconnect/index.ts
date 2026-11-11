// supabase/functions/strava-disconnect/index.ts
//
// Déconnexion Strava (feat-strava-sync) : révoque l'autorisation chez Strava
// (au mieux) puis supprime les jetons.
//
//   supabase functions deploy strava-disconnect
import { adminClient, callerId, deauthorize, freshAccessToken, json, type Integration } from '../_shared/strava.ts';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const db = adminClient();
  const userId = await callerId(req, db);
  if (!userId) return json({ error: 'unauthorized' }, 401);

  const { data: row } = await db
    .from('user_integrations')
    .select('user_id, access_token, refresh_token, expires_at')
    .eq('user_id', userId)
    .eq('provider', 'strava')
    .maybeSingle<Integration>();

  if (row) {
    try {
      const res = await deauthorize(await freshAccessToken(db, row));
      if (!res.ok) console.warn('strava deauthorize HTTP', res.status);
    } catch (e) {
      // Autorisation déjà retirée côté Strava : on supprime quand même.
      console.warn('strava deauthorize', (e as Error).message);
    }
    const { error } = await db.from('user_integrations').delete().eq('user_id', userId).eq('provider', 'strava');
    if (error) return json({ error: 'internal' }, 500);
  }
  return json({ disconnected: true });
});
