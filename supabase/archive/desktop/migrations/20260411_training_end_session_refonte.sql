-- feat-training-end-session-refonte
-- Ajoute les métriques backend (best_aero_score, min_surface_m2, aero_qualified_s)
-- et la table user_onboarding_answers pour le mini-questionnaire post-séance.

-- ──────────────────────────────────────────────────────────────────
-- 1. Colonnes sur sessions + user_bests
-- ──────────────────────────────────────────────────────────────────

ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS best_aero_score JSONB DEFAULT '[]'::jsonb;

ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS min_surface_m2 FLOAT;

ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS aero_qualified_s INTEGER DEFAULT 0;

ALTER TABLE public.user_bests
  ADD COLUMN IF NOT EXISTS best_aero_score JSONB DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.sessions.best_aero_score IS
  'Best aero_score per 13 time windows : [[window_s, score_float], ...]';
COMMENT ON COLUMN public.sessions.min_surface_m2 IS
  'Minimum surface_m2 over entire session (used for FTP-based W/m2 potential calc)';
COMMENT ON COLUMN public.sessions.aero_qualified_s IS
  'Seconds with aero_score > 0.5 (accumulates all-time via RiderProgressionService)';

-- ──────────────────────────────────────────────────────────────────
-- 2. Table user_onboarding_answers
-- ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.user_onboarding_answers (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  answered_at timestamptz NOT NULL DEFAULT now(),
  objective text NOT NULL CHECK (objective IN ('training','competition','evaluation')),
  time_budget text NOT NULL CHECK (time_budget IN ('low','medium','high')),
  pain_severity text NOT NULL CHECK (pain_severity IN ('none','light','severe')),
  pain_zones text[] NOT NULL DEFAULT '{}',
  recommended_primary text,
  recommended_premium text,
  chosen text
);

ALTER TABLE public.user_onboarding_answers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rider_can_read_own" ON public.user_onboarding_answers;
CREATE POLICY "rider_can_read_own" ON public.user_onboarding_answers
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "rider_can_insert_own" ON public.user_onboarding_answers;
CREATE POLICY "rider_can_insert_own" ON public.user_onboarding_answers
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "rider_can_update_own" ON public.user_onboarding_answers;
CREATE POLICY "rider_can_update_own" ON public.user_onboarding_answers
  FOR UPDATE USING (auth.uid() = user_id);
