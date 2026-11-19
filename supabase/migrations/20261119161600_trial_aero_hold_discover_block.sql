-- feat-onboarding-trial : Aero Endurance Test en 3 étapes, comme sa page de
-- présentation — se préparer (15 s en position relevée, mesure de la
-- caméra), découvrir son aéro (5 min libres : surface frontale et score
-- aéro en direct), puis le défi de 40 min.
--
-- * bloc SIMULATION de 5 min ajouté avant les 40 min (45 min au total) ;
--   l'analyse de fin (AeroHoldAnalysis) ne mesure que le dernier bloc ;
-- * rappels « tiens ta position » décalés au début du défi (315 s) et à
--   mi-défi (1 500 s) — pas de nouvelle clé : les versions installées
--   afficheraient la clé brute ;
-- * aero_duration_sec reste 2 400 (le défi).

UPDATE public.training_sessions
SET session_json = jsonb_set(
      jsonb_set(session_json, '{duration}', '45'::jsonb),
      '{blocks}',
      '[{"type": "SIMULATION", "unit": "% FTP", "duration_work": 300},
        {"type": "SIMULATION", "unit": "% FTP", "duration_work": 2400}]'::jsonb
    ),
    total_duration = 45,
    live_comments = '[{"at": 315, "key": "trial_aero_hold_hint", "duration": 12},
                      {"at": 1500, "key": "trial_aero_hold_hint", "duration": 12}]'::jsonb
WHERE name = 'trial_aero_hold_session_name';
