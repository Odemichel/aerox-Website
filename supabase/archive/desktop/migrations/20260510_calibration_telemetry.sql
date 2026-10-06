-- feat-calibration-telemetry
-- Audit data store for re-evaluating calibration → surface measurement on
-- early testers. Distinct from the AeroX product mode "Diagnostique"
-- (3 aero protocols Basic/Expert/Complete).
--
-- Tables:
--   calibration_telemetry         (parent, 1 row per session)
--   calibration_telemetry_samples (child, 0..7 rows per session)
--
-- Bucket:
--   calibration-telemetry-private  (private, layout: {user_id}/{session_id}/{sample_id}.png)
--
-- RLS: owner read+insert/update + admin read all (`admin_read_all_*` pattern).

-- ────────────────────────────────────────────────────────────────────────
-- PARENT: 1 row per session (latest-wins on calibration / hardware fields)
-- ────────────────────────────────────────────────────────────────────────
create table public.calibration_telemetry (
  session_id uuid primary key references public.sessions(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),

  -- Calibration finale (latest-wins)
  lcintre_m                  double precision,
  cam_distance_m             double precision,
  saddle_distance_m          double precision,
  pixel_p1                   jsonb,
  pixel_p2                   jsonb,
  cintre_pix_640             double precision,
  echelle_m_per_px           double precision,
  proportionality_coef       double precision,
  facteur_correctif_surface  double precision,
  mask_height_px             int,
  mask_width_px              int,
  shape_frame                jsonb,
  roi                        jsonb,

  -- Hardware utilisé (latest-wins)
  camera_used            jsonb,
  ht_connected           jsonb,
  hrm_connected          jsonb,

  -- Listes détectées (latest snapshot)
  webcams_detected       jsonb default '[]'::jsonb,
  hts_detected           jsonb default '[]'::jsonb,
  hrms_detected          jsonb default '[]'::jsonb,

  -- Compteur diagnostique (Flutter-side increment per calibration_end trigger)
  recalibration_count    int not null default 0
);

create index calibration_telemetry_user_idx
  on public.calibration_telemetry (user_id, created_at desc);

alter table public.calibration_telemetry enable row level security;

create policy "user_select_own_telemetry"
  on public.calibration_telemetry for select
  using (auth.uid() = user_id);

create policy "user_insert_own_telemetry"
  on public.calibration_telemetry for insert
  with check (auth.uid() = user_id);

create policy "user_update_own_telemetry"
  on public.calibration_telemetry for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "admin_read_all_telemetry"
  on public.calibration_telemetry for select
  using ((select role from public.users where id = auth.uid()) = 'admin');

comment on table public.calibration_telemetry is
  'feat-calibration-telemetry: per-session calibration + hardware audit metadata. 1 row per session, parent of calibration_telemetry_samples. Distinct from AeroX product mode "Diagnostique".';

-- ────────────────────────────────────────────────────────────────────────
-- CHILD: 0..7 samples per session (paired with FrameCollector JPEG slots)
-- ────────────────────────────────────────────────────────────────────────
create table public.calibration_telemetry_samples (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references public.calibration_telemetry(session_id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  captured_at  timestamptz not null default now(),

  slot_index     smallint not null check (slot_index between 0 and 6),
  trigger_type   text not null check (trigger_type in ('auto', 'surface_bucket', 'on_demand')),

  surface_m2          double precision,
  cda                 double precision,
  mask_png_url        text,
  mask_height_px      int,
  mask_width_px       int,
  echelle_m_per_px    double precision,

  power_w        int,
  elapsed_s      double precision,
  frame_filename text
);

create index calibration_telemetry_samples_session_idx
  on public.calibration_telemetry_samples (session_id, captured_at);

alter table public.calibration_telemetry_samples enable row level security;

create policy "user_select_own_telemetry_samples"
  on public.calibration_telemetry_samples for select
  using (auth.uid() = user_id);

create policy "user_insert_own_telemetry_samples"
  on public.calibration_telemetry_samples for insert
  with check (auth.uid() = user_id);

create policy "admin_read_all_telemetry_samples"
  on public.calibration_telemetry_samples for select
  using ((select role from public.users where id = auth.uid()) = 'admin');

-- Pas d'UPDATE/DELETE policy : samples immutables, cleanup uniquement via CASCADE
-- (suppression du parent ou du user supabase).

comment on table public.calibration_telemetry_samples is
  'feat-calibration-telemetry: mask + surface samples paired with FrameCollector JPEG captures. Mask PNG stored in bucket calibration-telemetry-private/{user_id}/{session_id}/{sample_id}.png.';

-- ────────────────────────────────────────────────────────────────────────
-- BUCKET STORAGE
-- ────────────────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('calibration-telemetry-private', 'calibration-telemetry-private', false)
on conflict (id) do nothing;

-- Layout : calibration-telemetry-private/{user_id}/{session_id}/{sample_id}.png
-- (storage.foldername(name))[1] = user_id segment

create policy "user_upload_own_telemetry_masks"
  on storage.objects for insert
  with check (
    bucket_id = 'calibration-telemetry-private'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "user_read_own_telemetry_masks"
  on storage.objects for select
  using (
    bucket_id = 'calibration-telemetry-private'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "admin_read_all_telemetry_masks"
  on storage.objects for select
  using (
    bucket_id = 'calibration-telemetry-private'
    and (select role from public.users where id = auth.uid()) = 'admin'
  );
