-- ============================================================
-- MIGRATION : Plans d'entraînement AeroX
-- ============================================================

-- 1. Colonne live_comments sur training_sessions (si absente)
ALTER TABLE training_sessions
  ADD COLUMN IF NOT EXISTS live_comments JSONB DEFAULT '[]'::jsonb;

-- 2. Colonne first_session_completed sur public.users
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS first_session_completed BOOLEAN NOT NULL DEFAULT false;

-- 3. Plans pré-construits (admin via Supabase Dashboard)
--    NB : la table existait déjà avec (title, description, level) — on ajoute les colonnes i18n
--    et on rend title nullable (colonne legacy remplacée par name_key)
CREATE TABLE IF NOT EXISTS training_plans (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name_key       TEXT NOT NULL,
  description_key TEXT NOT NULL,
  objective_key  TEXT NOT NULL,
  duration_weeks INT NOT NULL DEFAULT 8,
  difficulty     TEXT NOT NULL CHECK (difficulty IN ('beginner','intermediate','advanced')),
  thumbnail_url  TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ DEFAULT now()
);

-- Colonnes i18n manquantes si la table existait déjà
ALTER TABLE training_plans
  ADD COLUMN IF NOT EXISTS name_key TEXT,
  ADD COLUMN IF NOT EXISTS description_key TEXT,
  ADD COLUMN IF NOT EXISTS objective_key TEXT,
  ADD COLUMN IF NOT EXISTS duration_weeks INT NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS difficulty TEXT CHECK (difficulty IN ('beginner','intermediate','advanced')),
  ADD COLUMN IF NOT EXISTS thumbnail_url TEXT,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

-- Colonne legacy title : on lève la contrainte NOT NULL (remplacée par name_key)
DO $$ BEGIN
  ALTER TABLE training_plans ALTER COLUMN title DROP NOT NULL;
EXCEPTION WHEN undefined_column THEN NULL;
END $$;

-- 4. Séances ordonnées dans un plan
CREATE TABLE IF NOT EXISTS plan_sessions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id             UUID NOT NULL REFERENCES training_plans(id) ON DELETE CASCADE,
  training_session_id UUID NOT NULL REFERENCES training_sessions(id),
  week_number         INT NOT NULL,
  session_number      INT NOT NULL,
  created_at          TIMESTAMPTZ DEFAULT now(),
  UNIQUE (plan_id, week_number, session_number)
);

-- 5. Progression rider
CREATE TABLE IF NOT EXISTS user_plan_progress (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_id            UUID NOT NULL REFERENCES training_plans(id),
  started_at         TIMESTAMPTZ DEFAULT now(),
  is_active          BOOLEAN NOT NULL DEFAULT true,
  completed_sessions JSONB NOT NULL DEFAULT '[]'::jsonb,
  completed_at       TIMESTAMPTZ,
  UNIQUE (user_id, plan_id)
);

-- 6. RLS
ALTER TABLE training_plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Read active plans" ON training_plans;
CREATE POLICY "Read active plans" ON training_plans FOR SELECT USING (is_active = true);

ALTER TABLE plan_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Read plan sessions" ON plan_sessions;
CREATE POLICY "Read plan sessions" ON plan_sessions FOR SELECT USING (true);

ALTER TABLE user_plan_progress ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "User manages own progress" ON user_plan_progress;
CREATE POLICY "User manages own progress"
  ON user_plan_progress FOR ALL USING (auth.uid() = user_id);

-- ============================================================
-- DONNÉES : séance accueil + plan accueil
-- ============================================================

