-- ============================================================
-- MIGRATION : Correction total_duration et session_json.duration
-- Les séances seedées avaient ces valeurs en secondes au lieu de minutes
-- ============================================================

UPDATE training_sessions
SET
  total_duration = (total_duration / 60),
  session_json = jsonb_set(
    session_json,
    '{duration}',
    to_jsonb((session_json->>'duration')::int / 60)
  )
WHERE total_duration > 100;
