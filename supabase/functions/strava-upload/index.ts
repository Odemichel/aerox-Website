// supabase/functions/strava-upload/index.ts
//
// Envoi d'une séance d'entraînement sur Strava (feat-strava-sync).
//
// Corps : { session_id, fit_base64?, name, description }. La séance doit
// appartenir à l'appelant. Un envoi abouti n'est jamais refait ; un envoi
// en traitement est relu (sans fichier) ; une séance n'est envoyée que
// MAX_ATTEMPTS fois et un utilisateur ne lance que MAX_UPLOADS_PER_HOUR
// envois par heure (le quota d'appels Strava est commun à toute l'app).
// Doublon (Zwift, montre) : la description AeroX est ajoutée à la fin de
// celle de l'activité existante, jamais à sa place.
//
// Réponse : { status: 'created' | 'duplicate_updated' | 'processing' |
//             'error' | 'not_connected', activity_id?, error? }
//
//   supabase functions deploy strava-upload
import { decodeBase64 } from 'jsr:@std/encoding@1/base64';
import {
  adminClient,
  callerId,
  dropIntegration,
  duplicateActivityId,
  freshAccessToken,
  isStravaId,
  json,
  STRAVA_API,
  stravaFetch,
  StravaRateLimited,
  StravaUnauthorized,
  type Integration,
} from '../_shared/strava.ts';

const MAX_FIT_BYTES = 5 * 1024 * 1024;
const MAX_FIT_BASE64 = Math.ceil(MAX_FIT_BYTES / 3) * 4 + 4;
const MAX_DESCRIPTION = 2000;
const MAX_NAME = 200;
const MAX_ATTEMPTS = 3;
const MAX_UPLOADS_PER_HOUR = 20;
const STALE_CLAIM_MS = 2 * 60 * 1000;
/** Relectures de l'envoi : ~20 s au total, de plus en plus espacées. */
const POLL_DELAYS_MS = [1000, 1000, 1500, 1500, 2000, 2000, 3000, 3000, 5000];

type Status = 'created' | 'duplicate_updated' | 'processing' | 'error';

interface Upload {
  id_str?: string;
  error?: string | null;
  activity_id?: number | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Texte sans caractères de contrôle (sauf retours à la ligne). */
function cleanText(v: unknown, max: number): string | null {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex -- caractères de contrôle retirés volontairement
  return v.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '').slice(0, max);
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const db = adminClient();
  const userId = await callerId(req, db);
  if (!userId) return json({ error: 'unauthorized' }, 401);

  const length = Number(req.headers.get('Content-Length') ?? '0');
  if (length > MAX_FIT_BASE64 + 16 * 1024) return json({ error: 'bad_file' }, 413);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  const sessionId = body.session_id;
  const name = cleanText(body.name, MAX_NAME);
  const description = cleanText(body.description, MAX_DESCRIPTION);
  const fitB64 = body.fit_base64;
  if (typeof sessionId !== 'string' || !UUID.test(sessionId) || name === null || description === null) {
    return json({ error: 'bad_request' }, 400);
  }
  if (fitB64 !== undefined && (typeof fitB64 !== 'string' || fitB64.length > MAX_FIT_BASE64)) {
    return json({ error: 'bad_file' }, 400);
  }

  // Séance d'entraînement de l'appelant seulement.
  const { data: session } = await db
    .from('sessions')
    .select('id')
    .eq('id', sessionId)
    .eq('user_id', userId)
    .eq('session_type', 'training')
    .maybeSingle();
  if (!session) return json({ error: 'session_not_found' }, 404);

  const { data: integration } = await db
    .from('user_integrations')
    .select('user_id, access_token, refresh_token, expires_at')
    .eq('user_id', userId)
    .eq('provider', 'strava')
    .maybeSingle<Integration>();
  if (!integration) return json({ status: 'not_connected' });

