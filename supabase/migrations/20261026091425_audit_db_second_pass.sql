-- Audit base 2026-10-26 (2e passe) : correctifs compatibles avec les apps
-- diffusées.

-- 1. Onboarding : un `pending_bf` qui revient sur « je suis un rider » ne
--    pouvait pas repasser `rider` (la policy de `users` refuse le changement
--    de rôle ; cas rendu atteignable par request_bike_fitter_role).
CREATE OR REPLACE FUNCTION public.cancel_bike_fitter_request()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _role text;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'permission denied';
  END IF;
  SELECT u.role INTO _role FROM public.users u WHERE u.id = _uid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user not found';
  END IF;
  IF _role = 'pending_bf' THEN
    UPDATE public.users SET role = 'rider' WHERE id = _uid;
    RETURN 'rider';
  END IF;
  RETURN _role;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.cancel_bike_fitter_request() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_bike_fitter_request() TO authenticated;

-- 2. Facturation BF : une analyse `uncredited` (séance faite en lecture
--    seule / sans crédit, journalisée par le backstop) servait de doublon
--    30 jours → le client devenait gratuit 30 jours une fois le compte
--    régularisé. Seules les analyses réellement comptées font doublon ; une
--    seule ligne `uncredited` par client et par période reste journalisée.
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

  select * into _existing
  from public.bf_analyses
  where client_id = p_client_id
    and counted_at > now() - interval '30 days'
    and billing_mode <> 'uncredited'
  order by counted_at desc
  limit 1;

  select exists (
    select 1 from public.bf_analyses
    where client_id = p_client_id
      and counted_at > now() - interval '30 days'
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

-- 3. Écriture chez autrui :
--    * `rider_id` (séance ou position) libre → une ligne apparaissait dans
--      l'historique de n'importe quel compte : il doit être soi-même ou un
--      client lié du bike fitter ;
--    * `bf_clients.id` choisi par le client (un id = uid d'une victime) :
--      généré par la base ;
--    * `client_reads_sessions` comparait `client_id` (id de bf_clients) à
--      un uid : branche retirée, la lecture passe par `rider_id`.
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
    AND (rider_id IS NULL OR rider_id = (SELECT auth.uid()) OR EXISTS (
      SELECT 1 FROM public.bf_clients c
      WHERE c.bf_user_id = (SELECT auth.uid()) AND c.linked_user_id = rider_id
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
    AND (rider_id IS NULL OR rider_id = (SELECT auth.uid()) OR EXISTS (
      SELECT 1 FROM public.bf_clients c
      WHERE c.bf_user_id = (SELECT auth.uid()) AND c.linked_user_id = rider_id
    ))
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
    AND (rider_id IS NULL OR rider_id = (SELECT auth.uid()) OR EXISTS (
      SELECT 1 FROM public.bf_clients c
      WHERE c.bf_user_id = (SELECT auth.uid()) AND c.linked_user_id = rider_id
    ))
  );

DROP POLICY IF EXISTS client_reads_sessions ON public.sessions;
CREATE POLICY client_reads_sessions ON public.sessions
  FOR SELECT TO authenticated
  USING (rider_id = (SELECT auth.uid()));

CREATE OR REPLACE FUNCTION public.bf_clients_server_id()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF coalesce(auth.role(), '') IN ('authenticated', 'anon') THEN
    NEW.id := gen_random_uuid();
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.bf_clients_server_id() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS bf_clients_server_id ON public.bf_clients;
CREATE TRIGGER bf_clients_server_id
  BEFORE INSERT ON public.bf_clients
  FOR EACH ROW
  EXECUTE FUNCTION public.bf_clients_server_id();

-- 4. Diagnostic : la clôture était refusée pendant les 6 h de grâce
--    (`diagnostic_is_writable` les accorde aux écritures S1/S2) → une S2
--    finie juste après l'échéance laissait le diagnostic non clôturé.
CREATE OR REPLACE FUNCTION public.diagnostic_basic_guard_client_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if old.status <> 'in_progress' or old.expires_at + interval '6 hours' <= now() then
    raise exception 'diagnostic_closed' using errcode = '42501';
  end if;
  if new.status not in ('in_progress', 'completed') then
    raise exception 'diagnostic_status_forbidden' using errcode = '42501';
  end if;
  return new;
end;
$function$;

-- 5. `users` : la garde des colonnes client ne couvrait que l'UPDATE ; un
--    compte confirmé sans profil pouvait s'INSERER avec licencetype,
--    device_ids ou l'e-mail d'un tiers. Même garde à l'INSERT.
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

DROP TRIGGER IF EXISTS users_guard_client_columns ON public.users;
CREATE TRIGGER users_guard_client_columns
  BEFORE INSERT OR UPDATE ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.users_guard_client_columns();

-- 6. Comptes CRM (`profile_type = 'crm'`) : pas de profil d'app créé à la
--    confirmation (le trigger AFTER INSERT de 20261026130000 leur créait un
--    profil rider).
CREATE OR REPLACE FUNCTION public.handle_email_confirmed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  _profile_type text := coalesce(new.raw_user_meta_data ->> 'profile_type', '');
  _is_bf boolean := _profile_type = 'bike-fitter';
  _confirmed_now boolean :=
    new.email_confirmed_at is not null
    and (tg_op = 'INSERT' or old.email_confirmed_at is null);
begin
  if _confirmed_now and _profile_type <> 'crm' then
    insert into public.users (id, email, phonenumber, role, is_active, onboarding_completed, studio_name)
    values (
      new.id,
      new.email,
      new.raw_user_meta_data ->> 'phone',
      case when _is_bf then 'bike-fitter' else 'rider' end,
      _is_bf,
      false,
      case when _is_bf then nullif(new.raw_user_meta_data ->> 'studio_name', '') end
    )
    on conflict (id) do nothing;

    if _is_bf then
      begin
        perform public.bf_start_trial(new.id);
      exception when others then
        raise warning 'handle_email_confirmed: bf_start_trial(%) a échoué : %', new.id, sqlerrm;
      end;
    end if;
  end if;
  return new;
end;
$function$;
