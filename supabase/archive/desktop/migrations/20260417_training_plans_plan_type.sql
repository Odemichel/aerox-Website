-- 20260417_training_plans_plan_type.sql
-- Adds plan_type classification to training_plans.
-- Values: 'training' (default, existing flow) | 'diagnostic' | 'fitting'.
-- When a rider executes a session from a plan, this value will populate
-- sessions.session_type so analytics/summary pages can filter accordingly.
-- Idempotent + additive — nullable so existing seeds stay valid.

ALTER TABLE public.training_plans
  ADD COLUMN IF NOT EXISTS plan_type TEXT
  CHECK (plan_type IS NULL OR plan_type IN ('training', 'diagnostic', 'fitting'));

-- Backfill the welcome seed to the default training type.
UPDATE public.training_plans
SET plan_type = 'training'
WHERE plan_type IS NULL
  AND name_key = 'plan_welcome_name';
