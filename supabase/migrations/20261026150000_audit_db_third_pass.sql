-- Audit base 2026-10-26 (3e passe).

-- 1. Cron d'expiration (03:00 UTC) : passait en `expired` un diagnostic
--    pendant sa grâce de 6 h (écritures S1/S2 et clôture refusées ensuite).
--    Exécution retirée aux clients (cron seulement).
CREATE OR REPLACE FUNCTION public.expire_stale_diagnostic_basic()
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  affected int;
BEGIN
  UPDATE public.diagnostic_basic
  SET status = 'expired'
  WHERE status = 'in_progress'
    AND expires_at + interval '6 hours' < now();
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.expire_stale_diagnostic_basic() FROM PUBLIC, anon, authenticated;

-- 2. E-mail post-fitting : n'importe quel bike fitter (rôle en libre-service)
--    pouvait faire envoyer un e-mail AeroX à une adresse arbitraire (fiche
--    client libre), même quand la facturation refusait l'analyse. Envoi
--    seulement si une analyse a réellement été comptée pour ce client
--    (30 j), et au plus 10 clients notifiés par bike fitter et par jour.
CREATE OR REPLACE FUNCTION public.notify_client_post_fitting()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  _client_email text;
  _already_sent boolean;
  _notified_today int;
  _secret text;
BEGIN
  IF NEW.client_id IS NULL THEN RETURN NEW; END IF;

  SELECT email INTO _client_email FROM public.bf_clients WHERE id = NEW.client_id;
  IF _client_email IS NULL OR _client_email = '' THEN RETURN NEW; END IF;

  -- Analyse réellement comptée (essai, crédit, abonnement, legacy).
  IF NOT EXISTS (
    SELECT 1 FROM public.bf_analyses a
    WHERE a.client_id = NEW.client_id
      AND a.billing_mode <> 'uncredited'
      AND a.counted_at > now() - interval '30 days'
  ) THEN
    RETURN NEW;
  END IF;

  -- Max 1 notification par client et par jour.
  SELECT EXISTS (
    SELECT 1 FROM public.sessions
    WHERE client_id = NEW.client_id AND id <> NEW.id AND created_at::date = current_date
  ) INTO _already_sent;
  IF _already_sent THEN RETURN NEW; END IF;

  -- Max 10 clients notifiés par bike fitter et par jour.
  SELECT count(DISTINCT s.client_id) INTO _notified_today
  FROM public.sessions s
  WHERE s.user_id = NEW.user_id
    AND s.client_id IS NOT NULL
    AND s.id <> NEW.id
    AND s.created_at::date = current_date;
  IF _notified_today >= 10 THEN
    RAISE WARNING 'notify_client_post_fitting: plafond quotidien atteint pour %', NEW.user_id;
    RETURN NEW;
  END IF;

  SELECT decrypted_secret INTO _secret FROM vault.decrypted_secrets WHERE name = 'bf_notify_secret' LIMIT 1;
  IF _secret IS NULL THEN
    RAISE WARNING 'notify_client_post_fitting: secret bf_notify_secret absent du Vault, notification non envoyée';
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url := 'https://agvksgrjqskpetokudda.supabase.co/functions/v1/notify-client-post-fitting',
    body := jsonb_build_object('session_id', NEW.id, 'client_id', NEW.client_id, 'bf_user_id', NEW.user_id),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-hook-secret', _secret
    )
  );
  RETURN NEW;
END;
$function$;

-- 3. Approbation admin pending_bf → bike-fitter : aucune ligne bf_billing
--    n'était créée (essai impossible à démarrer depuis l'espace BF du site
--    avant une première analyse). Créée au passage du rôle à bike-fitter.
CREATE OR REPLACE FUNCTION public.bf_billing_on_role_granted()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NEW.role = 'bike-fitter' AND OLD.role IS DISTINCT FROM 'bike-fitter' THEN
    BEGIN
      PERFORM public.bf_start_trial(NEW.id);
    EXCEPTION WHEN others THEN
      RAISE WARNING 'bf_billing_on_role_granted(%) : %', NEW.id, SQLERRM;
    END;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bf_billing_on_role_granted() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS bf_billing_on_role_granted ON public.users;
CREATE TRIGGER bf_billing_on_role_granted
  AFTER UPDATE OF role ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.bf_billing_on_role_granted();

-- 4. E-mail « nouveau bike fitter » envoyé à l'admin quand il approuve
--    lui-même une demande pending_bf : bruit, ignoré.
CREATE OR REPLACE FUNCTION public.notify_admin_new_bf()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  _secret text;
begin
  if new.role <> 'bike-fitter' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.role in ('bike-fitter', 'pending_bf') then
    return new;
  end if;

  select decrypted_secret into _secret from vault.decrypted_secrets where name = 'bf_notify_secret' limit 1;
  if _secret is null then
    raise warning 'notify_admin_new_bf: secret bf_notify_secret absent du Vault, notification non envoyée';
    return new;
  end if;

  perform net.http_post(
    url := 'https://agvksgrjqskpetokudda.supabase.co/functions/v1/notify-admin-new-bf',
    body := jsonb_build_object('record', jsonb_build_object(
      'id', new.id, 'email', new.email, 'firstname', new.firstname, 'name', new.name,
      'studio_name', new.studio_name, 'lang', new.lang, 'created_at', new.created_at
    )),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', _secret)
  );
  return new;
end;
$function$;

-- 5. `bf_clients.id` : imposé à l'INSERT, mais encore modifiable par UPDATE.
CREATE OR REPLACE FUNCTION public.bf_clients_server_id()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF coalesce(auth.role(), '') IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' THEN
      NEW.id := gen_random_uuid();
    ELSE
      NEW.id := OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS bf_clients_server_id ON public.bf_clients;
CREATE TRIGGER bf_clients_server_id
  BEFORE INSERT OR UPDATE ON public.bf_clients
  FOR EACH ROW
  EXECUTE FUNCTION public.bf_clients_server_id();

-- 6. Boucle demande / annulation du rôle bike fitter (une notification admin
--    par passage en pending_bf) : `onboarding_completed` ne peut plus être
--    remis à faux par le client (aucune app ne le fait), ce qui borne la
--    boucle à la durée de l'onboarding.
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
    IF jsonb_array_length(coalesce(NEW.device_ids, '[]'::jsonb)) > 3 THEN
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
       AND jsonb_array_length(coalesce(NEW.device_ids, '[]'::jsonb)) <= 3
     ) THEN
    RAISE EXCEPTION 'device_ids: only adding a device within the limit is allowed'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

-- 7. Comptes confirmés sans profil d'app (créés avant les triggers actuels),
--    hors comptes CRM : profil créé comme à la confirmation.
INSERT INTO public.users (id, email, phonenumber, role, is_active, onboarding_completed, studio_name)
SELECT a.id, a.email, a.raw_user_meta_data ->> 'phone',
       CASE WHEN a.raw_user_meta_data ->> 'profile_type' = 'bike-fitter' THEN 'bike-fitter' ELSE 'rider' END,
       coalesce(a.raw_user_meta_data ->> 'profile_type', '') = 'bike-fitter',
       false,
       CASE WHEN a.raw_user_meta_data ->> 'profile_type' = 'bike-fitter'
            THEN nullif(a.raw_user_meta_data ->> 'studio_name', '') END
FROM auth.users a
LEFT JOIN public.users u ON u.id = a.id
WHERE u.id IS NULL
  AND a.email_confirmed_at IS NOT NULL
  AND coalesce(a.raw_user_meta_data ->> 'profile_type', '') <> 'crm'
ON CONFLICT (id) DO NOTHING;
