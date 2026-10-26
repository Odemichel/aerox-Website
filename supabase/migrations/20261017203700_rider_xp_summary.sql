-- feat-xp-aerox-v2 (veloaero + aerox-mycompanion) : total d'XP AeroX calculé
-- par la base.
--
-- Les deux apps additionnaient elles-mêmes les lignes `sessions` du rider :
-- au-delà de 1000 séances (plafond « max rows » de l'API), le total était
-- tronqué sans erreur. Une seule ligne est maintenant renvoyée.
--
-- Règle (identique aux deux apps) : entraînements du compte connecté d'au
-- moins 60 s ; XP de séance = aero_xp, ou 1 XP par minute qualifiée
-- (aero_qualified_s / 60) pour les séances antérieures au barème par zone.
--
-- SECURITY INVOKER : la RLS de `sessions` s'applique ; le filtre explicite sur
-- auth.uid() évite qu'un admin (qui lit toutes les séances) reçoive le total
-- de tout le monde.

create or replace function public.rider_xp_summary()
returns table (
  total_xp numeric,
  sessions_count integer,
  total_aero_qualified_s bigint,
  first_session_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    coalesce(sum(coalesce(s.aero_xp, s.aero_qualified_s / 60.0)), 0)::numeric,
    count(*)::integer,
    coalesce(sum(s.aero_qualified_s), 0)::bigint,
    min(s.created_at)
  from public.sessions s
  where s.user_id = (select auth.uid())
    and s.session_type = 'training'
    and s.duration_s >= 60;
$$;

revoke all on function public.rider_xp_summary() from public, anon;
grant execute on function public.rider_xp_summary() to authenticated;

comment on function public.rider_xp_summary() is
  'Total d''XP AeroX, nombre d''entraînements (≥ 60 s), secondes aéro qualifiées et date du premier entraînement du compte connecté. feat-xp-aerox-v2.';
