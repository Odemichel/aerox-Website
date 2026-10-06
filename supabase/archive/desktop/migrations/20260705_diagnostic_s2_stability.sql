-- feat-diagnostic-s2-stability : ajoute le lien position S1, score confort,
-- écart-type A, et étend la zone stabilité à 3 valeurs (low/mid/high) pour
-- la matrice de recos 3×3.

-- ============================================================================
-- 1. Nouvelles colonnes sur diagnostic_basic_s2
-- ============================================================================
ALTER TABLE public.diagnostic_basic_s2
  ADD COLUMN IF NOT EXISTS s1_position_id UUID
    REFERENCES public.diagnostic_basic_positions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS comfort_score  INT
    CHECK (comfort_score BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS std_surface_m2 DOUBLE PRECISION;

CREATE INDEX IF NOT EXISTS idx_diag_s2_position
  ON public.diagnostic_basic_s2 (diagnostic_id, s1_position_id);

-- ============================================================================
-- 2. Zone stabilité passe de ('low','high') à ('low','mid','high')
-- ============================================================================
ALTER TABLE public.diagnostic_basic
  DROP CONSTRAINT IF EXISTS diagnostic_basic_stability_zone_check;

ALTER TABLE public.diagnostic_basic
  ADD CONSTRAINT diagnostic_basic_stability_zone_check
    CHECK (stability_zone IS NULL OR stability_zone IN ('low', 'mid', 'high'));
