-- supabase/migrations/20261116090251_mailerlite_parked_subscribers.sql
--
-- Inscrits MailerLite mis de côté : actifs qui ont reçu plusieurs e-mails sans
-- en ouvrir aucun, retirés de MailerLite pour rester sous le palier de 500
-- inscrits, et à réimporter quand la liste justifiera le palier supérieur.
-- On garde l'instantané MailerLite (id, source, compteurs, champs, date
-- d'inscription = preuve du consentement d'origine).
--
-- Les lignes ne sont pas dans ce fichier (adresses e-mail = données
-- personnelles, pas dans git) : insérées à part depuis l'API MailerLite.
--
-- Écriture : service_role seulement. Lecture : admins (RLS).

create table public.mailerlite_parked_subscribers (
  email text primary key check (email = lower(email)),
  mailerlite_id text not null unique,
  source text,
  sent integer not null,
  opens_count integer not null,
  clicks_count integer not null,
  subscribed_at timestamptz not null,
  fields jsonb not null default '{}'::jsonb,
  parked_at timestamptz not null default now(),
  reactivated_at timestamptz
);

alter table public.mailerlite_parked_subscribers enable row level security;
revoke all on public.mailerlite_parked_subscribers from anon, authenticated;

grant select on public.mailerlite_parked_subscribers to authenticated;
create policy mailerlite_parked_subscribers_admin_read on public.mailerlite_parked_subscribers
  for select to authenticated
  using ((select public.is_admin()));
