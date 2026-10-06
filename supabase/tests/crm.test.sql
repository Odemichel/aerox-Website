-- supabase/tests/crm.test.sql
-- CRM privé : accès réservé aux membres, version de fiche, dernier échange
-- calculé, fiche créée à l'inscription d'un bike fitter sans jamais bloquer.
-- Données propres à ce test (préfixe c0…) : indépendant de l'ordre des autres.

insert into auth.users (id, email, email_confirmed_at, last_sign_in_at) values
  ('00000000-0000-0000-0000-0000000c0001', 'membre@example.com', now(), now()),
  ('00000000-0000-0000-0000-0000000c0002', 'intrus@example.com', now(), now()),
  ('00000000-0000-0000-0000-0000000c0003', 'fitter.crm@example.com', now(), now());
insert into public.crm_members (user_id, email)
values ('00000000-0000-0000-0000-0000000c0001', 'membre@example.com');
insert into public.users (id, email, role, is_active)
values ('00000000-0000-0000-0000-0000000c0002', 'intrus@example.com', 'rider', true);

-- Inscription d'un bike fitter : fiche « lead » + un échange entrant.
insert into public.users (id, email, firstname, name, role, is_active)
values ('00000000-0000-0000-0000-0000000c0003', 'Fitter.CRM@example.com', 'Ana', 'Lopes', 'pending_bf', false);
do $$ begin
  assert (select count(*) from public.crm_contacts where lower(email) = 'fitter.crm@example.com') = 1,
    'inscription : fiche non créée';
  assert (select name from public.crm_contacts where lower(email) = 'fitter.crm@example.com') = 'Ana Lopes',
    'inscription : nom non repris';
  assert (select stage from public.crm_contacts where lower(email) = 'fitter.crm@example.com') = 'lead',
    'inscription : étape différente de lead';
  assert (select count(*) from public.crm_events e join public.crm_contacts c on c.id = e.contact_id
          where lower(c.email) = 'fitter.crm@example.com') = 1, 'inscription : échange non créé';
end $$;

-- Passage pending_bf -> bike-fitter : pas de nouvel échange ni de doublon.
update public.users set role = 'bike-fitter' where id = '00000000-0000-0000-0000-0000000c0003';
do $$ begin
  assert (select count(*) from public.crm_contacts where lower(email) = 'fitter.crm@example.com') = 1,
    'changement de rôle : doublon de fiche';
  assert (select count(*) from public.crm_events e join public.crm_contacts c on c.id = e.contact_id
          where lower(c.email) = 'fitter.crm@example.com') = 1, 'changement de rôle : échange en double';
end $$;

-- Une erreur du CRM ne bloque pas l'inscription : une contrainte de test fait
-- échouer la création de la fiche, l'inscription doit passer quand même.
insert into auth.users (id, email, email_confirmed_at) values ('00000000-0000-0000-0000-0000000c0004', 'casse@example.com', now());
alter table public.crm_contacts add constraint crm_test_block check (email <> 'casse@example.com');
insert into public.users (id, email, role, is_active)
values ('00000000-0000-0000-0000-0000000c0004', 'casse@example.com', 'bike-fitter', true);
do $$ begin
  assert (select count(*) from public.users where id = '00000000-0000-0000-0000-0000000c0004') = 1,
    'erreur CRM : inscription bloquée';
end $$;
alter table public.crm_contacts drop constraint crm_test_block;

-- Un cycliste n'a pas de fiche.
do $$ begin
  assert (select count(*) from public.crm_contacts where lower(email) = 'intrus@example.com') = 0,
    'cycliste : fiche créée à tort';
end $$;

set role authenticated;

-- Non-membre : rien à lire, rien à écrire, pas d'état de compte.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0002', false);
do $$ begin
  assert (select count(*) from public.crm_contacts) = 0, 'non-membre : fiches visibles';
  assert (select count(*) from public.crm_contacts_view) = 0, 'non-membre : vue visible';
  assert (select count(*) from public.crm_events) = 0, 'non-membre : échanges visibles';
  assert not public.crm_is_member(), 'non-membre : reconnu membre';
  begin
    insert into public.crm_contacts (slug, name) values ('pirate', 'Pirate');
    raise exception 'non-membre : création acceptée';
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from public.crm_account_status(array['fitter.crm@example.com']);
    raise exception 'non-membre : état de compte lisible';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Membre : lecture, écriture, état de compte, version, dernier échange.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0001', false);
do $$
declare _id uuid; _v int; _n int;
begin
  assert public.crm_is_member(), 'membre : non reconnu';
  select id, version into _id, _v from public.crm_contacts where lower(email) = 'fitter.crm@example.com';
  assert _id is not null, 'membre : fiche invisible';

  update public.crm_contacts set stage = 'demo' where id = _id and version = _v;
  get diagnostics _n = row_count;
  assert _n = 1, 'membre : mise à jour refusée';
  assert (select version from public.crm_contacts where id = _id) = _v + 1, 'version non incrémentée';
  assert (select updated_by from public.crm_contacts where id = _id) = '00000000-0000-0000-0000-0000000c0001',
    'auteur de la modification non enregistré';

  -- Version périmée : aucune ligne modifiée.
  update public.crm_contacts set stage = 'test' where id = _id and version = _v;
  get diagnostics _n = row_count;
  assert _n = 0, 'version périmée : modification acceptée';

  insert into public.crm_events (contact_id, occurred_on, direction, summary)
  values (_id, current_date + 1, 'out', 'Invitation démo collective');
  assert (select last_direction from public.crm_contacts_view where id = _id) = 'out', 'dernier échange non calculé';
  assert (select events_count from public.crm_contacts_view where id = _id) = 2, 'nombre d''échanges faux';

  assert (select role from public.crm_account_status(array['FITTER.crm@example.com'])) = 'bike-fitter',
    'état de compte : rôle absent';

  begin
    delete from public.crm_contacts where id = _id;
    raise exception 'membre : suppression acceptée';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;

-- Connexion : seules les adresses des membres sont acceptées (anonyme).
set role anon;
do $$ begin
  assert public.crm_login_allowed(' Membre@Example.com '), 'connexion : membre refusé';
  assert not public.crm_login_allowed('intrus@example.com'), 'connexion : intrus accepté';
end $$;
reset role;
