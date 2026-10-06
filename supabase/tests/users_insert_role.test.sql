-- supabase/tests/users_insert_role.test.sql
-- Un utilisateur ne peut créer sa ligne public.users qu'avec un rôle de départ.
-- RLS activée le temps du test (le socle de test ne l'active pas sur users).

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000e0001', 'malin@example.com', now()),
  ('00000000-0000-0000-0000-0000000e0002', 'normal@example.com', now()),
  ('00000000-0000-0000-0000-0000000e0003', 'defaut@example.com', now());

alter table public.users enable row level security;
create policy users_test_read on public.users for select to authenticated using (true);
grant insert, select on public.users to authenticated;

set role authenticated;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0001', false);
do $$ begin
  begin
    insert into public.users (id, email, role) values ('00000000-0000-0000-0000-0000000e0001', 'malin@example.com', 'admin');
    raise exception 'insertion avec role admin acceptée';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.users (id, email, role) values ('00000000-0000-0000-0000-0000000e0001', 'malin@example.com', 'bike-fitter');
    raise exception 'insertion avec role bike-fitter acceptée';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0002', false);
insert into public.users (id, email, role) values ('00000000-0000-0000-0000-0000000e0002', 'normal@example.com', 'pending_bf');

-- Profil créé sans rôle (app mobile) : valeur par défaut acceptée.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0003', false);
insert into public.users (id, email, role) values ('00000000-0000-0000-0000-0000000e0003', 'defaut@example.com', 'user');

reset role;

do $$ begin
  assert (select count(*) from public.users where id = '00000000-0000-0000-0000-0000000e0001') = 0, 'ligne admin créée';
  assert (select role from public.users where id = '00000000-0000-0000-0000-0000000e0002') = 'pending_bf', 'pending_bf refusé';
  assert (select role from public.users where id = '00000000-0000-0000-0000-0000000e0003') = 'user', 'défaut refusé';
end $$;

drop policy users_test_read on public.users;
alter table public.users disable row level security;