  const { data: previous } = await db
    .from('session_exports')
    .select('status, upload_id, activity_id, attempts, updated_at')
    .eq('session_id', sessionId)
    .eq('provider', 'strava')
    .maybeSingle();
  if (previous?.status === 'created' || previous?.status === 'duplicate_updated') {
    return json({ status: previous.status, activity_id: previous.activity_id });
  }

  // Tentative réservée par cet appel : rendue si l'échec survient avant
  // l'envoi du fichier (quota Strava, erreur passagère).
  let claimedAttempts: number | null = null;

  const record = async (
    status: Status,
    fields: { upload_id?: string | null; activity_id?: string | null; error?: string | null }
  ) => {
    const refund = status === 'error' && !fields.upload_id && claimedAttempts !== null;
    const { error } = await db
      .from('session_exports')
      .update({
        status,
        upload_id: fields.upload_id ?? null,
        activity_id: fields.activity_id ?? null,
        error: fields.error ?? null,
        updated_at: new Date().toISOString(),
        ...(refund ? { attempts: Math.max(0, (claimedAttempts as number) - 1) } : {}),
      })
      .eq('session_id', sessionId)
      .eq('provider', 'strava');
    if (error) console.error('session_exports update', error.message);
    return json({ status, activity_id: fields.activity_id ?? undefined, error: fields.error ?? undefined });
  };

  // Envoi encore en traitement : relu, sans nouveau fichier.
  let uploadId: string | null =
    previous?.status === 'processing' && isStravaId(previous.upload_id) ? previous.upload_id : null;

  if (!uploadId) {
    if (typeof fitB64 !== 'string' || fitB64.length === 0) return json({ error: 'missing_file' }, 400);
    if ((previous?.attempts ?? 0) >= MAX_ATTEMPTS) {
      return json({ status: 'error', error: 'too_many_attempts' });
    }
    const { count } = await db
      .from('session_exports')
      .select('session_id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gt('updated_at', new Date(Date.now() - 3600 * 1000).toISOString());
    if ((count ?? 0) >= MAX_UPLOADS_PER_HOUR) return json({ status: 'error', error: 'rate_limited' });

    // Réservation atomique de l'envoi : deux appels simultanés pour la même
    // séance n'envoient qu'un fichier.
    const claim = previous
      ? await db
          .from('session_exports')
          .update({
            status: 'processing',
            upload_id: null,
            error: null,
            attempts: previous.attempts + 1,
            updated_at: new Date().toISOString(),
          })
          .eq('session_id', sessionId)
          .eq('provider', 'strava')
          .eq('attempts', previous.attempts)
          // Échec, ou envoi resté sans upload (appel interrompu) depuis 2 min.
          .or(`status.eq.error,updated_at.lt."${new Date(Date.now() - STALE_CLAIM_MS).toISOString()}"`)
          .select('session_id')
      : await db
          .from('session_exports')
          .insert({ session_id: sessionId, provider: 'strava', user_id: userId, status: 'processing', attempts: 1 })
          .select('session_id');
    // Déjà réservée par un autre appel (0 ligne, ou clé en double à
    // l'insertion) : envoi en cours. Toute autre erreur est signalée.
    if (claim.error && claim.error.code !== '23505') {
      console.error('session_exports claim', claim.error.message);
      return json({ status: 'error', error: 'internal' });
    }
    if (!claim.data?.length) return json({ status: 'processing' });
    claimedAttempts = (previous?.attempts ?? 0) + 1;
  }

  try {
    const token = await freshAccessToken(db, integration);

    if (!uploadId) {
      let fit: Uint8Array;
      try {
        fit = decodeBase64(fitB64 as string);
      } catch {
        return await record('error', { error: 'bad_file' });
      }
      if (fit.length === 0 || fit.length > MAX_FIT_BYTES) return await record('error', { error: 'bad_file' });

      const form = new FormData();
      form.append('file', new Blob([fit], { type: 'application/octet-stream' }), `aerox-${sessionId}.fit`);
      form.append('data_type', 'fit');
      form.append('name', name || 'AeroX');
      form.append('description', description);
      form.append('trainer', '1');
      form.append('external_id', `aerox-${sessionId}`);
      const res = await stravaFetch(token, '/uploads', { method: 'POST', body: form });
      const up: Upload = await res.json().catch(() => ({}));
      if (!res.ok || !isStravaId(up.id_str)) {
        return await record('error', { error: up.error ?? `upload HTTP ${res.status}` });
      }
      uploadId = up.id_str;
    }

    try {
      for (const delay of POLL_DELAYS_MS) {
        await sleep(delay);
        const res = await stravaFetch(token, `/uploads/${uploadId}`);
        const up: Upload = await res.json().catch(() => ({}));
        if (up.activity_id) {
          return await record('created', { upload_id: uploadId, activity_id: String(up.activity_id) });
        }
        if (up.error) {
          const existing = duplicateActivityId(up.error);
          if (!existing) return await record('error', { upload_id: uploadId, error: up.error });
          return await appendToExisting(token, existing, description, uploadId, record);
        }
      }
    } catch (e) {
      // Fichier déjà envoyé : on garde l'upload pour le relire plus tard,
      // sans renvoyer le fichier.
      if (!(e instanceof StravaUnauthorized)) {
        console.warn('strava upload poll', (e as Error).message);
        return await record('processing', { upload_id: uploadId });
      }
      throw e;
    }
    return await record('processing', { upload_id: uploadId });
  } catch (e) {
    if (e instanceof StravaUnauthorized) {
      // Autorisation retirée côté Strava : connexion supprimée (sauf si
      // renouvelée entre-temps par un autre appel).
      await dropIntegration(db, integration);
      return await record('error', { upload_id: uploadId, error: 'unauthorized' });
    }
    if (e instanceof StravaRateLimited) {
      return await record(uploadId ? 'processing' : 'error', { upload_id: uploadId, error: 'rate_limited' });
    }
    console.error('strava upload', (e as Error).message);
    return await record(uploadId ? 'processing' : 'error', { upload_id: uploadId, error: 'internal' });
  }
});

