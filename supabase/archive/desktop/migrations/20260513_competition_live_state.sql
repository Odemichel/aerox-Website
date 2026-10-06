-- 20260513_competition_live_state.sql
-- feat-live-competition v2 :
--   * table competition_live_state pour le push 1 Hz pendant un run
--     (côté desktop) consommée en Realtime par la webapp publique
--   * colonnes height_cm / weight_kg / ftp sur competition_users + backfill
--     morpho pour les riders historiques
--
-- Ce fichier régularise sur l'env local des changements appliqués
-- directement en prod via MCP apply_migration le 2026-05-13.
-- Idempotent : sûr à rejouer sur un env fresh ou déjà migré.
-- PG15-safe : CREATE POLICY IF NOT EXISTS n'existe pas avant PG18, on
-- utilise DROP POLICY IF EXISTS + CREATE POLICY.

-- ============================================================
-- competition_users : morpho + FTP
-- ============================================================
ALTER TABLE public.competition_users
  ADD COLUMN IF NOT EXISTS height_cm int2 CHECK (height_cm BETWEEN 100 AND 220),
  ADD COLUMN IF NOT EXISTS weight_kg int2 CHECK (weight_kg BETWEEN 25 AND 200),
  ADD COLUMN IF NOT EXISTS ftp       int2 CHECK (ftp       BETWEEN 50  AND 800);

-- Backfill rétro pour les riders historiques (valeurs neutres ; ne touche
-- pas les rows qui ont déjà une valeur set).
UPDATE public.competition_users SET height_cm = 175 WHERE height_cm IS NULL;
UPDATE public.competition_users SET weight_kg = 72  WHERE weight_kg IS NULL;
UPDATE public.competition_users SET ftp       = 250 WHERE ftp       IS NULL;

-- Colonnes laissées nullable volontairement : le code Flutter valide à
-- l'enregistrement, ce qui permet une migration progressive sans bloquer
-- les flows existants.

-- ============================================================
-- competition_live_state : single-row pour le push 1 Hz
-- ============================================================
CREATE TABLE IF NOT EXISTS public.competition_live_state (
  id                    boolean PRIMARY KEY DEFAULT true CHECK (id = true),
  competition_user_id   uuid REFERENCES public.competition_users(id) ON DELETE SET NULL,
  first_name            text,
  last_name             text,
  is_active             boolean NOT NULL DEFAULT false,
  current_speed_kmh     float,
  current_watts_per_m2  int,
  current_surface_m2    float,
  current_aero_score    float,
  current_cda           float,
  current_power         float,
  elapsed_seconds       int,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Seed de la ligne unique (id = true) en idle.
INSERT INTO public.competition_live_state (id, is_active)
VALUES (true, false)
ON CONFLICT (id) DO NOTHING;

-- RLS
ALTER TABLE public.competition_live_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_all_competition_live_state    ON public.competition_live_state;
DROP POLICY IF EXISTS public_read_competition_live_state  ON public.competition_live_state;

-- Admin : full access (INSERT/UPDATE/DELETE depuis le desktop event).
CREATE POLICY admin_all_competition_live_state
  ON public.competition_live_state
  FOR ALL
  USING (EXISTS (SELECT 1 FROM public.users
                 WHERE users.id = auth.uid() AND users.role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.users
                      WHERE users.id = auth.uid() AND users.role = 'admin'));

-- Anon + authenticated : SELECT only.
-- Pas de fuite : la table ne contient ni email, ni age, ni created_by.
-- Le rider est désigné par first_name / last_name (déjà publics dans les vues
-- leaderboard) + UUID. Cohérent avec public_read_competition_runs.
CREATE POLICY public_read_competition_live_state
  ON public.competition_live_state
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- Realtime publication (idempotent : on swallow l'erreur si déjà membre).
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.competition_live_state;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
