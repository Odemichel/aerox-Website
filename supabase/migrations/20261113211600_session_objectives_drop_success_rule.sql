-- Objectifs de séance : la phrase « Réussite : N passages en TT validés (...) »
-- est retirée des 9 langues (la règle reste expliquée en fin de séance).
UPDATE public.training_sessions ts
SET translations_json = jsonb_set(
  ts.translations_json,
  '{objectif}',
  (SELECT jsonb_object_agg(e.key, regexp_replace(e.value, '\s*(Réussite :|Success:|Éxito:|Riuscita:|Erfolg:|Geslaagd:|Sucesso:|達成条件：|Başarı:).*$', ''))
     FROM jsonb_each_text(ts.translations_json->'objectif') AS e)
)
WHERE ts.translations_json->'objectif'->>'fr' LIKE '%Réussite :%';
