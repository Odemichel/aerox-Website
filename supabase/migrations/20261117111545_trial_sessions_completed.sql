-- feat-onboarding-trial : les 2 séances de l'essai gratuit sont disponibles
-- dès le début, dans n'importe quel ordre. Un compteur ne dit plus
-- laquelle est faite : liste des séances faites (`training_sessions.name`),
-- écrite par l'app à l'enregistrement d'une séance d'essai. L'essai est
-- fini quand les 2 y sont (`first_session_completed` passe alors à vrai).
--
-- `trial_sessions_done` n'est plus lu par l'app à partir de cette version ;
-- gardée pour les versions déjà installées (toutes les valeurs à 0), à
-- retirer quand la version minimale l'exclura.

ALTER TABLE public.users
  ADD COLUMN trial_sessions_completed text[] NOT NULL DEFAULT '{}'
    CONSTRAINT users_trial_sessions_completed_check
    CHECK (trial_sessions_completed <@ ARRAY['Test FTP classique', 'trial_aero_hold_session_name']::text[]);

-- `users` est en liste blanche de colonnes (lecture comme écriture).
GRANT SELECT (trial_sessions_completed), UPDATE (trial_sessions_completed)
  ON public.users TO authenticated;
