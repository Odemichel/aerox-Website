-- feat-diagnostic-basic-schema
-- Dissocie complètement les données diagnostic des tables fitting/training.
-- Remplace `diagnostic_runs` par 3 tables dédiées :
--   • diagnostic_basic            — 1 diagnostic (N par rider, versionnés)
--   • diagnostic_basic_positions  — positions capturées en S1
--   • diagnostic_basic_s2         — sessions S2 (stabilité)
--
-- Règles produit :
--   • 1 rider = N diagnostics dans le temps
--   • 3 semaines pour finaliser un diagnostic (expires_at)
--   • S1 : ≤ 10 positions cumulées, ≤ 4 sessions
--   • S2 : ≤ 4 sessions, best_s2 = argmax(stability_score) parmi validated
--   • Session S1 avec 0 position n'incrémente PAS s1_sessions_count
--     (dérivé via COUNT(DISTINCT s1_session_index) — trigger)
--   • pg_cron 1×/jour → status='expired' si expires_at < now et in_progress
--   • DROP diagnostic_runs (paywall a bloqué tout usage réel en prod)

-- ============================================================================
-- 1. Enum status
-- ============================================================================
DO $$ BEGIN
  CREATE TYPE diagnostic_basic_status AS ENUM
    ('in_progress', 'completed', 'expired', 'archived');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================================
-- 2. Table diagnostic_basic
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.diagnostic_basic (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status                diagnostic_basic_status NOT NULL DEFAULT 'in_progress',
  started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at            TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '3 weeks'),
  completed_at          TIMESTAMPTZ,

  -- Compteurs dénormalisés (recomputés par triggers, servent aussi de garde)
  s1_sessions_count     INT NOT NULL DEFAULT 0
                        CHECK (s1_sessions_count BETWEEN 0 AND 4),
  s1_positions_count    INT NOT NULL DEFAULT 0
                        CHECK (s1_positions_count BETWEEN 0 AND 10),
  s2_sessions_count     INT NOT NULL DEFAULT 0
                        CHECK (s2_sessions_count BETWEEN 0 AND 4),

  -- Référence S2 canonique = meilleur stability_score parmi validated
  best_s2_id            UUID,  -- FK ajoutée après création de diagnostic_basic_s2

  -- Synthèse (calculée à completion)
  aero_zone             TEXT CHECK (aero_zone IN ('low', 'mid', 'high')),
  stability_zone        TEXT CHECK (stability_zone IN ('low', 'high')),
  recommendation_key    TEXT
);

COMMENT ON TABLE public.diagnostic_basic IS
  'Diagnostic AeroX Basic. 1 diagnostic = ≤4 sessions S1 (10 positions max) + ≤4 sessions S2. 3 semaines pour finaliser.';

-- Un seul diagnostic in_progress par user
CREATE UNIQUE INDEX IF NOT EXISTS uniq_diagnostic_basic_in_progress
  ON public.diagnostic_basic (user_id)
  WHERE status = 'in_progress';

CREATE INDEX IF NOT EXISTS idx_diagnostic_basic_user_status
  ON public.diagnostic_basic (user_id, status);

CREATE INDEX IF NOT EXISTS idx_diagnostic_basic_expires
  ON public.diagnostic_basic (expires_at)
  WHERE status = 'in_progress';

-- ============================================================================
-- 3. Table diagnostic_basic_positions
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.diagnostic_basic_positions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  diagnostic_id         UUID NOT NULL
                        REFERENCES public.diagnostic_basic(id) ON DELETE CASCADE,
  s1_session_index      INT NOT NULL CHECK (s1_session_index BETWEEN 1 AND 4),
  name                  TEXT NOT NULL,
  cda                   DOUBLE PRECISION,
  surface_m2            DOUBLE PRECISION,
  aero_score            DOUBLE PRECISION,
  mask_png              BYTEA NOT NULL,
  mask_url              TEXT,
  note                  TEXT,
  captured_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.diagnostic_basic_positions IS
  'Positions capturées en S1. CASCADE delete via diagnostic_id.';

CREATE INDEX IF NOT EXISTS idx_diagnostic_basic_positions_diagnostic
  ON public.diagnostic_basic_positions (diagnostic_id);

