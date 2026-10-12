-- My Companion ouvert sur le smartphone : la webapp met à jour cette date
-- toutes les 20 s tant que la page est visible. Le desktop la lit au
-- démarrage d'une séance rider pour ne pas proposer la carte QR à un
-- rider dont le téléphone suit déjà la séance.
alter table public.webapp_session_state
  add column if not exists companion_seen_at timestamptz;

comment on column public.webapp_session_state.companion_seen_at is
  'Dernier signe de vie de My Companion (page visible), toutes les 20 s.';
