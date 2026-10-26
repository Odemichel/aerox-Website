-- supabase/migrations/20260924140000_bf_trigger_functions_private.sql
--
-- Fonctions de trigger SECURITY DEFINER : jamais appelables via l'API
-- (/rest/v1/rpc). Un trigger n'a pas besoin du droit EXECUTE de l'appelant
-- pour se déclencher.
revoke execute on function public.notify_admin_new_bf() from public, anon, authenticated;
revoke execute on function public.handle_email_confirmed() from public, anon, authenticated;
