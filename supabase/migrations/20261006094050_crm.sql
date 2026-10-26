-- supabase/migrations/20261006100000_crm.sql
--
-- CRM privé (crm.aeroxbefaster.com, dépôt aerox-crm) : contacts, échanges et
-- membres, réservés aux membres du CRM (Olivier, Marlène). Le site n'utilise
-- pas ces tables ; il n'est concerné que par un déclencheur qui crée la fiche
-- d'un nouvel inscrit bike fitter, et qui ne doit jamais bloquer l'inscription.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.crm_members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  created_at timestamptz not null default now()
);

create table public.crm_contacts (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null check (length(trim(name)) > 0),
  email text not null default '',
  email_alt text not null default '',
  company text not null default '',
  country text not null default '',
  lang text not null default 'fr',
  segment text not null default 'bf'
    check (segment in ('bf', 'cycliste', 'coach', 'evenement', 'industrie')),
  stage text not null default 'lead'
    check (stage in ('lead', 'demo', 'test', 'client', 'partenaire', 'froid')),
  priority boolean not null default false,
  next_action text not null default '',
  notes text not null default '',
  equipment text not null default '',
  pricing text not null default '',
  issue text not null default '',
  -- Libellé MailerLite saisi à la main (ex. « actif · BF en attente »), repris
  -- de l'ancien CRM ; l'état réel vient de la fonction crm-mailerlite.
  ml_note text not null default '',
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);
-- Un même e-mail ne peut avoir qu'une fiche (sans tenir compte de la casse).
create unique index crm_contacts_email_key on public.crm_contacts (lower(email)) where email <> '';

create table public.crm_events (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.crm_contacts (id) on delete cascade,
  occurred_on date not null,
  direction text not null check (direction in ('in', 'out')),
  summary text not null check (length(trim(summary)) > 0),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index crm_events_contact_idx on public.crm_events (contact_id, occurred_on desc);

-- ---------------------------------------------------------------------------
-- Appartenance
-- ---------------------------------------------------------------------------

create function public.crm_is_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.crm_members where user_id = auth.uid());
$$;

-- Avant l'envoi d'un lien magique : l'adresse est-elle celle d'un membre ?
-- Ne renvoie qu'un booléen (rien sur les autres comptes).
create function public.crm_login_allowed(p_email text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.crm_members where lower(email) = lower(trim(p_email)));
$$;

-- ---------------------------------------------------------------------------
-- Version de fiche et auteur : une modification sur une version périmée
-- n'aboutit pas (l'appli filtre sur `version` et voit 0 ligne modifiée).
-- ---------------------------------------------------------------------------

create function public.crm_contacts_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.version := old.version + 1;
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end;
$$;

create trigger trg_crm_contacts_touch
before update on public.crm_contacts
for each row execute function public.crm_contacts_touch();

create function public.crm_events_author()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.created_by := coalesce(auth.uid(), new.created_by);
  return new;
end;
$$;

create trigger trg_crm_events_author
before insert on public.crm_events
for each row execute function public.crm_events_author();

-- ---------------------------------------------------------------------------
-- Vue : fiche + dernier échange (calculé, plus saisi à la main)
-- ---------------------------------------------------------------------------

create view public.crm_contacts_view
with (security_invoker = true)
as
select
  c.*,
  last.occurred_on as last_on,
  last.direction as last_direction,
  coalesce(cnt.n, 0) as events_count
from public.crm_contacts c
left join lateral (
  select e.occurred_on, e.direction
  from public.crm_events e
  where e.contact_id = c.id
  order by e.occurred_on desc, e.created_at desc
  limit 1
) last on true
left join lateral (
  select count(*)::int as n from public.crm_events e where e.contact_id = c.id
) cnt on true;

-- ---------------------------------------------------------------------------
-- État des comptes du site, pour les membres du CRM uniquement
-- ---------------------------------------------------------------------------

