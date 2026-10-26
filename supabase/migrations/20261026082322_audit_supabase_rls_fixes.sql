-- Audit Supabase 2026-10-26 : correctifs compatibles avec les apps diffusées.

-- 1. Fuite : un bike fitter (rôle en libre-service à l'inscription) lisait la
--    ligne `users` complète (téléphone, santé, date de naissance) de tout
--    compte posé en `bf_clients.linked_user_id`, colonne libre. Aucune app ne
--    lit la fiche d'un client lié : branche retirée.
DROP POLICY IF EXISTS users_select ON public.users;
CREATE POLICY users_select ON public.users
  FOR SELECT TO authenticated
  USING (id = (SELECT auth.uid()) OR public.is_admin());

-- 2. `bf_find_user_by_email` ne renvoie plus téléphone ni rôle (oracle
--    e-mail → téléphone). Le desktop ne s'en sert que pour lier et préremplir
--    le nom.
DROP FUNCTION IF EXISTS public.bf_find_user_by_email(text);
CREATE FUNCTION public.bf_find_user_by_email(_email text)
 RETURNS TABLE(id uuid, firstname text, name text, email text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF coalesce(public.get_my_role(), '') NOT IN ('bike-fitter', 'admin') THEN
    RAISE EXCEPTION 'permission denied';
  END IF;

  RETURN QUERY
  SELECT u.id, u.firstname, u.name, u.email
  FROM public.users u
  WHERE u.email = _email
  LIMIT 1;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bf_find_user_by_email(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bf_find_user_by_email(text) TO authenticated;

-- 3. Bug : `comfort_zone` (ajoutée le 2026-10-17) sans droit UPDATE → la
--    clôture d'un diagnostic Basic échouait toujours (0 `completed`).
GRANT UPDATE (comfort_zone) ON public.diagnostic_basic TO authenticated;

-- 4. Écriture chez autrui :
--    * sessions.client_id pointait vers le client d'un autre bike fitter
--      (e-mail post-fitting envoyé à n'importe quelle adresse) ;
--    * une position pouvait être ajoutée à la séance d'un autre (visible
--      dans le rapport de sa séance, entraînement compris).
DROP POLICY IF EXISTS own_sessions ON public.sessions;
CREATE POLICY own_sessions ON public.sessions
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND (client_id IS NULL OR EXISTS (
      SELECT 1 FROM public.bf_clients c
      WHERE c.id = client_id AND c.bf_user_id = (SELECT auth.uid())
    ))
  );

DROP POLICY IF EXISTS own_positions ON public.session_positions;
CREATE POLICY own_positions ON public.session_positions
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = session_id AND s.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS insert_own_positions ON public.session_positions;
CREATE POLICY insert_own_positions ON public.session_positions
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = session_id AND s.user_id = (SELECT auth.uid())
    )
  );

-- 5. `users` publiée en Realtime sans aucun abonné : surface de fuite inutile.
ALTER PUBLICATION supabase_realtime DROP TABLE public.users;
