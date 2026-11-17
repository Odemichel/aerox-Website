-- feat-onboarding-trial : la séance 2 de l'essai s'appelle
-- « Aero Endurance Test » (nom de produit, identique dans les 9 langues).

UPDATE public.training_sessions
SET translations_json = jsonb_set(
      translations_json,
      '{name}',
      '{"fr": "Aero Endurance Test", "en": "Aero Endurance Test", "es": "Aero Endurance Test", "it": "Aero Endurance Test", "de": "Aero Endurance Test", "nl": "Aero Endurance Test", "pt": "Aero Endurance Test", "ja": "Aero Endurance Test", "tr": "Aero Endurance Test"}'::jsonb),
    session_json = jsonb_set(session_json, '{nom}', '"Aero Endurance Test"'::jsonb)
WHERE name = 'trial_aero_hold_session_name';