create function public.crm_account_status(p_emails text[])
returns table (
  email text,
  user_id uuid,
  role text,
  is_active boolean,
  account_created_at timestamptz,
  last_sign_in_at timestamptz,
  plan text,
  billing_status text,
  trial_state text,
  trial_ends_at timestamptz,
  has_business_id boolean,
  has_trial_card boolean,
  analyses_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.crm_is_member() then
    raise exception 'crm: accès réservé aux membres' using errcode = '42501';
  end if;
  return query
  select
    lower(u.email)::text,
    u.id,
    pu.role,
    pu.is_active,
    u.created_at,
    u.last_sign_in_at,
    b.plan,
    b.status,
    b.trial_state,
    b.trial_ends_at,
    exists (select 1 from public.bf_business_ids bi where bi.user_id = u.id),
    exists (select 1 from public.bf_trial_cards tc where tc.user_id = u.id),
    (select count(*)::int from public.bf_analyses a where a.user_id = u.id)
  from auth.users u
  left join public.users pu on pu.id = u.id
  left join public.bf_billing b on b.user_id = u.id
  where lower(u.email) = any (select lower(x) from unnest(p_emails) x);
end;
$$;

-- ---------------------------------------------------------------------------
-- Nouvel inscrit bike fitter : fiche créée (ou échange ajouté si l'e-mail est
-- déjà connu). Ne lève jamais : une erreur ici ne doit pas bloquer le site.
-- ---------------------------------------------------------------------------

create function public.crm_on_bf_signup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  _contact uuid;
  _email text := lower(coalesce(new.email, ''));
  _slug text;
begin
  if new.role not in ('bike-fitter', 'pending_bf') then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.role in ('bike-fitter', 'pending_bf') then
    return new;
  end if;
  if _email = '' then
    return new;
  end if;

  begin
    select c.id into _contact
    from public.crm_contacts c
    where lower(c.email) = _email or lower(c.email_alt) = _email
    limit 1;

    if _contact is null then
      _slug := regexp_replace(split_part(_email, '@', 1), '[^a-z0-9]+', '-', 'g')
               || '-' || substr(md5(_email), 1, 6);
      insert into public.crm_contacts (slug, name, email, segment, stage, ml_note, issue)
      values (
        _slug,
        coalesce(nullif(trim(coalesce(new.firstname, '') || ' ' || coalesce(new.name, '')), ''), split_part(_email, '@', 1)),
        _email,
        'bf',
        'lead',
        '',
        case when new.role = 'pending_bf' then 'Compte en attente d''activation (pending_bf)' else '' end
      )
      returning id into _contact;
    end if;

    insert into public.crm_events (contact_id, occurred_on, direction, summary)
    values (_contact, current_date, 'in', 'Inscription bike fitter sur le site');
  exception when others then
    raise warning 'crm_on_bf_signup: %', sqlerrm;
  end;
  return new;
end;
$$;

create trigger trg_crm_bf_signup
after insert or update of role on public.users
for each row execute function public.crm_on_bf_signup();

-- ---------------------------------------------------------------------------
-- Accès : membres uniquement, pas de suppression par l'API
-- ---------------------------------------------------------------------------

alter table public.crm_members enable row level security;
alter table public.crm_contacts enable row level security;
alter table public.crm_events enable row level security;

revoke all on public.crm_members, public.crm_contacts, public.crm_events, public.crm_contacts_view from anon, authenticated;
grant select on public.crm_members to authenticated;
grant select, insert, update on public.crm_contacts to authenticated;
grant select, insert on public.crm_events to authenticated;
grant select on public.crm_contacts_view to authenticated;

create policy crm_members_read on public.crm_members
  for select to authenticated using (public.crm_is_member());

create policy crm_contacts_read on public.crm_contacts
  for select to authenticated using (public.crm_is_member());
create policy crm_contacts_insert on public.crm_contacts
  for insert to authenticated with check (public.crm_is_member());
create policy crm_contacts_update on public.crm_contacts
  for update to authenticated using (public.crm_is_member()) with check (public.crm_is_member());

create policy crm_events_read on public.crm_events
  for select to authenticated using (public.crm_is_member());
create policy crm_events_insert on public.crm_events
  for insert to authenticated with check (public.crm_is_member());

revoke execute on function public.crm_is_member() from public, anon;
grant execute on function public.crm_is_member() to authenticated;
revoke execute on function public.crm_login_allowed(text) from public;
grant execute on function public.crm_login_allowed(text) to anon, authenticated;
revoke execute on function public.crm_account_status(text[]) from public, anon;
grant execute on function public.crm_account_status(text[]) to authenticated;
revoke execute on function public.crm_on_bf_signup() from public, anon, authenticated;
