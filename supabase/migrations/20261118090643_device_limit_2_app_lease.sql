-- Ordinateurs par compte : limite passée de 3 à 2, et un seul ordinateur
-- à la fois (lancements simultanés refusés).
--
-- * `register_device` (connexion) et la garde `users_guard_client_columns`
--   passent à 2. Aucun compte non admin n'a plus d'un appareil enregistré
--   au 2026-11-18 : personne n'est bloqué.
-- * `claim_app_lease` est appelée par l'app desktop au lancement puis toutes
--   les 30 s : elle enregistre l'appareil s'il manque (dans la limite — ce qui
--   referme aussi la session ouverte par le code de mot de passe oublié sans
--   enregistrement) et prend le jeton du compte. Jeton tenu par un autre
--   ordinateur avec un signal de moins de 2 min → 'busy', l'app refuse.
-- * `release_app_lease` libère le jeton à la fermeture / déconnexion ; sans
--   elle (plantage, veille), il expire après 2 min.
-- * Admin : ni limite ni jeton (postes de dev et de test en parallèle).

CREATE TABLE IF NOT EXISTS public.app_leases (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  heartbeat_at timestamptz NOT NULL DEFAULT now()
);

-- Accès par les fonctions SECURITY DEFINER seulement.
ALTER TABLE public.app_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_leases FROM PUBLIC, anon, authenticated;

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

  IF jsonb_array_length(_devices) >= 2 AND NOT public.is_admin() THEN
    RETURN 'limit_reached';
  END IF;

  UPDATE public.users
     SET device_ids = _devices || to_jsonb(_device_id)
   WHERE id = _uid;
  RETURN 'ok';
END;
$function$;

CREATE OR REPLACE FUNCTION public.claim_app_lease(_device_id text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _registered text;
  _holder text;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'permission denied';
  END IF;

  IF public.is_admin() THEN
    RETURN 'ok';
  END IF;

  -- Verrouille la ligne users : deux lancements concurrents sont sérialisés.
  _registered := public.register_device(_device_id);
  IF _registered = 'limit_reached' THEN
    RETURN 'limit_reached';
  END IF;

  INSERT INTO public.app_leases AS l (user_id, device_id, heartbeat_at)
  VALUES (_uid, _device_id, now())
  ON CONFLICT (user_id) DO UPDATE
     SET device_id = excluded.device_id,
         heartbeat_at = excluded.heartbeat_at
   WHERE l.device_id = excluded.device_id
      OR l.heartbeat_at < now() - interval '2 minutes'
  RETURNING l.device_id INTO _holder;

  IF _holder IS NULL THEN
    RETURN 'busy';
  END IF;
  RETURN 'ok';
END;
$function$;

CREATE OR REPLACE FUNCTION public.release_app_lease(_device_id text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  DELETE FROM public.app_leases
   WHERE user_id = auth.uid() AND device_id = _device_id;
$function$;

REVOKE EXECUTE ON FUNCTION public.claim_app_lease(text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.release_app_lease(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_app_lease(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_app_lease(text) TO authenticated;

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

  IF TG_OP = 'INSERT' THEN
    NEW.licencetype := NULL;
    IF jsonb_array_length(coalesce(NEW.device_ids, '[]'::jsonb)) > 2 THEN
      RAISE EXCEPTION 'device_ids: limit exceeded' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.licencetype IS DISTINCT FROM OLD.licencetype THEN
    RAISE EXCEPTION 'licencetype is not client-writable'
      USING ERRCODE = '42501';
  END IF;

  IF coalesce(OLD.onboarding_completed, false) AND NOT coalesce(NEW.onboarding_completed, false) THEN
    RAISE EXCEPTION 'onboarding_completed cannot be reset' USING ERRCODE = '42501';
  END IF;

  IF NEW.device_ids IS DISTINCT FROM OLD.device_ids AND NOT (
       coalesce(NEW.device_ids, '[]'::jsonb) @> coalesce(OLD.device_ids, '[]'::jsonb)
       AND jsonb_array_length(coalesce(NEW.device_ids, '[]'::jsonb)) <= 2
     ) THEN
    RAISE EXCEPTION 'device_ids: only adding a device within the limit is allowed'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;
