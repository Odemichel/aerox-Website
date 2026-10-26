-- Suite de 20261026113903 : l'heure serveur était posée sur toute écriture,
-- y compris la présence du téléphone (companion_seen_at toutes les 20 s,
-- sans updated_at) — une séance plantée côté desktop ne paraissait alors
-- jamais figée. Heure serveur seulement quand l'écriture pose elle-même
-- updated_at (ticks du desktop) ou à la création.
CREATE OR REPLACE FUNCTION public.webapp_session_state_touch()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.updated_at IS DISTINCT FROM OLD.updated_at THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$function$;
