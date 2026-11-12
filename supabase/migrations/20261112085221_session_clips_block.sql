-- feat-clips-block : clips « tout le bloc » et début / fin à la demande,
-- accélérés au-delà de 2 min.
--
-- * mode : + 'block' (bloc en cours) et 'span' (début / fin) ;
-- * duration_s : durée réelle couverte, jusqu'à 60 min ;
-- * speed : facteur d'accélération de la vidéo (1 = vitesse réelle) ;
-- * webapp_session_state.clip_state : {phase, mode} publié par le desktop,
--   pour que le téléphone affiche ⏹ pendant un enregistrement.

ALTER TABLE public.session_clips
  DROP CONSTRAINT session_clips_duration_s_check,
  ADD CONSTRAINT session_clips_duration_s_check CHECK (duration_s BETWEEN 1 AND 3600),
  DROP CONSTRAINT session_clips_mode_check,
  ADD CONSTRAINT session_clips_mode_check CHECK (mode IN ('past', 'next', 'block', 'span')),
  ADD COLUMN speed real NOT NULL DEFAULT 1 CHECK (speed BETWEEN 1 AND 100);

ALTER TABLE public.webapp_session_state
  ADD COLUMN clip_state jsonb CHECK (clip_state IS NULL OR jsonb_typeof(clip_state) = 'object');
