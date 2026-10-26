-- Audit 2026-10-26 (6e passe).

-- 1. Garde d'identité des fiches client contournable (audit_cross_fixes) :
--    elle comparait la mise à jour à la valeur précédente — vider puis
--    remplir, renommer par petits pas, lier la fiche à un compte le temps du
--    renommage. Elle compare maintenant à l'identité de la personne au
--    moment où l'analyse a été comptée (figée sur bf_analyses).
CREATE OR REPLACE FUNCTION public.bf_identity_name(p_first text, p_last text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select left(regexp_replace(lower(btrim(coalesce(p_first, '') || ' ' || coalesce(p_last, ''))), '\s+', ' ', 'g'), 255);
$function$;

-- Forme canonique d'une adresse : minuscules, sans +étiquette, sans points
-- pour Gmail (même boîte).
CREATE OR REPLACE FUNCTION public.email_canonical(p_email text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  with e as (
    select lower(btrim(coalesce(p_email, ''))) as v
  ), p as (
    select split_part(v, '@', 1) as loc, split_part(v, '@', 2) as dom from e
  )
  select case
    when (select v from e) = '' then ''
    when dom in ('gmail.com', 'googlemail.com') then
      replace(split_part(loc, '+', 1), '.', '') || '@gmail.com'
    else split_part(loc, '+', 1) || '@' || dom
  end
  from p;
$function$;
REVOKE EXECUTE ON FUNCTION public.bf_identity_name(text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.email_canonical(text) FROM PUBLIC, anon, authenticated;

ALTER TABLE public.bf_analyses ADD COLUMN IF NOT EXISTS client_name_ref text;
ALTER TABLE public.bf_analyses ADD COLUMN IF NOT EXISTS client_email_ref text;

CREATE OR REPLACE FUNCTION public.bf_analyses_identity_ref()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  SELECT public.bf_identity_name(c.firstname, c.lastname), public.email_canonical(c.email)
    INTO NEW.client_name_ref, NEW.client_email_ref
    FROM public.bf_clients c WHERE c.id = NEW.client_id;
  RETURN NEW;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bf_analyses_identity_ref() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS bf_analyses_identity_ref ON public.bf_analyses;
CREATE TRIGGER bf_analyses_identity_ref
  BEFORE INSERT ON public.bf_analyses
  FOR EACH ROW
  EXECUTE FUNCTION public.bf_analyses_identity_ref();

UPDATE public.bf_analyses a
  SET client_name_ref = public.bf_identity_name(c.firstname, c.lastname),
      client_email_ref = public.email_canonical(c.email)
  FROM public.bf_clients c
  WHERE c.id = a.client_id AND a.client_name_ref IS NULL;

CREATE OR REPLACE FUNCTION public.bf_clients_identity_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  _ref public.bf_analyses%rowtype;
  _name text;
  _email text;
  _linked_name text;
  _linked_email text;
BEGIN
  IF coalesce(auth.role(), '') NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.identity_changed_at := NULL;
    RETURN NEW;
  END IF;
  NEW.identity_changed_at := OLD.identity_changed_at;

  -- Personne de la dernière analyse comptée (30 j).
  SELECT * INTO _ref FROM public.bf_analyses a
   WHERE a.client_id = OLD.id AND a.billing_mode <> 'uncredited'
     AND a.counted_at > now() - interval '30 days'
     AND a.counted_at > coalesce(OLD.identity_changed_at, '-infinity'::timestamptz)
   ORDER BY a.counted_at DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- Liaison au compte AeroX de cette même personne : identité recopiée du
  -- compte, pas un changement de personne.
  IF NEW.linked_user_id IS DISTINCT FROM OLD.linked_user_id
     AND NEW.linked_user_id IS NOT NULL
     AND NEW.linked_user_id <> NEW.bf_user_id THEN
    SELECT public.bf_identity_name(u.firstname, u.name), public.email_canonical(u.email)
      INTO _linked_name, _linked_email
      FROM public.users u WHERE u.id = NEW.linked_user_id;
    IF (coalesce(_ref.client_email_ref, '') <> '' AND _linked_email = _ref.client_email_ref)
       OR (coalesce(_ref.client_email_ref, '') = '' AND coalesce(_ref.client_name_ref, '') <> ''
           AND extensions.levenshtein(_linked_name, _ref.client_name_ref) <= 2) THEN
      RETURN NEW;
    END IF;
  END IF;

  _name := public.bf_identity_name(NEW.firstname, NEW.lastname);
  _email := public.email_canonical(NEW.email);
  IF (coalesce(_ref.client_name_ref, '') <> '' AND _name <> ''
      AND extensions.levenshtein(_name, _ref.client_name_ref) > 2)
     OR (coalesce(_ref.client_email_ref, '') <> '' AND _email <> ''
      AND _email <> _ref.client_email_ref) THEN
    NEW.identity_changed_at := now();
  END IF;
  RETURN NEW;
END;
$function$;

DROP FUNCTION IF EXISTS public.bf_clients_identity_changed(text, text);

-- 2. E-mail post-fitting : le champ acceptait plusieurs destinataires
--    (« a@x, b@y ») et des variantes d'une même boîte (+étiquette, points
--    Gmail) contournaient le plafond par adresse. Une seule adresse simple ;
--    plafond sur la forme canonique ; l'Edge Function envoie à l'adresse
--    inscrite au journal (passée dans la requête).
ALTER TABLE public.bf_clients DROP CONSTRAINT IF EXISTS bf_clients_email_single_address;
ALTER TABLE public.bf_clients ADD CONSTRAINT bf_clients_email_single_address
  CHECK (email IS NULL OR btrim(email) = '' OR email ~ '^[^\s,;<>@"]+@[^\s,;<>@"]+\.[^\s,;<>@"]+$');

ALTER TABLE public.bf_client_notifications ADD COLUMN IF NOT EXISTS recipient_canonical text;
UPDATE public.bf_client_notifications
  SET recipient_canonical = public.email_canonical(recipient_email)
  WHERE recipient_canonical IS NULL;
CREATE INDEX IF NOT EXISTS bf_client_notifications_canonical_sent
  ON public.bf_client_notifications (recipient_canonical, sent_at);

CREATE OR REPLACE FUNCTION public.notify_client_post_fitting()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  _email text;
  _canonical text;
  _secret text;
BEGIN
  IF NEW.client_id IS NULL THEN RETURN NEW; END IF;
  -- Séance de fitting récente (le rejeu hors ligne d'une séance ancienne
  -- n'envoie rien ; une séance antidatée non plus).
  IF NEW.created_at < now() - interval '1 day' OR NEW.created_at > now() + interval '1 hour' THEN
    RETURN NEW;
  END IF;

  SELECT btrim(email) INTO _email FROM public.bf_clients WHERE id = NEW.client_id;
  IF _email IS NULL OR _email = '' THEN RETURN NEW; END IF;
  _canonical := public.email_canonical(_email);

  -- Analyse réellement comptée pour ce client (30 j).
  IF NOT EXISTS (
    SELECT 1 FROM public.bf_analyses a
    WHERE a.client_id = NEW.client_id
      AND a.billing_mode <> 'uncredited'
      AND a.counted_at > now() - interval '30 days'
  ) THEN
    RETURN NEW;
  END IF;

  IF EXISTS (SELECT 1 FROM public.bf_client_notifications n
             WHERE n.client_id = NEW.client_id AND n.sent_at > now() - interval '24 hours')
     OR EXISTS (SELECT 1 FROM public.bf_client_notifications n
                WHERE n.recipient_canonical = _canonical AND n.sent_at > now() - interval '7 days') THEN
    RETURN NEW;
  END IF;

  IF (SELECT count(*) FROM public.bf_client_notifications n
      WHERE n.bf_user_id = NEW.user_id AND n.sent_at > now() - interval '24 hours') >= 10 THEN
    RAISE WARNING 'notify_client_post_fitting: plafond quotidien atteint pour %', NEW.user_id;
    RETURN NEW;
  END IF;

  SELECT decrypted_secret INTO _secret FROM vault.decrypted_secrets WHERE name = 'bf_notify_secret' LIMIT 1;
  IF _secret IS NULL THEN
    RAISE WARNING 'notify_client_post_fitting: secret bf_notify_secret absent du Vault, notification non envoyée';
    RETURN NEW;
  END IF;

  INSERT INTO public.bf_client_notifications (bf_user_id, client_id, recipient_email, recipient_canonical)
  VALUES (NEW.user_id, NEW.client_id, lower(_email), _canonical);

  PERFORM net.http_post(
    url := 'https://agvksgrjqskpetokudda.supabase.co/functions/v1/notify-client-post-fitting',
    body := jsonb_build_object('session_id', NEW.id, 'client_id', NEW.client_id,
                               'bf_user_id', NEW.user_id, 'email', _email),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-hook-secret', _secret
    )
  );
  RETURN NEW;
END;
$function$;

-- 3. Demande de rôle bike fitter : une ligne par appel (table sans fin) ;
--    une ligne au plus par 24 h, notification seulement pour celle-ci.
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
  IF _role IN ('bike-fitter', 'pending_bf') THEN
    RETURN _role;
  END IF;
  IF _role IS DISTINCT FROM 'rider' OR coalesce(_onboarded, false) THEN
    RAISE EXCEPTION 'role change not allowed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.bf_role_requests r
                 WHERE r.user_id = _uid AND r.requested_at > now() - interval '24 hours') THEN
    INSERT INTO public.bf_role_requests (user_id) VALUES (_uid);
    PERFORM set_config('aerox.bf_request_new', '1', true);
  END IF;
  UPDATE public.users SET role = 'pending_bf' WHERE id = _uid;
  RETURN 'pending_bf';
END;
$function$;

-- Vrai si une demande des 24 h a déjà été notifiée (la demande courante n'a
-- pas ajouté de ligne).
CREATE OR REPLACE FUNCTION public.bf_role_request_repeated(p_uid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (select 1 from public.bf_role_requests r
                 where r.user_id = p_uid and r.requested_at > now() - interval '24 hours')
     and current_setting('aerox.bf_request_new', true) is distinct from '1';
$function$;

-- 4. Profil créé par le client lui-même (compte confirmé sans ligne
--    users) : rôle pending_bf posable sans passer par la RPC. Le trigger
--    handle_email_confirmed crée le profil ; l'INSERT client ne pose plus
--    que rider (ou rien).
DROP POLICY IF EXISTS "Allow insert for authenticated users" ON public.users;
CREATE POLICY "Allow insert for authenticated users" ON public.users
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = id AND (role IS NULL OR role = 'rider'));

-- 5. Bucket de télémétrie privé sans limite : images seulement, 2 Mo.
UPDATE storage.buckets
  SET allowed_mime_types = ARRAY['image/png', 'image/jpeg'], file_size_limit = 2097152
  WHERE id = 'calibration-telemetry-private';

-- 6. Vue d'achats de diagnostic : droits d'écriture superflus.
REVOKE INSERT, UPDATE, DELETE ON public.diagnostic_purchase_status FROM authenticated, anon;

-- 7. Écritures tardives du desktop (une requête expirée côté app arrive
--    après la fin) : un tick « running » ou un signe de vie « ending » du
--    même run ne rouvre plus une séance terminée. Seulement depuis les
--    états de fin écrits par le desktop (completed, unsaved) : une remise au
--    repos (idle) faite à tort par le téléphone reste réparable par le tick
--    suivant.
ALTER TABLE public.webapp_session_state ADD COLUMN IF NOT EXISTS run_id text;

CREATE OR REPLACE FUNCTION public.webapp_session_state_touch()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.run_id IS NOT NULL AND NEW.run_id = OLD.run_id
     AND NOT coalesce(OLD.is_active, false)
     AND lower(coalesce(OLD.session_state, '')) IN ('completed', 'unsaved')
     AND lower(coalesce(NEW.session_state, '')) IN ('running', 'paused', 'ending') THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.updated_at IS DISTINCT FROM OLD.updated_at THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$function$;
