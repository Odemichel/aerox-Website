-- Colonnes de `users` que l'utilisateur pouvait réécrire lui-même
-- (liste blanche UPDATE d'`authenticated`) :
--   * device_ids  → limite d'appareils contournée par un PATCH direct
--                   (`device_ids = []`) ;
--   * licencetype → gratuit/payant décidé par l'app sur une colonne ouverte ;
--   * email       → e-mail d'un tiers posé sur son compte : à l'inscription de
--                   la victime l'INSERT du trigger viole UNIQUE(email), et un
--                   bike fitter qui cherche ce tiers trouve l'attaquant.
-- (audits sécurité 2026-10-25 / 2026-10-26)
--
-- Compatible avec toutes les versions desktop diffusées : pas de REVOKE. Une
-- version antérieure à `register_device` ajoute elle-même l'appareil à
-- `device_ids` au login (liste complète réécrite) : un ajout dans la limite
-- de 3 reste autorisé, toute suppression / remise à zéro est refusée.
-- `licencetype` n'est écrit par aucune app. `email` est recalé sur
-- `auth.users` (l'onboarding desktop et mycompanion le renvoient).
-- Écritures serveur (service_role, SQL admin, triggers) et admin : libres.

CREATE OR REPLACE FUNCTION public.users_guard_client_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF coalesce(auth.role(), '') NOT IN ('authenticated', 'anon')
     OR public.is_admin() THEN
    RETURN NEW;
  END IF;

  NEW.email := (SELECT a.email FROM auth.users a WHERE a.id = NEW.id);

  IF NEW.licencetype IS DISTINCT FROM OLD.licencetype THEN
    RAISE EXCEPTION 'licencetype is not client-writable'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.device_ids IS DISTINCT FROM OLD.device_ids AND NOT (
       coalesce(NEW.device_ids, '[]'::jsonb) @> coalesce(OLD.device_ids, '[]'::jsonb)
       AND jsonb_array_length(coalesce(NEW.device_ids, '[]'::jsonb)) <= 3
     ) THEN
    RAISE EXCEPTION 'device_ids: only adding a device within the limit is allowed'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.users_guard_client_columns() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS users_guard_client_columns ON public.users;
CREATE TRIGGER users_guard_client_columns
  BEFORE UPDATE ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.users_guard_client_columns();
