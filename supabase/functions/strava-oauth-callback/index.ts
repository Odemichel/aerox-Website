// supabase/functions/strava-oauth-callback/index.ts
//
// Retour de l'autorisation Strava (feat-strava-sync), appelé par le
// navigateur de l'athlète : pas de JWT. L'utilisateur est celui du `state`
// (usage unique, 10 min), accepté seulement avec le cookie posé par
// `strava-oauth-start` dans ce même navigateur. Échange le code, enregistre
// les jetons, puis redirige vers la page de confirmation du site (les Edge
// Functions ne servent pas de HTML).
//
//   supabase functions deploy strava-oauth-callback --no-verify-jwt
import {
  adminClient,
  exchangeCode,
  knownScopes,
  LOCALES,
  maskEmail,
  NONCE_COOKIE,
  NONCE_COOKIE_ATTRS,
  readCookie,
  sha256Hex,
  SITE_URL,
  STATE_TTL_MS,
} from '../_shared/strava.ts';

type Status = 'ok' | 'denied' | 'error';

function redirect(lang: string, status: Status, account = ''): Response {
  const l = (LOCALES as readonly string[]).includes(lang) ? lang : 'en';
  const query = new URLSearchParams({ status });
  if (account) query.set('account', account);
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${SITE_URL}/${l}/strava/connexion/?${query}`,
      // Cookie à usage unique : effacé dans tous les cas.
      'Set-Cookie': `${NONCE_COOKIE}=; Max-Age=0; ${NONCE_COOKIE_ATTRS}`,
      'Cache-Control': 'no-store',
    },
  });
}

Deno.serve(async (req) => {
  const params = new URL(req.url).searchParams;
  const state = params.get('state');
  const nonce = readCookie(req, NONCE_COOKIE);
  const db = adminClient();

  // Usage unique : le state est supprimé à la lecture.
  const { data: st } = state
    ? await db
        .from('oauth_states')
        .delete()
        .eq('state', state)
        .select('user_id, created_at, browser_nonce_hash')
        .maybeSingle()
    : { data: null };
  if (!st || Date.now() - Date.parse(st.created_at) > STATE_TTL_MS) {
    return redirect('en', 'error');
  }

  const { data: user } = await db.from('users').select('lang').eq('id', st.user_id).maybeSingle();
  const lang = (user?.lang as string | undefined) ?? 'en';

  // Navigateur différent de celui qui a ouvert la connexion : refusé.
  if (!nonce || !st.browser_nonce_hash || (await sha256Hex(nonce)) !== st.browser_nonce_hash) {
    console.warn('strava callback : cookie absent ou différent');
    return redirect(lang, 'error');
  }

  const code = params.get('code');
  const granted = knownScopes(params.get('scope'));
  if (params.get('error') || !code) return redirect(lang, 'denied');
  if (!granted.includes('activity:write')) return redirect(lang, 'denied');

  try {
    const t = await exchangeCode(code);
    const athleteId = t.athlete?.id ? String(t.athlete.id) : '';
    if (!athleteId) throw new Error('athlète absent de la réponse Strava');

    // Un compte Strava n'appartient qu'à un seul utilisateur AeroX.
    const { data: owner } = await db
      .from('user_integrations')
      .select('user_id')
      .eq('provider', 'strava')
      .eq('provider_athlete_id', athleteId)
      .maybeSingle();
    if (owner && owner.user_id !== st.user_id) {
      console.warn('strava callback : athlète déjà lié à un autre compte');
      return redirect(lang, 'error');
    }

    const { error } = await db.from('user_integrations').upsert({
      user_id: st.user_id,
      provider: 'strava',
      provider_athlete_id: athleteId,
      athlete_name: [t.athlete.firstname, t.athlete.lastname].filter(Boolean).join(' ') || null,
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_at: new Date(t.expires_at * 1000).toISOString(),
      scope: granted.join(','),
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    if (error) throw new Error(error.message);
    // Compte AeroX rattaché, masqué : l'athlète voit tout de suite si le
    // lien venait de quelqu'un d'autre.
    const { data: auth } = await db.auth.admin.getUserById(st.user_id);
    return redirect(lang, 'ok', maskEmail(auth?.user?.email));
  } catch (e) {
    console.error('strava callback', (e as Error).message);
    return redirect(lang, 'error');
  }
});
