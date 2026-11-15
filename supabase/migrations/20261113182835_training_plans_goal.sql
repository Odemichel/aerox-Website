-- Objectif principal de chaque plan, pour le tri du catalogue (app desktop).
-- base | endurance | power | threshold | vo2 | race_tt | race_tri
ALTER TABLE public.training_plans ADD COLUMN IF NOT EXISTS goal text;

UPDATE public.training_plans SET goal = CASE
  WHEN name_key LIKE 'base\_%' THEN 'base'
  WHEN name_key LIKE 'endurance\_%' THEN 'endurance'
  WHEN name_key LIKE 'sprint\_%' THEN 'power'
  WHEN name_key LIKE 'threshold\_%' THEN 'threshold'
  WHEN name_key LIKE 'vo2\_%' THEN 'vo2'
  WHEN name_key LIKE 'clm\_%' THEN 'race_tt'
  WHEN name_key LIKE 'triathlon\_%' THEN 'race_tri'
END
WHERE goal IS NULL AND duration_weeks > 1;
