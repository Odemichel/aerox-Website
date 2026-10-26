-- feat-rider-position-5cls (veloaero) : chemin de l'image dans le bucket
-- training-frames enregistré sur la ligne d'échantillon.
--
-- Le chemin était reconstruit par convention (`<date>/<session8>_<slot>.jpg`,
-- date d'envoi) : un fitting repris le même jour garde son session_id et le
-- desktop repart des mêmes slots, les images du matin étaient écrasées et les
-- lignes du matin pointaient vers celles de l'après-midi. Le desktop envoie
-- désormais `<date>/<session8>_<slot>_<id échantillon>.jpg` et l'écrit ici.
-- NULL : ligne antérieure, ou image non envoyée.

alter table public.calibration_telemetry_samples
  add column if not exists frame_path text;
