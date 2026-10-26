-- Audit Supabase 2026-10-26.

-- 1. Job pg_cron `insta-scheduler` : `x-cron-secret` écrit en clair dans
--    `cron.job.command` (lisible par tout accès SQL / dashboard). La valeur
--    actuelle est déplacée dans le Vault (`insta_cron_secret`, même valeur :
--    l'Edge Function `insta-scheduler` n'est pas touchée) et la commande la
--    lit à chaque exécution. Le secret n'apparaît pas dans ce fichier.
DO $$
DECLARE
  _cmd text;
  _secret text;
BEGIN
  SELECT command INTO _cmd FROM cron.job WHERE jobname = 'insta-scheduler';
  IF _cmd IS NULL OR _cmd ~ 'vault\.decrypted_secrets' THEN
    RETURN; -- job absent ou déjà migré
  END IF;
  _secret := substring(_cmd FROM '''x-cron-secret''\s*,\s*''([^'']*)''');
  IF _secret IS NULL OR _secret = '' THEN
    RAISE EXCEPTION 'insta-scheduler : secret introuvable dans la commande';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'insta_cron_secret') THEN
    PERFORM vault.create_secret(_secret, 'insta_cron_secret',
      'x-cron-secret du job pg_cron insta-scheduler (= INSTA_CRON_SECRET de l''Edge Function)');
  END IF;
  PERFORM cron.alter_job(
    (SELECT jobid FROM cron.job WHERE jobname = 'insta-scheduler'),
    command := $cmd$
  select net.http_post(
    url := 'https://agvksgrjqskpetokudda.supabase.co/functions/v1/insta-scheduler',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'insta_cron_secret' limit 1)
    ),
    body := '{}'::jsonb, timeout_milliseconds := 60000)
$cmd$
  );
END $$;

-- 2. Création du profil à la confirmation de l'e-mail :
--    * l'échec de l'essai bike fitter (`bf_start_trial`) faisait échouer
--      toute la confirmation → inscription bloquée ; il est maintenant
--      journalisé (warning) et l'inscription aboutit ;
--    * un compte créé déjà confirmé (dashboard, création admin) n'obtenait
--      jamais de profil (trigger sur UPDATE seulement) : trigger AFTER
--      INSERT ajouté, même fonction.
--    La création du profil elle-même est inchangée (une erreur y reste
--    bloquante : un compte sans profil est inutilisable dans les apps).
CREATE OR REPLACE FUNCTION public.handle_email_confirmed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  _is_bf boolean := coalesce(new.raw_user_meta_data ->> 'profile_type', '') = 'bike-fitter';
  _confirmed_now boolean :=
    new.email_confirmed_at is not null
    and (tg_op = 'INSERT' or old.email_confirmed_at is null);
begin
  if _confirmed_now then
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

DROP TRIGGER IF EXISTS on_auth_user_created_confirmed ON auth.users;
CREATE TRIGGER on_auth_user_created_confirmed
  AFTER INSERT ON auth.users
  FOR EACH ROW
  WHEN (NEW.email_confirmed_at IS NOT NULL)
  EXECUTE FUNCTION public.handle_email_confirmed();
