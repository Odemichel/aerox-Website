-- Note de confort 0–10 d'une position de fitting, saisie par le bike fitter
-- (desktop) ou le client (mycompanion) à l'enregistrement de la position,
-- comme `diagnostic_basic_positions.comfort_rating` en diagnostic.

alter table public.session_positions
  add column if not exists comfort_rating smallint;

alter table public.session_positions
  drop constraint if exists session_positions_comfort_rating_check,
  add constraint session_positions_comfort_rating_check
    check (comfort_rating is null or (comfort_rating >= 0 and comfort_rating <= 10));

comment on column public.session_positions.comfort_rating is
  'Confort de la position, 0 (intenable) à 10 (parfaitement confortable). Null = non noté.';
