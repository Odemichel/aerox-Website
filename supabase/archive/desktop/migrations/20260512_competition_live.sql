-- 20260512_competition_live.sql
-- feat-live-competition : tables riders + runs + leaderboards + RLS
--
-- Securité :
--  * competition_users : ADMIN-ONLY (email/age/created_by jamais exposés à anon)
--  * competition_runs  : ADMIN pour INSERT/UPDATE/DELETE, anon SELECT autorisé
--                        (nécessaire pour Realtime subscription côté webapp)
--  * Vues leaderboard  : SECURITY DEFINER intentionnel — pattern Supabase
--                        standard pour exposer des colonnes sanitized à anon
--                        sans donner accès à la table raw. L'advisor signale
--                        "security_definer_view" en ERROR : accepté car la vue
--                        ne SELECT que first_name, last_name + metrics.

-- ============================================================
-- TABLE: competition_users
-- ============================================================
CREATE TABLE IF NOT EXISTS public.competition_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text,
  first_name text NOT NULL,
  last_name text NOT NULL,
  age int2 NOT NULL CHECK (age BETWEEN 5 AND 99),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS competition_users_created_at_idx
  ON public.competition_users (created_at DESC);
CREATE INDEX IF NOT EXISTS competition_users_email_idx
  ON public.competition_users (email);

-- ============================================================
-- TABLE: competition_runs
-- ============================================================
CREATE TABLE IF NOT EXISTS public.competition_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL
    REFERENCES public.competition_users(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  best_watts_per_m2_30s int,
  best_speed_30s float,
  best_cda_300s float,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS competition_runs_user_id_idx
  ON public.competition_runs (user_id);
CREATE INDEX IF NOT EXISTS competition_runs_perf_idx
  ON public.competition_runs (best_watts_per_m2_30s DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS competition_runs_aero_idx
  ON public.competition_runs (best_cda_300s ASC NULLS LAST);

-- ============================================================
-- RLS
-- ============================================================
ALTER TABLE public.competition_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.competition_runs  ENABLE ROW LEVEL SECURITY;

-- competition_users : admin only (pas de SELECT anon → email protégé)
CREATE POLICY admin_all_competition_users
  ON public.competition_users
  FOR ALL
  USING (EXISTS (SELECT 1 FROM public.users
                 WHERE users.id = auth.uid() AND users.role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.users
                      WHERE users.id = auth.uid() AND users.role = 'admin'));

-- competition_runs : admin pour INSERT/UPDATE/DELETE
CREATE POLICY admin_all_competition_runs
  ON public.competition_runs
  FOR ALL
  USING (EXISTS (SELECT 1 FROM public.users
                 WHERE users.id = auth.uid() AND users.role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.users
                      WHERE users.id = auth.uid() AND users.role = 'admin'));

-- competition_runs : anon SELECT autorisé (nécessaire pour Realtime)
-- competition_runs ne contient pas de données personnelles
-- (uniquement metrics + UUIDs).
CREATE POLICY public_read_competition_runs
  ON public.competition_runs
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- ============================================================
-- VIEWS: leaderboards (SECURITY DEFINER intentionnel)
-- ============================================================
CREATE OR REPLACE VIEW public.competition_leaderboard_perf AS
SELECT DISTINCT ON (r.user_id)
  r.user_id,
  u.first_name,
  u.last_name,
  r.best_watts_per_m2_30s,
  r.best_speed_30s,
  r.ended_at
FROM public.competition_runs r
JOIN public.competition_users u ON u.id = r.user_id
WHERE r.best_watts_per_m2_30s IS NOT NULL
ORDER BY r.user_id, r.best_watts_per_m2_30s DESC;

CREATE OR REPLACE VIEW public.competition_leaderboard_aero AS
SELECT DISTINCT ON (r.user_id)
  r.user_id,
  u.first_name,
  u.last_name,
  r.best_cda_300s,
  r.ended_at
FROM public.competition_runs r
JOIN public.competition_users u ON u.id = r.user_id
WHERE r.best_cda_300s IS NOT NULL
ORDER BY r.user_id, r.best_cda_300s ASC;

GRANT SELECT ON public.competition_leaderboard_perf TO anon, authenticated;
GRANT SELECT ON public.competition_leaderboard_aero TO anon, authenticated;

COMMENT ON VIEW public.competition_leaderboard_perf IS
  'Public leaderboard view. SECURITY DEFINER intentionnel : la vue bypasse '
  'RLS pour permettre l''accès anon mais ne sélectionne QUE des colonnes '
  'sanitized (first_name, last_name, metrics). Pas d''email.';

COMMENT ON VIEW public.competition_leaderboard_aero IS
  'Public leaderboard view (CdA). Voir competition_leaderboard_perf pour la '
  'justification SECURITY DEFINER.';

-- ============================================================
-- Realtime publication
-- ============================================================
ALTER PUBLICATION supabase_realtime ADD TABLE public.competition_runs;