/** Doublon : ajoute la description AeroX à la fin de celle de l'activité
 * existante (jamais de remplacement, rien si elle y est déjà). */
async function appendToExisting(
  token: string,
  activityId: string,
  description: string,
  uploadId: string,
  record: (
    s: Status,
    f: { upload_id?: string | null; activity_id?: string | null; error?: string | null }
  ) => Promise<Response>
): Promise<Response> {
  if (!description) return record('duplicate_updated', { upload_id: uploadId, activity_id: activityId });
  // Appels directs (pas stravaFetch) : un refus ici (activité privée sans
  // `activity:read_all`) ne doit pas supprimer une connexion valide.
  const auth = { Authorization: `Bearer ${token}` };
  const get = await fetch(`${STRAVA_API}/activities/${activityId}`, { headers: auth });
  if (!get.ok) {
    console.warn('strava duplicate GET HTTP', get.status);
    return record('duplicate_updated', { upload_id: uploadId, activity_id: activityId, error: 'not_appended' });
  }
  const current = ((await get.json()).description as string | null) ?? '';
  if (current.includes(description)) {
    return record('duplicate_updated', { upload_id: uploadId, activity_id: activityId });
  }
  const merged = current.trim() ? `${current.trimEnd()}\n\n${description}` : description;
  const put = await fetch(`${STRAVA_API}/activities/${activityId}`, {
    method: 'PUT',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ description: merged }),
  });
  return put.ok
    ? record('duplicate_updated', { upload_id: uploadId, activity_id: activityId })
    : record('error', { upload_id: uploadId, activity_id: activityId, error: `duplicate, PUT HTTP ${put.status}` });
}
