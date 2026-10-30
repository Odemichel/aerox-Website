-- feat-aero-model-v2 (veloaero) : contrôle de taille et version du modèle aéro
-- enregistrés avec chaque calibration.
--
-- check_height_gap_pct : écart (%) entre l'échelle déduite de la taille du
-- rider (hauteur visible = height_pose_coef × taille) et l'échelle morpho, au
-- même plan. Jusqu'ici dans le seul log local du desktop ; il sert à valider
-- le coefficient 0,842 (simulateur aerox-world) sur les prochaines séances.
-- aero_model_version : 1 (historique) ou 2 (feat-aero-model-v2), pour ne pas
-- mélanger des k mesurés sous deux modèles différents.
-- NULL : ligne antérieure, ou contrôle échoué.

alter table public.calibration_telemetry
  add column if not exists check_height_gap_pct double precision,
  add column if not exists aero_model_version smallint;
