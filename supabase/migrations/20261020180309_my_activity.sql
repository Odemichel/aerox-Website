-- Section Activité des comptes (site : dashboard.astro ; desktop : sections
-- Activité cycliste et bike fitter) : totaux et comptes par mois calculés par
-- la base.
--
-- Les clients téléchargeaient la date de chaque séance (`.limit(10000)`, que
-- l'API ramène toujours au plafond « max rows » de 1000) puis comptaient
-- eux-mêmes : au-delà de 1000 lignes, totaux et graphiques étaient faux sans
-- erreur. Un seul objet JSON est maintenant renvoyé.
--
-- p_bounds : débuts de mois en heure LOCALE du client, croissants (12 mois
-- affichés = 13 bornes, la dernière = début du mois suivant). Le découpage
-- reste ainsi celui du fuseau de l'utilisateur, heure d'été comprise, sans
-- que la base ait à le connaître.
--
-- Séries (même définition que les anciens calculs des deux apps) :
-- - training : entraînements du compte (user_id) ;
-- - fittings_received : fittings faits pour lui par un bike fitter
--   (rider_id = soi, user_id ≠ soi) ;
-- - fittings_done : fittings enregistrés par le compte (bike fitter) ;
-- - clients : fiches clients du bike fitter ;
-- - diagnostics : séances du Diagnostic, une séance S1 = ses positions de
--   même index (date de la première capture), une séance S2 = une ligne.
-- Chaque série : { total, first_at, months: [n par intervalle de p_bounds] }.
--
-- SECURITY INVOKER (RLS appliquée) + filtre explicite sur auth.uid() : un
-- admin, qui lit toutes les lignes, ne reçoit que ses propres chiffres.

create or replace function public.activity_series(p_dates timestamptz[], p_bounds timestamptz[])
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'total', coalesce(cardinality(p_dates), 0),
    'first_at', (select min(d) from unnest(p_dates) d),
    'months', (
      select coalesce(jsonb_agg(coalesce(c.n, 0) order by i), '[]'::jsonb)
      from generate_series(1, cardinality(p_bounds) - 1) i
      left join (
        select width_bucket(d, p_bounds) as b, count(*) as n
        from unnest(p_dates) d
        group by 1
      ) c on c.b = i
    )
  );
$$;

create or replace function public.my_activity(p_bounds timestamptz[])
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_n integer := coalesce(cardinality(p_bounds), 0);
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if v_n < 2 or v_n > 37
     or exists (select 1 from generate_series(1, v_n - 1) i
                where p_bounds[i] is null or p_bounds[i + 1] is null
                   or p_bounds[i] >= p_bounds[i + 1]) then
    raise exception 'p_bounds: 2 to 37 increasing month starts' using errcode = '22023';
  end if;

  return jsonb_build_object(
    'training', public.activity_series(array(
      select s.created_at from public.sessions s
      where s.user_id = v_uid and s.session_type = 'training'), p_bounds),
    'fittings_received', public.activity_series(array(
      select s.created_at from public.sessions s
      where s.rider_id = v_uid and s.user_id <> v_uid
        and s.session_type like 'fitting%'), p_bounds),
    'fittings_done', public.activity_series(array(
      select s.created_at from public.sessions s
      where s.user_id = v_uid and s.session_type like 'fitting%'), p_bounds),
    'clients', public.activity_series(array(
      select c.created_at from public.bf_clients c
      where c.bf_user_id = v_uid), p_bounds),
    'diagnostics', public.activity_series(array(
      select min(p.captured_at)
      from public.diagnostic_basic_positions p
      join public.diagnostic_basic d on d.id = p.diagnostic_id
      where d.user_id = v_uid and p.captured_at is not null
      group by p.diagnostic_id, p.s1_session_index
      union all
      select s2.captured_at
      from public.diagnostic_basic_s2 s2
      join public.diagnostic_basic d on d.id = s2.diagnostic_id
      where d.user_id = v_uid and s2.captured_at is not null), p_bounds)
  );
end;
$$;

revoke all on function public.activity_series(timestamptz[], timestamptz[]) from public, anon;
grant execute on function public.activity_series(timestamptz[], timestamptz[]) to authenticated;
revoke all on function public.my_activity(timestamptz[]) from public, anon;
grant execute on function public.my_activity(timestamptz[]) to authenticated;

comment on function public.my_activity(timestamptz[]) is
  'Section Activité du compte connecté (site + desktop) : totaux, première date et comptes par mois (bornes locales p_bounds) des entraînements, fittings reçus / réalisés, clients et séances du Diagnostic.';
