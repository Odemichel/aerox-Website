-- ============================================================================
-- feat-diagnostic-s1-comfort — score de confort par position S1
-- ============================================================================
-- Le rider note le confort de chaque position capturée en séance 1, sur la
-- même échelle 1-5 que le confort de fin de séance 2
-- (`diagnostic_basic_s2.comfort_score`, migration 20260705).
--
-- Nullable et le reste : la saisie est facultative ("Passer"). Toute lecture
-- doit traiter NULL comme « non renseigné », jamais comme zéro, sous peine de
-- fausser une moyenne.
-- ============================================================================

ALTER TABLE public.diagnostic_basic_positions
  ADD COLUMN IF NOT EXISTS comfort_score INT
    CHECK (comfort_score BETWEEN 1 AND 5);

COMMENT ON COLUMN public.diagnostic_basic_positions.comfort_score IS
  'Ressenti du rider sur cette position, 1 (très inconfortable) à 5 (très '
  'confortable). NULL = non renseigné. Saisi au dialogue post-capture.';
