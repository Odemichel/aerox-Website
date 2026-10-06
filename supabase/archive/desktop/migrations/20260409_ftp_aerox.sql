-- ============================================================
-- MIGRATION : Table FTP-AeroX (historique progression)
-- ============================================================

CREATE TABLE IF NOT EXISTS ftp_aerox (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at           TIMESTAMPTZ DEFAULT now(),
  ftp_aerox            INT NOT NULL,
  best_1min_wpm2       INT NOT NULL,
  avg_power            INT NOT NULL,
  avg_surface          REAL NOT NULL,
  training_session_id  UUID REFERENCES training_sessions(id)
);

ALTER TABLE ftp_aerox ENABLE ROW LEVEL SECURITY;

CREATE POLICY "User manages own ftp_aerox"
  ON ftp_aerox FOR ALL USING (auth.uid() = user_id);
