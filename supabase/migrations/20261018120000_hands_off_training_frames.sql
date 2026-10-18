-- feat-rider-position-5cls (veloaero) : images « mains lâchées » pour le
-- réentraînement du modèle de segmentation.
--
-- À chaque passage en mains lâchées détecté (assis droit, sans les mains sur
-- le cintre), le desktop envoie 3 images à 1 s d'intervalle, 5 images au
-- plus par séance, par le même circuit que la télémétrie de calibration :
-- JPEG dans le bucket training-frames, masque dans
-- calibration-telemetry-private, ligne dans calibration_telemetry_samples.
--
-- Ces images occupent les slots 7 à 11 (0-6 inchangés) avec le déclencheur
-- `hands_off`. Sans cette migration, la ligne était refusée par les
-- contraintes CHECK (le JPEG et le masque arrivaient quand même, orphelins).

alter table public.calibration_telemetry_samples
  drop constraint calibration_telemetry_samples_slot_index_check,
  add constraint calibration_telemetry_samples_slot_index_check
    check (slot_index between 0 and 11),
  drop constraint calibration_telemetry_samples_trigger_type_check,
  add constraint calibration_telemetry_samples_trigger_type_check
    check (trigger_type in ('auto', 'surface_bucket', 'on_demand', 'hands_off'));
