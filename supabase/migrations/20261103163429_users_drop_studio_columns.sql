-- Phase 2 de la fiche studio à source unique (voir
-- 20261103200000_bf_profiles_source_unique.sql) : le site, le desktop et
-- My Companion lisent et écrivent `bf_profiles` ; les colonnes studio de
-- `users` sont retirées (recopiées dans `bf_profiles`, aucun écart vérifié
-- le 2026-11-03 avant suppression).
alter table public.users drop constraint if exists users_studio_address_length;
alter table public.users drop constraint if exists users_bf_pro_fields_check;
alter table public.users
  drop column if exists studio_name,
  drop column if exists website,
  drop column if exists studio_address,
  drop column if exists specialties,
  drop column if exists experience_years,
  drop column if exists certifications;
