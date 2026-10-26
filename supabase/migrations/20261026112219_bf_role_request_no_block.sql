-- Suite de 20261026160000 : la 2e demande de rôle bike fitter en 24 h était
-- refusée, ce qui bloquait un utilisateur revenu par erreur à « cycliste »
-- pendant l'onboarding (erreur générique). La demande passe toujours ; seuls
-- la notification admin et l'événement CRM sont limités à la 1re demande
-- des 24 h.
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
  INSERT INTO public.bf_role_requests (user_id) VALUES (_uid);
  UPDATE public.users SET role = 'pending_bf' WHERE id = _uid;
  RETURN 'pending_bf';
END;
$function$;

-- Vrai si une demande antérieure à la demande courante existe dans les 24 h.
CREATE OR REPLACE FUNCTION public.bf_role_request_repeated(p_uid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select (select count(*) from public.bf_role_requests r
          where r.user_id = p_uid and r.requested_at > now() - interval '24 hours') > 1;
$function$;
REVOKE EXECUTE ON FUNCTION public.bf_role_request_repeated(uuid) FROM PUBLIC, anon, authenticated;

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
  IF public.bf_role_request_repeated(NEW.id) THEN
    RETURN NEW;
  END IF;

  SELECT decrypted_secret INTO _secret FROM vault.decrypted_secrets WHERE name = 'bf_notify_secret' LIMIT 1;
  IF _secret IS NULL THEN
    RAISE WARNING 'notify_admin_pending_bf: secret bf_notify_secret absent du Vault, notification non envoyée';
    RETURN NEW;
  END IF;

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

CREATE OR REPLACE FUNCTION public.crm_on_bf_signup()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  _contact uuid;
  _email text := lower(coalesce(new.email, ''));
  _slug text;
begin
  if new.role not in ('bike-fitter', 'pending_bf') then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.role in ('bike-fitter', 'pending_bf') then
    return new;
  end if;
  if _email = '' then
    return new;
  end if;
  if public.bf_role_request_repeated(new.id) then
    return new;
  end if;

  begin
    select c.id into _contact
    from public.crm_contacts c
    where lower(c.email) = _email or lower(c.email_alt) = _email
    limit 1;

    if _contact is null then
      _slug := regexp_replace(split_part(_email, '@', 1), '[^a-z0-9]+', '-', 'g')
               || '-' || substr(md5(_email), 1, 6);
      insert into public.crm_contacts (slug, name, email, segment, stage, ml_note, issue)
      values (
        _slug,
        coalesce(nullif(trim(coalesce(new.firstname, '') || ' ' || coalesce(new.name, '')), ''), split_part(_email, '@', 1)),
        _email,
        'bf',
        'lead',
        '',
        case when new.role = 'pending_bf' then 'Compte en attente d''activation (pending_bf)' else '' end
      )
      returning id into _contact;
    end if;

    insert into public.crm_events (contact_id, occurred_on, direction, summary)
    values (_contact, current_date, 'in', 'Inscription bike fitter sur le site');
  exception when others then
    raise warning 'crm_on_bf_signup: %', sqlerrm;
  end;
  return new;
end;
$function$;
