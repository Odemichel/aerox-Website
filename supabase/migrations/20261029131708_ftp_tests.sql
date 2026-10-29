-- Historique des tests FTP en puissance (test incrémental « Test FTP
-- classique ») : FTP = meilleure puissance moyenne sur 1 min × 0,75. Distinct
-- de ftp_aerox (W/m², tests en km/h) : la fin de test compare la nouvelle FTP
-- au dernier test, pas à une FTP saisie à la main dans le profil.
CREATE TABLE public.ftp_tests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  ftp_w integer NOT NULL CHECK (ftp_w BETWEEN 50 AND 600),
  best_1min_w integer NOT NULL CHECK (best_1min_w > 0),
  training_session_id uuid REFERENCES public.training_sessions (id) ON DELETE SET NULL
);

CREATE INDEX ftp_tests_user_created_idx
  ON public.ftp_tests (user_id, created_at DESC);

ALTER TABLE public.ftp_tests ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.ftp_tests FROM anon;
GRANT SELECT, INSERT ON public.ftp_tests TO authenticated;
REVOKE UPDATE, DELETE ON public.ftp_tests FROM authenticated;

CREATE POLICY "Rider reads own ftp_tests" ON public.ftp_tests
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Rider inserts own ftp_tests" ON public.ftp_tests
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);
