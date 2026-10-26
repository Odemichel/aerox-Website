-- supabase/migrations/20261011160000_calibration_telemetry_calibration_restored.sql
--
-- App desktop : la calibration géométrique peut être reprise de la séance
-- précédente quand le rider répond que son vélo et sa caméra n'ont pas bougé
-- (clics, largeur de cintre et distance rejoués au lieu d'être ressaisis).
-- La télémétrie distingue ces calibrations reprises des calibrations refaites.

alter table public.calibration_telemetry
  add column if not exists calibration_restored boolean not null default false;

comment on column public.calibration_telemetry.calibration_restored is
  'true quand la calibration géométrique a été reprise de la séance précédente (rider : « rien n''a bougé ») au lieu d''être refaite.';
