-- Fin de bascule de 20261026110000 : les Edge Functions
-- notify-admin-pending-bf / notify-client-post-fitting sont déployées sans
-- vérification JWT et authentifient `x-hook-secret` ; la clé anon codée en
-- dur n'est plus envoyée par les triggers.

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
      'x-hook-secret', _secret
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
      'x-hook-secret', _secret
    )
  );
  RETURN NEW;
END;
$function$;

