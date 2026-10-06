-- feat-diag-s2-progressive-blocks : Séance 2 en blocs progressifs.
-- Ajoute les métadonnées de blocs, warnings, best_A_5min, baseline min1,
-- badges d'aptitude par distance de course, et raison d'arrêt.
--
-- Migration purement additive. Rollback safe (DROP COLUMN sur les 6 colonnes).

ALTER TABLE public.diagnostic_basic_s2
  ADD COLUMN IF NOT EXISTS stability_blocks JSONB,
  ADD COLUMN IF NOT EXISTS warnings         JSONB,
  ADD COLUMN IF NOT EXISTS best_a_5min_m2   DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS a_ref_min1_m2    DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS aptitude_badges  TEXT[],
  ADD COLUMN IF NOT EXISTS stop_reason      TEXT;

ALTER TABLE public.diagnostic_basic_s2
  DROP CONSTRAINT IF EXISTS diagnostic_basic_s2_stop_reason_check;

ALTER TABLE public.diagnostic_basic_s2
  ADD CONSTRAINT diagnostic_basic_s2_stop_reason_check
    CHECK (stop_reason IS NULL OR stop_reason IN
      ('user_stop','warning_timeout','warnings_exceeded','im_completed','block1_incomplete'));

CREATE INDEX IF NOT EXISTS idx_diag_s2_badges
  ON public.diagnostic_basic_s2 USING GIN (aptitude_badges);

COMMENT ON COLUMN public.diagnostic_basic_s2.stability_blocks IS
  'Array of {index, duration_s, validated, warnings_count, mean_surface_m2} — one entry per block';
COMMENT ON COLUMN public.diagnostic_basic_s2.warnings IS
  'Array of {triggered_at_s, resolved_at_s, peak_delta_pct, block_index} — chronological warnings log';
COMMENT ON COLUMN public.diagnostic_basic_s2.aptitude_badges IS
  'Ordered subset of [clm_court, 40km, 70_3, im] — badges earned during the session';
COMMENT ON COLUMN public.diagnostic_basic_s2.stop_reason IS
  'Why the session ended: user_stop, warning_timeout, warnings_exceeded, im_completed, block1_incomplete';
