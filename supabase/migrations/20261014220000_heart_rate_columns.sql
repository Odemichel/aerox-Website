-- feat-ble-heart-rate (veloaero) : fréquence cardiaque d'un capteur BLE
-- (Heart Rate Service) connecté au desktop.
--
-- sessions : FC moyenne et max de la séance, calculées côté Rust sur les
-- secondes où une FC a été mesurée. NULL = pas de capteur FC.
-- webapp_session_state : FC instantanée poussée par le desktop (2 Hz) pour
-- l'affichage live mobile. NULL = pas de capteur FC.
--
-- Droits : accordés au niveau table (pas de liste blanche de colonnes sur ces
-- deux tables), aucune politique RLS à modifier.

alter table public.sessions
  add column if not exists avg_hr smallint,
  add column if not exists max_hr smallint;

comment on column public.sessions.avg_hr is
  'FC moyenne de la séance (bpm), secondes sans mesure exclues. NULL sans capteur FC. feat-ble-heart-rate.';
comment on column public.sessions.max_hr is
  'FC max de la séance (bpm). NULL sans capteur FC. feat-ble-heart-rate.';

alter table public.webapp_session_state
  add column if not exists heart_rate smallint;

comment on column public.webapp_session_state.heart_rate is
  'FC instantanée (bpm) du capteur BLE connecté au desktop, pour le live mobile. NULL sans capteur ou mesure périmée. feat-ble-heart-rate.';