-- ============================================================================
-- 4. Table diagnostic_basic_s2
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.diagnostic_basic_s2 (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  diagnostic_id         UUID NOT NULL
                        REFERENCES public.diagnostic_basic(id) ON DELETE CASCADE,
  session_index         INT NOT NULL CHECK (session_index BETWEEN 1 AND 4),
  duration_s            INT NOT NULL,
  stability_score       DOUBLE PRECISION NOT NULL,
  avg_surface_m2        DOUBLE PRECISION,
  avg_aero_score        DOUBLE PRECISION,
  time_series_5s        JSONB,
  validated             BOOLEAN NOT NULL,
  captured_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.diagnostic_basic_s2 IS
  'Sessions S2 (stabilité). ≤4 par diagnostic. Validée si durée ≥ 25 min (1500 s).';

CREATE INDEX IF NOT EXISTS idx_diagnostic_basic_s2_diagnostic
  ON public.diagnostic_basic_s2 (diagnostic_id);

CREATE INDEX IF NOT EXISTS idx_diagnostic_basic_s2_stability
  ON public.diagnostic_basic_s2 (diagnostic_id, stability_score DESC);

-- FK best_s2_id (résolution de la circularité — les deux tables existent maintenant)
ALTER TABLE public.diagnostic_basic
  DROP CONSTRAINT IF EXISTS diagnostic_basic_best_s2_fk;
ALTER TABLE public.diagnostic_basic
  ADD CONSTRAINT diagnostic_basic_best_s2_fk
  FOREIGN KEY (best_s2_id) REFERENCES public.diagnostic_basic_s2(id)
  ON DELETE SET NULL;

-- ============================================================================
-- 5. Triggers de recompute (compteurs S1, S2, best_s2_id)
-- ============================================================================
-- Recompute s1_positions_count + s1_sessions_count (COUNT DISTINCT session_index)
-- après INSERT/DELETE dans positions.
CREATE OR REPLACE FUNCTION public.recompute_diagnostic_basic_s1_counts()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_id UUID := COALESCE(NEW.diagnostic_id, OLD.diagnostic_id);
BEGIN
  UPDATE public.diagnostic_basic
  SET s1_positions_count = (
        SELECT COUNT(*) FROM public.diagnostic_basic_positions
        WHERE diagnostic_id = target_id
      ),
      s1_sessions_count = (
        SELECT COUNT(DISTINCT s1_session_index) FROM public.diagnostic_basic_positions
        WHERE diagnostic_id = target_id
      )
  WHERE id = target_id;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_recompute_s1_counts ON public.diagnostic_basic_positions;
CREATE TRIGGER trg_recompute_s1_counts
  AFTER INSERT OR DELETE
  ON public.diagnostic_basic_positions
  FOR EACH ROW
  EXECUTE FUNCTION public.recompute_diagnostic_basic_s1_counts();

-- Recompute s2_sessions_count après INSERT/DELETE dans s2.
CREATE OR REPLACE FUNCTION public.recompute_diagnostic_basic_s2_count()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_id UUID := COALESCE(NEW.diagnostic_id, OLD.diagnostic_id);
BEGIN
  UPDATE public.diagnostic_basic
  SET s2_sessions_count = (
        SELECT COUNT(*) FROM public.diagnostic_basic_s2
        WHERE diagnostic_id = target_id
      )
  WHERE id = target_id;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_recompute_s2_count ON public.diagnostic_basic_s2;
CREATE TRIGGER trg_recompute_s2_count
  AFTER INSERT OR DELETE
  ON public.diagnostic_basic_s2
  FOR EACH ROW
  EXECUTE FUNCTION public.recompute_diagnostic_basic_s2_count();

-- Recompute best_s2_id après INSERT/UPDATE stability_score/validated.
CREATE OR REPLACE FUNCTION public.recompute_diagnostic_basic_best_s2()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.diagnostic_basic
  SET best_s2_id = (
        SELECT id
        FROM public.diagnostic_basic_s2
        WHERE diagnostic_id = NEW.diagnostic_id
          AND validated = TRUE
        ORDER BY stability_score DESC, captured_at DESC
        LIMIT 1
      )
  WHERE id = NEW.diagnostic_id;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_recompute_best_s2 ON public.diagnostic_basic_s2;
CREATE TRIGGER trg_recompute_best_s2
  AFTER INSERT OR UPDATE OF stability_score, validated
  ON public.diagnostic_basic_s2
  FOR EACH ROW
  EXECUTE FUNCTION public.recompute_diagnostic_basic_best_s2();

-- ============================================================================
-- 6. Fonction d'expiration + pg_cron
-- ============================================================================
CREATE OR REPLACE FUNCTION public.expire_stale_diagnostic_basic()
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  affected INT;
BEGIN
  UPDATE public.diagnostic_basic
  SET status = 'expired'
  WHERE status = 'in_progress'
    AND expires_at < now();
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

-- pg_cron : job quotidien à 3h UTC — idempotent
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'expire_diagnostic_basic_daily') THEN
    PERFORM cron.unschedule('expire_diagnostic_basic_daily');
  END IF;
