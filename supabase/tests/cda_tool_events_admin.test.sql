-- Compteur du calculateur de CdA : lecture réservée aux admins (RLS).
-- Table vidée : ce test ne dépend pas de l'ordre des autres.
truncate public.cda_tool_events;
insert into auth.users (id, email, email_confirmed_at)
values ('00000000-0000-0000-0000-00000000ad01', 'admin@example.com', now());
insert into public.users (id, email, role, is_active)
values ('00000000-0000-0000-0000-00000000ad01', 'admin@example.com', 'admin', true);
insert into public.cda_tool_events (kind, lang) values ('calc', 'fr');

set role authenticated;

-- Bike fitter (non admin) : aucune ligne, ni dans la table ni dans les vues.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a001', false);
do $$ begin
  assert (select count(*) from public.cda_tool_events) = 0, 'non-admin : table visible';
  assert (select count(*) from public.cda_tool_activity_daily) = 0, 'non-admin : vue visible';
end $$;

-- Admin : tout est visible, écriture toujours refusée.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000ad01', false);
do $$ begin
  assert (select count(*) from public.cda_tool_events) > 0, 'admin : table invisible';
  assert (select count(*) from public.cda_tool_activity_daily) > 0, 'admin : vue invisible';
  begin
    insert into public.cda_tool_events (kind, lang) values ('calc', 'fr');
    raise exception 'admin : écriture acceptée';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;
