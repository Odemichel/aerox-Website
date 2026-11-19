-- Géométrie du vélo déclarée au début de la calibration d'onboarding (desktop) :
-- la pose de calibration (mains sur les cocottes, bras tendus) n'a pas la même
-- surface frontale sur un vélo de route et sur un vélo de CLM / triathlon.
-- `bike_aerobars` : prolongateurs montés sur le vélo de route (null en CLM).
-- En attendant le garage (géométrie fine du vélo).
alter table public.users
  add column if not exists bike_geometry text
    check (bike_geometry in ('road', 'tt')),
  add column if not exists bike_aerobars boolean;

-- `users` n'accorde l'INSERT / UPDATE à `authenticated` que colonne par
-- colonne ; les policies RLS limitent toujours à sa propre ligne.
grant update (bike_geometry, bike_aerobars) on public.users to authenticated;
