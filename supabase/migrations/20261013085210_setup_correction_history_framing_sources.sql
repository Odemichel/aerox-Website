-- supabase/migrations/20261013100000_setup_correction_history_framing_sources.sql
--
-- App desktop (feat-k-history) : la position relevée tenue pendant le cadrage
-- de la calibration caméra est mesurée. Deux nouvelles origines de k :
--   - framing_calibration : caméra sans k, k du cadrage pris comme k de
--     calibration (la pose n'est pas redemandée) ;
--   - framing_ok : caméra avec k, k du cadrage concordant avec la médiane des
--     5 derniers (calibration confirmée, contrôle de la 1re séance dispensé).
-- calibration_telemetry.check_status n'a pas de contrainte : rien à changer.

alter table public.setup_correction_history
  drop constraint if exists setup_correction_history_source_check;

alter table public.setup_correction_history
  add constraint setup_correction_history_source_check
  check (source = any (array[
    'calibration',
    'session_ok',
    'session_corrected',
    'bf_reference',
    'framing_calibration',
    'framing_ok'
  ]));
