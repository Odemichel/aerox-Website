-- ============================================================================
-- feat-k-history — historique des corrections de setup (k) par caméra
-- ============================================================================
-- k (`setup_correction`) est déterminé à la première calibration réussie
-- d'une caméra, puis chaque début de séance en mesure un nouveau : le k
-- appliqué est la médiane des 5 derniers k de la caméra (calcul côté app).
--
-- Entrent dans l'historique :
--   calibration        1re calibration réussie de la caméra (ou après reset)
--   session_ok         mesure de début de séance à écart ≤ 10 %
--   session_corrected  écart > 10 %, le rider a choisi « Corriger
--                      automatiquement » (k appliqué pour la séance)
-- « Continuer » et « Refaire la calibration » n'y écrivent rien.
--
-- `users.setup_correction` / `setup_anchor` restent le cache du k courant et
-- de sa caméra, envoyés à Rust à la connexion.

create table public.setup_correction_history (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  camera_name text not null,
  k           double precision not null check (k between 0.5 and 2.0),
  source      text not null
              check (source in ('calibration', 'session_ok', 'session_corrected')),
  gap_pct     double precision,
  created_at  timestamptz not null default now()
);

comment on table public.setup_correction_history is
  'feat-k-history : k mesurés par caméra (calibration + débuts de séance). '
  'k appliqué = médiane des 5 derniers de la caméra.';

-- Lecture type : 5 derniers k d'un rider pour une caméra.
create index setup_correction_history_user_camera_idx
  on public.setup_correction_history (user_id, camera_name, created_at desc);

alter table public.setup_correction_history enable row level security;

create policy "own_select_k_history" on public.setup_correction_history
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "own_insert_k_history" on public.setup_correction_history
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

-- Reset du k (profil admin) : le rider supprime son propre historique.
create policy "own_delete_k_history" on public.setup_correction_history
  for delete to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.setup_correction_history from anon;
revoke update, truncate on public.setup_correction_history from authenticated;
