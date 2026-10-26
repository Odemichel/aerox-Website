-- Identifiant Instagram d'un contact (sans @, en minuscules) : création rapide depuis un profil et détection des doublons.
alter table public.crm_contacts
  add column instagram text not null default ''
  constraint crm_contacts_instagram_check check (instagram = '' or instagram ~ '^[a-z0-9._]{1,30}$');

create unique index crm_contacts_instagram_key on public.crm_contacts (instagram) where instagram <> '';

-- Reprise des liens Instagram déjà notés dans les fiches.
update public.crm_contacts c
set instagram = lower(m[1])
from (
  select id, regexp_match(notes, 'instagram\.com/([A-Za-z0-9._]{1,30})') as m
  from public.crm_contacts
  where instagram = ''
) s
where s.id = c.id and s.m is not null;

create or replace view public.crm_contacts_view with (security_invoker = true) as
 SELECT c.id, c.slug, c.name, c.email, c.email_alt, c.company, c.country, c.lang, c.segment, c.stage, c.priority,
    c.next_action, c.notes, c.equipment, c.pricing, c.issue, c.ml_note, c.version, c.created_at, c.updated_at, c.updated_by,
    last.occurred_on AS last_on,
    last.direction AS last_direction,
    COALESCE(cnt.n, 0) AS events_count,
    c.instagram
   FROM public.crm_contacts c
     LEFT JOIN LATERAL ( SELECT e.occurred_on, e.direction
           FROM public.crm_events e
          WHERE e.contact_id = c.id
          ORDER BY e.occurred_on DESC, e.created_at DESC
         LIMIT 1) last ON true
     LEFT JOIN LATERAL ( SELECT count(*)::integer AS n
           FROM public.crm_events e
          WHERE e.contact_id = c.id) cnt ON true;
