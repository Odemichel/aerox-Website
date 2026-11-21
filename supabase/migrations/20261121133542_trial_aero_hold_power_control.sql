-- Aero Endurance Test de l'essai en puissance contrôlée (feat-onboarding-trial).
--
-- 1. Séance : échauffement 100 W 5 min puis défi 150 W 40 min (blocs CONST en
--    W, au lieu des 2 blocs SIMULATION en puissance libre). Le cycliste règle
--    la puissance du défi sur la page de présentation puis depuis le
--    smartphone ; l'échauffement suit dans la même proportion.
-- 2. Message du début du défi : plus d'XP pendant la séance (dévoilés à la
--    fin), la consigne porte sur la tenue de la position.
-- 3. webapp_session_state.target_power : puissance du défi publiée par le
--    desktop pendant une séance pilotée en puissance ; le smartphone affiche
--    alors un réglage en watts (commande set_target_power) au lieu de la FTP.
--    Null pour les autres séances.

alter table public.webapp_session_state
  add column if not exists target_power smallint;

update public.training_sessions
set session_json = session_json || jsonb_build_object(
      'UnitDisplay', 'Watts',
      'blocks', jsonb_build_array(
        jsonb_build_object('type', 'CONST', 'unit', 'Watts',
                           'power_start', 100, 'duration_work', 300),
        jsonb_build_object('type', 'CONST', 'unit', 'Watts',
                           'power_start', 150, 'duration_work', 2400)
      )
    ),
    translations_json = jsonb_set(
      translations_json,
      '{live_comments,trial_ah_lc_start}',
      jsonb_build_object(
        'fr', 'Ton défi commence maintenant. Tiens ta position aéro le plus longtemps possible !',
        'en', 'Your challenge starts now. Hold your aero position as long as you can!',
        'pt', 'Seu desafio começa agora. Mantenha sua posição aero o máximo possível!',
        'es', 'Tu reto empieza ahora. ¡Mantén tu posición aero el mayor tiempo posible!',
        'it', 'La tua sfida inizia ora. Tieni la posizione aero il più a lungo possibile!',
        'de', 'Deine Challenge beginnt jetzt. Halte deine Aero-Position so lange wie möglich!',
        'nl', 'Je uitdaging begint nu. Houd je aeropositie zo lang mogelijk vast!',
        'ja', 'チャレンジ開始！エアロポジションをできるだけ長く保とう！',
        'tr', 'Meydan okuman şimdi başlıyor. Aero pozisyonunu olabildiğince uzun koru!'
      )
    )
where name = 'trial_aero_hold_session_name';
