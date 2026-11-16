-- supabase/migrations/20261116090844_mailerlite_parked_subscribers_origin.sql
--
-- Origine de l'inscription des inscrits MailerLite mis de côté : groupes
-- MailerLite d'appartenance (à reprendre à la réimportation) et IP
-- d'inscription quand MailerLite l'a (formulaire), preuve du consentement.

alter table public.mailerlite_parked_subscribers
  add column groups text[] not null default '{}',
  add column signup_ip text;
