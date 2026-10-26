-- Audit base 2026-10-26 (4e passe).

-- 1. E-mail post-fitting : les plafonds se calculaient sur sessions.created_at
--    (écrit par le client → séances antidatées hors plafond) et par fiche
--    client (adresse modifiable entre deux séances). Journal des envois :
--    plafonds sur la date réelle d'envoi, par client (1 / 24 h), par adresse
--    (1 / 7 j) et par bike fitter (10 / 24 h) ; séance récente seulement.
CREATE TABLE IF NOT EXISTS public.bf_client_notifications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bf_user_id uuid NOT NULL,
  client_id uuid NOT NULL,
  recipient_email text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.bf_client_notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bf_client_notifications FROM anon, authenticated;
CREATE INDEX IF NOT EXISTS bf_client_notifications_bf_sent ON public.bf_client_notifications (bf_user_id, sent_at);
CREATE INDEX IF NOT EXISTS bf_client_notifications_email_sent ON public.bf_client_notifications (recipient_email, sent_at);
CREATE INDEX IF NOT EXISTS bf_client_notifications_client_sent ON public.bf_client_notifications (client_id, sent_at);

CREATE OR REPLACE FUNCTION public.notify_client_post_fitting()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  _email text;
  _secret text;
BEGIN
  IF NEW.client_id IS NULL THEN RETURN NEW; END IF;
  -- Séance de fitting récente (le rejeu hors ligne d'une séance ancienne
  -- n'envoie rien ; une séance antidatée non plus).
  IF NEW.created_at < now() - interval '1 day' OR NEW.created_at > now() + interval '1 hour' THEN
    RETURN NEW;
  END IF;

  SELECT lower(btrim(email)) INTO _email FROM public.bf_clients WHERE id = NEW.client_id;
  IF _email IS NULL OR _email = '' THEN RETURN NEW; END IF;

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
                WHERE n.recipient_email = _email AND n.sent_at > now() - interval '7 days') THEN
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

  INSERT INTO public.bf_client_notifications (bf_user_id, client_id, recipient_email)
  VALUES (NEW.user_id, NEW.client_id, _email);

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

-- 2a. Comptage de secours : une séance créée sans client puis rattachée par
--     UPDATE de client_id n'était jamais comptée.
DROP TRIGGER IF EXISTS trg_bf_count_session_backstop_client_update ON public.sessions;
CREATE TRIGGER trg_bf_count_session_backstop_client_update
  AFTER UPDATE OF client_id ON public.sessions
  FOR EACH ROW
  WHEN (NEW.client_id IS DISTINCT FROM OLD.client_id)
  EXECUTE FUNCTION public.bf_count_session_backstop();

-- 2b. Gratuité 30 j réutilisée en renommant la fiche client : l'identité
--     (prénom, nom, e-mail) modifiée après une analyse comptée ouvre une
--     nouvelle analyse. Horodatage tenu par la base (non modifiable par le
--     client).
ALTER TABLE public.bf_clients ADD COLUMN IF NOT EXISTS identity_changed_at timestamptz;

CREATE OR REPLACE FUNCTION public.bf_clients_identity_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF coalesce(auth.role(), '') NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.identity_changed_at := NULL;
    RETURN NEW;
  END IF;
  NEW.identity_changed_at := OLD.identity_changed_at;
  IF (lower(btrim(coalesce(NEW.firstname, ''))) IS DISTINCT FROM lower(btrim(coalesce(OLD.firstname, '')))
      OR lower(btrim(coalesce(NEW.lastname, ''))) IS DISTINCT FROM lower(btrim(coalesce(OLD.lastname, '')))
      OR lower(btrim(coalesce(NEW.email, ''))) IS DISTINCT FROM lower(btrim(coalesce(OLD.email, ''))))
     AND EXISTS (SELECT 1 FROM public.bf_analyses a
                 WHERE a.client_id = OLD.id AND a.billing_mode <> 'uncredited'
                   AND a.counted_at > now() - interval '30 days') THEN
    NEW.identity_changed_at := now();
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bf_clients_identity_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS bf_clients_identity_guard ON public.bf_clients;
CREATE TRIGGER bf_clients_identity_guard
  BEFORE INSERT OR UPDATE ON public.bf_clients
  FOR EACH ROW
  EXECUTE FUNCTION public.bf_clients_identity_guard();

