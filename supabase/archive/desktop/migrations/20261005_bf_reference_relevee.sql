-- ============================================================================
-- feat-bf-reference-relevee — k par client de bike fitter + référence de séance
-- ============================================================================
-- Le bike fitter déclare son client en position relevée en début de fitting ;
-- la mesure (morphologie du client) définit le k du client pour la caméra,
-- ou le contrôle. Ces k vivent dans `setup_correction_history` avec
-- `client_id` renseigné ; les k « rider » restent à `client_id is null`.
--
-- `session_positions.is_reference` : référence des gains/pertes choisie par
-- le bike fitter (repli applicatif sur la 1re position si aucune).

alter table public.setup_correction_history
  add column client_id uuid references public.bf_clients (id) on delete cascade;

alter table public.setup_correction_history
  drop constraint setup_correction_history_source_check;
alter table public.setup_correction_history
  add constraint setup_correction_history_source_check
  check (source = any (array['calibration', 'session_ok', 'session_corrected', 'bf_reference']));

create index setup_correction_history_client_idx
  on public.setup_correction_history (user_id, camera_name, client_id, created_at desc)
  where client_id is not null;

-- Un bike fitter n'écrit de k que pour ses propres clients.
drop policy own_insert_k_history on public.setup_correction_history;
create policy own_insert_k_history on public.setup_correction_history
  for insert
  with check (
    (select auth.uid()) = user_id
    and (
      client_id is null
      or exists (
        select 1 from public.bf_clients c
        where c.id = client_id and c.bf_user_id = (select auth.uid())
      )
    )
  );

alter table public.session_positions
  add column is_reference boolean not null default false;
