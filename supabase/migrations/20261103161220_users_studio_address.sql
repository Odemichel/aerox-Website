-- Adresse du studio d'un bike fitter, saisie dans l'onglet Studio de
-- l'espace compte (avec le nom du studio, le contact, le téléphone, le site
-- et le logo). Écrite par le bike fitter sur sa propre ligne : la policy
-- `user_update_own_row` et le trigger `users_guard_client_columns`
-- s'appliquent déjà, rien d'autre à ouvrir.
alter table public.users add column if not exists studio_address text;

alter table public.users drop constraint if exists users_studio_address_length;
alter table public.users add constraint users_studio_address_length
  check (studio_address is null or char_length(studio_address) <= 300);
