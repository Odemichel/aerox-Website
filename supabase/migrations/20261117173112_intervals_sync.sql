-- feat-intervals-sync : Intervals.icu rejoint Strava dans les connexions aux
-- services tiers (mêmes tables, mêmes règles d'accès).
--
-- * provider 'intervals' accepté par user_integrations, oauth_states et
--   session_exports ;
-- * refresh_token et expires_at facultatifs : Intervals ne documente ni
--   jeton de renouvellement ni expiration (Strava les remplit toujours) ;
-- * scope lisible par l'app (permissions accordées, pas un secret) : elle
--   masque l'envoi ou les séances planifiées selon ce qui a été accordé.

alter table public.user_integrations
  drop constraint user_integrations_provider_check,
  add constraint user_integrations_provider_check check (provider in ('strava', 'intervals'));

alter table public.oauth_states
  drop constraint oauth_states_provider_check,
  add constraint oauth_states_provider_check check (provider in ('strava', 'intervals'));

alter table public.session_exports
  drop constraint session_exports_provider_check,
  add constraint session_exports_provider_check check (provider in ('strava', 'intervals'));

alter table public.user_integrations
  alter column refresh_token drop not null,
  alter column expires_at drop not null,
  add constraint user_integrations_strava_refresh check (
    provider <> 'strava' or (refresh_token is not null and expires_at is not null)
  );

grant select (scope) on public.user_integrations to authenticated;
