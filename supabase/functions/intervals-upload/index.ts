// supabase/functions/intervals-upload/index.ts
//
// Envoi d'une séance d'entraînement sur Intervals.icu (feat-intervals-sync).
//
// Corps : { session_id, fit_base64, name, description, paired_event_id? }.
// La séance doit appartenir à l'appelant. Un envoi abouti n'est jamais
// refait ; une séance n'est envoyée que MAX_ATTEMPTS fois et un utilisateur
// ne lance que MAX_UPLOADS_PER_HOUR envois par heure (quota Intervals : 100
// appels par athlète et par jour). `paired_event_id` relie l'activité à la
// séance planifiée d'où elle a été lancée.
//
// Réponse : { status: 'created' | 'processing' | 'error' | 'not_connected',
//             activity_id?, error? }
//
//   supabase functions deploy intervals-upload
import { decodeBase64 } from 'jsr:@std/encoding@1/base64';
import { adminClient, callerId, json } from '../_shared/strava.ts';
import {
  dropIntegration,
  grantedScopes,
  hasScope,
  intervalsFetch,
  IntervalsRateLimited,
  IntervalsUnauthorized,
  isIntervalsId,
  loadIntegration,
} from '../_shared/intervals.ts';

const MAX_FIT_BYTES = 5 * 1024 * 1024;
const MAX_FIT_BASE64 = Math.ceil(MAX_FIT_BYTES / 3) * 4 + 4;
const MAX_DESCRIPTION = 2000;
const MAX_NAME = 200;
const MAX_ATTEMPTS = 3;
const MAX_UPLOADS_PER_HOUR = 20;
const STALE_CLAIM_MS = 2 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Status = 'created' | 'error';

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
  const pairedEventId = body.paired_event_id;
  if (typeof sessionId !== 'string' || !UUID.test(sessionId) || name === null || description === null) {
    return json({ error: 'bad_request' }, 400);
  }
  if (typeof fitB64 !== 'string' || fitB64.length === 0 || fitB64.length > MAX_FIT_BASE64) {
    return json({ error: 'bad_file' }, 400);
  }
  if (pairedEventId !== undefined && pairedEventId !== null && !isIntervalsId(String(pairedEventId))) {
    return json({ error: 'bad_request' }, 400);
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

  const integration = await loadIntegration(db, userId);
  if (!integration || !hasScope(grantedScopes(integration.scope), 'ACTIVITY:WRITE')) {
    return json({ status: 'not_connected' });
  }

  const { data: previous } = await db
    .from('session_exports')
    .select('status, activity_id, attempts')
    .eq('session_id', sessionId)
    .eq('provider', 'intervals')
    .maybeSingle();
  if (previous?.status === 'created') {
    return json({ status: 'created', activity_id: previous.activity_id });
  }
  if ((previous?.attempts ?? 0) >= MAX_ATTEMPTS) return json({ status: 'error', error: 'too_many_attempts' });
  const { count } = await db
    .from('session_exports')
    .select('session_id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gt('updated_at', new Date(Date.now() - 3600 * 1000).toISOString());
  if ((count ?? 0) >= MAX_UPLOADS_PER_HOUR) return json({ status: 'error', error: 'rate_limited' });

  // Réservation atomique : deux appels simultanés (envoi auto + bouton)
  // n'envoient qu'un fichier.
  const claim = previous
    ? await db
        .from('session_exports')
        .update({
          status: 'processing',
          error: null,
          attempts: previous.attempts + 1,
          updated_at: new Date().toISOString(),
        })
        .eq('session_id', sessionId)
        .eq('provider', 'intervals')
        .eq('attempts', previous.attempts)
        .or(`status.eq.error,updated_at.lt."${new Date(Date.now() - STALE_CLAIM_MS).toISOString()}"`)
        .select('session_id')
    : await db
        .from('session_exports')
        .insert({ session_id: sessionId, provider: 'intervals', user_id: userId, status: 'processing', attempts: 1 })
        .select('session_id');
  if (claim.error && claim.error.code !== '23505') {
    console.error('session_exports claim', claim.error.message);
    return json({ status: 'error', error: 'internal' });
  }
  if (!claim.data?.length) return json({ status: 'processing' });
  const claimedAttempts = (previous?.attempts ?? 0) + 1;

  const record = async (status: Status, fields: { activity_id?: string | null; error?: string | null }) => {
    // Échec avant tout envoi réussi : la tentative est rendue.
    const refund = status === 'error' && fields.error !== 'upload_failed';
    const { error } = await db
      .from('session_exports')
      .update({
        status,
        activity_id: fields.activity_id ?? null,
        error: fields.error ?? null,
        updated_at: new Date().toISOString(),
        ...(refund ? { attempts: Math.max(0, claimedAttempts - 1) } : {}),
      })
      .eq('session_id', sessionId)
      .eq('provider', 'intervals');
    if (error) console.error('session_exports update', error.message);
    return json({ status, activity_id: fields.activity_id ?? undefined, error: fields.error ?? undefined });
  };

  let fit: Uint8Array;
  try {
    fit = decodeBase64(fitB64);
  } catch {
    return await record('error', { error: 'bad_file' });
  }
  if (fit.length === 0 || fit.length > MAX_FIT_BYTES) return await record('error', { error: 'bad_file' });

  try {
    const query = new URLSearchParams({
      name: name || 'AeroX',
      description,
      external_id: `aerox-${sessionId}`,
    });
    if (pairedEventId !== undefined && pairedEventId !== null) query.set('paired_event_id', String(pairedEventId));
    const form = new FormData();
    form.append('file', new Blob([fit], { type: 'application/octet-stream' }), `aerox-${sessionId}.fit`);
    const res = await intervalsFetch(integration.access_token, `/athlete/0/activities?${query}`, {
      method: 'POST',
      body: form,
    });
    const up = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn('intervals upload HTTP', res.status);
      return await record('error', { error: 'upload_failed' });
    }
    const activityId = up?.activities?.[0]?.id ?? up?.id;
    return await record('created', { activity_id: activityId ? String(activityId) : null });
  } catch (e) {
    if (e instanceof IntervalsUnauthorized) {
      await dropIntegration(db, integration);
      return await record('error', { error: 'unauthorized' });
    }
    if (e instanceof IntervalsRateLimited) return await record('error', { error: 'rate_limited' });
    console.error('intervals upload', (e as Error).message);
    return await record('error', { error: 'internal' });
  }
});
