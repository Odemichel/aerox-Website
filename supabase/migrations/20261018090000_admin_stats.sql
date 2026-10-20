-- aerox-mycompanion (tableau de bord admin) : indicateurs calculés par la base.
--
-- L'app chargeait toutes les lignes `users` et `sessions` puis agrégeait
-- elle-même : au-delà de 1000 lignes (plafond « max rows » de l'API), tous les
-- chiffres étaient faux sans erreur. Un seul objet JSON est maintenant renvoyé.
--
-- Règles identiques à l'ancien calcul Dart :
-- - profil complet = weight et height renseignés ;
-- - actifs 7/30/90 j = dernière séance (user_id) à ≤ N jours ;
-- - churn = inscrit depuis > 30 j, aucune séance depuis 30 j ;
-- - entonnoir 0 / 1 / 2+ séances par compte (user_id).
-- Courbes : buckets date_trunc (semaine ISO commençant le lundi, mois, année),
-- un seul bucket (première date, total) pour 'all_time'.
--
-- SECURITY INVOKER : la RLS de `users` / `sessions` s'applique (un admin lit
-- tout via is_admin()). Le contrôle explicite renvoie une erreur aux non-admins
-- plutôt que des statistiques partielles sur leurs seules lignes.

-- Courbe de croissance : [{date, count}] triée ; p_trunc null = un seul bucket
-- (première date, total).
create or replace function public.admin_growth_curve(p_dates timestamptz[], p_trunc text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('date', b, 'count', n) order by b), '[]'::jsonb)
  from (
    select case when p_trunc is null then (select min(x) from unnest(p_dates) x)
                else date_trunc(p_trunc, d) end as b,
           count(*) as n
    from unnest(p_dates) as d
    group by 1
  ) g;
$$;

create or replace function public.admin_stats(p_period text default 'weekly')
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_trunc text;
  v_result jsonb;
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;

  v_trunc := case p_period
    when 'weekly' then 'week'
    when 'monthly' then 'month'
    when 'yearly' then 'year'
    when 'all_time' then null
    else null
  end;
  if v_trunc is null and p_period <> 'all_time' then
    raise exception 'invalid period: %', p_period using errcode = '22023';
  end if;

  with
  u as (
    select id, coalesce(role, 'rider') as role, created_at,
           (weight is not null and height is not null) as complete
    from public.users
  ),
  s as (
    select user_id, coalesce(session_type, 'training') as session_type,
           coalesce(duration_s, 0) as duration_s, created_at
    from public.sessions
  ),
  per_user as (
    select user_id, count(*) as n, max(created_at) as last_at
    from s group by user_id
  ),
  funnel as (
    select
      count(*) filter (where coalesce(p.n, 0) = 0) as zero,
      count(*) filter (where p.n = 1) as one,
      count(*) filter (where p.n >= 2) as two_plus,
      count(*) filter (
        where u.created_at < now() - interval '30 days'
          and (p.last_at is null or p.last_at < now() - interval '30 days')
      ) as churned
    from u left join per_user p on p.user_id = u.id
  )
  select jsonb_build_object(
    'total_users', (select count(*) from u),
    'users_by_role', coalesce(
      (select jsonb_object_agg(role, n) from (select role, count(*) n from u group by role) r),
      '{}'::jsonb),
    'users_profile_complete', (select count(*) filter (where complete) from u),
    'user_growth', public.admin_growth_curve(array(select created_at from u), v_trunc),
    'total_sessions', (select count(*) from s),
    'sessions_by_type', coalesce(
      (select jsonb_object_agg(session_type, n) from (select session_type, count(*) n from s group by session_type) t),
      '{}'::jsonb),
    'avg_duration_by_type', coalesce(
      (select jsonb_object_agg(session_type, a) from (select session_type, (avg(duration_s))::bigint a from s group by session_type) t),
      '{}'::jsonb),
    'total_duration_s', (select coalesce(sum(duration_s), 0) from s),
    'session_growth', public.admin_growth_curve(array(select created_at from s), v_trunc),
    -- Comme l'ancien calcul : comptes distincts ayant au moins une séance
    -- (user_id), y compris hors table users.
    'users_with_session', (select count(*) from per_user),
    'users_zero_sessions', (select zero from funnel),
    'users_one_session', (select one from funnel),
    'users_two_plus_sessions', (select two_plus from funnel),
    'active_users_7d', (select count(*) from per_user where last_at >= now() - interval '7 days'),
    'active_users_30d', (select count(*) from per_user where last_at >= now() - interval '30 days'),
    'active_users_90d', (select count(*) from per_user where last_at >= now() - interval '90 days'),
    'churned_users', (select churned from funnel)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.admin_growth_curve(timestamptz[], text) from public, anon;
grant execute on function public.admin_growth_curve(timestamptz[], text) to authenticated;
revoke all on function public.admin_stats(text) from public, anon;
grant execute on function public.admin_stats(text) to authenticated;

comment on function public.admin_stats(text) is
  'Indicateurs du tableau de bord admin (aerox-mycompanion), réservé aux admins. p_period : weekly | monthly | yearly | all_time.';
