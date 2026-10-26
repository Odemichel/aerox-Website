-- supabase/migrations/20261002110000_cda_tool_events_admin_read.sql
--
-- Lecture du compteur du calculateur de CdA par les admins, depuis
-- l'interface admin de mycompanion (client Supabase + JWT de l'admin, donc
-- soumis à la RLS). Les vues étant en security_invoker, la politique de la
-- table s'applique aussi à elles : un utilisateur non admin n'y voit aucune
-- ligne. L'écriture reste réservée à la route serveur (service_role).

grant select on public.cda_tool_events to authenticated;

create policy cda_tool_events_admin_read on public.cda_tool_events
  for select to authenticated
  using ((select public.is_admin()));

grant select on public.cda_tool_activity_daily, public.cda_tool_activity_weekly, public.cda_tool_activity_monthly
  to authenticated;
