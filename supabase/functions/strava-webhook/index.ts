// supabase/functions/strava-webhook/index.ts
//
// Webhook Strava (feat-strava-sync, developers.strava.com/docs/webhooks) :
// appelé par Strava, pas de JWT.
//
// - GET : validation de l'abonnement (hub.challenge renvoyé si le
//   verify_token est le nôtre).
// - POST : événements. Réponse 200 immédiate (Strava exige < 2 s, sinon
//   3 tentatives), traitement en arrière-plan :
//   * athlète, `authorized: "false"` : l'athlète a retiré l'accès depuis
//     Strava → connexion supprimée (jetons, identifiant, nom de l'athlète)
//     et envois de séances purgés ;
//   * activité supprimée sur Strava → l'envoi de la séance correspondante
//     est effacé (la séance redevient envoyable).
//
// Strava ne signe pas ses événements : seul l'identifiant d'abonnement est
// contrôlé à la réception, et chaque événement est vérifié auprès de Strava
// avec les jetons de l'athlète avant d'effacer quoi que ce soit (401 =
// accès bien retiré, 404 = activité bien supprimée). Un faux événement ne
// supprime donc rien.
//
//   supabase secrets set STRAVA_WEBHOOK_VERIFY_TOKEN=<aléatoire>
//   supabase functions deploy strava-webhook --no-verify-jwt
//   (abonnement créé, puis) supabase secrets set STRAVA_WEBHOOK_SUBSCRIPTION_ID=<id>
import {
  adminClient,
  dropIntegration,
  freshAccessToken,
  isStravaId,
  json,
  stravaFetch,
  StravaUnauthorized,
  type Integration,
} from '../_shared/strava.ts';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

interface StravaEvent {
  object_type?: string;
  object_id?: number;
  aspect_type?: string;
  owner_id?: number;
  subscription_id?: number;
  updates?: Record<string, string>;
}

Deno.serve(async (req) => {
  if (req.method === 'GET') return validate(new URL(req.url));
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  let event: StravaEvent;
  try {
    event = await req.json();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  const subscription = Deno.env.get('STRAVA_WEBHOOK_SUBSCRIPTION_ID');
  if (!subscription || String(event.subscription_id) !== subscription) {
    return json({ error: 'forbidden' }, 403);
  }
  EdgeRuntime.waitUntil(handle(event).catch((e) => console.error('strava webhook', (e as Error).message)));
  return json({ received: true });
});

/** Validation de l'abonnement : écho de hub.challenge en JSON. */
async function validate(url: URL): Promise<Response> {
  const expected = Deno.env.get('STRAVA_WEBHOOK_VERIFY_TOKEN');
  const token = url.searchParams.get('hub.verify_token') ?? '';
  const challenge = url.searchParams.get('hub.challenge');
  if (
    !expected ||
    url.searchParams.get('hub.mode') !== 'subscribe' ||
    !challenge ||
    !(await sameSecret(token, expected))
  ) {
    return json({ error: 'forbidden' }, 403);
  }
  return json({ 'hub.challenge': challenge });
}

/** Comparaison à temps constant (empreintes de même longueur). */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const digest = async (v: string) =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)));
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function handle(event: StravaEvent): Promise<void> {
  const owner = String(event.owner_id ?? '');
  if (!isStravaId(owner)) return;
  const db = adminClient();
  const integration = await integrationOf(db, owner);
  if (!integration) return;

  if (event.object_type === 'athlete' && event.updates?.authorized === 'false') {
    await onDeauthorized(db, integration);
  } else if (event.object_type === 'activity' && event.aspect_type === 'delete') {
    const activity = String(event.object_id ?? '');
    if (isStravaId(activity)) await onActivityDeleted(db, integration, activity);
  }
}

async function integrationOf(db: SupabaseClient, athleteId: string): Promise<Integration | null> {
  const { data, error } = await db
    .from('user_integrations')
    .select('user_id, access_token, refresh_token, expires_at')
    .eq('provider', 'strava')
    .eq('provider_athlete_id', athleteId)
    .maybeSingle<Integration>();
  if (error) throw new Error(`Connexion de l'athlète : ${error.message}`);
  return data;
}

/** Accès retiré depuis Strava : purge confirmée par un refus de Strava. */
async function onDeauthorized(db: SupabaseClient, integration: Integration): Promise<void> {
  try {
    const res = await stravaFetch(await freshAccessToken(db, integration), '/athlete');
    await res.body?.cancel();
    // Jetons toujours acceptés : l'événement ne vient pas de Strava.
    console.warn('strava webhook : désautorisation non confirmée', res.status);
  } catch (e) {
    if (!(e instanceof StravaUnauthorized)) throw e;
    await dropIntegration(db, integration);
    console.info('strava webhook : connexion et envois purgés');
  }
}

/** Activité supprimée sur Strava, confirmée par un 404. */
async function onActivityDeleted(db: SupabaseClient, integration: Integration, activityId: string): Promise<void> {
  let res: Response;
  try {
    res = await stravaFetch(await freshAccessToken(db, integration), `/activities/${activityId}`);
  } catch (e) {
    // Accès retiré entre-temps : l'événement de désautorisation purge tout.
    if (e instanceof StravaUnauthorized) return;
    throw e;
  }
  await res.body?.cancel();
  if (res.status !== 404) {
    console.warn("strava webhook : suppression d'activité non confirmée", res.status);
    return;
  }
  const { error } = await db
    .from('session_exports')
    .delete()
    .eq('user_id', integration.user_id)
    .eq('provider', 'strava')
    .eq('activity_id', activityId);
  if (error) throw new Error(`Envoi de l'activité supprimée : ${error.message}`);
}
