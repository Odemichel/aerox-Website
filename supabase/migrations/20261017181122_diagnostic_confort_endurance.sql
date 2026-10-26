-- feat-diagnostic-confort-endurance (veloaero) : diagnostic simplifié.
--
-- • S1 : test de confort libre de 5 min par position (note 0–10 + % du temps
--   à surface ≤ +5 %). L'ancienne note 1–5 (comfort_score) est conservée
--   pour les positions déjà notées.
-- • S2 : endurance libre à badges (temps en zone ≤ +10 % de la surface de la
--   position choisie), plus de stabilité. stability_score devient facultatif.
-- • Meilleure S2 = plus haut badge, puis plus de temps en zone.
-- • Rapport : zone de confort (matrice aéro × confort).
--
-- Additive : aucune ligne existante réécrite.

-- ---------- diagnostic_basic_positions ----------
alter table public.diagnostic_basic_positions
  add column if not exists comfort_rating smallint,
  add column if not exists comfort_in_zone_pct real,
  add column if not exists comfort_test_duration_s integer;

alter table public.diagnostic_basic_positions
  drop constraint if exists diagnostic_basic_positions_comfort_rating_check,
  add constraint diagnostic_basic_positions_comfort_rating_check
    check (comfort_rating is null or (comfort_rating >= 0 and comfort_rating <= 10)),
  drop constraint if exists diagnostic_basic_positions_comfort_in_zone_pct_check,
  add constraint diagnostic_basic_positions_comfort_in_zone_pct_check
    check (comfort_in_zone_pct is null or (comfort_in_zone_pct >= 0 and comfort_in_zone_pct <= 100));

comment on column public.diagnostic_basic_positions.comfort_rating is
  'Note de confort 0–10 donnée après le test de 5 min (ou à la place du test s''il est passé). feat-diagnostic-confort-endurance.';
comment on column public.diagnostic_basic_positions.comfort_in_zone_pct is
  '% des 300 s du test passées à surface ≤ +5 % de la surface enregistrée (arrêt anticipé : temps non roulé compté hors zone). NULL = test passé (score déclaratif).';
comment on column public.diagnostic_basic_positions.comfort_test_duration_s is
  'Durée réellement roulée du test de confort (s). NULL = test passé.';

-- ---------- diagnostic_basic_s2 ----------
alter table public.diagnostic_basic_s2
  alter column stability_score drop not null,
  add column if not exists time_in_zone_s integer,
  add column if not exists time_out_zone_s integer,
  add column if not exists target_surface_m2 double precision,
  add column if not exists target_cda double precision,
  add column if not exists mean_cda double precision,
  add column if not exists hold_difficulty smallint;

alter table public.diagnostic_basic_s2
  drop constraint if exists diagnostic_basic_s2_hold_difficulty_check,
  add constraint diagnostic_basic_s2_hold_difficulty_check
    check (hold_difficulty is null or (hold_difficulty >= 0 and hold_difficulty <= 10)),
  drop constraint if exists diagnostic_basic_s2_stop_reason_check,
  add constraint diagnostic_basic_s2_stop_reason_check
    check (stop_reason is null or stop_reason = any (array[
      'user_stop', 'out_of_zone_budget', 'im_completed', 'time_cap',
      -- anciennes séances (blocs progressifs)
      'warning_timeout', 'warnings_exceeded', 'block1_incomplete'
    ]));

comment on column public.diagnostic_basic_s2.time_in_zone_s is
  'Temps cumulé à surface ≤ +10 % de la position cible (s), échauffement exclu.';
comment on column public.diagnostic_basic_s2.time_out_zone_s is
  'Temps cumulé hors zone (s). Arrêt quand > max(180, 10 % de time_in_zone_s).';
comment on column public.diagnostic_basic_s2.hold_difficulty is
  'Difficulté à tenir la position, 0 (sans effort) à 10 (impossible de tenir plus). Remplace comfort_score en S2.';
comment on table public.diagnostic_basic_s2 is
  'Sessions S2 (endurance de position). ≤4 par diagnostic. Validée si au moins un badge (30 min en zone).';

-- Meilleure S2 : rang du plus haut badge, puis temps en zone.
create or replace function public.recompute_diagnostic_basic_best_s2() returns trigger
  language plpgsql security definer
  set search_path to ''
  as $$
begin
  update public.diagnostic_basic
  set best_s2_id = (
        select id
        from public.diagnostic_basic_s2
        where diagnostic_id = new.diagnostic_id
          and validated = true
        order by
          case
            when 'im' = any (aptitude_badges) then 4
            when '70_3' = any (aptitude_badges) then 3
            when '40km' = any (aptitude_badges) then 2
            when 'clm_court' = any (aptitude_badges) then 1
            else 0
          end desc,
          coalesce(time_in_zone_s, 0) desc,
          captured_at desc
        limit 1
      )
  where id = new.diagnostic_id;
  return null;
end;
$$;

drop trigger if exists trg_recompute_best_s2 on public.diagnostic_basic_s2;
create trigger trg_recompute_best_s2
  after insert or update of validated, aptitude_badges, time_in_zone_s
  on public.diagnostic_basic_s2
  for each row execute function public.recompute_diagnostic_basic_best_s2();

-- ---------- diagnostic_basic ----------
alter table public.diagnostic_basic
  add column if not exists comfort_zone text;

alter table public.diagnostic_basic
  drop constraint if exists diagnostic_basic_comfort_zone_check,
  add constraint diagnostic_basic_comfort_zone_check
    check (comfort_zone is null or comfort_zone = any (array['low', 'mid', 'high']));

comment on column public.diagnostic_basic.comfort_zone is
  'Zone de confort de la meilleure position S1 (score confort ≥ 70 high, ≥ 50 mid). Remplace stability_zone (plus écrite).';

-- ---------- webapp_session_state ----------
comment on column public.webapp_session_state.guided_state is
  'Etat guide synchronise desktop <-> mycompanion pour le diagnostic. Structure: {intro_shown, intro_texts, live_hint_text, reference_pending, reference_response, comfort_test: {test_id, phase: offer|running|rating, position_id, position_name, remaining_s, in_zone_pct, in_zone, texts}|null, s2_progress: {in_zone, in_zone_s, out_zone_s, budget_left_s, next_badge, next_badge_in_s, badges, last_badge: {slug, message, at_ms}|null, texts}|null, gear: {gear, gears, at_limit}|null}. Les strings sont resolues cote desktop (i18n desktop).';
