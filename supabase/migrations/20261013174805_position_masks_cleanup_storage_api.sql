-- La purge nocturne de `position-masks` supprimait les fichiers en SQL ;
-- Supabase l'interdit désormais (`storage.protect_delete`) et le job
-- échouait chaque nuit depuis au moins le 2026-10-09. La suppression passe
-- maintenant par l'API Storage, dans l'Edge Function cleanup-position-masks.

-- Chemins des masques de plus de 24 h (lecture seule, appelée par l'Edge
-- Function avec la clé service).
create or replace function public.position_masks_expired()
returns text[]
language sql
stable
security definer
set search_path to ''
as $$
  select coalesce(array_agg(name), '{}')
  from storage.objects
  where bucket_id = 'position-masks'
    and created_at < now() - interval '24 hours';
$$;

revoke execute on function public.position_masks_expired() from public, anon, authenticated;
grant execute on function public.position_masks_expired() to service_role;

-- Appel de l'Edge Function par pg_cron (pg_net, secret du Vault).
create or replace function public.request_position_masks_cleanup()
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
    raise warning 'request_position_masks_cleanup: secret bf_notify_secret absent du Vault';
    return;
  end if;

  perform net.http_post(
    url := 'https://agvksgrjqskpetokudda.supabase.co/functions/v1/cleanup-position-masks',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', _secret)
  );
end;
$$;

revoke execute on function public.request_position_masks_cleanup() from public, anon, authenticated;

-- Même job, même horaire : il appelle désormais l'Edge Function.
select cron.unschedule('cleanup-position-masks-orphans');
select cron.schedule(
  'cleanup-position-masks-orphans',
  '0 3 * * *',
  'select public.request_position_masks_cleanup()'
);

drop function if exists public.cleanup_position_masks_orphans();
