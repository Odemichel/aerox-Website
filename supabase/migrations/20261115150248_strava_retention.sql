-- feat-strava-sync, conformité Strava API Agreement (Retention, Privacy) :
-- * nom de l'athlète : plus enregistré par strava-oauth-callback, effacé
--   des connexions existantes (colonne gardée : lue par les apps déployées) ;
-- * envois de séances : identifiants Strava (upload, activité) et message
--   d'erreur de Strava effacés 7 jours après le dernier envoi ; le statut
--   (envoyée ou non) reste, pour ne pas renvoyer la séance.

update public.user_integrations
   set athlete_name = null
 where provider = 'strava' and athlete_name is not null;

create or replace function public.purge_strava_export_ids()
returns void
language sql
security definer
set search_path = ''
as $$
  update public.session_exports
     set upload_id = null, activity_id = null, error = null
   where provider = 'strava'
     and updated_at < now() - interval '7 days'
     and (upload_id is not null or activity_id is not null or error is not null);
$$;

revoke all on function public.purge_strava_export_ids() from public, anon, authenticated;

select cron.schedule(
  'purge-strava-export-ids',
  '23 3 * * *',
  $$select public.purge_strava_export_ids()$$
);