END $$;

SELECT cron.schedule(
  'expire_diagnostic_basic_daily',
  '0 3 * * *',
  $$SELECT public.expire_stale_diagnostic_basic();$$
);

-- ============================================================================
-- 7. RLS
-- ============================================================================
ALTER TABLE public.diagnostic_basic ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diagnostic_basic_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diagnostic_basic_s2 ENABLE ROW LEVEL SECURITY;

-- diagnostic_basic
DROP POLICY IF EXISTS "user_read_own_diag" ON public.diagnostic_basic;
CREATE POLICY "user_read_own_diag" ON public.diagnostic_basic
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "user_insert_own_diag" ON public.diagnostic_basic;
CREATE POLICY "user_insert_own_diag" ON public.diagnostic_basic
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "user_update_own_diag" ON public.diagnostic_basic;
CREATE POLICY "user_update_own_diag" ON public.diagnostic_basic
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "admin_read_all_diag" ON public.diagnostic_basic;
CREATE POLICY "admin_read_all_diag" ON public.diagnostic_basic
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin')
  );

-- diagnostic_basic_positions (via join diagnostic_id → user_id)
DROP POLICY IF EXISTS "user_read_own_diag_pos" ON public.diagnostic_basic_positions;
CREATE POLICY "user_read_own_diag_pos" ON public.diagnostic_basic_positions
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.diagnostic_basic
            WHERE id = diagnostic_id AND user_id = auth.uid())
  );

DROP POLICY IF EXISTS "user_insert_own_diag_pos" ON public.diagnostic_basic_positions;
CREATE POLICY "user_insert_own_diag_pos" ON public.diagnostic_basic_positions
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM public.diagnostic_basic
            WHERE id = diagnostic_id AND user_id = auth.uid())
  );

DROP POLICY IF EXISTS "user_update_own_diag_pos" ON public.diagnostic_basic_positions;
CREATE POLICY "user_update_own_diag_pos" ON public.diagnostic_basic_positions
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM public.diagnostic_basic
            WHERE id = diagnostic_id AND user_id = auth.uid())
  );

DROP POLICY IF EXISTS "user_delete_own_diag_pos" ON public.diagnostic_basic_positions;
CREATE POLICY "user_delete_own_diag_pos" ON public.diagnostic_basic_positions
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM public.diagnostic_basic
            WHERE id = diagnostic_id AND user_id = auth.uid())
  );

DROP POLICY IF EXISTS "admin_read_all_diag_pos" ON public.diagnostic_basic_positions;
CREATE POLICY "admin_read_all_diag_pos" ON public.diagnostic_basic_positions
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin')
  );

-- diagnostic_basic_s2
DROP POLICY IF EXISTS "user_read_own_diag_s2" ON public.diagnostic_basic_s2;
CREATE POLICY "user_read_own_diag_s2" ON public.diagnostic_basic_s2
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.diagnostic_basic
            WHERE id = diagnostic_id AND user_id = auth.uid())
  );

DROP POLICY IF EXISTS "user_insert_own_diag_s2" ON public.diagnostic_basic_s2;
CREATE POLICY "user_insert_own_diag_s2" ON public.diagnostic_basic_s2
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM public.diagnostic_basic
            WHERE id = diagnostic_id AND user_id = auth.uid())
  );

DROP POLICY IF EXISTS "user_update_own_diag_s2" ON public.diagnostic_basic_s2;
CREATE POLICY "user_update_own_diag_s2" ON public.diagnostic_basic_s2
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM public.diagnostic_basic
            WHERE id = diagnostic_id AND user_id = auth.uid())
  );

DROP POLICY IF EXISTS "admin_read_all_diag_s2" ON public.diagnostic_basic_s2;
CREATE POLICY "admin_read_all_diag_s2" ON public.diagnostic_basic_s2
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin')
  );

