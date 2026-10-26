-- Masse (cycliste + vélo, kg) du rider de la séance en cours, publiée par
-- l'app desktop au démarrage. En fitting c'est celle du client du bike
-- fitter, pas celle du compte connecté : My Companion en a besoin pour que
-- ses prédictions live (watts, temps) correspondent au client.
alter table public.webapp_session_state
  add column if not exists rider_mass_kg real;

comment on column public.webapp_session_state.rider_mass_kg is
  'Masse cycliste + vélo (kg) du rider de la séance : client du bike fitter en fitting, sinon l''utilisateur. Null = inconnue (repli sur le profil).';
