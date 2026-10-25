-- bf_find_user_by_email : la garde de rôle laissait passer les appels anonymes.
-- Sans session, get_my_role() renvoie NULL, `NULL NOT IN (...)` vaut NULL et
-- l'exception n'était jamais levée : avec la clé anon, n'importe qui obtenait
-- id, prénom, nom, e-mail, rôle et téléphone d'un compte à partir de son e-mail.
-- (audit sécurité Flutter 2026-10-25)

CREATE OR REPLACE FUNCTION public.bf_find_user_by_email(_email text)
 RETURNS TABLE(id uuid, firstname text, name text, email text, role text, phonenumber text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF coalesce(get_my_role(), '') NOT IN ('bike-fitter', 'admin') THEN
    RAISE EXCEPTION 'permission denied';
  END IF;

  RETURN QUERY
  SELECT u.id, u.firstname, u.name, u.email, u.role, u.phonenumber
  FROM public.users u
  WHERE u.email = _email
  LIMIT 1;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.bf_find_user_by_email(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bf_find_user_by_email(text) TO authenticated;
