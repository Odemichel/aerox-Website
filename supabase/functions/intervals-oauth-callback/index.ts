// supabase/functions/intervals-oauth-callback/index.ts
//
// Retour de l'autorisation Intervals.icu (feat-intervals-sync), appelé par
// le navigateur de l'athlète : pas de JWT. L'utilisateur est celui du
// `state` (usage unique, 10 min), accepté seulement avec le cookie posé par
// `intervals-oauth-start` dans ce même navigateur. Échange le code (dans les
// 2 min), enregistre le jeton, puis redirige vers la page de confirmation du
// site (les Edge Functions ne servent pas de HTML).
//
//   supabase functions deploy intervals-oauth-callback --no-verify-jwt
import {
  adminClient,
  LOCALES,
  maskEmail,
  NONCE_COOKIE_ATTRS,
  readCookie,
  sha256Hex,
  SITE_URL,
  STATE_TTL_MS,
} from '../_shared/strava.ts';
import { exchangeCode, grantedScopes, hasScope, NONCE_COOKIE } from '../_shared/intervals.ts';

type Status = 'ok' | 'denied' | 'error';

function redirect(lang: string, status: Status, account = ''): Response {
  const l = (LOCALES as readonly string[]).includes(lang) ? lang : 'en';
  const query = new URLSearchParams({ status });
  if (account) query.set('account', account);
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${SITE_URL}/${l}/intervals/connexion/?${query}`,
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
        .eq('provider', 'intervals')
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
    console.warn('intervals callback : cookie absent ou différent');
    return redirect(lang, 'error');
  }

  const code = params.get('code');
  if (params.get('error') || !code) return redirect(lang, 'denied');

  try {
    const t = await exchangeCode(code);
    const granted = grantedScopes(t.scope);
    // Sans envoi ni lecture du calendrier, la connexion ne sert à rien.
    if (!hasScope(granted, 'ACTIVITY:WRITE') && !hasScope(granted, 'CALENDAR:READ')) {
      return redirect(lang, 'denied');
    }
    const athleteId = t.athlete?.id !== undefined && t.athlete?.id !== null ? String(t.athlete.id) : '';
    if (!athleteId || !t.access_token) throw new Error('athlète ou jeton absent de la réponse Intervals');

    // Un compte Intervals n'appartient qu'à un seul utilisateur AeroX.
    const { data: owner } = await db
      .from('user_integrations')
      .select('user_id')
      .eq('provider', 'intervals')
      .eq('provider_athlete_id', athleteId)
      .maybeSingle();
    if (owner && owner.user_id !== st.user_id) {
      console.warn('intervals callback : athlète déjà lié à un autre compte');
      return redirect(lang, 'error');
    }

    const { error } = await db.from('user_integrations').upsert({
      user_id: st.user_id,
      provider: 'intervals',
      provider_athlete_id: athleteId,
      athlete_name: null,
      access_token: t.access_token,
      refresh_token: null,
      expires_at: null,
      scope: granted.join(','),
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    if (error) throw new Error(error.message);
    const { data: auth } = await db.auth.admin.getUserById(st.user_id);
    return redirect(lang, 'ok', maskEmail(auth?.user?.email));
  } catch (e) {
    console.error('intervals callback', (e as Error).message);
    return redirect(lang, 'error');
  }
});