-- Séance accueil (rampe 20→50 km/h, 20 min) — idempotente
INSERT INTO training_sessions (name, info, total_duration, session_json, live_comments, is_test)
SELECT
  'welcome_session_name',
  'welcome_session_info',
  20,
  '{
    "nom": "welcome_session_name",
    "infos": "welcome_session_info",
    "UnitDisplay": "km/h",
    "duration": 20,
    "blocks": [
      {
        "type": "Grad+",
        "duration_work": 1200,
        "power_start": 20.0,
        "power_end": 50.0,
        "unit": "km/h"
      }
    ]
  }'::jsonb,
  '[
    {"at": 0,    "duration": 1,  "key": "welcome_v2_mount_bike"},
    {"at": 1,    "duration": 13, "key": "welcome_v2_ramp_duration"},
    {"at": 15,   "duration": 13, "key": "welcome_v2_objective"},
    {"at": 90,   "duration": 16, "key": "welcome_v2_reveal_gauge"},
    {"at": 180,  "duration": 14, "key": "welcome_v2_explore_position"},
    {"at": 260,  "duration": 13, "key": "welcome_v2_maximize_gauge"},
    {"at": 350,  "duration": 14, "key": "welcome_v2_approaching_30"},
    {"at": 380,  "duration": 15, "key": "welcome_v2_watch_power"},
    {"at": 460,  "duration": 13, "key": "welcome_v2_find_best_position"},
    {"at": 540,  "duration": 14, "key": "welcome_v2_level_cyclo"},
    {"at": 660,  "duration": 14, "key": "welcome_v2_level_amateur"},
    {"at": 780,  "duration": 14, "key": "welcome_v2_level_regional"},
    {"at": 900,  "duration": 14, "key": "welcome_v2_level_national"},
    {"at": 1020, "duration": 14, "key": "welcome_v2_level_elite"},
    {"at": 1140, "duration": 14, "key": "welcome_v2_level_pro"}
  ]'::jsonb,
  true
WHERE NOT EXISTS (
  SELECT 1 FROM training_sessions WHERE name = 'welcome_session_name'
);

-- Passage en is_test = true (auto-complete + FTP-AeroX overlay)
UPDATE training_sessions
SET is_test = true
WHERE name = 'welcome_session_name';

-- Mise à jour live_comments si la séance existait déjà
UPDATE training_sessions
SET live_comments = '[
  {"at": 0,    "duration": 1,  "key": "welcome_v2_mount_bike"},
  {"at": 1,    "duration": 13, "key": "welcome_v2_ramp_duration"},
  {"at": 15,   "duration": 13, "key": "welcome_v2_objective"},
  {"at": 90,   "duration": 16, "key": "welcome_v2_reveal_gauge"},
  {"at": 180,  "duration": 14, "key": "welcome_v2_explore_position"},
  {"at": 260,  "duration": 13, "key": "welcome_v2_maximize_gauge"},
  {"at": 350,  "duration": 14, "key": "welcome_v2_approaching_30"},
  {"at": 380,  "duration": 15, "key": "welcome_v2_watch_power"},
  {"at": 460,  "duration": 13, "key": "welcome_v2_find_best_position"},
  {"at": 540,  "duration": 14, "key": "welcome_v2_level_cyclo"},
  {"at": 660,  "duration": 14, "key": "welcome_v2_level_amateur"},
  {"at": 780,  "duration": 14, "key": "welcome_v2_level_regional"},
  {"at": 900,  "duration": 14, "key": "welcome_v2_level_national"},
  {"at": 1020, "duration": 14, "key": "welcome_v2_level_elite"},
  {"at": 1140, "duration": 14, "key": "welcome_v2_level_pro"}
]'::jsonb
WHERE name = 'welcome_session_name';

-- Plan accueil — idempotent
INSERT INTO training_plans (name_key, description_key, objective_key, duration_weeks, difficulty)
SELECT
  'plan_welcome_name',
  'plan_welcome_description',
  'plan_welcome_objective',
  1,
  'beginner'
WHERE NOT EXISTS (
  SELECT 1 FROM training_plans WHERE name_key = 'plan_welcome_name'
);

-- Liaison plan → séance (idempotente via UNIQUE constraint)
INSERT INTO plan_sessions (plan_id, training_session_id, week_number, session_number)
SELECT p.id, s.id, 1, 1
FROM training_plans p, training_sessions s
WHERE p.name_key = 'plan_welcome_name'
  AND s.name = 'welcome_session_name'
ON CONFLICT (plan_id, week_number, session_number) DO NOTHING;
