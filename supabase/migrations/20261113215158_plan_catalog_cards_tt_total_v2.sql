-- Vignette du catalogue : temps total en position TT sur le plan (minutes),
-- calculé depuis les séances du plan.
UPDATE public.training_plans p
SET translations_json = jsonb_set(p.translations_json, '{card,tt_minutes}', to_jsonb(t.minutes))
FROM (
  SELECT ps.plan_id, (sum(coalesce(ts.aero_duration_sec, 0)) / 60)::int AS minutes
  FROM public.plan_sessions ps
  JOIN public.training_sessions ts ON ts.id = ps.training_session_id
  GROUP BY ps.plan_id
) t
WHERE t.plan_id = p.id AND p.translations_json ? 'card';
