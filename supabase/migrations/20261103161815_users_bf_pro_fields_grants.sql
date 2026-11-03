-- Écriture des colonnes de la fiche bike fitter par le bike fitter lui-même :
-- `users` n'accorde l'UPDATE à `authenticated` que colonne par colonne, les
-- colonnes ajoutées le 2026-11-03 doivent donc être listées. Les policies
-- RLS (`user_update_own_row`) limitent toujours à sa propre ligne.
grant update (studio_address, specialties, experience_years, certifications) on public.users to authenticated;
