-- feat-onboarding-ftp-test : le test FTP en puissance enregistre aussi
-- jusqu'où la position aéro tient et les meilleures minutes, et pointe vers
-- la séance enregistrée.
--
-- * position_ref : position de référence des 4 premiers paliers ('tt',
--   'aero_road'), null sans position aéro au départ ;
-- * position_held_w : consigne du dernier palier tenu (sortie ≥ 20 s) ;
-- * position_held_to_end : tenue jusqu'au dernier palier atteint ;
-- * best_*_1min : minute la plus puissante / la plus rapide / au CdA le plus
--   bas, {power_w, speed_kmh, cda} ;
-- * session_id : séance enregistrée, écrite après la fin de test (seule
--   colonne modifiable par le propriétaire, vers une de ses séances).

ALTER TABLE public.ftp_tests
  ADD COLUMN session_id uuid REFERENCES public.sessions (id) ON DELETE SET NULL,
  ADD COLUMN position_ref text CHECK (position_ref IN ('tt', 'aero_road')),
  ADD COLUMN position_held_w integer CHECK (position_held_w BETWEEN 0 AND 2000),
  ADD COLUMN position_held_to_end boolean NOT NULL DEFAULT false,
  ADD COLUMN best_power_1min jsonb CHECK (jsonb_typeof(best_power_1min) = 'object'),
  ADD COLUMN best_speed_1min jsonb CHECK (jsonb_typeof(best_speed_1min) = 'object'),
  ADD COLUMN best_cda_1min jsonb CHECK (jsonb_typeof(best_cda_1min) = 'object');

CREATE INDEX ftp_tests_session_id_idx ON public.ftp_tests (session_id);

GRANT UPDATE (session_id) ON public.ftp_tests TO authenticated;

CREATE POLICY "Rider links own ftp_tests to own session" ON public.ftp_tests
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK (
    (SELECT auth.uid()) = user_id
    AND (
      session_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.sessions s
        WHERE s.id = session_id AND s.user_id = (SELECT auth.uid())
      )
    )
  );
