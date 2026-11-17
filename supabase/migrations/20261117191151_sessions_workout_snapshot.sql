-- feat-training-calendar : séance jouée gardée avec chaque entraînement
-- (nom, traductions, blocs `session_json`), pour la miniature de timeline et
-- le nom dans le calendrier et l'historique — quelle que soit sa source
-- (catalogue, plan AeroX, Intervals.icu) et même si l'original change.

alter table public.sessions
  add column if not exists workout jsonb;

comment on column public.sessions.workout is
  'Instantané de la séance jouée : { name, translations_json, session_json } (feat-training-calendar).';
