// supabase/functions/cleanup-position-masks/index.ts
//
// Purge des masques live du bucket `position-masks` de plus de 24 h
// (séances interrompues : l'app desktop supprime elle-même ceux d'une
// séance terminée normalement).
//
// Supabase interdit désormais de supprimer des fichiers en SQL
// (`storage.protect_delete`) : l'ancienne purge pg_cron échouait chaque nuit.
// La liste vient de `public.position_masks_expired()` (lecture SQL), la
// suppression passe par l'API Storage.
//
// Appelée chaque nuit par `request_position_masks_cleanup()` (pg_cron).
// pg_net n'envoie pas de JWT : déployée avec `--no-verify-jwt`, authentifiée
// par l'en-tête `x-hook-secret` comparé à `BF_NOTIFY_SECRET` (secret partagé
// des appels pg_net du projet).
//
//   supabase functions deploy cleanup-position-masks --no-verify-jwt
import { createClient } from 'npm:@supabase/supabase-js@2';

const BUCKET = 'position-masks';
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

  const db = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data, error } = await db.rpc('position_masks_expired');
  if (error) {
    console.error('position_masks_expired', error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  const paths = (data ?? []) as string[];
  let deleted = 0;
  for (let i = 0; i < paths.length; i += BATCH) {
    const { data: removed, error: removeError } = await db.storage
      .from(BUCKET)
      .remove(paths.slice(i, i + BATCH));
    if (removeError) {
      console.error('storage.remove', removeError);
      return new Response(
        JSON.stringify({ deleted, error: removeError.message }),
        { status: 500 },
      );
    }
    deleted += removed?.length ?? 0;
  }

  console.log(`cleanup-position-masks: ${deleted} fichier(s) supprimé(s)`);
  return new Response(JSON.stringify({ deleted }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
