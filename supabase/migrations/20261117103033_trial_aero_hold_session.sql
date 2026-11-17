-- feat-onboarding-trial : essai gratuit ramené à 2 séances — test FTP
-- classique (puissance aéro, puissance et vitesse max 1'), puis 40 min en
-- puissance libre (temps de maintien de la position aéro, score aéro
-- moyen). Le diagnostic suit, verrouillé (abonnement ou achat).
--
-- * séance 2 : un bloc SIMULATION de 40 min sans parcours = rapports
--   virtuels libres (Zwift Click, flèches, smartphone), aucune consigne
--   envoyée au home trainer ;
-- * users.trial_sessions_done borné à 0–2 (aucun compte au-delà de 0 au
--   2026-11-17) ;
-- * les séances « trial_threshold_session_name » et
--   « trial_neuro_session_name » ne sont plus lues par l'app : laissées en
--   base.

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_trial_sessions_done_check;
ALTER TABLE public.users
  ADD CONSTRAINT users_trial_sessions_done_check
    CHECK (trial_sessions_done BETWEEN 0 AND 2);

INSERT INTO public.training_sessions (name, info, session_json, total_duration, is_test, live_comments, translations_json, aero_duration_sec)
SELECT 'trial_aero_hold_session_name', 'trial_aero_hold_session_info', '{"nom": "Essai 2 · Tenue de la position aéro", "infos": "", "duration": 40, "UnitDisplay": "% FTP", "blocks": [{"type": "SIMULATION", "unit": "% FTP", "duration_work": 2400}]}'::jsonb, 40, false, '[{"at": 15, "key": "trial_aero_hold_hint", "duration": 12}, {"at": 1200, "key": "trial_aero_hold_hint", "duration": 12}]'::jsonb, '{"name": {"fr": "Essai 2 · Tenue de la position aéro", "en": "Trial 2 · Holding the aero position", "es": "Prueba 2 · Mantener la posición aero", "it": "Prova 2 · Tenuta della posizione aero", "de": "Test 2 · Aero-Position halten", "nl": "Proef 2 · Aeropositie volhouden", "pt": "Teste 2 · Manter a posição aero", "ja": "トライアル2 · エアロポジションの維持", "tr": "Deneme 2 · Aero pozisyonu korumak"}}'::jsonb, 2400
WHERE NOT EXISTS (SELECT 1 FROM public.training_sessions WHERE name = 'trial_aero_hold_session_name');
