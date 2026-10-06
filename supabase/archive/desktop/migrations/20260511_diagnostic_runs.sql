-- feat-diagnostic-aero-rider
-- Table diagnostic_runs : 1 run = N sessions S1 (jusqu'à 10 positions) + 1 session S2 (stabilité)
-- + flag d'entitlement sur public.users (paiement géré côté aerox-web)

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Type ENUM pour le statut du run
-- ────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE diagnostic_run_status AS ENUM ('in_progress', 'completed', 'archived');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Table diagnostic_runs
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.diagnostic_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  diagnostic_type TEXT NOT NULL DEFAULT 'basic'
                  CHECK (diagnostic_type IN ('basic', 'expert', 'complete')),
  status          diagnostic_run_status NOT NULL DEFAULT 'in_progress',
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,

  -- S1 : agrégation positions sur N sessions
  s1_positions_count INT    NOT NULL DEFAULT 0,
  s1_session_ids     UUID[] NOT NULL DEFAULT '{}',

  -- S2 : session unique stabilité (replacée si re-faite)
  s2_session_id      UUID,
  s2_validated       BOOLEAN NOT NULL DEFAULT FALSE,
  s2_stability_score DOUBLE PRECISION,
  s2_avg_surface_m2  DOUBLE PRECISION,
  s2_avg_aero_score  DOUBLE PRECISION,

  -- Synthèse calculée à completion
  aero_zone          TEXT CHECK (aero_zone IN ('low', 'mid', 'high')),
  stability_zone     TEXT CHECK (stability_zone IN ('low', 'high')),
  recommendation_key TEXT
);

COMMENT ON TABLE public.diagnostic_runs IS
  'feat-diagnostic-aero-rider: 1 run = N sessions S1 (positions) + 1 session S2 (stabilité). Paywall via users.diagnostic_basic_paid.';

-- Un seul run "in_progress" par user (pas de duplicates)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_diagnostic_run_in_progress
  ON public.diagnostic_runs (user_id)
  WHERE status = 'in_progress';

CREATE INDEX IF NOT EXISTS idx_diagnostic_runs_user_status
  ON public.diagnostic_runs (user_id, status);

-- ────────────────────────────────────────────────────────────────────────────
-- 3. RLS
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.diagnostic_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_read_own_runs" ON public.diagnostic_runs;
CREATE POLICY "user_read_own_runs" ON public.diagnostic_runs
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "user_insert_own_runs" ON public.diagnostic_runs;
CREATE POLICY "user_insert_own_runs" ON public.diagnostic_runs
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "user_update_own_runs" ON public.diagnostic_runs;
CREATE POLICY "user_update_own_runs" ON public.diagnostic_runs
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "admin_read_all_runs" ON public.diagnostic_runs;
CREATE POLICY "admin_read_all_runs" ON public.diagnostic_runs
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin')
  );

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Flag d'entitlement sur public.users (paiement)
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS diagnostic_basic_paid    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS diagnostic_basic_paid_at TIMESTAMPTZ;

COMMENT ON COLUMN public.users.diagnostic_basic_paid IS
  'feat-diagnostic-aero-rider: true si le user a payé les $79 du Diagnostique Basic. Set côté aerox-web après Stripe webhook.';
