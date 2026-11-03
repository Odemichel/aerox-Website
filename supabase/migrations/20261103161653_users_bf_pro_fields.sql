-- Source unique de la fiche bike fitter : la ligne `users`.
--
-- L'encart « infos pro » du desktop écrivait dans `bf_profiles` (nom du
-- studio, ville, site, spécialités, expérience, bio, certifications) alors
-- que le site, l'admin, le CRM, le rapport PDF et le titre du compte desktop
-- lisent `users`. Les champs pro manquants passent sur `users` ; la ville est
-- remplacée par l'adresse du studio (`studio_address`). `bf_profiles` était
-- vide à la bascule (0 ligne le 2026-11-03) : rien à recopier.
--
-- `bf_profiles` reste en place pour les anciennes versions du desktop
-- (< 1.4.0, bloquées par version.min_required) et sera supprimée ensuite.
alter table public.users add column if not exists specialties text;
alter table public.users add column if not exists experience_years integer;
alter table public.users add column if not exists certifications text;

alter table public.users drop constraint if exists users_bf_pro_fields_check;
alter table public.users add constraint users_bf_pro_fields_check check (
  (experience_years is null or experience_years between 0 and 80)
  and (specialties is null or char_length(specialties) <= 500)
  and (certifications is null or char_length(certifications) <= 500)
);

comment on table public.bf_profiles is
  'Obsolète depuis le 2026-11-03 : la fiche bike fitter vit dans public.users (studio_name, studio_address, website, phonenumber, bio, specialties, experience_years, certifications).';
