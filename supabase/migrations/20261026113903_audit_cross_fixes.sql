-- Audit croisé 2026-10-26 (base ↔ desktop ↔ mobile).

-- 1. Garde d'identité des fiches client (20261026160000) : une correction
--    légitime facturait une nouvelle analyse — faute de frappe dans le nom,
--    e-mail oublié ajouté, liaison au compte AeroX du client (qui recopie
--    prénom, nom et e-mail du compte). Ne compte plus qu'un vrai changement
--    de personne : ancienne et nouvelle valeur renseignées, distance
--    d'édition > 2, hors liaison au compte.
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION public.bf_clients_identity_changed(p_old text, p_new text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select nullif(lower(btrim(coalesce(p_old, ''))), '') is not null
     and nullif(lower(btrim(coalesce(p_new, ''))), '') is not null
     and extensions.levenshtein(
           left(lower(btrim(p_old)), 255), left(lower(btrim(p_new)), 255)) > 2;
$function$;
REVOKE EXECUTE ON FUNCTION public.bf_clients_identity_changed(text, text) FROM PUBLIC, anon, authenticated;

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
  -- Liaison au compte du client : identité recopiée du compte, même personne.
  IF NEW.linked_user_id IS DISTINCT FROM OLD.linked_user_id AND NEW.linked_user_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF (public.bf_clients_identity_changed(
        coalesce(OLD.firstname, '') || ' ' || coalesce(OLD.lastname, ''),
        coalesce(NEW.firstname, '') || ' ' || coalesce(NEW.lastname, ''))
      OR public.bf_clients_identity_changed(OLD.email, NEW.email))
     AND EXISTS (SELECT 1 FROM public.bf_analyses a
                 WHERE a.client_id = OLD.id AND a.billing_mode <> 'uncredited'
                   AND a.counted_at > now() - interval '30 days') THEN
    NEW.identity_changed_at := now();
  END IF;
  RETURN NEW;
END;
$function$;

-- 2. « Recommencer » pendant la grâce de 6 h refusé (no_active_diagnostic)
--    alors que start_diagnostic et les écritures l'acceptent : même borne.
CREATE OR REPLACE FUNCTION public.restart_diagnostic()
 RETURNS diagnostic_basic
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := auth.uid();
  v_old public.diagnostic_basic;
  v_new public.diagnostic_basic;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select * into v_old
  from public.diagnostic_basic
  where user_id = v_uid and status = 'in_progress' and expires_at + interval '6 hours' > now()
  for update;
  if not found then
    raise exception 'no_active_diagnostic' using errcode = 'P0001';
  end if;

  update public.diagnostic_basic set status = 'archived' where id = v_old.id;

  insert into public.diagnostic_basic (user_id, purchase_id, started_at, expires_at)
  values (v_uid, v_old.purchase_id, now(), v_old.expires_at)
  returning * into v_new;

  return v_new;
end;
$function$;

-- 3. webapp_session_state.updated_at écrit avec l'horloge du desktop : un
--    PC en retard faisait juger la séance figée par le téléphone. Heure du
--    serveur imposée.
CREATE OR REPLACE FUNCTION public.webapp_session_state_touch()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.webapp_session_state_touch() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS webapp_session_state_touch ON public.webapp_session_state;
CREATE TRIGGER webapp_session_state_touch
  BEFORE INSERT OR UPDATE ON public.webapp_session_state
  FOR EACH ROW
  EXECUTE FUNCTION public.webapp_session_state_touch();

-- 4. Séances restées actives après un plantage du desktop (aucun tick
--    depuis plus d'une heure) : remises au repos.
UPDATE public.webapp_session_state
  SET is_active = false, session_state = 'idle', guided_state = NULL
  WHERE is_active AND updated_at < now() - interval '1 hour';
