-- Géométrie du vélo de chaque client d'un bike fitter, demandée à la
-- calibration du fitting : elle sert à la calibration du client (surface de
-- la pose relevée) et au CdA du vélo pendant le fitting. Mêmes valeurs que
-- `users.bike_geometry` / `users.bike_aerobars` (20261119091004).
alter table public.bf_clients
  add column if not exists bike_geometry text
    check (bike_geometry in ('road', 'tt')),
  add column if not exists bike_aerobars boolean;

-- `bf_clients` n'accorde l'INSERT / UPDATE à `authenticated` que colonne par
-- colonne ; les policies RLS limitent toujours aux clients du bike fitter.
grant insert (bike_geometry, bike_aerobars), update (bike_geometry, bike_aerobars)
  on public.bf_clients to authenticated;
