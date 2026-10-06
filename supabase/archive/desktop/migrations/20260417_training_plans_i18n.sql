-- 20260417_training_plans_i18n.sql
-- Adds translations_json to training_plans and training_sessions.
-- Structure: { "name": {"fr":"...","en":"..."}, "description": {...}, "objective": {...} }
-- Also ensures training_sessions has admin write policy (seeded rows relied on SELECT only).

ALTER TABLE public.training_plans
  ADD COLUMN IF NOT EXISTS translations_json JSONB;

ALTER TABLE public.training_sessions
  ADD COLUMN IF NOT EXISTS translations_json JSONB;

-- Enable RLS on training_sessions so the policies below actually apply.
-- Idempotent on tables where RLS is already enabled.
ALTER TABLE public.training_sessions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'training_sessions'
      AND policyname = 'Admin manages training sessions'
  ) THEN
    CREATE POLICY "Admin manages training sessions" ON public.training_sessions
      FOR ALL
      USING ((SELECT role FROM public.users WHERE id = auth.uid()) = 'admin')
      WITH CHECK ((SELECT role FROM public.users WHERE id = auth.uid()) = 'admin');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'training_sessions'
      AND policyname = 'Read training sessions'
  ) THEN
    CREATE POLICY "Read training sessions" ON public.training_sessions
      FOR SELECT USING (true);
  END IF;
END$$;
