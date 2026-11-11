-- feat-session-clips : clips vidéo de séance (30 s / 1 min) créés par l'app
-- desktop, lus et partagés depuis le mobile, purgés au bout de 7 jours.

-- ---------------------------------------------------------------------------
-- Bucket privé : <uid>/<clip_id>_16x9.mp4 et <uid>/<clip_id>_9x16.mp4
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('session-clips', 'session-clips', false, 52428800, array['video/mp4']);

create policy "session_clips_insert_own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'session-clips'
    and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "session_clips_select_own" on storage.objects
  for select to authenticated
  using (bucket_id = 'session-clips'
    and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "session_clips_delete_own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'session-clips'
    and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ---------------------------------------------------------------------------
-- Liste des clips (le mobile l'affiche, le desktop l'écrit)
-- ---------------------------------------------------------------------------
create table public.session_clips (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  duration_s integer not null check (duration_s between 1 and 120),
  mode text not null check (mode in ('past', 'next')),
  session_name text check (char_length(session_name) <= 200),
  landscape_path text not null,
  portrait_path text not null,
  -- Fichiers rangés dans le dossier de l'utilisateur, au nom du clip.
  check (landscape_path = user_id::text || '/' || id::text || '_16x9.mp4'),
  check (portrait_path = user_id::text || '/' || id::text || '_9x16.mp4')
);

comment on table public.session_clips is
  'feat-session-clips : clips vidéo de séance, purgés à 7 jours (cleanup-session-clips).';

alter table public.session_clips enable row level security;

revoke all on public.session_clips from anon, authenticated;
grant select, insert, delete on public.session_clips to authenticated;

create policy "session_clips_rows_select_own" on public.session_clips
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "session_clips_rows_insert_own" on public.session_clips
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "session_clips_rows_delete_own" on public.session_clips
  for delete to authenticated
  using ((select auth.uid()) = user_id);

create index session_clips_user_created_idx on public.session_clips (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Purge à 7 jours (fichiers par l'API Storage dans l'Edge Function, SQL
-- interdit par storage.protect_delete)
-- ---------------------------------------------------------------------------
-- Fichiers de plus de 7 jours, lignes comprises ou orphelins (envoi
-- interrompu avant la ligne).
create or replace function public.session_clips_expired()
returns text[]
language sql
stable
security definer
set search_path to ''
as $$
  select coalesce(array_agg(name), '{}')
  from storage.objects
  where bucket_id = 'session-clips'
    and created_at < now() - interval '7 days';
$$;

revoke execute on function public.session_clips_expired() from public, anon, authenticated;
grant execute on function public.session_clips_expired() to service_role;

create or replace function public.request_session_clips_cleanup()
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  _secret text;
begin
  select decrypted_secret into _secret
  from vault.decrypted_secrets where name = 'bf_notify_secret' limit 1;
  if _secret is null then
    raise warning 'request_session_clips_cleanup: secret bf_notify_secret absent du Vault';
    return;
  end if;

  perform net.http_post(
    url := 'https://agvksgrjqskpetokudda.supabase.co/functions/v1/cleanup-session-clips',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', _secret)
  );
end;
$$;

revoke execute on function public.request_session_clips_cleanup() from public, anon, authenticated;

select cron.schedule(
  'cleanup-session-clips',
  '15 3 * * *',
  'select public.request_session_clips_cleanup()'
);
