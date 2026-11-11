// supabase/functions/_shared/strava.ts
//
// Socle commun des fonctions Strava (feat-strava-sync) : clients Supabase,
// utilisateur appelant, jetons OAuth (échange, renouvellement), appels API.
// Les jetons ne sortent jamais des Edge Functions et ne sont jamais logués.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

export const SITE_URL = 'https://aeroxbefaster.com';
const FUNCTIONS_URL = 'https://agvksgrjqskpetokudda.supabase.co/functions/v1';
export const START_URL = `${FUNCTIONS_URL}/strava-oauth-start`;
export const CALLBACK_URL = `${FUNCTIONS_URL}/strava-oauth-callback`;
export const SCOPE = 'activity:write,activity:read_all';
const KNOWN_SCOPES = ['read', 'activity:write', 'activity:read_all'];
export const STATE_TTL_MS = 10 * 60 * 1000;
/** Délai pour ouvrir le lien de connexion dans le navigateur. */
export const BROWSER_STEP_TTL_MS = 2 * 60 * 1000;
/** Cookie liant le retour d'autorisation au navigateur qui l'a lancé.
 * Préfixe `__Host-` : le navigateur refuse toute version posée par un
 * autre sous-domaine de supabase.co. */
export const NONCE_COOKIE = '__Host-aerox_strava_nonce';
export const NONCE_COOKIE_ATTRS = 'Path=/; HttpOnly; Secure; SameSite=Lax';

const STRAVA_OAUTH = 'https://www.strava.com/oauth';
export const STRAVA_API = 'https://www.strava.com/api/v3';
/** Renouvellement anticipé : jeton valable moins de 2 min. */
const REFRESH_MARGIN_S = 120;

export const LOCALES = ['fr', 'en', 'pt', 'es', 'it', 'de', 'nl', 'ja', 'tr'] as const;

export function clientId(): string {
  const id = Deno.env.get('STRAVA_CLIENT_ID');
  if (!id) throw new Error('STRAVA_CLIENT_ID manquant');
  return id;
}

function clientSecret(): string {
  const secret = Deno.env.get('STRAVA_CLIENT_SECRET');
  if (!secret) throw new Error('STRAVA_CLIENT_SECRET manquant');
  return secret;
}

/** Client service role : seul accès aux jetons (RLS sans policy). */
export function adminClient(): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });
}

/** Identifiant de l'utilisateur du JWT de la requête, `null` sinon. */
export async function callerId(req: Request, db: SupabaseClient): Promise<string | null> {
  const jwt = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!jwt) return null;
  const { data, error } = await db.auth.getUser(jwt);
  return error || !data.user ? null : data.user.id;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export interface Integration {
  user_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
}

/** Erreur Strava 401 : autorisation retirée ou jeton révoqué. */
export class StravaUnauthorized extends Error {}

/** Erreur Strava 429 : quota d'appels de l'application atteint. */
export class StravaRateLimited extends Error {}

async function tokenRequest(fields: Record<string, string>) {
  const res = await fetch(`${STRAVA_OAUTH}/token`, {
    method: 'POST',
    body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), ...fields }),
  });
  // 400 = jeton ou code refusé seulement si Strava le dit (« invalid ») ;
  // toute autre erreur ne doit pas faire supprimer la connexion.
  if (res.status === 401) throw new StravaUnauthorized('token 401');
  if (res.status === 400) {
    const text = await res.text();
    if (/invalid/i.test(text)) throw new StravaUnauthorized('token 400 invalid');
    throw new Error('Strava token HTTP 400');
  }
  if (res.status === 429) throw new StravaRateLimited('token');
  if (!res.ok) throw new Error(`Strava token HTTP ${res.status}`);
  return await res.json();
}

/** Échange du code d'autorisation : jetons + athlète. */
export function exchangeCode(code: string) {
  return tokenRequest({ code, grant_type: 'authorization_code' });
}

