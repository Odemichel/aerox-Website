-- Durcissements de l'audit sécurité Flutter 2026-10-25.

-- 1. comments : `comments_select USING (true)` exposait `phone_number` de
--    chaque commentaire à tout compte connecté. Seul l'insert (avec
--    `.select().single()` sur sa propre ligne) est fait par les apps :
--    lecture limitée à l'auteur et à l'admin.
DROP POLICY IF EXISTS comments_select ON public.comments;
CREATE POLICY comments_select ON public.comments
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) OR public.is_admin());

-- 2. challenge_sessions : `INSERT WITH CHECK (true)` laissait n'importe quel
--    compte publier un challenge visible par tous. Réservé à l'admin
--    (éditeur de workouts, bibliothèque « ChallengesLibrary »).
DROP POLICY IF EXISTS "Enable insert for authenticated users only" ON public.challenge_sessions;
CREATE POLICY challenge_sessions_insert_admin ON public.challenge_sessions
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

-- 3. Vues de classement : tous les droits étaient accordés à anon et
--    authenticated. Lecture seule. Elles restent SECURITY DEFINER (pas de
--    security_invoker) : le classement public (événements, mycompanion)
--    affiche prénom / nom alors que `competition_users` n'est lisible que
--    par l'admin — c'est voulu.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.competition_leaderboard_aero, public.competition_leaderboard_perf
  FROM anon, authenticated;

-- 4. search_path figé (advisor function_search_path_mutable). get_my_role
--    qualifie déjà `public.users` ; les autres gardent `public` pour ne pas
--    casser une référence non qualifiée.
ALTER FUNCTION public.get_my_role() SET search_path = '';
ALTER FUNCTION public.notify_admin_pending_bf() SET search_path = public;
ALTER FUNCTION public.notify_client_post_fitting() SET search_path = public;
ALTER FUNCTION public.set_updated_at() SET search_path = public;
ALTER FUNCTION public.expire_stale_diagnostic_basic() SET search_path = public;
