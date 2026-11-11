// supabase/functions/cleanup-session-clips/index.ts
//
// Purge des clips vidéo de séance (`feat-session-clips`) de plus de 7 jours :
// fichiers du bucket `session-clips` (lignes ou orphelins d'un envoi
// interrompu) par l'API Storage, puis lignes `session_clips`.
//
// Supabase interdit de supprimer des fichiers en SQL
// (`storage.protect_delete`) : la liste vient de
// `public.session_clips_expired()` (lecture SQL, service role seulement).
//
// Appelée chaque nuit par `request_session_clips_cleanup()` (pg_cron).
// pg_net n'envoie pas de JWT : déployée avec `--no-verify-jwt`, authentifiée
// par l'en-tête `x-hook-secret` comparé à `BF_NOTIFY_SECRET`.
//
//   supabase functions deploy cleanup-session-clips --no-verify-jwt
import { createClient } from 'npm:@supabase/supabase-js@2';

const BUCKET = 'session-clips';
// L'API Storage accepte au plus 1000 chemins par suppression.
const BATCH = 1000;

// Comparaison à temps constant (voir notify-admin-lead).
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  const expected = Deno.env.get('BF_NOTIFY_SECRET');
  const given = req.headers.get('x-hook-secret') ?? '';
  if (!expected || !timingSafeEqual(given, expected)) {
    return new Response('unauthorized', { status: 401 });
  }

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const { data, error } = await db.rpc('session_clips_expired');
  if (error) {
    console.error('session_clips_expired', error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  const paths = (data ?? []) as string[];
  let deleted = 0;
  for (let i = 0; i < paths.length; i += BATCH) {
    const { data: removed, error: removeError } = await db.storage.from(BUCKET).remove(paths.slice(i, i + BATCH));
    if (removeError) {
      console.error('storage.remove', removeError);
      return new Response(JSON.stringify({ deleted, error: removeError.message }), { status: 500 });
    }
    deleted += removed?.length ?? 0;
  }

  // Lignes de plus de 7 jours (leurs fichiers viennent d'être supprimés).
  const { error: rowsError, count } = await db
    .from('session_clips')
    .delete({ count: 'exact' })
    .lt('created_at', new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString());
  if (rowsError) {
    console.error('session_clips delete', rowsError);
    return new Response(JSON.stringify({ deleted, error: rowsError.message }), { status: 500 });
  }
  console.log(`cleanup-session-clips: ${deleted} fichier(s), ${count ?? 0} ligne(s) supprimé(s)`);
  return new Response(JSON.stringify({ deleted }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
