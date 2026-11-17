-- feat-training-calendar (temps A) : calendrier d'entraînement.
--
-- * sessions.intervals_event_id : séance planifiée Intervals.icu jouée (le
--   calendrier la marque faite) ;
-- * user_plan_progress.training_days : jours d'entraînement choisis au
--   démarrage d'un plan (1 = lundi … 7 = dimanche) ;
-- * user_plan_schedule : date prévue de chaque séance d'un plan suivi,
--   posée sur ces jours (original_date) puis déplaçable à ±2 jours
--   (scheduled_date). Écrite par l'app du rider, sous RLS.

alter table public.sessions
  add column if not exists intervals_event_id text;

alter table public.user_plan_progress
  add column if not exists training_days smallint[],
  add constraint user_plan_progress_training_days_check
    check (training_days is null or training_days <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]);

create table public.user_plan_schedule (
  progress_id uuid not null references public.user_plan_progress (id) on delete cascade,
  plan_session_id uuid not null references public.plan_sessions (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  original_date date not null,
  scheduled_date date not null,
  primary key (progress_id, plan_session_id),
  constraint user_plan_schedule_window check (abs(scheduled_date - original_date) <= 2)
);

comment on table public.user_plan_schedule is
  'feat-training-calendar : date prévue de chaque séance d''un plan suivi (déplaçable à ±2 j).';

alter table public.user_plan_schedule enable row level security;

revoke all on public.user_plan_schedule from anon;
grant select, insert, update, delete on public.user_plan_schedule to authenticated;

create policy "user_plan_schedule_own" on public.user_plan_schedule
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.user_plan_progress p
      where p.id = progress_id and p.user_id = (select auth.uid())
    )
  );

create index user_plan_schedule_user_date_idx on public.user_plan_schedule (user_id, scheduled_date);
