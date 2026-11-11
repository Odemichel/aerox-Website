-- feat-strava-sync, durcissement après revue de sécurité :
-- * oauth_states.browser_nonce_hash : le retour d'autorisation n'est
--   accepté que dans le navigateur qui a ouvert la connexion (cookie) ;
-- * un compte Strava n'est lié qu'à un seul utilisateur AeroX ;
-- * session_exports.attempts : nombre d'envois d'une séance, plafonné.

alter table public.oauth_states
  add column browser_nonce_hash text;

alter table public.user_integrations
  add constraint user_integrations_athlete_not_empty check (provider_athlete_id <> '');

create unique index user_integrations_provider_athlete_key
  on public.user_integrations (provider, provider_athlete_id);

alter table public.session_exports
  add column attempts integer not null default 0;
