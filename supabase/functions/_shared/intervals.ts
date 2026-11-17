// supabase/functions/_shared/intervals.ts
//
// Socle commun des fonctions Intervals.icu (feat-intervals-sync) : OAuth,
// appels API. Les utilitaires génériques (client service role, JWT,
// cookie, nonce) viennent de `strava.ts`. Les jetons ne sortent jamais des
// Edge Functions et ne sont jamais logués.
//
// Sources (vérifiées le 2026-11-17) : forum.intervals.icu/t/2759 (OAuth),
// forum.intervals.icu/t/609 (API), intervals.icu/api/v1/docs.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

const FUNCTIONS_URL = 'https://agvksgrjqskpetokudda.supabase.co/functions/v1';
export const START_URL = `${FUNCTIONS_URL}/intervals-oauth-start`;
export const CALLBACK_URL = `${FUNCTIONS_URL}/intervals-oauth-callback`;
/** Envoi des séances + lecture des séances planifiées. */
export const SCOPE = 'ACTIVITY:WRITE,CALENDAR:READ';
export const NONCE_COOKIE = '__Host-aerox_intervals_nonce';
export const AUTHORIZE_URL = 'https://intervals.icu/oauth/authorize';
const TOKEN_URL = 'https://intervals.icu/api/oauth/token';
const API = 'https://intervals.icu/api/v1';

export function clientId(): string {
  const id = Deno.env.get('INTERVALS_CLIENT_ID');
  if (!id) throw new Error('INTERVALS_CLIENT_ID manquant');
  return id;
}

function clientSecret(): string {
  const secret = Deno.env.get('INTERVALS_CLIENT_SECRET');
  if (!secret) throw new Error('INTERVALS_CLIENT_SECRET manquant');
  return secret;
}

export interface IntervalsIntegration {
  user_id: string;
  access_token: string;
  scope: string;
}

/** Erreur 401 : autorisation retirée ou jeton révoqué. */
export class IntervalsUnauthorized extends Error {}

/** Erreur 429 : quota d'appels atteint (100 par athlète et par jour). */
export class IntervalsRateLimited extends Error {}

/** Échange du code d'autorisation (dans les 2 min) : jeton, permissions
 * accordées et athlète. Pas de jeton de renouvellement chez Intervals. */
export async function exchangeCode(
  code: string
): Promise<{ access_token: string; scope: string; athlete?: { id?: string | number } }> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), code }),
  });
  if (res.status === 429) throw new IntervalsRateLimited('token');
  if (!res.ok) throw new Error(`Intervals token HTTP ${res.status}`);
  return await res.json();
}

/** Permissions accordées, en majuscules, séparées par des virgules. */
export function grantedScopes(raw: string | null | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z]+:(READ|WRITE)$/.test(s));
}

/** `WRITE` vaut aussi `READ` (doc OAuth Intervals). */
export function hasScope(granted: string[], wanted: string): boolean {
  const [area, level] = wanted.split(':');
  return granted.includes(wanted) || (level === 'READ' && granted.includes(`${area}:WRITE`));
}

/** Appel API authentifié ; 401 et 429 levés en erreurs typées. `0` dans
 * les chemins désigne l'athlète du jeton. */
export async function intervalsFetch(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new IntervalsUnauthorized(path);
  if (res.status === 429) throw new IntervalsRateLimited(path);
  return res;
}

/** Connexion Intervals de l'utilisateur, `null` sans connexion. */
export async function loadIntegration(db: SupabaseClient, userId: string): Promise<IntervalsIntegration | null> {
  const { data } = await db
    .from('user_integrations')
    .select('user_id, access_token, scope')
    .eq('user_id', userId)
    .eq('provider', 'intervals')
    .maybeSingle<IntervalsIntegration>();
  return data;
}

/** Supprime la connexion si son jeton n'a pas changé depuis [row]
 * (reconnectée entre-temps par un autre appel). */
export async function dropIntegration(db: SupabaseClient, row: IntervalsIntegration): Promise<void> {
  await db
    .from('user_integrations')
    .delete()
    .eq('user_id', row.user_id)
    .eq('provider', 'intervals')
    .eq('access_token', row.access_token);
}

/** Retire l'autorisation chez Intervals (au mieux). */
export function disconnectApp(token: string): Promise<Response> {
  return fetch(`${API}/disconnect-app`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
}

/** Identifiant Intervals (activité, événement) avant de l'insérer dans un
 * chemin d'URL : chiffres, éventuellement préfixés d'une lettre (« i123 »). */
export function isIntervalsId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z]?\d{1,20}$/i.test(id);
}
