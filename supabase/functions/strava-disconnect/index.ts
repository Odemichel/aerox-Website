// supabase/functions/strava-disconnect/index.ts
//
// Déconnexion Strava (feat-strava-sync) : révoque l'autorisation chez Strava
// (au mieux), supprime la connexion (jetons, identifiant et nom de
// l'athlète) puis les envois de séances (identifiants d'activité Strava),
// et confirme la suppression par e-mail.
//
//   supabase functions deploy strava-disconnect
import {
  adminClient,
  callerId,
  deauthorize,
  freshAccessToken,
  json,
  purgeStravaExports,
  type Integration,
} from '../_shared/strava.ts';
import { sendStravaDeletionEmail } from '../_shared/strava_email.ts';

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
    // Jeton lu avant la suppression ; la connexion est supprimée avant la
    // révocation, pour que l'événement de retrait envoyé ensuite par Strava
    // au webhook ne trouve plus rien (pas de second e-mail).
    let token: string | null = null;
    try {
      token = await freshAccessToken(db, row);
    } catch (e) {
      // Autorisation déjà retirée côté Strava : on supprime quand même.
      console.warn('strava disconnect token', (e as Error).message);
    }
    const { error } = await db.from('user_integrations').delete().eq('user_id', userId).eq('provider', 'strava');
    if (error) return json({ error: 'internal' }, 500);
    if (token) {
      try {
        const res = await deauthorize(token);
        if (!res.ok) console.warn('strava deauthorize HTTP', res.status);
      } catch (e) {
        console.warn('strava deauthorize', (e as Error).message);
      }
    }
  }
  // Aussi sans connexion : envois restés d'une déconnexion antérieure.
  try {
    await purgeStravaExports(db, userId);
  } catch (e) {
    console.error('strava disconnect', (e as Error).message);
    return json({ error: 'internal' }, 500);
  }
  // Confirmation écrite de la suppression (connexion qui existait).
  if (row) await sendStravaDeletionEmail(db, userId);
  return json({ disconnected: true });
});