CREATE OR REPLACE FUNCTION public.bf_register_analysis_for(p_uid uuid, p_client_id uuid, p_origin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  _role text;
  _billing public.bf_billing%rowtype;
  _credit public.bf_credits%rowtype;
  _analysis_id uuid;
  _existing public.bf_analyses%rowtype;
  _has_uncredited boolean;
  _identity_since timestamptz;
begin
  select role into _role from public.users where id = p_uid;
  if _role is null or _role not in ('bike-fitter', 'admin') then
    return jsonb_build_object('status', 'refused', 'reason', 'not_bike_fitter');
  end if;

  perform 1 from public.bf_clients where id = p_client_id and bf_user_id = p_uid;
  if not found then
    return jsonb_build_object('status', 'refused', 'reason', 'client_not_found');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('bf_analysis:' || p_client_id::text, 0));

  select * into _billing from public.bf_billing where user_id = p_uid for update;
  if not found then
    perform public.bf_start_trial(p_uid);
    select * into _billing from public.bf_billing where user_id = p_uid for update;
  end if;

  -- Fiche dont l'identité a changé après une analyse comptée (prénom, nom,
  -- e-mail) : plus de gratuité 30 j, c'est un autre cycliste.
  select coalesce(c.identity_changed_at, '-infinity'::timestamptz) into _identity_since
  from public.bf_clients c where c.id = p_client_id;

  select * into _existing
  from public.bf_analyses
  where client_id = p_client_id
    and counted_at > now() - interval '30 days'
    and counted_at > _identity_since
    and billing_mode <> 'uncredited'
  order by counted_at desc
  limit 1;

  select exists (
    select 1 from public.bf_analyses
    where client_id = p_client_id
      and counted_at > now() - interval '30 days'
      and counted_at > _identity_since
      and billing_mode = 'uncredited'
  ) into _has_uncredited;

  if public.bf_access_level(_billing.status, _billing.grace_until) <> 'full' then
    if p_origin = 'session_backstop' and _existing.id is null and not _has_uncredited then
      insert into public.bf_analyses (user_id, client_id, billing_mode, origin)
      values (p_uid, p_client_id, 'uncredited', p_origin);
    end if;
    return jsonb_build_object('status', 'refused', 'reason', 'read_only', 'plan', _billing.plan);
  end if;

  if _existing.id is not null then
    return jsonb_build_object(
      'status', 'already_counted',
      'analysis_id', _existing.id,
      'counted_at', _existing.counted_at,
      'free_until', _existing.counted_at + interval '30 days',
      'plan', _billing.plan
    );
  end if;

  if _billing.plan in ('trial', 'pack') then
    select * into _credit
    from public.bf_credits
    where user_id = p_uid and remaining > 0 and expires_at > now()
    order by expires_at
    limit 1
    for update;

    if not found then
      if p_origin = 'session_backstop' and not _has_uncredited then
        insert into public.bf_analyses (user_id, client_id, billing_mode, origin)
        values (p_uid, p_client_id, 'uncredited', p_origin);
      end if;
      if _billing.trial_ends_at is null then
        return jsonb_build_object('status', 'refused', 'reason', 'needs_card', 'plan', _billing.plan);
      end if;
      return jsonb_build_object('status', 'refused', 'reason', 'no_credits', 'plan', _billing.plan);
    end if;

    update public.bf_credits set remaining = remaining - 1 where id = _credit.id;

    insert into public.bf_analyses (user_id, client_id, billing_mode, credit_id, origin)
    values (p_uid, p_client_id, _billing.plan, _credit.id, p_origin)
    returning id into _analysis_id;

    return jsonb_build_object(
      'status', 'counted',
      'analysis_id', _analysis_id,
      'plan', _billing.plan,
      'credits_remaining', (
        select coalesce(sum(remaining), 0) from public.bf_credits
        where user_id = p_uid and remaining > 0 and expires_at > now()
      )
    );
  end if;

  if _billing.plan <> 'legacy' and _billing.trial_ends_at is not null and _billing.trial_ends_at > now() then
    insert into public.bf_analyses (user_id, client_id, billing_mode, origin)
    values (p_uid, p_client_id, 'trial', p_origin)
    returning id into _analysis_id;
    return jsonb_build_object(
      'status', 'counted', 'analysis_id', _analysis_id, 'plan', _billing.plan, 'trial_ends_at', _billing.trial_ends_at
    );
  end if;

  if _billing.plan in ('essential', 'studio', 'payg') then
    _analysis_id := gen_random_uuid();
    insert into public.bf_analyses (id, user_id, client_id, billing_mode, stripe_meter_event_identifier, origin)
    values (_analysis_id, p_uid, p_client_id, _billing.plan, _analysis_id::text, p_origin);

    return jsonb_build_object('status', 'counted', 'analysis_id', _analysis_id, 'plan', _billing.plan, 'meter_pending', true);
  end if;

  insert into public.bf_analyses (user_id, client_id, billing_mode, origin)
  values (p_uid, p_client_id, _billing.plan, p_origin)
  returning id into _analysis_id;

  return jsonb_build_object('status', 'counted', 'analysis_id', _analysis_id, 'plan', _billing.plan);
