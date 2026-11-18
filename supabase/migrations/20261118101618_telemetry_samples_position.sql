-- Images de réentraînement par position (desktop, 2026-11-18) : position
-- lissée de chaque échantillon, pour vérifier que chaque classe du modèle
-- (CLM, aéro route, normale, mains lâchées) a ses images — 2 au plus par
-- séance et par position, prises après 5 s dans la position. NULL : ancien
-- échantillon ou image à la demande sans position annoncée.
ALTER TABLE public.calibration_telemetry_samples
  ADD COLUMN IF NOT EXISTS position text
  CHECK (position IN ('tt', 'aero_road', 'normal', 'hands_off'));
