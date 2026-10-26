-- Position retenue par le bike fitter en fin de fitting : la position
-- « après » de son rapport et de la carte de partage, à côté de la
-- référence (`is_reference`). Pas forcément la plus aéro (la plus
-- confortable par exemple). Une seule par séance, posée par l'app desktop.
alter table public.session_positions
  add column if not exists is_selected boolean not null default false;

comment on column public.session_positions.is_selected is
  'Position retenue par le bike fitter (« après » du rapport et de la carte de partage). Une seule par séance.';
