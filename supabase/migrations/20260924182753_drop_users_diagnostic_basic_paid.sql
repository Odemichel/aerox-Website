-- Remplacées par `diagnostic_purchases` (migration diagnostic_purchases).
-- Plus aucun lecteur ni écrivain : webhook du site sur la nouvelle table,
-- application sur `has_diagnostic_entitlement()`. Aucune valeur à reprendre
-- (0 compte marqué payé au 2026-09-24).
alter table public.users drop column if exists diagnostic_basic_paid;
alter table public.users drop column if exists diagnostic_basic_paid_at;
