// supabase/functions/strava-oauth-start/index.ts
//
// Début de la connexion Strava (feat-strava-sync), en deux temps :
//
// 1. POST, JWT de l'utilisateur : crée un `state` à usage unique lié à lui
//    et renvoie l'URL de l'étape 2 (cette même fonction, en GET).
// 2. GET ?state=…, ouvert par l'app dans le navigateur (2 min max, une
//    seule fois) : pose un cookie aléatoire, garde son empreinte avec le
//    state, puis redirige vers l'autorisation Strava.
//
// Le retour d'autorisation exige ce cookie : un lien d'autorisation transmis
// à quelqu'un d'autre ne peut pas rattacher son Strava au compte AeroX qui
// l'a créé (CSRF OAuth).
//
//   supabase functions deploy strava-oauth-start --no-verify-jwt
//   (JWT vérifié dans le code pour le POST ; le GET vient du navigateur)
import {
  adminClient,
  BROWSER_STEP_TTL_MS,
  CALLBACK_URL,
  callerId,
  clientId,
  json,
  NONCE_COOKIE,
  NONCE_COOKIE_ATTRS,
  randomNonce,
  SCOPE,
  sha256Hex,
  START_URL,
  STATE_TTL_MS,
} from '../_shared/strava.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function createState(req: Request): Promise<Response> {
  const db = adminClient();
  const userId = await callerId(req, db);
  if (!userId) return json({ error: 'unauthorized' }, 401);

  // Un seul state actif par utilisateur ; purge des états expirés.
  await db.from('oauth_states').delete().eq('user_id', userId);
  await db
    .from('oauth_states')
    .delete()
    .lt('created_at', new Date(Date.now() - STATE_TTL_MS).toISOString());

  const { data, error } = await db
    .from('oauth_states')
    .insert({ user_id: userId, provider: 'strava' })
    .select('state')
    .single();
  if (error || !data) {
    console.error('oauth_states insert', error?.message);
    return json({ error: 'internal' }, 500);
  }
  return json({ url: `${START_URL}?state=${data.state}` });
}

async function openInBrowser(req: Request): Promise<Response> {
  const state = new URL(req.url).searchParams.get('state') ?? '';
  if (!UUID.test(state)) return new Response('Lien invalide', { status: 400 });

  const nonce = randomNonce();
  const db = adminClient();
  // Étape navigateur une seule fois (empreinte encore vide), dans les 2 min.
  const { data } = await db
    .from('oauth_states')
    .update({ browser_nonce_hash: await sha256Hex(nonce) })
    .eq('state', state)
    .is('browser_nonce_hash', null)
    .gt('created_at', new Date(Date.now() - BROWSER_STEP_TTL_MS).toISOString())
    .select('state')
    .maybeSingle();
  if (!data) return new Response('Lien expiré : relance la connexion depuis AeroX.', { status: 410 });

  const url = new URL('https://www.strava.com/oauth/authorize');
  url.search = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: CALLBACK_URL,
    response_type: 'code',
    // Toujours l'écran d'autorisation : pas de connexion sans clic.
    approval_prompt: 'force',
    scope: SCOPE,
    state,
  }).toString();
  const maxAge = Math.floor(STATE_TTL_MS / 1000);
  return new Response(null, {
    status: 302,
    headers: {
      Location: url.toString(),
      'Set-Cookie': `${NONCE_COOKIE}=${nonce}; Max-Age=${maxAge}; ${NONCE_COOKIE_ATTRS}`,
      'Cache-Control': 'no-store',
    },
  });
}

Deno.serve((req) => {
  if (req.method === 'POST') return createState(req);
  if (req.method === 'GET') return openInBrowser(req);
  return json({ error: 'method_not_allowed' }, 405);
});
