-- supabase/migrations/20261010100000_webapp_session_state_block_mode.sql
--
-- Mode de contrôle du bloc en cours, publié par le desktop pour que la webapp
-- compagnon affiche la carte qui a du sens :
--   power : puissance imposée (ERG)  → gain/perte de vitesse
--   free  : simulation / libre       → gain/perte de vitesse
--   speed : vitesse imposée          → gain/perte de puissance
-- NULL : desktop plus ancien ou séance sans home trainer (la webapp garde
-- alors son affichage historique).

alter table public.webapp_session_state
  add column block_mode text check (block_mode in ('power', 'speed', 'free'));
