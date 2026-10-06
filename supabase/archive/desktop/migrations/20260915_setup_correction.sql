-- ============================================================================
-- feat-double-calibration-geo-morpho — correction de setup caméra + contrôle
-- ============================================================================
-- La calibration géométrique (cintre) devient le chemin unique de mesure. Elle
-- est suivie d'un contrôle morpho de 10 s qui, à la première séance, ancre une
-- correction multiplicative propre au setup caméra de l'utilisateur
-- (`setup_correction`), puis se contente de la valider aux séances suivantes.
--
-- `setup_correction` NULL = jamais ancré → le prochain contrôle ancre.
-- Elle n'est ré-ancrée que sur changement de setup : caméra différente,
-- distance modifiée de plus de 20 cm, ou confirmation explicite après un
-- écart de plus de 10 %. Un changement de cintre est une recalibration
-- géométrique, PAS un ré-ancrage — sinon la morpho absorberait la
-- différence entre deux vélos et le diagnostic multi-séance ne pourrait
-- plus les comparer.
--
-- `setup_anchor` conserve le contexte de l'ancrage :
--   { camera_name: text, d_m: float, f_px: float|null, anchored_at: iso8601 }
-- `f_px` (focale en pixels, constante matérielle) sert à détecter une saisie
-- fausse de largeur de cintre ou de distance dès les clics.
alter table public.users
  add column if not exists setup_correction double precision,
  add column if not exists setup_anchor     jsonb;

comment on column public.users.setup_correction is
  'feat-double-calibration-geo-morpho : correction multiplicative du setup '
  'caméra (1.0 = neutre). NULL = jamais ancrée. Appliquée côté Rust dans '
  'recalculer_facteur, jamais ailleurs.';
comment on column public.users.setup_anchor is
  'feat-double-calibration-geo-morpho : contexte de l''ancrage '
  '{camera_name, d_m, f_px, anchored_at}.';

-- Résultat du contrôle, par séance : permet au diagnostic multi-séance
-- d''écarter ou de signaler une séance dont le contrôle a échoué.
-- check_status : ok | anchored | mismatch_kept | mismatch_reanchored
--              | skipped_no_bsa | skipped_after_failures | skipped_bf_optout
--              | failed_<reason>
alter table public.calibration_telemetry
  add column if not exists setup_correction  double precision,
  add column if not exists f_px              double precision,
  add column if not exists f_px_gap_pct      double precision,
  add column if not exists check_status      text,
  add column if not exists check_ratio       double precision,
  add column if not exists check_gap_pct     double precision,
  add column if not exists check_k_hat       double precision,
  add column if not exists check_framing     jsonb,
  add column if not exists check_degraded    boolean;

comment on column public.calibration_telemetry.f_px is
  'Focale caméra en pixels = cintre_pix_640 × cam_distance_m / lcintre_m. '
  'Constante matérielle : sa dérive à caméra identique signale une saisie '
  'fausse ou une caméra déplacée.';
comment on column public.calibration_telemetry.check_status is
  'feat-double-calibration-geo-morpho : issue du contrôle morpho de début '
  'de séance. NULL = aucun contrôle reçu pour cette ligne.';
comment on column public.calibration_telemetry.check_framing is
  'Cadrage observé pendant le contrôle {top_cut, bottom_cut}. top_cut est '
  'bloquant (casque hors champ), bottom_cut est un avertissement.';

-- RLS inchangées : owner read/insert/update + admin read all sur
-- calibration_telemetry, owner sur users. Les nouvelles colonnes héritent
-- des policies existantes (policies au niveau table, pas colonne).
