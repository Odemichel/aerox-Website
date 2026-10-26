-- Suite de audit6_fixes : l'upsert de départ (sans session_state) arrivé en
-- retard après la fin du même run remettait is_active à vrai. Toute
-- réactivation d'un run terminé (completed, unsaved) est ignorée.
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
     AND (lower(coalesce(NEW.session_state, '')) IN ('running', 'paused', 'ending')
          OR coalesce(NEW.is_active, false)) THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.updated_at IS DISTINCT FROM OLD.updated_at THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$function$;
