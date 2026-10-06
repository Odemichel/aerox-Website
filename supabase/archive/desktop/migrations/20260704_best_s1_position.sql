-- feat-best-s1-position
-- Symétrique à best_s2_id : diagnostic_basic.best_s1_position_id référence
-- la meilleure position S1 du diagnostic (argmax aero_score parmi les
-- positions cumulées, toutes S1 sessions confondues).

-- ============================================================================
-- 1. Colonne best_s1_position_id + FK
-- ============================================================================
ALTER TABLE public.diagnostic_basic
  ADD COLUMN IF NOT EXISTS best_s1_position_id UUID;

ALTER TABLE public.diagnostic_basic
  DROP CONSTRAINT IF EXISTS diagnostic_basic_best_s1_fk;

ALTER TABLE public.diagnostic_basic
  ADD CONSTRAINT diagnostic_basic_best_s1_fk
  FOREIGN KEY (best_s1_position_id)
  REFERENCES public.diagnostic_basic_positions(id)
  ON DELETE SET NULL;

-- ============================================================================
-- 2. Trigger : recompute best_s1_position_id
-- ============================================================================
-- Sélectionne la position d'aero_score maximum (tie-break par captured_at
-- ascendant pour privilégier la 1re en cas d'égalité — reproductible).
CREATE OR REPLACE FUNCTION public.recompute_diagnostic_basic_best_s1()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_id UUID := COALESCE(NEW.diagnostic_id, OLD.diagnostic_id);
BEGIN
  UPDATE public.diagnostic_basic
  SET best_s1_position_id = (
        SELECT id
        FROM public.diagnostic_basic_positions
        WHERE diagnostic_id = target_id
          AND aero_score IS NOT NULL
        ORDER BY aero_score DESC, captured_at ASC
        LIMIT 1
      )
  WHERE id = target_id;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_recompute_best_s1
  ON public.diagnostic_basic_positions;
CREATE TRIGGER trg_recompute_best_s1
  AFTER INSERT OR UPDATE OF aero_score OR DELETE
  ON public.diagnostic_basic_positions
  FOR EACH ROW
  EXECUTE FUNCTION public.recompute_diagnostic_basic_best_s1();

-- ============================================================================
-- 3. Backfill des diagnostics existants
-- ============================================================================
-- Un seul UPDATE par diagnostic — le trigger ne se déclenche pas sur cette
-- table donc pas de récursion.
UPDATE public.diagnostic_basic db
SET best_s1_position_id = (
  SELECT id
  FROM public.diagnostic_basic_positions
  WHERE diagnostic_id = db.id
    AND aero_score IS NOT NULL
  ORDER BY aero_score DESC, captured_at ASC
  LIMIT 1
)
WHERE best_s1_position_id IS NULL
  AND EXISTS (
    SELECT 1 FROM public.diagnostic_basic_positions
    WHERE diagnostic_id = db.id
  );
