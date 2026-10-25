-- Limite de 3 appareils appliquée en base. Jusqu'ici l'app desktop lisait
-- puis réécrivait `users.device_ids` elle-même : un PATCH direct
-- `{"device_ids": []}` contournait la limite (compte partagé sans limite).
-- Cette RPC est additive (sans effet sur les versions actuelles) ; le retrait
-- du droit UPDATE(device_ids) est dans 20261025193000, à appliquer une fois
-- les postes passés à la version desktop qui appelle `register_device`.
-- (audit sécurité Flutter 2026-10-25)

CREATE OR REPLACE FUNCTION public.register_device(_device_id text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _devices jsonb;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'permission denied';
  END IF;
  IF coalesce(btrim(_device_id), '') = '' THEN
    RAISE EXCEPTION 'invalid device id';
  END IF;

  SELECT coalesce(u.device_ids, '[]'::jsonb)
    INTO _devices
    FROM public.users u
   WHERE u.id = _uid
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'user not found';
  END IF;

  IF _devices ? _device_id THEN
    RETURN 'already';
  END IF;

  IF jsonb_array_length(_devices) >= 3 THEN
    RETURN 'limit_reached';
  END IF;

  UPDATE public.users
     SET device_ids = _devices || to_jsonb(_device_id)
   WHERE id = _uid;
  RETURN 'ok';
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.register_device(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_device(text) TO authenticated;
