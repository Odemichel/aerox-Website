-- Compteur du calculateur de CdA : contraintes et agrégats des vues.
insert into public.cda_tool_events (created_at, kind, lang, bike) values
  ('2026-10-01 10:00+02', 'calc', 'fr', null),
  ('2026-10-01 10:01+02', 'calc', 'fr', null),
  ('2026-10-01 10:02+02', 'analyze', 'fr', 'road'),
  ('2026-10-02 23:30+02', 'analyze', 'de', 'tt');

do $$
declare r record;
begin
  select * into r from public.cda_tool_activity_daily where day = '2026-10-01';
  assert r.calculations = 2 and r.analyses = 1 and r.analyses_road = 1 and r.analyses_tt = 0, 'jour 2026-10-01';
  select * into r from public.cda_tool_activity_weekly where week_start = '2026-09-28';
  assert r.calculations = 2 and r.analyses = 2, 'semaine du 28/09';
  select * into r from public.cda_tool_activity_monthly where month = '2026-10-01';
  assert r.calculations = 2 and r.analyses = 2, 'mois d''octobre';
end $$;

-- Vélo obligatoire pour une analyse, interdit pour un calcul ; type et langue en liste fermée.
do $$
begin
  begin insert into public.cda_tool_events (kind, lang, bike) values ('analyze', 'fr', null); raise exception 'analyse sans vélo acceptée'; exception when check_violation then null; end;
  begin insert into public.cda_tool_events (kind, lang, bike) values ('calc', 'fr', 'tt'); raise exception 'calcul avec vélo accepté'; exception when check_violation then null; end;
  begin insert into public.cda_tool_events (kind, lang) values ('hack', 'fr'); raise exception 'type inconnu accepté'; exception when check_violation then null; end;
  begin insert into public.cda_tool_events (kind, lang) values ('calc', 'xx'); raise exception 'langue inconnue acceptée'; exception when check_violation then null; end;
end $$;
