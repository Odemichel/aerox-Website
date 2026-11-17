-- feat-onboarding-trial : la séance 2 de l'essai s'appelle « Endurance Test »
-- (sans « AeroX », la marque est portée par le titre « AeroX Launch Test »).

UPDATE public.training_sessions
SET translations_json = jsonb_set(
      translations_json,
      '{name}',
      '{"fr": "Endurance Test", "en": "Endurance Test", "es": "Endurance Test", "it": "Endurance Test", "de": "Endurance Test", "nl": "Endurance Test", "pt": "Endurance Test", "ja": "Endurance Test", "tr": "Endurance Test"}'::jsonb),
    session_json = jsonb_set(session_json, '{nom}', '"Endurance Test"'::jsonb)
WHERE name = 'trial_aero_hold_session_name';
