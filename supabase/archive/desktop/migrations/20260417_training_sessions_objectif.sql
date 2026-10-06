-- Add objectif column (nullable, mirror logic of name/info: slug-key or free text).
ALTER TABLE public.training_sessions
  ADD COLUMN IF NOT EXISTS objectif text;

-- Ensure plan_sessions.training_session_id cascades on delete.
-- No-op if CASCADE already set.
DO $$
DECLARE
  current_rule text;
BEGIN
  SELECT rc.delete_rule INTO current_rule
  FROM information_schema.referential_constraints rc
  JOIN information_schema.key_column_usage kcu
    ON rc.constraint_name = kcu.constraint_name
  WHERE kcu.table_schema = 'public'
    AND kcu.table_name = 'plan_sessions'
    AND kcu.column_name = 'training_session_id';

  IF current_rule IS DISTINCT FROM 'CASCADE' THEN
    EXECUTE 'ALTER TABLE public.plan_sessions
             DROP CONSTRAINT IF EXISTS plan_sessions_training_session_id_fkey';
    EXECUTE 'ALTER TABLE public.plan_sessions
             ADD CONSTRAINT plan_sessions_training_session_id_fkey
             FOREIGN KEY (training_session_id)
             REFERENCES public.training_sessions(id)
             ON DELETE CASCADE';
  END IF;
END $$;
