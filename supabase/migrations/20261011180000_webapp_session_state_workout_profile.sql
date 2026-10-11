-- supabase/migrations/20261011180000_webapp_session_state_workout_profile.sql
--
-- Séance d'entraînement suivie sur la webapp compagnon : chrono du bloc et
-- profil de la séance (timeline), publiés par le desktop.
--   block_time_s   : secondes écoulées dans le bloc en cours (current_block,
--                    1-based). NULL : desktop plus ancien ou séance sans blocs.
--   workout_blocks : blocs de la séance tels que chargés par le desktop
--                    (type, duration_work, repetitions, duration_recup,
--                    power_start, power_end, unit), publiés au démarrage.
--                    NULL hors séance structurée.

alter table public.webapp_session_state
  add column if not exists block_time_s integer,
  add column if not exists workout_blocks jsonb;
