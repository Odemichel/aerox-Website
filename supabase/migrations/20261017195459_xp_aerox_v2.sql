-- feat-xp-aerox-v2 (veloaero) : XP AeroX par zone de position.
--
-- • sessions.aero_xp : XP de la séance avec le nouveau barème (XP/min par
--   zone, ×2 après 5 min continues ≥ 70 %). NULL pour les séances
--   antérieures : le total reste Σ coalesce(aero_xp, aero_qualified_s / 60).
--   Plafond : 3 XP/min (1,5 × 2) sur la durée de la séance.
-- • webapp_session_state.xp_state : état XP live publié par le desktop pour
--   le téléphone ({total, rate, boosted, streak_s, grace_s, out_s}).
--
-- Additive : aucune ligne existante réécrite.

alter table public.sessions
  add column if not exists aero_xp numeric(8, 2);

alter table public.sessions
  drop constraint if exists sessions_aero_xp_check,
  add constraint sessions_aero_xp_check
    check (aero_xp is null or (aero_xp >= 0 and aero_xp <= greatest(duration_s, 0) * 3.0 / 60.0 + 0.01));

comment on column public.sessions.aero_xp is
  'XP AeroX de la séance (barème par zone de position, bonus ×2). NULL = séance antérieure à feat-xp-aerox-v2 (XP = aero_qualified_s / 60).';

alter table public.webapp_session_state
  add column if not exists xp_state jsonb;

comment on column public.webapp_session_state.xp_state is
  'XP AeroX live : {total, rate, boosted, streak_s, grace_s, out_s}. feat-xp-aerox-v2.';
