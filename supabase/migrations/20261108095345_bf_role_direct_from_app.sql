-- Inscription bike fitter depuis l'app desktop : même parcours que le site.
--
-- Avant : choisir « bike fitter » à l'onboarding de l'app passait le compte
-- en `pending_bf`, en attente d'une validation manuelle de l'admin ; le
-- bike fitter ne pouvait ni choisir d'offre ni enregistrer de carte (le
-- Checkout du site refuse `pending_bf`, E_ROLE).
--
-- Désormais (parcours du site, validé à l'installation) : le compte devient
-- `bike-fitter` tout de suite. Les déclencheurs existants font le reste :
-- `bf_billing_on_role_granted` ouvre la fiche de facturation (essai non
-- démarré), `notify_admin_new_bf` prévient l'admin, `crm_on_bf_signup`
-- crée le contact. Le bike fitter choisit son offre et enregistre sa carte
-- dans son espace du site ; l'essai de 14 jours naît à l'installation.
--
-- Un compte encore `pending_bf` (ancien parcours) qui rappelle la fonction
-- devient lui aussi `bike-fitter` (conversion à l'ouverture de l'app, pas
-- de mise à jour en masse).
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
  IF _role = 'bike-fitter' THEN
    RETURN _role;
  END IF;
  IF _role = 'pending_bf' THEN
    UPDATE public.users SET role = 'bike-fitter' WHERE id = _uid;
    RETURN 'bike-fitter';
  END IF;
  IF _role IS DISTINCT FROM 'rider' OR coalesce(_onboarded, false) THEN
    RAISE EXCEPTION 'role change not allowed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.bf_role_requests r
                 WHERE r.user_id = _uid AND r.requested_at > now() - interval '24 hours') THEN
    INSERT INTO public.bf_role_requests (user_id) VALUES (_uid);
    PERFORM set_config('aerox.bf_request_new', '1', true);
  END IF;
  UPDATE public.users SET role = 'bike-fitter' WHERE id = _uid;
  RETURN 'bike-fitter';
END;
$function$;
