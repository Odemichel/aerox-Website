create table public.setup_correction_history (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  camera_name text not null,
  k           double precision not null check (k between 0.5 and 2.0),
  source      text not null
              check (source in ('calibration', 'session_ok', 'session_corrected')),
  gap_pct     double precision,
  created_at  timestamptz not null default now()
);

comment on table public.setup_correction_history is
  'feat-k-history : k mesurés par caméra (calibration + débuts de séance). '
  'k appliqué = médiane des 5 derniers de la caméra.';

create index setup_correction_history_user_camera_idx
  on public.setup_correction_history (user_id, camera_name, created_at desc);

alter table public.setup_correction_history enable row level security;

create policy "own_select_k_history" on public.setup_correction_history
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "own_insert_k_history" on public.setup_correction_history
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "own_delete_k_history" on public.setup_correction_history
  for delete to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.setup_correction_history from anon;
revoke update, truncate on public.setup_correction_history from authenticated;