end;
$function$;

-- 3. Boucle demande / annulation du rôle bike fitter pendant l'onboarding
--    (une notification admin + un événement CRM par passage) : une demande
--    au plus par 24 h.
CREATE TABLE IF NOT EXISTS public.bf_role_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.bf_role_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bf_role_requests FROM anon, authenticated;
CREATE INDEX IF NOT EXISTS bf_role_requests_user ON public.bf_role_requests (user_id, requested_at);

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
  IF EXISTS (SELECT 1 FROM public.bf_role_requests r
             WHERE r.user_id = _uid AND r.requested_at > now() - interval '24 hours') THEN
    RAISE EXCEPTION 'bike fitter request already made in the last 24 hours';
  END IF;
  INSERT INTO public.bf_role_requests (user_id) VALUES (_uid);
  UPDATE public.users SET role = 'pending_bf' WHERE id = _uid;
  RETURN 'pending_bf';
END;
$function$;

-- 4. Bucket `thumbnails` : listable par tout compte connecté, sans limite de
--    taille ni de type. Lecture du listing limitée à son dossier (l'app lit
--    les miniatures par URL publique), PNG ≤ 512 Ko.
DROP POLICY IF EXISTS "Allow uploads for authenticated users 16v3daf_2" ON storage.objects;
CREATE POLICY thumbnails_select_own
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'thumbnails' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text);
UPDATE storage.buckets
  SET allowed_mime_types = ARRAY['image/png'], file_size_limit = 524288
  WHERE id = 'thumbnails';

-- 5. Diagnostic : un nouvel achat pendant la grâce de 6 h passait le
--    diagnostic en cours en `expired` au démarrage (S2 / clôture en cours
--    refusées). Le diagnostic en grâce reste le diagnostic courant ; l'achat
--    est consommé après la grâce.
CREATE OR REPLACE FUNCTION public.start_diagnostic()
 RETURNS diagnostic_basic
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := auth.uid();
  v_diag public.diagnostic_basic;
  v_purchase_id uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select * into v_diag
  from public.diagnostic_basic
  where user_id = v_uid and status = 'in_progress' and expires_at + interval '6 hours' > now()
  for update;
  if found then
    return v_diag;
  end if;

  select id into v_purchase_id
  from public.diagnostic_purchases
  where user_id = v_uid and consumed_at is null and refunded_at is null
  order by paid_at
  limit 1
  for update;
  if v_purchase_id is null then
    raise exception 'no_diagnostic_entitlement' using errcode = 'P0001';
  end if;

  update public.diagnostic_basic
  set status = 'expired'
  where user_id = v_uid and status = 'in_progress' and expires_at + interval '6 hours' <= now();

  insert into public.diagnostic_basic (user_id, purchase_id, started_at, expires_at)
  values (v_uid, v_purchase_id, now(), now() + interval '30 days')
  returning * into v_diag;

  update public.diagnostic_purchases
  set consumed_at = now()
  where id = v_purchase_id;

  return v_diag;
end;
$function$;

CREATE OR REPLACE FUNCTION public.has_diagnostic_entitlement()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select auth.uid() is not null and (
    exists (
      select 1 from public.diagnostic_purchases
      where user_id = auth.uid() and consumed_at is null and refunded_at is null
    )
    or exists (
      select 1 from public.diagnostic_basic
      where user_id = auth.uid() and status = 'in_progress' and expires_at + interval '6 hours' > now()
    )
  );
$function$;

-- 6. Droits Postgres par défaut de Supabase : TRUNCATE (qui ignore la RLS),
--    REFERENCES et TRIGGER retirés aux rôles clients (non exposés par
--    PostgREST, défense en profondeur), y compris pour les tables futures.
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM anon, authenticated;
