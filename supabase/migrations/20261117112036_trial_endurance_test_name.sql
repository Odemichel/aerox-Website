-- feat-onboarding-trial : la séance 2 de l'essai gratuit s'appelle
-- « AeroX Endurance Test » (nom de produit, identique dans les 9 langues).

UPDATE public.training_sessions
SET translations_json = jsonb_set(
      translations_json,
      '{name}',
      '{"fr": "AeroX Endurance Test", "en": "AeroX Endurance Test", "es": "AeroX Endurance Test", "it": "AeroX Endurance Test", "de": "AeroX Endurance Test", "nl": "AeroX Endurance Test", "pt": "AeroX Endurance Test", "ja": "AeroX Endurance Test", "tr": "AeroX Endurance Test"}'::jsonb),
    session_json = jsonb_set(session_json, '{nom}', '"AeroX Endurance Test"'::jsonb)
WHERE name = 'trial_aero_hold_session_name';
