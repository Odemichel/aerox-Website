-- Audit Supabase 2026-10-26.
--
-- 1. Onboarding desktop « je suis bike fitter » : la policy
--    `user_update_own_row` n'accepte un changement de rôle que depuis un
--    rôle NULL, or `handle_email_confirmed` crée toujours `rider` depuis le
--    2026-09-24 → le choix échouait toujours. RPC dédiée : rider → pending_bf
--    pendant l'onboarding seulement (validation admin ensuite, notification
--    par `trg_notify_admin_pending_bf`).
CREATE OR REPLACE FUNCTION public.request_bike_fitter_role()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _role text;
  _onboarded boolean;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'permission denied';
  END IF;
  SELECT u.role, u.onboarding_completed INTO _role, _onboarded
    FROM public.users u WHERE u.id = _uid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user not found';
  END IF;
  -- Déjà bike fitter (inscription site) ou déjà en attente : rien à faire.
  IF _role IN ('bike-fitter', 'pending_bf') THEN
    RETURN _role;
  END IF;
  IF _role IS DISTINCT FROM 'rider' OR coalesce(_onboarded, false) THEN
    RAISE EXCEPTION 'role change not allowed';
  END IF;
  UPDATE public.users SET role = 'pending_bf' WHERE id = _uid;
  RETURN 'pending_bf';
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.request_bike_fitter_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_bike_fitter_role() TO authenticated;

-- 2. Edge Functions d'e-mail appelables avec la seule clé anon : les
--    triggers s'authentifient désormais par `x-hook-secret` (secret Vault
--    `bf_notify_secret`, comme `notify_admin_new_bf`). La clé anon reste
--    envoyée pendant la bascule (fonctions déployées avant/après), retirée
--    par 20261026120000.
CREATE OR REPLACE FUNCTION public.notify_admin_pending_bf()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  _secret text;
BEGIN
  IF NEW.role <> 'pending_bf' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.role = 'pending_bf' THEN
    RETURN NEW;
  END IF;

  SELECT decrypted_secret INTO _secret FROM vault.decrypted_secrets WHERE name = 'bf_notify_secret' LIMIT 1;
  IF _secret IS NULL THEN
    RAISE WARNING 'notify_admin_pending_bf: secret bf_notify_secret absent du Vault, notification non envoyée';
    RETURN NEW;
  END IF;

  -- Champs utiles seulement (plus de row_to_json : profil complet envoyé).
  PERFORM net.http_post(
    url := 'https://agvksgrjqskpetokudda.supabase.co/functions/v1/notify-admin-pending-bf',
    body := jsonb_build_object('record', jsonb_build_object(
      'id', NEW.id, 'email', NEW.email, 'firstname', NEW.firstname, 'name', NEW.name,
      'role', NEW.role, 'lang', NEW.lang, 'created_at', NEW.created_at
    )),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-hook-secret', _secret,
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFndmtzZ3JqcXNrcGV0b2t1ZGRhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzkyODA4MTcsImV4cCI6MjA1NDg1NjgxN30.YxMG9QQCnLOcSttu5AlNMgRXl6cHoHiOPXYNe9c895M'
    )
  );
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.notify_client_post_fitting()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  _client_email text;
  _already_sent boolean;
  _secret text;
BEGIN
  IF NEW.client_id IS NULL THEN RETURN NEW; END IF;

  SELECT email INTO _client_email FROM public.bf_clients WHERE id = NEW.client_id;
  IF _client_email IS NULL OR _client_email = '' THEN RETURN NEW; END IF;

  -- Max 1 notification par client et par jour.
  SELECT EXISTS (
    SELECT 1 FROM public.sessions
    WHERE client_id = NEW.client_id AND id <> NEW.id AND created_at::date = current_date
  ) INTO _already_sent;
  IF _already_sent THEN RETURN NEW; END IF;

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
      'x-hook-secret', _secret,
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFndmtzZ3JqcXNrcGV0b2t1ZGRhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzkyODA4MTcsImV4cCI6MjA1NDg1NjgxN30.YxMG9QQCnLOcSttu5AlNMgRXl6cHoHiOPXYNe9c895M'
    )
  );
  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.notify_admin_pending_bf(), public.notify_client_post_fitting() FROM PUBLIC, anon, authenticated;