-- ============================================================================
-- 8. Migration de données depuis diagnostic_runs vers diagnostic_basic
-- ============================================================================
-- Rapatrie chaque run existant. Triggers désactivés pendant le transfert
-- pour éviter que les recompute écrasent les compteurs importés.
DO $$
DECLARE
  r RECORD;
  sess_id UUID;
  sess_idx INT;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'diagnostic_runs') THEN

    ALTER TABLE public.diagnostic_basic_positions DISABLE TRIGGER trg_recompute_s1_counts;
    ALTER TABLE public.diagnostic_basic_s2 DISABLE TRIGGER trg_recompute_s2_count;
    ALTER TABLE public.diagnostic_basic_s2 DISABLE TRIGGER trg_recompute_best_s2;

    FOR r IN SELECT * FROM public.diagnostic_runs LOOP
      -- Shell du diagnostic
      INSERT INTO public.diagnostic_basic (
        id, user_id, status, started_at, expires_at, completed_at,
        s1_positions_count, aero_zone, stability_zone, recommendation_key
      ) VALUES (
        r.id,
        r.user_id,
        r.status::text::diagnostic_basic_status,
        r.started_at,
        r.started_at + INTERVAL '3 weeks',
        r.completed_at,
        r.s1_positions_count,
        r.aero_zone,
        r.stability_zone,
        r.recommendation_key
      );

      -- Positions S1 : itère sur s1_session_ids, s1_session_index = ordre d'ajout (1..N)
      sess_idx := 0;
      FOREACH sess_id IN ARRAY r.s1_session_ids LOOP
        sess_idx := sess_idx + 1;
        EXIT WHEN sess_idx > 4;
        INSERT INTO public.diagnostic_basic_positions (
          diagnostic_id, s1_session_index, name, cda, surface_m2, aero_score,
          mask_png, mask_url, note, captured_at
        )
        SELECT r.id, sess_idx, sp.name, sp.cda, sp.surface_m2, sp.aero_score,
               sp.mask_png, NULL, sp.note,
               to_timestamp(sp.timestamp_ms / 1000.0)
        FROM public.session_positions sp
        WHERE sp.session_id = sess_id::text;
      END LOOP;

      -- S2 : recompose depuis sessions + diagnostic_runs (seul le résumé était dénormalisé)
      IF r.s2_session_id IS NOT NULL THEN
        INSERT INTO public.diagnostic_basic_s2 (
          diagnostic_id, session_index, duration_s, stability_score,
          avg_surface_m2, avg_aero_score, time_series_5s, validated, captured_at
        )
        SELECT r.id, 1,
               COALESCE(s.duration_s, 0),
               COALESCE(r.s2_stability_score, 0),
               r.s2_avg_surface_m2,
               r.s2_avg_aero_score,
               s.time_series_5s,
               r.s2_validated,
               COALESCE(s.created_at, r.started_at)
        FROM public.sessions s
        WHERE s.id = r.s2_session_id;
      END IF;
    END LOOP;

    -- Réactive triggers + recompute compteurs (pour cohérence)
    ALTER TABLE public.diagnostic_basic_positions ENABLE TRIGGER trg_recompute_s1_counts;
    ALTER TABLE public.diagnostic_basic_s2 ENABLE TRIGGER trg_recompute_s2_count;
    ALTER TABLE public.diagnostic_basic_s2 ENABLE TRIGGER trg_recompute_best_s2;

    UPDATE public.diagnostic_basic db SET
      s1_positions_count = (SELECT COUNT(*) FROM public.diagnostic_basic_positions WHERE diagnostic_id = db.id),
      s1_sessions_count = (SELECT COUNT(DISTINCT s1_session_index) FROM public.diagnostic_basic_positions WHERE diagnostic_id = db.id),
      s2_sessions_count = (SELECT COUNT(*) FROM public.diagnostic_basic_s2 WHERE diagnostic_id = db.id);

    UPDATE public.diagnostic_basic db SET best_s2_id = (
      SELECT id FROM public.diagnostic_basic_s2
      WHERE diagnostic_id = db.id AND validated = TRUE
      ORDER BY stability_score DESC, captured_at DESC
      LIMIT 1
    );
  END IF;
END $$;

-- ============================================================================
-- 9. DROP ancien schéma diagnostic_runs
-- ============================================================================
DROP TABLE IF EXISTS public.diagnostic_runs CASCADE;
DROP TYPE  IF EXISTS diagnostic_run_status;
