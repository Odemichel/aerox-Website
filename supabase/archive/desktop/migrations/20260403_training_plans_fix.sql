-- ============================================================
-- FIX MIGRATION : training_plans, plan_sessions
-- Fixes: NOT NULL guards, ON DELETE CASCADE, RLS admin policies, indexes
-- ============================================================

-- ============================================================
-- C1 — SET NOT NULL on pre-existing nullable columns
-- ============================================================

DO $$ BEGIN
  ALTER TABLE training_plans ALTER COLUMN duration_weeks SET NOT NULL;
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE training_plans ALTER COLUMN is_active SET NOT NULL;
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE training_plans ALTER COLUMN difficulty SET NOT NULL;
EXCEPTION WHEN others THEN NULL;
END $$;

-- Ensure CHECK constraint on difficulty exists (idempotent via name)
DO $$ BEGIN
  ALTER TABLE training_plans
    ADD CONSTRAINT training_plans_difficulty_check
    CHECK (difficulty IN ('beginner', 'intermediate', 'advanced'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- C3 — Recreate plan_sessions.training_session_id FK with ON DELETE CASCADE
-- ============================================================

DO $$ BEGIN
  -- Drop the existing FK if it exists (any name)
  DECLARE
    _constraint_name TEXT;
  BEGIN
    SELECT conname INTO _constraint_name
    FROM pg_constraint
    WHERE conrelid = 'plan_sessions'::regclass
      AND contype = 'f'
      AND conkey = ARRAY[
        (SELECT attnum FROM pg_attribute
         WHERE attrelid = 'plan_sessions'::regclass
           AND attname = 'training_session_id')
      ]::smallint[];

    IF _constraint_name IS NOT NULL THEN
      EXECUTE 'ALTER TABLE plan_sessions DROP CONSTRAINT ' || quote_ident(_constraint_name);
    END IF;
  END;
END $$;

ALTER TABLE plan_sessions
  ADD CONSTRAINT plan_sessions_training_session_id_fkey
  FOREIGN KEY (training_session_id)
  REFERENCES training_sessions(id)
  ON DELETE CASCADE;

-- ============================================================
-- C2 — Admin write policies on training_plans and plan_sessions
-- ============================================================

-- training_plans: admin ALL (INSERT, UPDATE, DELETE)
DROP POLICY IF EXISTS "Admin manages plans" ON training_plans;
CREATE POLICY "Admin manages plans"
  ON training_plans
  FOR ALL
  USING (
    (SELECT role FROM public.users WHERE id = auth.uid()) = 'admin'
  )
  WITH CHECK (
    (SELECT role FROM public.users WHERE id = auth.uid()) = 'admin'
  );

-- plan_sessions: admin ALL (INSERT, UPDATE, DELETE)
DROP POLICY IF EXISTS "Admin manages plan sessions" ON plan_sessions;
CREATE POLICY "Admin manages plan sessions"
  ON plan_sessions
  FOR ALL
  USING (
    (SELECT role FROM public.users WHERE id = auth.uid()) = 'admin'
  )
  WITH CHECK (
    (SELECT role FROM public.users WHERE id = auth.uid()) = 'admin'
  );

-- ============================================================
-- I1 — Missing indexes on FK columns
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_plan_sessions_training_session_id
  ON plan_sessions (training_session_id);

CREATE INDEX IF NOT EXISTS idx_user_plan_progress_user_id
  ON user_plan_progress (user_id);