/** Jeton d'accès valide, renouvelé et enregistré s'il expire bientôt. */
export async function freshAccessToken(db: SupabaseClient, row: Integration): Promise<string> {
  const expiresAt = Date.parse(row.expires_at) / 1000;
  if (expiresAt - Date.now() / 1000 > REFRESH_MARGIN_S) return row.access_token;
  let t;
  try {
    t = await tokenRequest({ refresh_token: row.refresh_token, grant_type: 'refresh_token' });
  } catch (e) {
    // Renouvellement concurrent (envoi auto + bouton) : l'autre appel a
    // déjà remplacé le refresh token, on reprend le sien.
    const current = await currentRow(db, row.user_id);
    if (e instanceof StravaUnauthorized && current && current.refresh_token !== row.refresh_token) {
      return current.access_token;
    }
    throw e;
  }
  // Écriture conditionnelle : seulement si personne n'a renouvelé entre-temps.
  const { data, error } = await db
    .from('user_integrations')
    .update({
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_at: new Date(t.expires_at * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', row.user_id)
    .eq('provider', 'strava')
    .eq('refresh_token', row.refresh_token)
    .select('user_id');
  if (error) throw new Error(`Enregistrement du jeton renouvelé : ${error.message}`);
  if (data.length === 0) {
    const current = await currentRow(db, row.user_id);
    if (current) return current.access_token;
  }
  return t.access_token;
}

async function currentRow(db: SupabaseClient, userId: string): Promise<Integration | null> {
  const { data } = await db
    .from('user_integrations')
    .select('user_id, access_token, refresh_token, expires_at')
    .eq('user_id', userId)
    .eq('provider', 'strava')
    .maybeSingle<Integration>();
  return data;
}

/** Supprime la connexion, sauf si ses jetons ont changé depuis [row]
 * (renouvelée ou reconnectée par un autre appel). */
export async function dropIntegration(db: SupabaseClient, row: Integration): Promise<void> {
  await db
    .from('user_integrations')
    .delete()
    .eq('user_id', row.user_id)
    .eq('provider', 'strava')
    .eq('refresh_token', row.refresh_token);
}

/** Permissions accordées, réduites aux valeurs connues. */
export function knownScopes(raw: string | null): string[] {
  return (raw ?? '').split(',').filter((s) => KNOWN_SCOPES.includes(s));
}

export function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Valeur du cookie [name] ; `null` s'il manque ou apparaît plusieurs
 * fois (cookie planté à côté du vrai). */
export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('Cookie') ?? '';
  const values = header
    .split(';')
    .map((part) => part.trim().split('='))
    .filter(([k]) => k === name)
    .map(([, ...v]) => v.join('='));
  return values.length === 1 ? values[0] : null;
}

/** E-mail masqué (« o•••@g•••.com ») pour montrer à quel compte AeroX un
 * Strava vient d'être rattaché, sans l'exposer. */
export function maskEmail(email: string | null | undefined): string {
  if (!email || !email.includes('@')) return '';
  const [local, domain] = email.split('@');
  const dot = domain.lastIndexOf('.');
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${local[0] ?? ''}•••@${host[0] ?? ''}•••${tld}`;
}

/** Appel API Strava authentifié ; 401 et 429 levés en erreurs typées. */
export async function stravaFetch(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${STRAVA_API}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new StravaUnauthorized(path);
  if (res.status === 429) throw new StravaRateLimited(path);
  return res;
}

/** Identifiant numérique Strava (upload, activité) avant de l'insérer
 * dans un chemin d'URL. */
export function isStravaId(id: unknown): id is string {
  return typeof id === 'string' && /^\d{1,20}$/.test(id);
}

export function deauthorize(token: string): Promise<Response> {
  return fetch(`${STRAVA_OAUTH}/deauthorize`, {
    method: 'POST',
    body: new URLSearchParams({ access_token: token }),
  });
}

/** Activité existante citée par l'erreur de doublon de Strava
 * (« … duplicate of <a href='/activities/123'>… »). Format non garanti. */
export function duplicateActivityId(error: string | null | undefined): string | null {
  if (!error || !/duplicate/i.test(error)) return null;
  return error.match(/activities\/(\d+)/)?.[1] ?? null;
}
